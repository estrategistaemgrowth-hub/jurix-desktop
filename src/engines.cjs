// Executa uma tarefa de IA do Jurix no CLI logado na assinatura do próprio usuário
// (Claude Code, Codex ou Antigravity) e devolve no formato que o servidor espera:
// { content, toolCalls?, usage? }.
const { spawn, execFileSync } = require("node:child_process");
const { existsSync, readFileSync, readdirSync, rmSync, statSync } = require("node:fs");
const { homedir, tmpdir } = require("node:os");
const { join } = require("node:path");

const ENGINES = ["claude", "codex", "agy"];
// Windows limita a linha de comando a ~32 mil caracteres; o agy recebe o prompt como argumento.
const AGY_MAX_PROMPT_CHARS = 30_000;
const RUN_TIMEOUT_MS = 170_000; // um pouco abaixo dos 180 s que o servidor espera

// O Jurix só precisa de TEXTO dos CLIs: tudo que deixa o agente agir na máquina fica
// desligado (nada de terminal, navegador, conectores ou MCP do usuário).
// Codex: sem shell, sem navegador, sem apps e sem os servidores MCP da config do usuário.
const CODEX_LOCKDOWN_ARGS = [
  "--disable", "shell_tool",
  "--disable", "unified_exec",
  "--disable", "browser_use",
  "--disable", "apps",
  "-c", "mcp_servers={}",
];
// Antigravity: modo plano (sem editar) e sandbox de terminal. Sem --disable-slash-commands:
// ele anula o --mode plan; o prompt nunca começa com "/" (vem depois das instruções).
const AGY_SAFE_ARGS = ["--output-format", "json", "--mode", "plan", "--sandbox"];

const home = homedir();
const win = process.platform === "win32";
const appData = process.env.APPDATA || join(home, "AppData", "Roaming");
const localAppData = process.env.LOCALAPPDATA || join(home, "AppData", "Local");
const npmGlobal = win ? join(appData, "npm", "node_modules") : null;

// Caminhos padrão de instalação. No Mac, app aberto pelo Dock não herda o PATH
// do terminal, por isso a lista e o fallback pelo shell de login.
const CANDIDATES = {
  claude: [
    win && join(npmGlobal, "@anthropic-ai", "claude-code", "bin", "claude.exe"),
    join(home, ".local", "bin", win ? "claude.exe" : "claude"),
    !win && "/opt/homebrew/bin/claude",
    !win && "/usr/local/bin/claude",
  ],
  codex: [
    win && join(npmGlobal, "@openai", "codex", "bin", "codex.js"),
    // Instalador oficial (install.ps1 / install.sh): fora do npm, e o PATH novo só
    // vale para programas abertos depois da instalação, então não dá pra contar com ele.
    win && join(localAppData, "Programs", "OpenAI", "Codex", "bin", "codex.exe"),
    join(home, ".codex", "packages", "standalone", "current", "bin", win ? "codex.exe" : "codex"),
    join(home, ".codex", "packages", "standalone", "current", win ? "codex.exe" : "codex"),
    !win && join(home, ".local", "bin", "codex"),
    !win && "/opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js",
    !win && "/usr/local/lib/node_modules/@openai/codex/bin/codex.js",
    !win && "/opt/homebrew/bin/codex",
    !win && "/usr/local/bin/codex",
  ],
  agy: [
    win && join(localAppData, "agy", "bin", "agy.exe"),
    join(home, ".local", "bin", win ? "agy.exe" : "agy"),
    !win && "/opt/homebrew/bin/agy",
    !win && "/usr/local/bin/agy",
  ],
};

// Windows: o PATH do app é o de quando ele abriu, e o instalador de qualquer CLI só
// grava o novo no registro. Lido de lá, o motor aparece sem reabrir o Jurix.
function freshWinEnv() {
  const read = (key) => {
    try {
      const out = execFileSync("reg.exe", ["query", key, "/v", "Path"], {
        encoding: "utf8",
        windowsHide: true,
      });
      return out.match(/\sPath\s+REG_(?:EXPAND_)?SZ\s+(.*)/i)?.[1].trim() ?? "";
    } catch {
      return "";
    }
  };
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^path$/i.test(k)));
  env.Path = [
    read("HKCU\\Environment"),
    read("HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment"),
    process.env.PATH,
  ]
    .join(";")
    .replace(/%([^%]+)%/g, (m, v) => process.env[v] ?? m);
  return env;
}

