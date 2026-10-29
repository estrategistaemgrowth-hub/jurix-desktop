const test = require("node:test");
const assert = require("node:assert/strict");
const { createRpc, createWorker, HEARTBEAT_EVERY_MS, MAX_PARALLEL } = require("../src/worker.cjs");

// Banco simulado: guarda as chamadas e entrega as tarefas da fila uma a uma.
function fakeRpc(queue) {
  const calls = [];
  const rpc = async (fn, body) => {
    calls.push([fn, body]);
    if (fn === "claim_local_ai_job") {
      const job = queue.shift();
      return job ? [job] : [];
    }
    return true;
  };
  return { rpc, calls };
}

const silent = { error: () => {} };

const claudeOnly = () => ({ engine: "claude", available: ["claude"] });

test("heartbeat na primeira volta e depois só a cada intervalo", async () => {
  let clock = 0;
  const { rpc, calls } = fakeRpc([]);
  const worker = createWorker({
    rpc,
    heartbeat: () => ({ engine: "claude", available: ["claude", "codex"] }),
    execute: async () => ({}),
    now: () => clock,
  });
  await worker.tick();
  clock += HEARTBEAT_EVERY_MS - 1;
  await worker.tick();
  clock += 1;
  await worker.tick();
  const beats = calls.filter(([fn]) => fn === "local_ai_heartbeat");
  assert.equal(beats.length, 2);
  assert.deepEqual(beats[0][1], { p_engine: "claude", p_available: ["claude", "codex"] });
});

test("repassa a IA escolhida pelo usuário que o servidor devolve no heartbeat", async () => {
  const rpc = async (fn) => (fn === "local_ai_heartbeat" ? "codex" : []);
  const chosen = [];
  const worker = createWorker({
    rpc,
    heartbeat: claudeOnly,
    onPreferred: (name) => chosen.push(name),
    execute: async () => ({}),
  });
  await worker.tick();
  assert.deepEqual(chosen, ["codex"]);
});

test("sem nenhuma IA instalada só avisa a nuvem e não pega tarefa", async () => {
  const { rpc, calls } = fakeRpc([{ id: "job-1", request: {} }]);
  const worker = createWorker({
    rpc,
    heartbeat: () => ({ engine: null, available: [] }),
    execute: async () => ({}),
  });
  await worker.tick();
  assert.deepEqual(
    calls.map(([fn]) => fn),
    ["local_ai_heartbeat"],
  );
});

test("pega várias tarefas em paralelo, até o limite", async () => {
  const queue = Array.from({ length: MAX_PARALLEL + 1 }, (_, i) => ({ id: `job-${i}`, request: {} }));
  const { rpc, calls } = fakeRpc(queue);
  let release;
  const gate = new Promise((r) => (release = r));
  let started = 0;
  const worker = createWorker({
    rpc,
    heartbeat: claudeOnly,
    execute: async () => {
      started++;
      await gate;
      return { content: "ok" };
    },
  });
  const state = await worker.tick();
  assert.equal(state.running, MAX_PARALLEL);
  assert.equal(started, MAX_PARALLEL);
  assert.equal(queue.length, 1, "a quarta tarefa fica na fila até liberar vaga");

  release();
  await worker.drain();
  const done = calls.filter(([fn]) => fn === "complete_local_ai_job");
  assert.equal(done.length, MAX_PARALLEL);
  assert.deepEqual(done[0][1], { p_job_id: "job-0", p_response: { content: "ok" }, p_error: null });
});

test("erro do CLI vira p_error para o servidor cair na API", async () => {
  const { rpc, calls } = fakeRpc([{ id: "job-x", request: {} }]);
  const worker = createWorker({
    rpc,
    heartbeat: claudeOnly,
    execute: async () => {
      throw new Error("Limite do plano atingido.");
    },
    log: silent,
  });
  await worker.tick();
  await worker.drain();
  const [, body] = calls.find(([fn]) => fn === "complete_local_ai_job");
  assert.deepEqual(body, { p_job_id: "job-x", p_response: null, p_error: "Limite do plano atingido." });
});

test("RPC usa o token e a chave pública do usuário; sem sessão não chama nada", async () => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, init });
    return { ok: true, text: async () => "[]" };
  };
  let auth = null;
  const rpc = createRpc({ getApiKey: () => "pub-key", getAuth: async () => auth, fetchImpl });

  await assert.rejects(rpc("claim_local_ai_job"), { code: "NO_SESSION" });
  assert.equal(requests.length, 0);

  auth = { token: "user-jwt", supabaseUrl: "https://abc.supabase.co" };
  assert.deepEqual(await rpc("claim_local_ai_job"), []);
  assert.equal(requests[0].url, "https://abc.supabase.co/rest/v1/rpc/claim_local_ai_job");
  assert.equal(requests[0].init.headers.Authorization, "Bearer user-jwt");
  assert.equal(requests[0].init.headers.apikey, "pub-key");
});
