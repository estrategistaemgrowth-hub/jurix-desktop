// Laço do Jurix Desktop: avisa o servidor que está online, pega as tarefas de IA
// do usuário logado e devolve as respostas. Só fala com o banco pelas RPCs das
// migrations local_ai_* (fila, batida e texto parcial), sempre com o token da
// sessão do próprio usuário.

const HEARTBEAT_EVERY_MS = 15_000; // servidor considera online até 45 s sem sinal
const MAX_PARALLEL = 3; // Raio-X de contrato manda até 3 blocos ao mesmo tempo
const PROGRESS_EVERY_MS = 300; // o servidor lê a fila a cada 400 ms

/** Chamadas REST às RPCs do Supabase com o token do usuário. getAuth → { token, supabaseUrl }. */
function createRpc({ getApiKey, getAuth, fetchImpl = fetch }) {
  return async (fn, body = {}) => {
    const { token, supabaseUrl } = (await getAuth()) || {};
    const apiKey = getApiKey();
    if (!token || !supabaseUrl || !apiKey) {
      throw Object.assign(new Error("Sem sessão no Jurix."), { code: "NO_SESSION" });
    }
    const res = await fetchImpl(`${supabaseUrl}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: {
        apikey: apiKey,
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${fn} falhou (${res.status}): ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : null;
  };
}

/**
 * heartbeat(): { engine, available, status? } — IA em uso (ou null), as encontradas no PC
 * e a cota de cada uma.
 * onPreferred(engine): o servidor devolve a IA escolhida pelo usuário em Configurações.
 */
function createWorker({ rpc, heartbeat, onPreferred = () => {}, execute, now = Date.now, log = console }) {
  let lastHeartbeat = -Infinity;
  const running = new Set();

  // Texto parcial para a tela do Jurix IA, no máximo a cada PROGRESS_EVERY_MS.
  // Banco sem a RPC (migration local_ai_partial pendente): para de tentar.
  let progressSupported = true;
  function progress(jobId) {
    let latest = "";
    let timer = null;
    const send = () => {
      timer = null;
      rpc("progress_local_ai_job", { p_job_id: jobId, p_partial: latest }).catch((e) => {
        if (/404|PGRST202/.test(e.message)) progressSupported = false;
      });
    };
    return {
      update(text) {
        latest = text;
        if (progressSupported && !timer) timer = setTimeout(send, PROGRESS_EVERY_MS);
      },
      stop: () => clearTimeout(timer),
    };
  }

  async function handle(job) {
    let response = null;
    let error = null;
    const partial = progress(job.id);
    try {
      response = await execute(job.request, partial.update);
    } catch (e) {
      error = (e && e.message) || "Falha ao executar a IA local.";
      log.error(`[jurix-desktop] tarefa ${job.id} falhou: ${error}`);
    } finally {
      partial.stop();
    }
    await rpc("complete_local_ai_job", {
      p_job_id: job.id,
      p_response: response,
      p_error: error,
    }).catch((e) => log.error(`[jurix-desktop] não consegui devolver ${job.id}: ${e.message}`));
  }

  /** Uma volta do laço. Retorna o estado para a interface. */
  async function tick() {
    if (now() - lastHeartbeat >= HEARTBEAT_EVERY_MS) {
      const { engine, available, status } = heartbeat();
      const base = { p_engine: engine, p_available: available };
      // Banco ainda sem a migration da cota (sem p_status): bate do jeito antigo.
      const preferred = await rpc("local_ai_heartbeat", status ? { ...base, p_status: status } : base)
        .catch((e) => (status && /p_status|PGRST202/.test(e.message) ? rpc("local_ai_heartbeat", base) : Promise.reject(e)));
      lastHeartbeat = now();
      if (preferred) onPreferred(preferred);
    }
    // Sem nenhuma IA no PC: só avisa a nuvem, não pega tarefa (o servidor usa a API).
    while (heartbeat().engine && running.size < MAX_PARALLEL) {
      const rows = await rpc("claim_local_ai_job");
      const job = Array.isArray(rows) ? rows[0] : null;
      if (!job) break;
      const task = handle(job).finally(() => running.delete(task));
      running.add(task);
    }
    return { running: running.size };
  }

  /** Espera as tarefas em andamento (usado ao fechar o app e nos testes). */
  const drain = () => Promise.all([...running]);

  return { tick, drain };
}

module.exports = { createRpc, createWorker, HEARTBEAT_EVERY_MS, MAX_PARALLEL };