function whichFromShell(name) {
  try {
    const out = win
      ? execFileSync("where.exe", [name], { encoding: "utf8", windowsHide: true, env: freshWinEnv() })
      : execFileSync(process.env.SHELL || "/bin/zsh", ["-lc", `command -v ${name}`], {
          encoding: "utf8",
        });
    // Windows: só .exe (o npm também põe no PATH um script sem extensão, que não executa).
    const path = out.split(/\r?\n/).find((l) => l && (win ? /\.exe\s*$/i : /./).test(l));
    return path && existsSync(path) ? path.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Codex do npm: o codex.js inicia o codex.exe sem esconder o console, e num app sem
 * terminal (o Jurix) o Windows abre uma janela preta a cada pergunta. Chamando o
 * codex.exe direto, a janela fica escondida (windowsHide).
 */
function nativeCodex(jsPath) {
  if (!win || !jsPath.endsWith(".js")) return jsPath;
  const pkg = join(jsPath, "..", "..");
  const [arch, triple] =
    process.arch === "arm64"
      ? ["arm64", "aarch64-pc-windows-msvc"]
      : ["x64", "x86_64-pc-windows-msvc"];
  const exe = [
    join(pkg, "node_modules", "@openai", `codex-win32-${arch}`, "vendor", triple, "bin", "codex.exe"),
    join(pkg, "..", `codex-win32-${arch}`, "vendor", triple, "bin", "codex.exe"),
    join(pkg, "vendor", triple, "bin", "codex.exe"),
  ].find((p) => existsSync(p));
  return exe || jsPath;
}

/** Caminho do executável do motor, ou null se não estiver instalado. */
function findEngine(name) {
  const found = CANDIDATES[name].filter(Boolean).find((p) => existsSync(p));
  const path = found || whichFromShell(name);
  return path && name === "codex" ? nativeCodex(path) : path;
}

// .js (Codex via npm) roda com o próprio Node embutido no Electron.
function command(path, args) {
  if (path.endsWith(".js")) {
    return { cmd: process.execPath, args: [path, ...args], env: { ELECTRON_RUN_AS_NODE: "1" } };
  }
  return { cmd: path, args, env: {} };
}

// Sem as chaves de API no ambiente, os CLIs usam obrigatoriamente o login da assinatura.
function cleanEnv(extra) {
  const env = { ...process.env, ...extra };
  for (const key of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"]) {
    delete env[key];
  }
  return env;
}

/** Sobe o CLI; ele espera a entrada (stdin) para trabalhar. */
function start({ cmd, args, env }) {
  // Pasta temporária como cwd: o CLI não lê CLAUDE.md/AGENTS.md nem arquivos do usuário.
  const p = spawn(cmd, args, { env: cleanEnv(env), cwd: tmpdir(), windowsHide: true });
  let out = "";
  let err = "";
  p.stdout.on("data", (d) => (out += d));
  p.stderr.on("data", (d) => (err += d));
  p.stdin.on("error", () => {}); // processo que morreu antes de receber a pergunta
  const done = new Promise((resolve, reject) => {
    p.on("error", reject);
    p.on("close", (code) => {
      if (code === 0) resolve(out);
      else reject(new Error((err || out).trim().slice(-400) || `saiu com código ${code}`));
    });
  });
  done.catch(() => {}); // processo de reserva descartado sem uso
  return { p, done };
}

/** Manda a entrada e espera o CLI terminar. */
function finish(proc, input = "") {
  const timer = setTimeout(() => proc.p.kill(), RUN_TIMEOUT_MS);
  proc.p.stdin.end(input);
  return proc.done.finally(() => clearTimeout(timer));
}

const run = (cmd, input = "") => finish(start(cmd), input);

/**
 * Como finish, mas devolve a saída assim que chega a linha completa com `marker`
 * (o evento final), sem esperar o CLI encerrar; o processo é fechado em seguida.
 */
function finishOn(proc, input, marker) {
  let out = "";
  const early = new Promise((resolve) => {
    const check = (d) => {
      out += d;
      const at = out.indexOf(marker);
      if (at === -1 || out.indexOf("\n", at) === -1) return;
      proc.p.stdout.off("data", check);
      proc.p.kill();
      resolve(out);
    };
    proc.p.stdout.on("data", check);
  });
  return Promise.race([finish(proc, input), early]);
}

// Claude pré-aberto: o programa leva 3-4 s só para subir (medido: 7 s por chamada
// abrindo na hora, ~1,5 s com ele já de pé). Fica um de reserva, com as instruções
// fixas do Jurix IA; cada processo atende UMA pergunta e é descartado, então nada
// passa de uma conversa para outra.
const WARM_IDLE_MS = 10 * 60_000;
let claudeWarm = null; // { key, proc, timer }

function disposeWarm() {
  if (!claudeWarm) return;
  clearTimeout(claudeWarm.timer);
  claudeWarm.proc.p.kill();
  claudeWarm = null;
}

function claudeProcess(path, args, warmable) {
  const key = `${path}\n${args.join("\n")}`;
  const hit = claudeWarm?.key === key && claudeWarm.proc.p.exitCode === null ? claudeWarm.proc : null;
  if (hit) {
    clearTimeout(claudeWarm.timer);
    claudeWarm = null;
  } else disposeWarm();
  // Repõe a reserva já, para a próxima rodada (ferramenta → resposta) ou pergunta.
  if (warmable) {
    claudeWarm = {
      key,
      proc: start(command(path, args)),
      timer: setTimeout(disposeWarm, WARM_IDLE_MS),
    };
  }
  return hit || start(command(path, args));
}

const TOOL_PROTOCOL = [
  "FERRAMENTAS DISPONÍVEIS (formato JSON Schema):",
  "%TOOLS%",
  "",
  "Para consultar dados antes de responder, responda SOMENTE com este JSON, sem nenhum texto fora dele:",
  '{"tool_calls":[{"name":"<ferramenta>","arguments":{...}}]}',
  // Texto normal (não JSON) pode ir aparecendo na tela enquanto é escrito.
  "Para responder ao usuário, escreva só a resposta final, em texto normal (nunca em JSON).",
  "Use ferramenta quando a resposta depender de dados que ainda não estão na conversa.",
].join("\n");

// O servidor marca assim o contexto que muda a cada pergunta (data, panorama,
// lições): ele vai na mensagem, e as instruções fixas ficam no system.
const CONTEXT_PREFIX = "CONTEXTO DESTA CONVERSA";

/**
 * Converte as mensagens no formato OpenAI (com tools) em system + prompt de texto.
 * warmable: pedido do Jurix IA (com contexto separado), que aproveita o Claude pré-aberto.
 */
function buildPrompt(request) {
  const system = [];
  const context = [];
  const turns = [];
  for (const m of request.messages || []) {
    if (m.role === "system") (m.content.startsWith(CONTEXT_PREFIX) ? context : system).push(m.content);
    else if (m.role === "user") turns.push(`[USUÁRIO]\n${m.content}`);
    else if (m.role === "assistant") {
      const calls = (m.tool_calls || []).map(
        (c) => `${c.function.name}(${c.function.arguments}) [id ${c.id}]`,
      );
      turns.push(`[ASSISTENTE]\n${[m.content || "", ...calls].filter(Boolean).join("\n")}`);
    } else if (m.role === "tool") turns.push(`[RESULTADO DA FERRAMENTA ${m.tool_call_id}]\n${m.content}`);
  }
  const tools = request.tools || [];
  if (tools.length > 0) {
    system.push(
      TOOL_PROTOCOL.replace("%TOOLS%", JSON.stringify(tools.map((t) => t.function), null, 1)),
    );
  }
  return {
    system: system.join("\n\n"),
    prompt: [...context, ...turns].join("\n\n"),
    hasTools: tools.length > 0,
    warmable: context.length > 0,
  };
}

let callSeq = 0;
/** Lê a resposta do protocolo de ferramentas; texto fora do protocolo vira resposta final. */
function parseToolReply(text) {
  const trimmed = text.trim();
  // Um JSON só, ou um por linha (o Antigravity às vezes repete o pedido em várias linhas).
  const objects = [trimmed.match(/\{[\s\S]*\}/)?.[0], ...trimmed.split("\n")]
    .map((part) => {
      try {
        return part && part.trim().startsWith("{") ? JSON.parse(part) : null;
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  const seen = new Set();
  const toolCalls = objects
    .flatMap((o) => (Array.isArray(o.tool_calls) ? o.tool_calls : []))
    .filter((c) => c && typeof c.name === "string")
    .map((c) => ({ name: c.name, arguments: JSON.stringify(c.arguments ?? {}) }))
    .filter((c) => !seen.has(`${c.name}${c.arguments}`) && seen.add(`${c.name}${c.arguments}`))
    .map((c) => ({ id: `local_${Date.now().toString(36)}_${callSeq++}`, function: c }));
  if (toolCalls.length > 0) return { content: "", toolCalls };
  const answer = objects.find((o) => typeof o.content === "string");
  return { content: answer ? answer.content : trimmed };
}

const WINDOW_LABEL = { 300: "5 horas", 10080: "semana" };
const windowLabel = (minutes) =>
  WINDOW_LABEL[minutes] ||
  (minutes >= 1440 ? `${Math.round(minutes / 1440)} dias` : `${Math.round(minutes / 60)} horas`);
const pct = (n) => Math.max(0, Math.min(100, Math.round(n)));

/** Cota do Claude: evento rate_limit_event do stream-json (utilização 0-1 por janela). */
function claudeQuota(event) {
  const windows = event?.rate_limit_info?.unifiedWindows;
  if (!windows) return null;
  const list = [
    ["five_hour", "5 horas"],
    ["seven_day", "semana"],
  ]
    .filter(([key]) => windows[key])
    .map(([key, label]) => ({
      label,
      usedPercent: pct((windows[key].utilization || 0) * 100),
      resetsAt: windows[key].resetsAt,
    }));
  return list.length > 0 ? { windows: list, updatedAt: Date.now() } : null;
}

/** Cota do Codex: o rate_limits mais recente que o próprio Codex grava nas sessões. */
function codexQuota(sessionsDir = join(home, ".codex", "sessions")) {
  try {
    // sessions/AAAA/MM/DD/rollout-*.jsonl: a pasta mais nova tem a leitura mais recente.
    let dir = sessionsDir;
    for (let i = 0; i < 3; i++) {
      const sub = readdirSync(dir)
        .filter((n) => /^\d+$/.test(n))
        .sort();
      if (sub.length === 0) return null;
      dir = join(dir, sub[sub.length - 1]);
    }
    const files = readdirSync(dir)
      .filter((n) => n.endsWith(".jsonl"))
      .map((n) => join(dir, n))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    for (const file of files) {
      for (const line of readFileSync(file, "utf8").split("\n").reverse()) {
        if (!line.includes('"rate_limits"')) continue;
        const limits = JSON.parse(line)?.payload?.rate_limits;
        const list = [limits?.primary, limits?.secondary]
          .filter((w) => w && typeof w.used_percent === "number")
          .map((w) => ({
            label: windowLabel(w.window_minutes),
            usedPercent: pct(w.used_percent),
            resetsAt: w.resets_at,
          }));
        if (list.length > 0) return { windows: list, updatedAt: statSync(file).mtimeMs };
      }
    }
  } catch {
    // sem sessões ou formato diferente: fica sem cota
  }
  return null;
}

// Conversa curta responde mais rápido com raciocínio leve (Claude: ~2 s a menos);
// peça, minuta e análise longa seguem no esforço padrão.
const DRAFTING_RE =
  /minuta|peti[cç][aã]o|contrato|parecer|recurso|contesta|redij|elabor|escrev|redac|analis|notifica|relat[oó]rio|document|pdf|word|export|pesquis/i;
function isQuick(request) {
  const last = [...(request.messages || [])].reverse().find((m) => m.role === "user");
  const text = String(last?.content || "");
  return text.length > 0 && text.length <= 400 && !DRAFTING_RE.test(text);
}

/** Texto que o Claude vai escrevendo (eventos text_delta do stream-json). */
function claudeTextStream(onPartial) {
  let buffer = "";
  let text = "";
  return (d) => {
    buffer += d;
    const lines = buffer.split("\n");
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.includes('"text_delta"')) continue;
      try {
        const piece = JSON.parse(line).event?.delta?.text;
        if (typeof piece !== "string") continue;
        text += piece;
        // JSON é pedido de ferramenta: não é texto para o usuário.
        if (!text.trimStart().startsWith("{")) onPartial(text);
      } catch {
        // linha que não é evento: ignora
      }
    }
  };
}

async function runClaude(path, { system, prompt, quick, warmable, onPartial }) {
  const args = [
    "-p",
    "--input-format",
    "stream-json", // a pergunta entra pelo stdin depois: permite subir o processo antes
    "--output-format",
    "stream-json", // traz o evento de cota (rate_limit_event) junto com o resultado
    "--include-partial-messages", // texto aos pedaços: a tela mostra a resposta aparecendo
    "--verbose",
    "--no-session-persistence",
    "--model",
    "sonnet",
    ...(quick ? ["--effort", "low"] : []),
    "--safe-mode", // ignora hooks, MCPs, plugins e CLAUDE.md do usuário
    "--tools",
    "", // só gera texto: não mexe em arquivos nem roda comandos
    "--system-prompt",
    system || "Responda em português do Brasil.",
  ];
  const message = { type: "user", message: { role: "user", content: prompt } };
  const proc = claudeProcess(path, args, warmable);
  if (onPartial) proc.p.stdout.on("data", claudeTextStream(onPartial));
  const out = await finishOn(proc, `${JSON.stringify(message)}\n`, '"type":"result"');
  const events = out
    .split("\n")
    .filter((l) => l.trim().startsWith("{"))
    .map((l) => JSON.parse(l));
  const quota = claudeQuota(events.find((e) => e.type === "rate_limit_event"));
  const j = events.find((e) => e.type === "result");
  if (!j) throw new Error("Claude não devolveu resposta.");
  if (j.is_error) throw new Error(j.result || "Claude retornou erro.");
  const usage = j.usage
    ? {
        prompt_tokens:
          (j.usage.input_tokens || 0) +
          (j.usage.cache_read_input_tokens || 0) +
          (j.usage.cache_creation_input_tokens || 0),
        completion_tokens: j.usage.output_tokens,
      }
    : undefined;
  return { text: j.result, usage, quota };
}

async function runCodex(path, { system, prompt, quick }) {
  const file = join(tmpdir(), `jurix-codex-${process.pid}-${Date.now()}-${callSeq++}.txt`);
  try {
    await run(
      command(path, [
        "exec",
        "--skip-git-repo-check",
        "--ephemeral",
        "--sandbox",
        "read-only",
        ...CODEX_LOCKDOWN_ARGS,
        ...(quick ? ["-c", 'model_reasoning_effort="low"'] : []),
        "-o",
        file,
        "-",
      ]),
      `${system}\n\n${prompt}`,
    );
    return { text: readFileSync(file, "utf8"), quota: codexQuota() };
  } finally {
    rmSync(file, { force: true });
  }
}

// No --mode plan o Antigravity às vezes "monta um plano" e pede confirmação em vez de
// responder (visto com pasta anexada), ou tenta rodar comando para editar (bloqueado
// pelo sandbox, resposta vazia). O Jurix só quer texto ou o JSON das ferramentas.
const AGY_ANSWER_NOW =
  "IMPORTANTE: você não tem terminal, arquivos nem comandos. Para usar uma ferramenta do Jurix, preencha tool_calls (uma vez cada). Para responder, escreva em content a resposta final dirigida ao usuário, como se falasse com ele (nunca um resumo do que você fez). Responda nesta mesma mensagem: não crie plano nem artefato e não peça confirmação.";

// Formato fixo da resposta (--json-schema): sem ele, o Antigravity tentava rodar comando
// em ~metade dos pedidos de ação (medido: 3/6 respondiam; com ele e as descrições, 8/8).
const AGY_REPLY_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    // Sem a descrição, ele preenchia "a tarefa foi concluída" em vez da resposta.
    content: {
      type: "string",
      description:
        "Resposta final ao usuário, completa, com as informações pedidas (datas, nomes, valores), em português. Vazio se for usar ferramenta.",
    },
    tool_calls: {
      type: "array",
      description: "Ferramentas do Jurix a chamar (cada uma uma vez). Vazio se já pode responder.",
      items: {
        type: "object",
        properties: { name: { type: "string" }, arguments: { type: "object" } },
        required: ["name", "arguments"],
      },
    },
  },
});

