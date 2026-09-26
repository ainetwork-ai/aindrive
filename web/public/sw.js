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

// ── P2P media (media spec M5): fs/stream requests of a page that enabled P2P are
// answered by that page (chunks straight from the device over WebRTC, verified,
// with the server for anything the device does not bring). "via=server" requests
// and pages without P2P go to the network as always.
const p2pClients = new Set();
self.addEventListener("message", (e) => { if (e.data?.type === "p2p-enable" && e.source?.id) p2pClients.add(e.source.id); });

const TYPES = { mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", webm: "video/webm", mkv: "video/x-matroska", mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav", ogg: "audio/ogg" };

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET" || !p2pClients.has(e.clientId)) return;
  const url = new URL(req.url);
  const m = /^\/api\/drives\/([^/]+)\/fs\/stream$/.exec(url.pathname);
  if (!m || url.searchParams.has("via") || !url.searchParams.get("path")) return;
  e.respondWith(p2pOrNetwork(e, decodeURIComponent(m[1]), url.searchParams.get("path")));
});

async function p2pOrNetwork(e, driveId, path) {
  const client = await self.clients.get(e.clientId);
  if (!client) return fetch(e.request);
  const r = /bytes=(\d+)-(\d*)/.exec(e.request.headers.get("range") || "");
  const start = r ? Number(r[1]) : 0;
  const end = r && r[2] ? Number(r[2]) : null;
  const ch = new MessageChannel();
  const answer = await new Promise((resolve) => {
    const t = setTimeout(() => resolve({ ok: false }), 9000); // the page opens the direct path (≤ ~8 s) or says no
    ch.port1.onmessage = (ev) => { clearTimeout(t); resolve(ev.data); };
    client.postMessage({ type: "p2p-range", driveId, path, start, end }, [ch.port2]);
  });
  if (!answer.ok) return fetch(e.request);
  const last = end === null ? answer.size - 1 : Math.min(end, answer.size - 1);
  const ext = (path.split(".").pop() || "").toLowerCase();
  const headers = {
    "Accept-Ranges": "bytes",
    "Content-Length": String(last - start + 1),
    "Content-Type": TYPES[ext] || "application/octet-stream",
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
  };
  if (r) headers["Content-Range"] = `bytes ${start}-${last}/${answer.size}`;
  return new Response(answer.stream, { status: r ? 206 : 200, headers });
}
