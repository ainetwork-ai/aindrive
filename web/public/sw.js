// web/public/sw.js
// Offline open (spec §7): the app shell and every drive page visited are cached;
// documents come from the Willow store in IndexedDB, so a cached page is enough.
const CACHE = "aindrive-shell-v1";
self.addEventListener("install", (e) => e.waitUntil(self.skipWaiting()));
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin || url.pathname.startsWith("/api/")) return;
  const cacheable = req.mode === "navigate" || url.pathname.startsWith("/_next/static/");
  if (!cacheable) return;
  e.respondWith(
    fetch(req)
      .then((res) => { if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); } return res; })
      .catch(async () => (await caches.match(req)) ?? (await caches.match("/")) ?? Response.error()),
  );
});
