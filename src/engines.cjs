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

function whichFromShell(name) {
  try {
    const out = win
      ? execFileSync("where.exe", [name], { encoding: "utf8", windowsHide: true })
      : execFileSync(process.env.SHELL || "/bin/zsh", ["-lc", `command -v ${name}`], {
          encoding: "utf8",
        });
    const path = out.split(/\r?\n/).find((l) => l && !/\.(cmd|ps1)$/i.test(l));
    return path && existsSync(path) ? path.trim() : null;
  } catch {
    return null;
  }
}

/** Caminho do executável do motor, ou null se não estiver instalado. */
function findEngine(name) {
  const found = CANDIDATES[name].filter(Boolean).find((p) => existsSync(p));
  return found || whichFromShell(name);
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

function run({ cmd, args, env }, input = "") {
  return new Promise((resolve, reject) => {
    // Pasta temporária como cwd: o CLI não lê CLAUDE.md/AGENTS.md nem arquivos do usuário.
    const p = spawn(cmd, args, { env: cleanEnv(env), cwd: tmpdir(), windowsHide: true });
    let out = "";
    let err = "";
    const timer = setTimeout(() => p.kill(), RUN_TIMEOUT_MS);
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    p.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error((err || out).trim().slice(-400) || `saiu com código ${code}`));
    });
    p.stdin.end(input);
  });
}

const TOOL_PROTOCOL = [
  "FERRAMENTAS DISPONÍVEIS (formato JSON Schema):",
  "%TOOLS%",
  "",
  "Responda SOMENTE com um objeto JSON, sem texto fora dele, em um destes formatos:",
  '- Para consultar dados antes de responder: {"tool_calls":[{"name":"<ferramenta>","arguments":{...}}]}',
  '- Para responder ao usuário: {"content":"<resposta final>"}',
  "Use ferramenta quando a resposta depender de dados que ainda não estão na conversa.",
].join("\n");

/** Converte as mensagens no formato OpenAI (com tools) em system + prompt de texto. */
function buildPrompt(request) {
  const system = [];
  const turns = [];
  for (const m of request.messages || []) {
    if (m.role === "system") system.push(m.content);
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
  return { system: system.join("\n\n"), prompt: turns.join("\n\n"), hasTools: tools.length > 0 };
}

let callSeq = 0;
/** Lê a resposta do protocolo de ferramentas; texto fora do protocolo vira resposta final. */
function parseToolReply(text) {
  const trimmed = text.trim();
  const json = trimmed.match(/\{[\s\S]*\}/)?.[0];
  try {
    const parsed = JSON.parse(json);
    if (Array.isArray(parsed.tool_calls) && parsed.tool_calls.length > 0) {
      const toolCalls = parsed.tool_calls
        .filter((c) => c && typeof c.name === "string")
        .map((c) => ({
          id: `local_${Date.now().toString(36)}_${callSeq++}`,
          function: { name: c.name, arguments: JSON.stringify(c.arguments ?? {}) },
        }));
      if (toolCalls.length > 0) return { content: "", toolCalls };
    }
    if (typeof parsed.content === "string") return { content: parsed.content };
  } catch {
    // não era JSON: segue como texto
  }
  return { content: trimmed };
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
  /minuta|peti[cç][aã]o|contrato|parecer|recurso|contesta|redij|elabor|escrev|redac|analis|notifica/i;
function isQuick(request) {
  const last = [...(request.messages || [])].reverse().find((m) => m.role === "user");
  const text = String(last?.content || "");
  return text.length > 0 && text.length <= 400 && !DRAFTING_RE.test(text);
}

async function runClaude(path, { system, prompt, quick }) {
  const out = await run(
    command(path, [
      "-p",
      "--output-format",
      "stream-json", // traz o evento de cota (rate_limit_event) junto com o resultado
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
    ]),
    prompt,
  );
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

async function runAgy(path, { system, prompt }) {
  const full = `${system}\n\n${prompt}`;
  if (full.length > AGY_MAX_PROMPT_CHARS) {
    // Erro explícito: o servidor cai na API em vez de mandar o texto cortado.
    throw new Error("Conteúdo grande demais para o Antigravity; use Claude ou Codex.");
  }
  const out = await run(command(path, ["-p", full, ...AGY_SAFE_ARGS]));
  const j = JSON.parse(out);
  if (j.status !== "SUCCESS") throw new Error(j.response || j.status);
  return {
    text: j.response,
    usage: j.usage
      ? { prompt_tokens: j.usage.input_tokens, completion_tokens: j.usage.output_tokens }
      : undefined,
  };
}

const RUNNERS = { claude: runClaude, codex: runCodex, agy: runAgy };

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
 */
async function runJob(engine, path, request) {
  const built = buildPrompt(request);
  const { text, usage, quota = null } = await RUNNERS[engine](path, {
    ...built,
    quick: isQuick(request),
  });
  const reply = built.hasTools ? parseToolReply(text) : { content: text.trim() };
  return { reply: usage ? { ...reply, usage } : reply, quota };
}

module.exports = {
  ENGINES,
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