async function runAgy(path, { system, prompt }) {
  const full = `${system}\n\n${prompt}\n\n${AGY_ANSWER_NOW}`;
  if (full.length > AGY_MAX_PROMPT_CHARS) {
    // Erro explícito: o servidor cai na API em vez de mandar o texto cortado.
    throw new Error("Conteúdo grande demais para o Antigravity; use Claude ou Codex.");
  }
  const ask = async () =>
    JSON.parse(
      await run(command(path, ["-p", full, ...AGY_SAFE_ARGS, "--json-schema", AGY_REPLY_SCHEMA])),
    );
  let j = await ask();
  if (j.status !== "SUCCESS") throw new Error(j.response || j.status);
  // Tentou agir no computador (bloqueado pelo sandbox) e não respondeu: tenta mais uma
  // vez (em geral acerta); se repetir, erro, e o servidor usa a API.
  if (!String(j.response || "").trim() && j.denied_actions?.length) j = await ask();
  if (!String(j.response || "").trim()) {
    throw new Error(
      j.denied_actions?.length
        ? "O Antigravity tentou uma ação bloqueada e não respondeu."
        : "O Antigravity não respondeu.",
    );
  }
  // Com o formato fixo, a resposta final vem como {"content": "..."}; ferramenta segue em JSON.
  let text = j.response;
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed.content === "string" && !parsed.tool_calls?.length) text = parsed.content;
  } catch {
    // texto solto: segue como veio
  }
  return {
    text,
    usage: j.usage
      ? { prompt_tokens: j.usage.input_tokens, completion_tokens: j.usage.output_tokens }
      : undefined,
  };
}

