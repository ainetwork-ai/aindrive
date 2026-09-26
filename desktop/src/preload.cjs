// The shell window's only bridge to the app. shell/mac-bridge.js turns it
// into Capacitor's native bridge; nothing else of Electron or Node reaches the page.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("__aindriveNative", {
  /** A plugin method (AindriveAgent.*, CapacitorCookies.*) → its result. */
  call: (plugin, method, options) => ipcRenderer.invoke("native:call", plugin, method, options),
  /** Plugin events (AindriveAgent "statusChanged"). */
  onEvent: (fn) => ipcRenderer.on("native:event", (_e, plugin, event, data) => fn(plugin, event, data)),
  /** An http(s) request made by the main process, with the session's cookies. */
  fetch: (req) => ipcRenderer.invoke("native:fetch", req),
});
