// Jurix Desktop: o mesmo Jurix web numa janela, mais o motor de IA local.
// Login, telas e regras são os da nuvem; o app só executa as tarefas de IA do
// usuário logado na assinatura dele (Claude Code, Codex ou Antigravity).
const { app, BrowserWindow, Menu, ipcMain, shell } = require("electron");
const { readFileSync, writeFileSync, existsSync } = require("node:fs");
const { join } = require("node:path");
const {
  ENGINES,
  LIMIT_RE,
  findEngine,
  codexQuota,
  runJob,
  loginStatus,
  startLogin,
} = require("./engines.cjs");
const { createRpc, createWorker } = require("./worker.cjs");

const TICK_MS = 1_000; // tempo máximo até o desktop pegar uma pergunta nova
const RESCAN_EVERY_MS = 15_000; // mesmo ritmo do heartbeat: "Localizar IAs" na web espera isso
const UPDATE_EVERY_MS = 2 * 60 * 60 * 1000;
const UPDATE_PAGE = join(__dirname, "update.html");
const ICON = join(__dirname, "..", "build", "icon.png");
const ONBOARDING = join(__dirname, "onboarding", "index.html");
const SPLASH = join(__dirname, "splash.html");
const ENGINE_LABEL = { claude: "Claude", codex: "ChatGPT", agy: "Gemini" };
const RELEASES = "https://github.com/estrategistaemgrowth-hub/jurix-desktop/releases/latest";

// Páginas oficiais de instalação de cada IA.
const INSTALL_PAGES = {
  claude: "https://docs.claude.com/pt/docs/claude-code/setup",
  codex: "https://developers.openai.com/codex/cli",
  agy: "https://antigravity.google",
};

// Ícone e grupo próprios na barra de tarefas do Windows (senão aparece o do Electron).
if (process.platform === "win32") app.setAppUserModelId("work.jurix.desktop");
// Uma janela só: abrir o atalho de novo traz a janela que já está aberta.
const isFirstInstance = app.requestSingleInstanceLock();
if (!isFirstInstance) app.quit();

// Config pública (as mesmas que vão no bundle do site); env sobrescreve.
function loadConfig() {
  const file = join(__dirname, "..", "config.json");
  const fromFile = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  return {
    appUrl: process.env.JURIX_URL || fromFile.appUrl || "https://jurix.work",
    supabaseUrl: process.env.JURIX_SUPABASE_URL || fromFile.supabaseUrl || "",
    supabaseKey: process.env.JURIX_SUPABASE_KEY || fromFile.supabaseKey || "",
    engine: process.env.JURIX_ENGINE || fromFile.engine || "",
  };
}

// Progresso do onboarding do app (fica na pasta de dados do usuário, não no instalador).
const statePath = () => join(app.getPath("userData"), "onboarding.json");
function readState() {
  try {
    return JSON.parse(readFileSync(statePath(), "utf8"));
  } catch {
    return {};
  }
}
function saveState(patch) {
  writeFileSync(statePath(), JSON.stringify({ ...readState(), ...patch }));
}

/** IAs instaladas no PC: { claude: "C:\\...\\claude.exe", ... }. */
function scanEngines() {
  const found = {};
  for (const name of ENGINES) {
    const path = findEngine(name);
    if (path) found[name] = path;
  }
  return found;
}

// Ordem: a escolhida pelo usuário em Configurações, a da config/env, a atual, a primeira encontrada.
function chooseEngine(installed, ...wishes) {
  return wishes.find((name) => name && installed[name]) || Object.keys(installed)[0] || null;
}