// Antigravity um pedido por vez: em paralelo ele falha muito mais (medido: 1/8 com 4
// juntos, 4/5 em sequência). Os outros pedidos esperam na fila do app.
let agyQueue = Promise.resolve();
function runAgyInTurn(...args) {
  const turn = agyQueue.then(() => runAgy(...args));
  agyQueue = turn.catch(() => {});
  return turn;
}

const RUNNERS = { claude: runClaude, codex: runCodex, agy: runAgyInTurn };

const quiet = (path, args, input, timeoutMs) =>
  Promise.race([
    run(command(path, args), input),
    new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), timeoutMs)),
  ]);

/**
 * A conta está logada? { connected, account? }. Sem janela, sem custo de IA
 * (no Antigravity, que não tem comando de status, é uma pergunta mínima).
 */
async function loginStatus(engine, path) {
  try {
    if (engine === "claude") {
      const j = JSON.parse(await quiet(path, ["auth", "status"], "", 20_000));
      return { connected: j.loggedIn === true, account: j.email || undefined };
    }
    if (engine === "codex") {
      const out = await quiet(path, ["login", "status"], "", 20_000);
      return { connected: /logged in/i.test(out) && !/not logged in/i.test(out) };
    }
    const out = await quiet(path, ["-p", "Responda apenas: ok", ...AGY_SAFE_ARGS], "", 40_000);
    return { connected: JSON.parse(out).status === "SUCCESS" };
  } catch {
    return { connected: false };
  }
}

