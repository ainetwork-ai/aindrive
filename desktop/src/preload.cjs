// The window's only bridge to the app: a handful of named calls, no Node.
const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("aindrive", {
  state: () => ipcRenderer.invoke("state"),
  onState: (fn) => ipcRenderer.on("state", (_e, s) => fn(s)),
  share: (folder) => ipcRenderer.invoke("share", folder),
  pause: (folder) => ipcRenderer.invoke("pause", folder),
  resume: (folder) => ipcRenderer.invoke("resume", folder),
  remove: (folder) => ipcRenderer.invoke("remove", folder),
  open: (what, folder) => ipcRenderer.invoke("open", what, folder),
  web: () => ipcRenderer.invoke("web"),
  setOpenAtLogin: (on) => ipcRenderer.invoke("openAtLogin", on),
  signOut: () => ipcRenderer.invoke("signOut"),
  /** the path of a folder dropped on the window */
  pathOf: (file) => webUtils.getPathForFile(file),
});
