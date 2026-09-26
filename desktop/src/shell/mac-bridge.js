// The Mac's Capacitor "native bridge", loaded before the mobile shell
// (desktop/scripts/prepare-shell.mjs puts it first in the shell's index.html).
//
// On a phone, Capacitor's native runtime provides plugin headers +
// nativePromise/nativeCallback, and CapacitorHttp routes fetch() through the
// native HTTP stack (no CORS, a real cookie jar). Here the same three things
// are provided over the preload's `__aindriveNative` (IPC to the main process),
// so the shell (mobile/src) runs unchanged: AindriveAgent is the Mac's agent
// (desktop/src/mac-agent.js), and every http(s) fetch goes out from the main
// process with the session cookie, exactly like CapacitorHttp.
(() => {
  const native = window.__aindriveNative;
  if (!native) return;

  const promise = (...names) => names.map((name) => ({ name, rtype: "promise" }));
  const headers = [
    {
      name: "AindriveAgent",
      methods: [
        ...promise("pickFolder", "requestCallLog", "addFiles", "mkdir", "rename", "writeText", "delete", "listFolder",
          "openFile", "readFile", "googleSignIn", "registerHandoffs", "thumbnail", "start", "stop", "status", "reindex",
          "ensureModels", "ask", "removeListener", "removeAllListeners"),
        { name: "addListener", rtype: "callback" },
      ],
    },
    {
      name: "CapacitorCookies",
      methods: promise("getCookies", "setCookie", "deleteCookie", "clearCookies", "clearAllCookies"),
    },
  ];

  // callbackId → { plugin, event, cb }
  const listeners = new Map();
  let nextId = 1;
  native.onEvent((plugin, event, data) => {
    for (const l of listeners.values()) if (l.plugin === plugin && l.event === event) l.cb(data);
  });

  window.CapacitorCustomPlatform = { name: "electron", plugins: {} };
  window.Capacitor = {
    PluginHeaders: headers,
    nativePromise(plugin, method, options) {
      if (method === "removeListener") {
        listeners.delete(options?.callbackId);
        return Promise.resolve();
      }
      if (method === "removeAllListeners") {
        for (const [id, l] of listeners) if (l.plugin === plugin) listeners.delete(id);
        return Promise.resolve();
      }
      return native.call(plugin, method, options ?? {});
    },
    nativeCallback(plugin, method, options, cb) {
      if (method !== "addListener") return Promise.reject(new Error(`${plugin}.${method} is not a callback`));
      const id = String(nextId++);
      listeners.set(id, { plugin, event: options?.eventName, cb });
      return Promise.resolve(id);
    },
  };

  // CapacitorHttp's job: http(s) requests leave from the main process.
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const req = new Request(input, init);
    if (!/^https?:/i.test(req.url)) return originalFetch(input, init);
    const body = req.method === "GET" || req.method === "HEAD" ? undefined : new Uint8Array(await req.arrayBuffer());
    const r = await native.fetch({ url: req.url, method: req.method, headers: [...req.headers.entries()], body: body?.byteLength ? body : undefined });
    const empty = r.status === 204 || r.status === 205 || r.status === 304 || req.method === "HEAD";
    return new Response(empty ? null : r.body, { status: r.status, statusText: r.statusText, headers: r.headers });
  };
})();