/** Notas do release (HTML ou lista do GitHub) em itens de texto para a janela. */
function releaseNotes(info) {
  const raw = Array.isArray(info.releaseNotes)
    ? info.releaseNotes.map((n) => n.note || "").join("\n")
    : String(info.releaseNotes || "");
  const items = raw
    .replace(/<\/(li|p|h\d)>|<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .split("\n")
    .map((l) => l.replace(/^\s*[-*•#]+\s*/, "").trim())
    .filter((l) => l.length > 2)
    .slice(0, 8);
  return items.length > 0 ? items : ["Melhorias e correções para o Jurix funcionar melhor."];
}

// Atualização do app numa janela do Jurix: versão nova, o que mudou e progresso.
// Windows: baixa e instala ao reiniciar. Mac (sem assinatura da Apple não há
// instalação automática): abre o download do instalador novo.
function setupUpdates(win) {
  if (!app.isPackaged) return;
  let autoUpdater;
  try {
    ({ autoUpdater } = require("electron-updater"));
  } catch {
    return;
  }
  const mac = process.platform === "darwin";
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  let popup = null;
  let state = null;
  let dismissedVersion = null;
  const send = (patch) => {
    state = { ...state, ...patch };
    if (popup && !popup.isDestroyed()) popup.webContents.send("update:state", state);
  };
  function openPopup() {
    if (popup && !popup.isDestroyed()) return popup.focus();
    popup = new BrowserWindow({
      parent: win,
      modal: true,
      width: 440,
      height: 520,
      resizable: false,
      minimizable: false,
      maximizable: false,
      frame: false,
      show: false,
      backgroundColor: "#ffffff",
      icon: ICON,
      webPreferences: {
        preload: join(__dirname, "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    popup.loadFile(UPDATE_PAGE);
    popup.webContents.on("did-finish-load", () => send({}));
    popup.once("ready-to-show", () => popup.show());
  }

  ipcMain.handle("update:start", () => {
    if (mac) {
      shell.openExternal(RELEASES);
      popup?.close();
      return;
    }
    send({ phase: "downloading", percent: 0 });
    autoUpdater.downloadUpdate().catch(() => send({ phase: "error" }));
  });
  ipcMain.handle("update:install", () => autoUpdater.quitAndInstall());
  ipcMain.handle("update:dismiss", () => {
    // "Depois" sem baixar: não insiste nesta versão até reabrir o app.
    if (state?.phase === "available") dismissedVersion = state.version;
    popup?.close();
  });

  autoUpdater.on("update-available", (info) => {
    if (info.version === dismissedVersion || state?.phase === "downloading") return;
    state = {
      phase: "available",
      current: app.getVersion(),
      version: info.version,
      notes: releaseNotes(info),
      manual: mac,
    };
    openPopup();
  });
  autoUpdater.on("download-progress", (p) =>
    send({ phase: "downloading", percent: p.percent, transferred: p.transferred, total: p.total }),
  );
  autoUpdater.on("update-downloaded", () => {
    send({ phase: "ready" });
    openPopup(); // reaparece pronta, mesmo se o usuário fechou durante o download
  });
  autoUpdater.on("error", (e) => {
    console.error("[jurix-desktop] atualização:", e.message);
    if (state?.phase === "downloading") send({ phase: "error" });
  });
  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  check();
  setInterval(check, UPDATE_EVERY_MS);
}

app.whenReady().then(() => {
  if (!isFirstInstance) return;
  // Sem o menu padrão do Electron. No Mac fica o mínimo do sistema (barra do topo),
  // senão Cmd+C/Cmd+V/Cmd+Q deixam de funcionar.
  Menu.setApplicationMenu(
    process.platform === "darwin"
      ? Menu.buildFromTemplate([{ role: "appMenu" }, { role: "editMenu" }])
      : null,
  );

  if (process.platform === "darwin") app.dock.setIcon(ICON);

  const config = loadConfig();
  const appOrigin = new URL(config.appUrl).origin;
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    title: "Jurix",
    icon: ICON,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: join(__dirname, "preload.cjs"),
    },
  });
  app.on("second-instance", () => {
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  // O Google bloqueia login OAuth (Agenda, Drive, Meet) em navegador "embutido";
  // sem a marca do Electron no user agent, a janela é tratada como o Chrome que ela é.
  win.webContents.setUserAgent(
    win.webContents.getUserAgent().replace(/ (Electron|jurix-desktop)\/\S+/g, ""),
  );

  // Links para fora do Jurix abrem no navegador padrão, nunca dentro do app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(appOrigin)) shell.openExternal(url);
    return { action: url.startsWith(appOrigin) ? "allow" : "deny" };
  });

  // O app abre direto no login do Jurix (que manda para o /dashboard quem já está
  // logado), passando pela tela de abertura animada em vez de piscar em branco.
  const AUTH_URL = `${config.appUrl}/auth`;
  win.loadFile(SPLASH);
  win.webContents.once("did-finish-load", () => win.loadURL(AUTH_URL));

  // A landing page não aparece no app (ex.: depois de sair da conta): volta pro login.
  const isLanding = (url) => {
    try {
      const u = new URL(url);
      return u.origin === appOrigin && (u.pathname === "/" || u.pathname === "");
    } catch {
      return false;
    }
  };
  const skipLanding = (_e, url) => {
    if (isLanding(url)) win.loadURL(AUTH_URL);
  };
  win.webContents.on("did-navigate", skipLanding);
  win.webContents.on("did-navigate-in-page", skipLanding);

  setupUpdates(win);

  let lastStatus = "";
  const setStatus = (text) => {
    if (text === lastStatus || win.isDestroyed()) return;
    lastStatus = text;
    win.setTitle(`Jurix · IA local: ${text}`);
    console.log(`[jurix-desktop] IA local: ${text}`);
  };

  let installed = scanEngines();
  let preferred = null;
  let engine = chooseEngine(installed, config.engine);
  let lastScan = Date.now();
  function rescan() {
    installed = scanEngines();
    engine = chooseEngine(installed, preferred, config.engine, engine);
    lastScan = Date.now();
  }

  // Telas de onboarding (arquivos locais) → processo principal.
  ipcMain.handle("onboarding:scan", () => {
    rescan();
    return Object.keys(installed);
  });
  ipcMain.handle("onboarding:install", (_e, name) => {
    if (INSTALL_PAGES[name]) shell.openExternal(INSTALL_PAGES[name]);
  });
  // Estado de cada IA: instalada? conta conectada? (para a tela mostrar "Conectado").
  ipcMain.handle("onboarding:status", async () => {
    rescan();
    const entries = await Promise.all(
      ENGINES.map(async (name) => [
        name,
        installed[name]
          ? { installed: true, ...(await loginStatus(name, installed[name])) }
          : { installed: false, connected: false },
      ]),
    );
    return Object.fromEntries(entries);
  });
  // Login em segundo plano: sem terminal; o navegador abre na página de login da conta.
  ipcMain.handle("onboarding:login", async (_e, name) => {
    if (!installed[name]) return { connected: false };
    await startLogin(name, installed[name], (url) => shell.openExternal(url));
    return loginStatus(name, installed[name]);
  });
  ipcMain.handle("onboarding:finish-ai", () => {
    saveState({ aiStepDone: true });
    rescan();
    win.loadURL(`${config.appUrl}/dashboard`);
  });

  // Sessão do Supabase que o próprio Jurix web grava no localStorage (sb-<ref>-auth-token).
  async function readSession() {
    if (win.isDestroyed() || !win.webContents.getURL().startsWith(appOrigin)) return null;
    return win.webContents.executeJavaScript(`(() => {
      const key = Object.keys(localStorage).find((k) => /^sb-[a-z0-9]+-auth-token$/.test(k));
      if (!key) return null;
      try {
        const s = JSON.parse(localStorage.getItem(key));
        return { ref: key.slice(3, -11), token: s.access_token || null };
      } catch { return null; }
    })()`);
  }

  // Primeira vez já dentro do sistema (depois do cadastro e do /boas-vindas da nuvem):
  // mostra a etapa "Conecte sua IA" uma única vez.
  function maybeShowAiStep(session) {
    if (!session?.token || readState().aiStepDone) return;
    const path = new URL(win.webContents.getURL()).pathname;
    if (["/auth", "/login", "/boas-vindas"].some((p) => path.startsWith(p))) return;
    win.loadFile(ONBOARDING);
  }

  // A chave pública (publishable) do Supabase é a mesma que o site manda em toda
  // requisição; o app a pega do tráfego do próprio Jurix em vez de exigir config.
  let apiKey = config.supabaseKey;
  win.webContents.session.webRequest.onBeforeSendHeaders(
    { urls: ["https://*.supabase.co/*"] },
    (details, callback) => {
      if (!apiKey && details.requestHeaders.apikey) apiKey = details.requestHeaders.apikey;
      callback({ requestHeaders: details.requestHeaders });
    },
  );

  const rpc = createRpc({
    getApiKey: () => apiKey,
    getAuth: async () => {
      const session = await readSession();
      if (!session) return null;
      maybeShowAiStep(session);
      // Sem URL na config, ela sai da própria chave da sessão (sb-<ref>-auth-token).
      return {
        token: session.token,
        supabaseUrl: config.supabaseUrl || `https://${session.ref}.supabase.co`,
      };
    },
  });

  // Cota de cada IA para o seletor do chat: { claude: { windows, updatedAt, limited? }, ... }.
  // O Codex grava a cota nas próprias sessões; lê já na abertura.
  const status = {};
  const codexNow = codexQuota();
  if (codexNow) status.codex = codexNow;

  const worker = createWorker({
    rpc,
    heartbeat: () => ({ engine, available: Object.keys(installed), status }),
    onPreferred: (name) => {
      preferred = name;
      engine = chooseEngine(installed, preferred, engine);
    },
    // A conversa pode pedir uma IA específica (seletor do chat); se ela não estiver
    // instalada, usa a do computador. Motor fixado na hora de pegar a tarefa.
    execute: async (request) => {
      const name = installed[request.engine] ? request.engine : engine;
      try {
        const { reply, quota } = await runJob(name, installed[name], request);
        status[name] = quota || { ...status[name], limited: false };
        return { ...reply, engine: name };
      } catch (e) {
        if (LIMIT_RE.test(e.message)) {
          status[name] = { ...status[name], limited: true, updatedAt: Date.now() };
        }
        throw e;
      }
    },
  });

  let busy = false;
  let lastError = "";
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    if (Date.now() - lastScan >= RESCAN_EVERY_MS) rescan();
    const label = engine ? ENGINE_LABEL[engine] : "nenhuma IA instalada";
    try {
      const { running } = await worker.tick();
      setStatus(
        !engine
          ? "nenhuma IA instalada (usando a IA do Jurix)"
          : running > 0
            ? `${label} trabalhando (${running})`
            : `${label} conectado`,
      );
      lastError = "";
    } catch (e) {
      setStatus(e.code === "NO_SESSION" ? `${label} (entre no Jurix)` : `${label} sem conexão`);
      // Registra o erro uma vez, não a cada volta do laço.
      if (e.code !== "NO_SESSION" && e.message !== lastError) {
        console.error("[jurix-desktop]", e.message);
      }
      lastError = e.message;
    } finally {
      busy = false;
    }
  }, TICK_MS);

  app.on("before-quit", () => clearInterval(timer));
});

app.on("window-all-closed", () => app.quit());
