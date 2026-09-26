import { test } from "node:test";
import assert from "node:assert/strict";
import { createDavServer, driveFolderName } from "../webdav.js";

/** A fake aindrive server: drives with files in memory, errors with a status. */
function fakeApi() {
  const err = (status, m = "x") => Object.assign(new Error(m), { status });
  const drives = [
    { id: "phone", name: "Seoul photos", hostname: "Galaxy S26", online: true },
    { id: "shared", name: "Team", hostname: null, online: true },
    { id: "offline", name: "Old laptop", hostname: "mbp", online: false },
    { id: "mine", name: "This Mac folder", hostname: "this-mac", online: true },
  ];
  /** driveId → path → { data?: Buffer } (no data = folder) */
  const fs = {
    phone: new Map([["trips", {}], ["trips/서울.jpg", { data: Buffer.from("JPEGDATA-0123456789") }], ["notes.md", { data: Buffer.from("# hi") }]]),
    shared: new Map([["readme.txt", { data: Buffer.from("read only") }]]),
    offline: new Map(), mine: new Map(),
  };
  const calls = [];
  const need = (d, p) => { const f = fs[d]?.get(p); if (!f) throw err(404); return f; };
  return {
    fs, calls,
    drives: async () => drives,
    list: async (d, path) => {
      calls.push(["list", d, path]);
      if (d === "offline") throw err(503, "device offline");
      if (path && fs[d].get(path)?.data !== undefined) throw err(400);
      if (path && !fs[d].has(path)) throw err(404);
      return [...fs[d]].filter(([p]) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "") === path)
        .map(([p, f]) => ({ name: p.split("/").pop(), isDir: f.data === undefined, size: f.data?.length ?? 0, mtimeMs: 1_700_000_000_000 }));
    },
    read: async (d, path, range) => {
      const data = need(d, path).data;
      const m = /^bytes=(\d+)-(\d*)$/.exec(range ?? "");
      if (m) {
        const a = +m[1], b = m[2] ? +m[2] : data.length - 1, part = data.subarray(a, b + 1);
        return { status: 206, headers: { "content-range": `bytes ${a}-${b}/${data.length}`, "content-length": String(part.length) }, body: [part] };
      }
      return { status: 200, headers: { "content-length": String(data.length) }, body: [data] };
    },
    write: async (d, path, body) => {
      if (d === "shared") throw err(403, "viewer");
      const c = []; for await (const x of body) c.push(Buffer.from(x));
      calls.push(["write", d, path]);
      fs[d].set(path, { data: Buffer.concat(c) });
    },
    mkdir: async (d, path) => { calls.push(["mkdir", d, path]); fs[d].set(path, {}); },
    remove: async (d, path) => { calls.push(["remove", d, path]); need(d, path); for (const k of [...fs[d].keys()]) if (k === path || k.startsWith(path + "/")) fs[d].delete(k); },
    rename: async (d, from, to) => { calls.push(["rename", d, from, to]); const f = need(d, from); fs[d].delete(from); fs[d].set(to, f); },
  };
}

async function start() {
  const api = fakeApi();
  const dav = createDavServer({ api, excludeIds: () => new Set(["mine"]), token: "TKN" });
  const url = await dav.listen();
  const req = (method, path, init = {}) => fetch(url + path, { method, ...init, headers: { ...(init.headers ?? {}) } });
  return { api, dav, url, req };
}
const hrefs = (xml) => [...xml.matchAll(/<D:href>([^<]+)<\/D:href>/g)].map((m) => decodeURIComponent(m[1]));

test("the volume lists remote drives by name and device — never this Mac's own", async () => {
  const { dav, req } = await start();
  try {
    const r = await req("PROPFIND", "", { headers: { depth: "1" } });
    assert.equal(r.status, 207);
    const names = hrefs(await r.text()).map((h) => h.replace("/TKN/aindrive/", ""));
    assert.deepEqual(names.sort(), ["", "Old laptop (mbp)/", "Seoul photos (Galaxy S26)/", "Team/"]);
  } finally { await dav.close(); }
});

test("a folder lists its files; a file is read whole or by range", async () => {
  const { dav, req } = await start();
  try {
    const d = "Seoul%20photos%20(Galaxy%20S26)/";
    const list = await (await req("PROPFIND", d + "trips/", { headers: { depth: "1" } })).text();
    assert.ok(hrefs(list).some((h) => h.endsWith("trips/서울.jpg")));
    assert.match(list, /<D:getcontentlength>19<\/D:getcontentlength>/);
    // Finder sends NFD; the drive's name is NFC
    const nfd = encodeURIComponent("서울.jpg".normalize("NFD"));
    assert.equal(await (await req("GET", d + "trips/" + nfd)).text(), "JPEGDATA-0123456789");
    const part = await req("GET", d + "trips/" + nfd, { headers: { range: "bytes=4-7" } });
    assert.equal(part.status, 206);
    assert.equal(await part.text(), "DATA");
    assert.equal((await req("PROPFIND", d + "nope.txt", { headers: { depth: "0" } })).status, 404);
  } finally { await dav.close(); }
});