const LOGIN_ARGS = {
  claude: ["auth", "login", "--claudeai"],
  codex: ["login"],
  // Sem comando de login: a primeira chamada pede a conta Google no navegador.
  agy: ["-p", "Responda apenas: ok", ...AGY_SAFE_ARGS],
};
const LOGIN_TIMEOUT_MS = 5 * 60_000;

/**
 * Login em segundo plano (sem terminal). O CLI abre o navegador; se ele só
 * imprimir o link, onUrl(link) deixa o app abrir. Resolve quando o CLI termina.
 */
function startLogin(engine, path, onUrl) {
  return new Promise((resolve) => {
    const { cmd, args, env } = command(path, LOGIN_ARGS[engine]);
    const p = spawn(cmd, args, { env: cleanEnv(env), cwd: tmpdir(), windowsHide: true });
    let opened = false;
    const watch = (d) => {
      const url = String(d).match(/https:\/\/\S+/)?.[0];
      if (url && !opened) {
        opened = true;
        onUrl(url);
      }
    };
    const timer = setTimeout(() => p.kill(), LOGIN_TIMEOUT_MS);
    p.stdout.on("data", watch);
    p.stderr.on("data", watch);
    p.on("error", () => resolve(false));
    p.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
    p.stdin.end();
  });
}

// Mensagens de limite da assinatura (Claude: "usage limit reached"; Codex: "rate limit"/"usage limit").
const LIMIT_RE =
  /usage limit|rate.?limit|limit reached|quota|resource.?exhausted|too many requests|\b429\b/i;

/**
 * Executa uma tarefa do Jurix (request da fila) no motor escolhido.
 * { reply, quota }: quota (ou null) é a leitura mais recente da cota desse motor.
 * onPartial(texto até agora): só o Claude manda a resposta aos pedaços.
 */
async function runJob(engine, path, request, onPartial) {
  const built = buildPrompt(request);
  const { text, usage, quota = null } = await RUNNERS[engine](path, {
    ...built,
    quick: isQuick(request),
    onPartial,
  });
  const reply = built.hasTools ? parseToolReply(text) : { content: text.trim() };
  return { reply: usage ? { ...reply, usage } : reply, quota };
}

module.exports = {
  ENGINES,
  CONTEXT_PREFIX,
  disposeWarm,
  LIMIT_RE,
  findEngine,
  buildPrompt,
  parseToolReply,
  isQuick,
  claudeQuota,
  codexQuota,
  runJob,
  loginStatus,
  startLogin,
};
