// web/lib/willow/offline.ts
"use client";
let done = false;
export function registerOffline() {
  if (done || typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  done = true;
  void navigator.serviceWorker.register("/sw.js").catch(() => {});
  // this page answers the worker's P2P media requests (lib/media/p2p-client.ts)
  void import("@/lib/media/p2p-client").then((m) => m.serveP2PForServiceWorker()).catch(() => {});
}
