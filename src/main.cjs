// Jurix Desktop: o mesmo Jurix web numa janela, mais o motor de IA local.
// Login, telas e regras são os da nuvem; o app só executa as tarefas de IA do
// usuário logado na assinatura dele (Claude Code, Codex ou Antigravity).
const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require("electron");
const { spawn } = require("node:child_process");
const { readFileSync, writeFileSync, existsSync } = require("node:fs");
const { join } = require("node:path");
const { ENGINES, findEngine, runJob } = require("./engines.cjs");
const { createRpc, createWorker } = require("./worker.cjs");

const TICK_MS = 2_000;
const RESCAN_EVERY_MS = 15_000; // mesmo ritmo do heartbeat: "Localizar IAs" na web espera isso
const UPDATE_EVERY_MS = 6 * 60 * 60 * 1000;
const ICON = join(__dirname, "..", "build", "icon.png");
const ONBOARDING = join(__dirname, "onboarding", "index.html");
const ENGINE_LABEL = { claude: "Claude", codex: "ChatGPT", agy: "Gemini" };
const RELEASES = "https://github.com/estrategistaemgrowth-hub/jurix-desktop/releases/latest";

// Onde instalar e como fazer login em cada IA (páginas oficiais e comando de login do CLI).
const INSTALL_PAGES = {
  claude: "https://docs.claude.com/pt/docs/claude-code/setup",
  codex: "https://developers.openai.com/codex/cli",
  agy: "https://antigravity.google",
};
const LOGIN_COMMANDS = { claude: "claude", codex: "codex login", agy: "agy" };

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

// Abre um terminal com o login do CLI: é ele quem abre o navegador na conta do usuário.
function openLoginTerminal(command) {
  if (process.platform === "win32") {
    spawn("cmd.exe", ["/c", "start", "Login da IA", "cmd", "/k", command], {
      detached: true,
      windowsHide: false,
    }).unref();
  } else if (process.platform === "darwin") {
    spawn("osascript", ["-e", `tell application "Terminal" to do script "${command}"`, "-e",
      'tell application "Terminal" to activate']).unref();
  } else {
    spawn("x-terminal-emulator", ["-e", command], { detached: true }).unref();
  }
}

// Atualização do app: no Windows baixa e instala ao reiniciar; no Mac (sem assinatura
// da Apple não há instalação automática) só avisa e abre o download.
function setupUpdates(win) {
  if (!app.isPackaged) return;
  let autoUpdater;
  try {
    ({ autoUpdater } = require("electron-updater"));
  } catch {
    return;
  }
  const mac = process.platform === "darwin";
  autoUpdater.autoDownload = !mac;
  autoUpdater.on("update-available", async (info) => {
    if (!mac) return;
    const { response } = await dialog.showMessageBox(win, {
      type: "info",
      buttons: ["Baixar agora", "Depois"],
      defaultId: 0,
      title: "Atualização do Jurix",
      message: `O Jurix ${info.version} está disponível.`,
      detail: "Baixe o instalador novo e arraste o Jurix para Aplicativos, substituindo o atual.",
    });
    if (response === 0) shell.openExternal(RELEASES);
  });
  autoUpdater.on("update-downloaded", async (info) => {
    const { response } = await dialog.showMessageBox(win, {
      type: "info",
      buttons: ["Reiniciar agora", "Depois"],
      defaultId: 0,
      title: "Atualização do Jurix",
      message: `A versão ${info.version} do Jurix está pronta.`,
      detail: "Reinicie para usar. Se escolher depois, ela é instalada quando você fechar o app.",
    });
    if (response === 0) autoUpdater.quitAndInstall();
  });
  autoUpdater.on("error", (e) => console.error("[jurix-desktop] atualização:", e.message));
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

  const state = readState();
  if (state.welcomed) win.loadURL(config.appUrl);
  else win.loadFile(ONBOARDING, { query: { step: "welcome" } });

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
  ipcMain.handle("onboarding:login", (_e, name) => {
    if (LOGIN_COMMANDS[name] && installed[name]) openLoginTerminal(LOGIN_COMMANDS[name]);
  });
  ipcMain.handle("onboarding:account", (_e, mode) => {
    saveState({ welcomed: true });
    win.loadURL(`${config.appUrl}/auth${mode === "signup" ? "?mode=signup" : ""}`);
  });
  ipcMain.handle("onboarding:finish-ai", () => {
    saveState({ aiStepDone: true });
    rescan();
    win.loadURL(config.appUrl);
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
    win.loadFile(ONBOARDING, { query: { step: "ai" } });
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

  const worker = createWorker({
    rpc,
    heartbeat: () => ({ engine, available: Object.keys(installed) }),
    onPreferred: (name) => {
      preferred = name;
      engine = chooseEngine(installed, preferred, engine);
    },
    // Motor fixado na hora de pegar a tarefa: trocar de IA não afeta as que já estão rodando.
    execute: (request) => {
      const name = engine;
      return runJob(name, installed[name], request);
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
