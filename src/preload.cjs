// Ponte das telas de onboarding (arquivos locais do app) com o processo principal.
// O site jurix.work roda na mesma janela, mas NÃO recebe esta API: ela só existe
// quando a página aberta é um arquivo do próprio app.
const { contextBridge, ipcRenderer } = require("electron");

if (location.protocol === "file:") {
  contextBridge.exposeInMainWorld("jurixDesktop", {
    platform: process.platform,
    scanEngines: () => ipcRenderer.invoke("onboarding:scan"),
    engineStatus: () => ipcRenderer.invoke("onboarding:status"),
    openInstallPage: (engine) => ipcRenderer.invoke("onboarding:install", engine),
    openLogin: (engine) => ipcRenderer.invoke("onboarding:login", engine),
    finishAiStep: () => ipcRenderer.invoke("onboarding:finish-ai"),
  });
}