test("Finder can write: create, overwrite, mkdir, rename, copy, delete", async () => {
  const { api, dav, req } = await start();
  try {
    const d = "Seoul%20photos%20(Galaxy%20S26)/";
    const opts = await req("OPTIONS", d);
    assert.match(opts.headers.get("dav") ?? "", /2/);   // class 2: Finder mounts read-write
    const lock = await req("LOCK", d + "new.txt", { body: "<lockinfo/>" });
    assert.match(lock.headers.get("lock-token") ?? "", /^<opaquelocktoken:/);
    assert.equal((await req("PUT", d + "new.txt", { body: "hello" })).status, 201);
    assert.equal((await req("PUT", d + "new.txt", { body: "hello again" })).status, 204);
    assert.equal(api.fs.phone.get("new.txt").data.toString(), "hello again");
    assert.equal((await req("MKCOL", d + "made")).status, 201);
    assert.equal((await req("MOVE", d + "new.txt", { headers: { destination: `http://127.0.0.1/TKN/aindrive/${d}made/moved.txt` } })).status, 201);
    assert.ok(api.fs.phone.has("made/moved.txt") && !api.fs.phone.has("new.txt"));
    assert.equal((await req("COPY", d + "notes.md", { headers: { destination: `http://127.0.0.1/TKN/aindrive/${d}notes%20copy.md` } })).status, 201);
    assert.equal(api.fs.phone.get("notes copy.md").data.toString(), "# hi");
    assert.equal((await req("DELETE", d + "made")).status, 204);
    assert.ok(!api.fs.phone.has("made/moved.txt"));
  } finally { await dav.close(); }
});

test("Finder's own files stay here; the drive's role and the volume's top level are respected", async () => {
  const { api, dav, req } = await start();
  try {
    const d = "Seoul%20photos%20(Galaxy%20S26)/";
    assert.equal((await req("PUT", d + ".DS_Store", { body: "finder" })).status, 201);
    assert.equal((await req("PUT", d + "._notes.md", { body: "appledouble" })).status, 201);
    assert.equal(await (await req("GET", d + ".DS_Store")).text(), "finder");
    assert.ok(!api.calls.some(([op, , p]) => op === "write" && /DS_Store|^\._/.test(p)));
    assert.ok(hrefs(await (await req("PROPFIND", d, { headers: { depth: "1" } })).text()).some((h) => h.endsWith("/.DS_Store")));
    // a viewer's drive refuses writes; the volume root and a drive's folder can't be written or deleted
    assert.equal((await req("PUT", "Team/x.txt", { body: "no" })).status, 403);
    assert.equal((await req("PUT", "x.txt", { body: "no" })).status, 403);
    assert.equal((await req("DELETE", d)).status, 403);
    // moving between two drives is Finder's copy + delete, not ours
    assert.equal((await req("MOVE", d + "notes.md", { headers: { destination: "http://127.0.0.1/TKN/aindrive/Team/notes.md" } })).status, 502);
  } finally { await dav.close(); }
});

test("an offline device is an empty folder; other token or host is refused", async () => {
  const { dav, url, req } = await start();
  try {
    const r = await req("PROPFIND", "Old%20laptop%20(mbp)/", { headers: { depth: "1" } });
    assert.equal(r.status, 207);
    assert.equal(hrefs(await r.text()).length, 1);
    assert.equal((await fetch(url.replace("/TKN/", "/WRONG/"), { method: "PROPFIND" })).status, 404);
    const u = new URL(url);
    const other = await new Promise((ok) => {
      import("node:http").then(({ request }) => {
        const q = request({ host: "127.0.0.1", port: u.port, path: u.pathname, method: "PROPFIND", headers: { host: "evil.example" } }, (res) => ok(res.statusCode));
        q.end();
      });
    });
    assert.equal(other, 403);
  } finally { await dav.close(); }
});

test("drive folder names are safe path segments", () => {
  assert.equal(driveFolderName({ id: "a", name: "a/b:c", hostname: "host" }), "a-b-c (host)");
  assert.equal(driveFolderName({ id: "a", name: "..hidden", hostname: null }), "hidden");
  assert.equal(driveFolderName({ id: "a1", name: "", hostname: null }), "a1");
});
