// Executa uma tarefa de IA do Jurix no CLI logado na assinatura do próprio usuário
// (Claude Code, Codex ou Antigravity) e devolve no formato que o servidor espera:
// { content, toolCalls?, usage? }.
const { spawn, execFileSync } = require("node:child_process");
const { existsSync, readFileSync, rmSync } = require("node:fs");
const { homedir, tmpdir } = require("node:os");
const { join } = require("node:path");

const ENGINES = ["claude", "codex", "agy"];
// Windows limita a linha de comando a ~32 mil caracteres; o agy recebe o prompt como argumento.
const AGY_MAX_PROMPT_CHARS = 30_000;
const RUN_TIMEOUT_MS = 170_000; // um pouco abaixo dos 180 s que o servidor espera

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

async function runClaude(path, { system, prompt }) {
  const out = await run(
    command(path, [
      "-p",
      "--output-format",
      "json",
      "--no-session-persistence",
      "--model",
      "sonnet",
      "--safe-mode", // ignora hooks, MCPs, plugins e CLAUDE.md do usuário
      "--tools",
      "", // só gera texto: não mexe em arquivos nem roda comandos
      "--system-prompt",
      system || "Responda em português do Brasil.",
    ]),
    prompt,
  );
  const j = JSON.parse(out);
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
  return { text: j.result, usage };
}

async function runCodex(path, { system, prompt }) {
  const file = join(tmpdir(), `jurix-codex-${process.pid}-${Date.now()}-${callSeq++}.txt`);
  try {
    await run(
      command(path, [
        "exec",
        "--skip-git-repo-check",
        "--ephemeral",
        "--sandbox",
        "read-only",
        "-o",
        file,
        "-",
      ]),
      `${system}\n\n${prompt}`,
    );
    return { text: readFileSync(file, "utf8") };
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
  const out = await run(
    command(path, [
      "-p",
      full,
      "--output-format",
      "json",
      "--mode",
      "plan",
      "--disable-slash-commands",
    ]),
  );
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
    const out = await quiet(
      path,
      ["-p", "Responda apenas: ok", "--output-format", "json", "--mode", "plan", "--disable-slash-commands"],
      "",
      40_000,
    );
    return { connected: JSON.parse(out).status === "SUCCESS" };
  } catch {
    return { connected: false };
  }
}

const LOGIN_ARGS = {
  claude: ["auth", "login", "--claudeai"],
  codex: ["login"],
  // Sem comando de login: a primeira chamada pede a conta Google no navegador.
  agy: ["-p", "Responda apenas: ok", "--output-format", "json", "--mode", "plan", "--disable-slash-commands"],
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

/** Executa uma tarefa do Jurix (request da fila) no motor escolhido. */
async function runJob(engine, path, request) {
  const built = buildPrompt(request);
  const { text, usage } = await RUNNERS[engine](path, built);
  const reply = built.hasTools ? parseToolReply(text) : { content: text.trim() };
  return usage ? { ...reply, usage } : reply;
}

module.exports = {
  ENGINES,
  findEngine,
  buildPrompt,
  parseToolReply,
  runJob,
  loginStatus,
  startLogin,
};
