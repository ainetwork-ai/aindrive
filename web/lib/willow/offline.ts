// web/lib/willow/offline.ts
"use client";
let done = false;
export function registerOffline() {
  if (done || typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  done = true;
  void navigator.serviceWorker.register("/sw.js").catch(() => {});
}
