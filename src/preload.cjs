// Ponte das telas de onboarding (arquivos locais do app) com o processo principal.
// O site jurix.work roda na mesma janela e recebe SÓ o "anexar pasta": o processo
// principal confere que o pedido veio do Jurix e abre a janela de escolha do sistema.
// As outras funções (onboarding, atualização) só existem nos arquivos do próprio app.
const { contextBridge, ipcRenderer } = require("electron");

if (location.protocol !== "file:") {
  contextBridge.exposeInMainWorld("jurixDesktop", {
    pickFolderDocuments: () => ipcRenderer.invoke("files:pick-folder"),
  });
} else {
  contextBridge.exposeInMainWorld("jurixDesktop", {
    platform: process.platform,
    scanEngines: () => ipcRenderer.invoke("onboarding:scan"),
    engineStatus: () => ipcRenderer.invoke("onboarding:status"),
    openInstallPage: (engine) => ipcRenderer.invoke("onboarding:install", engine),
    openLogin: (engine) => ipcRenderer.invoke("onboarding:login", engine),
    finishAiStep: () => ipcRenderer.invoke("onboarding:finish-ai"),
    // Janela de atualização (update.html).
    onUpdate: (cb) => ipcRenderer.on("update:state", (_e, state) => cb(state)),
    startUpdate: () => ipcRenderer.invoke("update:start"),
    installUpdate: () => ipcRenderer.invoke("update:install"),
    dismissUpdate: () => ipcRenderer.invoke("update:dismiss"),
  });
}
