/**
 * Remote drives in Finder: a WebDAV server on 127.0.0.1 that main.js mounts as
 * /Volumes/aindrive. The volume holds one folder per drive this Mac doesn't
 * serve itself (the phone's folders, drives shared with you); its files are
 * read and written through the aindrive server's fs/* routes, with the app's
 * session — so roles and paywalls apply exactly as on the web.
 *
 * No Electron here: the server API is injected (`api`, see below) so this is
 * unit-tested with a fake. Finder quirks handled here:
 *   - it mounts read-only unless the server does class-2 locking → LOCK/UNLOCK
 *     are answered (advisory, in memory);
 *   - it writes .DS_Store and AppleDouble "._name" files next to everything →
 *     kept in memory for this session, never sent to a drive;
 *   - it spells Korean (and other) names in NFD → paths go out in NFC, which
 *     is how drives name them.
 *
 * Only a request that carries the random `token` as the first path segment is
 * served; the socket listens on loopback only.
 */
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";

/**
 * @typedef {{ id: string, name: string, hostname?: string | null, online?: boolean }} RemoteDrive
 * @typedef {{ name: string, isDir: boolean, size?: number, mtimeMs?: number, mime?: string }} Entry
 * @typedef {{ status: number, headers?: Record<string, string>, body?: AsyncIterable<Uint8Array> | null }} Bytes
 * @typedef {{
 *   drives(): Promise<RemoteDrive[]>,
 *   list(driveId: string, path: string): Promise<Entry[]>,
 *   read(driveId: string, path: string, range?: string): Promise<Bytes>,
 *   write(driveId: string, path: string, body: AsyncIterable<Uint8Array>, length?: number): Promise<void>,
 *   mkdir(driveId: string, path: string): Promise<void>,
 *   remove(driveId: string, path: string): Promise<void>,
 *   rename(driveId: string, from: string, to: string): Promise<void>,
 * }} DriveApi
 * An API call that fails throws an Error with `status` (the server's HTTP status).
 */

const LIST_TTL_MS = 3_000;
const DRIVES_TTL_MS = 10_000;
/** Finder's own bookkeeping files: never a drive's business. */
const isJunk = (name) => name === ".DS_Store" || name.startsWith("._") || name === ".localized" || name === ".TemporaryItems" || name === ".Trashes" || name === ".fseventsd" || name === ".metadata_never_index";

/** A folder name for a drive in the volume: its name, and the device it lives on. */
export function driveFolderName(d) {
  const clean = (s) => String(s ?? "").normalize("NFC").replace(/[/:]/g, "-").replace(/^\.+/, "").trim();
  const name = clean(d.name) || d.id;
  const host = clean(d.hostname);
  return host ? `${name} (${host})` : name;
}

/**
 * @param {{ api: DriveApi, excludeIds?: () => Set<string>, token?: string, volume?: string, log?: (m: string) => void }} o
 */
export function createDavServer({ api, excludeIds = () => new Set(), token = randomBytes(24).toString("base64url"), volume = "aindrive", log = () => {} }) {
  const base = `/${token}/${volume}/`;
  /** @type {Map<string, { at: number, entries: Entry[] }>} */
  const listings = new Map();
  let driveCache = { at: 0, map: /** @type {Map<string, RemoteDrive>} */ (new Map()) };
  /** Finder's files, per full path, for this session only. */
  const junk = new Map();
  const locks = new Map();

  async function driveMap() {
    if (Date.now() - driveCache.at < DRIVES_TTL_MS) return driveCache.map;
    const skip = excludeIds();
    const map = new Map();
    for (const d of await api.drives()) {
      if (skip.has(d.id)) continue;
      let name = driveFolderName(d);
      for (let n = 2; map.has(name); n++) name = `${driveFolderName(d)} ${n}`;
      map.set(name, d);
    }
    driveCache = { at: Date.now(), map };
    return map;
  }

  async function list(drive, path) {
    const key = `${drive.id}|${path}`;
    const hit = listings.get(key);
    if (hit && Date.now() - hit.at < LIST_TTL_MS) return hit.entries;
    let entries;
    try { entries = await api.list(drive.id, path); }
    catch (e) {
      // An offline device: its folder is there, empty, rather than an error dialog on every look.
      if (!path && [502, 503, 504].includes(e.status)) entries = [];
      else throw e;
    }
    entries = entries.filter((e) => !isJunk(e.name)).map((e) => ({ ...e, name: e.name.normalize("NFC") }));
    listings.set(key, { at: Date.now(), entries });
    return entries;
  }
  const forget = (drive, path) => { listings.delete(`${drive.id}|${path}`); listings.delete(`${drive.id}|${parentOf(path)}`); };

  /** URL path → where it points: the volume root, a drive's folder, or a path inside a drive. */
  async function resolve(urlPath) {
    if (!urlPath.startsWith(base) && urlPath !== base.slice(0, -1)) return null;
    const rest = urlPath.slice(base.length).split("/").filter(Boolean).map((s) => decodeURIComponent(s).normalize("NFC"));
    if (!rest.length) return { kind: "root" };
    const drive = (await driveMap()).get(rest[0]);
    const path = rest.slice(1).join("/");
    const name = rest[rest.length - 1];
    return { kind: drive ? "drive" : "none", drive, driveName: rest[0], path, name, junk: rest.length > 1 && isJunk(name) };
  }

  /** The entry at a path inside a drive (null: not there), from its parent's listing. */
  async function stat(drive, path) {
    if (!path) return { name: "", isDir: true };
    const entries = await list(drive, parentOf(path));
    return entries.find((e) => e.name === lastOf(path)) ?? null;
  }

  // ── responses ──
  const send = (res, status, body = "", headers = {}) => {
    res.writeHead(status, { "content-length": Buffer.byteLength(body), ...headers });
    res.end(body);
  };
  const fail = (res, e) => {
    const status = e?.status && e.status >= 400 && e.status < 600 ? e.status : 502;
    log(`dav: ${status} ${e?.message ?? e}`);
    // 402 (paid, not bought) reads to Finder as "no permission"
    send(res, status === 402 ? 403 : status);
  };
  const href = (parts, dir) => base + parts.map((p) => encodeURIComponent(p)).join("/") + (dir && parts.length ? "/" : "");
  const propResponse = (parts, e) => {
    const dir = e.isDir;
    const mtime = new Date(e.mtimeMs ?? Date.now()).toUTCString();
    return `<D:response><D:href>${xml(href(parts, dir))}</D:href><D:propstat><D:prop>`
      + `<D:displayname>${xml(parts[parts.length - 1] ?? volume)}</D:displayname>`
      + `<D:resourcetype>${dir ? "<D:collection/>" : ""}</D:resourcetype>`
      + (dir ? "" : `<D:getcontentlength>${e.size ?? 0}</D:getcontentlength><D:getcontenttype>${xml(e.mime && e.mime !== "folder" ? e.mime : "application/octet-stream")}</D:getcontenttype>`)
      + `<D:getlastmodified>${mtime}</D:getlastmodified><D:creationdate>${new Date(e.mtimeMs ?? Date.now()).toISOString()}</D:creationdate>`
      + `<D:getetag>"${(e.size ?? 0).toString(16)}-${Math.floor(e.mtimeMs ?? 0).toString(16)}"</D:getetag>`
      + `<D:supportedlock><D:lockentry><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockentry></D:supportedlock>`
      + `</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`;
  };
  const multistatus = (res, parts) => send(res, 207, `<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:">${parts.join("")}</D:multistatus>`, { "content-type": "application/xml; charset=utf-8" });

  async function propfind(req, res, at, urlParts) {
    const depth = req.headers.depth === "0" ? 0 : 1;
    const out = [];
    if (at.kind === "root") {
      out.push(propResponse([], { name: volume, isDir: true }));
      if (depth) for (const name of (await driveMap()).keys()) out.push(propResponse([name], { name, isDir: true }));
      return multistatus(res, out);
    }
    if (at.kind === "none") return send(res, 404);
    const self = at.junk ? junkEntry(urlParts) : await stat(at.drive, at.path);
    if (!self) return send(res, 404);
    out.push(propResponse(urlParts, self));
    if (depth && self.isDir) {
      for (const e of await list(at.drive, at.path)) out.push(propResponse([...urlParts, e.name], e));
      for (const [k, v] of junk) if (parentOf(k) === urlParts.join("/")) out.push(propResponse(k.split("/"), { name: lastOf(k), isDir: false, size: v.length, mtimeMs: Date.now() }));
    }
    return multistatus(res, out);
  }
  const junkEntry = (parts) => { const b = junk.get(parts.join("/")); return b ? { name: lastOf(parts.join("/")), isDir: false, size: b.length } : null; };

  async function handle(req, res) {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    // A request from a web page (DNS rebinding) names another host.
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host ?? "")) return send(res, 403);
    if (req.method === "OPTIONS") return send(res, 200, "", { dav: "1, 2", allow: "OPTIONS, PROPFIND, PROPPATCH, GET, HEAD, PUT, DELETE, MKCOL, MOVE, COPY, LOCK, UNLOCK", "ms-author-via": "DAV" });
    const at = await resolve(url.pathname);
    if (!at) return send(res, 404);
    const urlParts = at.kind === "root" ? [] : [at.driveName, ...(at.path ? at.path.split("/") : [])];
    const key = urlParts.join("/");
    const readOnlyTop = at.kind === "root" || (at.kind === "drive" && !at.path);

    switch (req.method) {
      case "PROPFIND": await drain(req); return propfind(req, res, at, urlParts);
      case "PROPPATCH": {
        // Finder sets its own properties (Finder info, tags); nothing to keep — say yes to each.
        const body = await text(req);
        const names = [...body.matchAll(/<([A-Za-z0-9_-]+:)?([A-Za-z0-9_.-]+)\s*(xmlns(:\w+)?="[^"]*")?\s*\/?>/g)].map((m) => m[2]).filter((n) => !["propertyupdate", "set", "remove", "prop"].includes(n));
        return multistatus(res, [`<D:response><D:href>${xml(href(urlParts, false))}</D:href><D:propstat><D:prop>${names.map((n) => `<D:${n}/>`).join("")}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`]);
      }
      case "LOCK": {
        await drain(req);
        const t = `opaquelocktoken:${randomBytes(16).toString("hex")}`;
        locks.set(key, t);
        const body = `<?xml version="1.0" encoding="utf-8"?><D:prop xmlns:D="DAV:"><D:lockdiscovery><D:activelock><D:locktype><D:write/></D:locktype><D:lockscope><D:exclusive/></D:lockscope><D:depth>0</D:depth><D:timeout>Second-600</D:timeout><D:locktoken><D:href>${t}</D:href></D:locktoken></D:activelock></D:lockdiscovery></D:prop>`;
        return send(res, 200, body, { "content-type": "application/xml; charset=utf-8", "lock-token": `<${t}>` });
      }
      case "UNLOCK": locks.delete(key); await drain(req); return send(res, 204);
      case "GET": case "HEAD": {
        if (at.kind !== "drive") return send(res, at.kind === "root" ? 405 : 404);
        if (at.junk) { const b = junk.get(key); return b ? send(res, 200, req.method === "HEAD" ? "" : b, { "content-type": "application/octet-stream" }) : send(res, 404); }
        try {
          if (req.method === "HEAD") {
            const e = await stat(at.drive, at.path);
            if (!e) return send(res, 404);
            res.writeHead(200, e.isDir ? {} : { "content-length": String(e.size ?? 0), "accept-ranges": "bytes" });
            return res.end();
          }
          const r = await api.read(at.drive.id, at.path, req.headers.range);
          const h = {};
          for (const k of ["content-length", "content-range", "accept-ranges"]) if (r.headers?.[k]) h[k] = r.headers[k];
          res.writeHead(r.status, { "content-type": "application/octet-stream", ...h });
          if (!r.body) return res.end();
          for await (const c of r.body) if (!res.write(c)) await new Promise((ok) => res.once("drain", ok));
          return res.end();
        } catch (e) { return res.headersSent ? res.destroy() : fail(res, e); }
      }
      case "PUT": {
        if (readOnlyTop || at.kind !== "drive") { await drain(req); return send(res, 403); }
        if (at.junk) { junk.set(key, Buffer.from(await bytes(req))); return send(res, 201); }
        try {
          const had = await stat(at.drive, at.path).catch(() => null);
          const declared = Number(req.headers["x-expected-entity-length"] ?? req.headers["content-length"]);
          await api.write(at.drive.id, at.path, req, Number.isFinite(declared) ? declared : undefined);
          forget(at.drive, at.path);
          return send(res, had ? 204 : 201);
        } catch (e) { await drain(req).catch(() => {}); return fail(res, e); }
      }
      case "MKCOL": {
        await drain(req);
        if (readOnlyTop || at.kind !== "drive") return send(res, 403);
        try { await api.mkdir(at.drive.id, at.path); forget(at.drive, at.path); return send(res, 201); }
        catch (e) { return fail(res, e); }
      }
      case "DELETE": {
        await drain(req);
        if (readOnlyTop || at.kind !== "drive") return send(res, 403);
        if (at.junk) { junk.delete(key); return send(res, 204); }
        try { await api.remove(at.drive.id, at.path); forget(at.drive, at.path); listings.delete(`${at.drive.id}|${at.path}`); return send(res, 204); }
        catch (e) { return fail(res, e); }
      }
      case "MOVE": case "COPY": {
        await drain(req);
        if (readOnlyTop || at.kind !== "drive") return send(res, 403);
        let dest;
        try { dest = await resolve(new URL(String(req.headers.destination ?? ""), "http://127.0.0.1").pathname); } catch { dest = null; }
        if (!dest || dest.kind !== "drive" || !dest.path) return send(res, 403);
        const destKey = [dest.driveName, ...dest.path.split("/")].join("/");
        if (at.junk || dest.junk) {
          const b = junk.get(key);
          if (b) { junk.set(destKey, b); if (req.method === "MOVE") junk.delete(key); }
          return send(res, 201);
        }
        // Between two drives there is no server-side move: Finder then copies and deletes itself.
        if (dest.drive.id !== at.drive.id) return send(res, 502);
        try {
          const existed = await stat(dest.drive, dest.path).catch(() => null);
          if (existed && req.headers.overwrite === "F") return send(res, 412);
          if (req.method === "MOVE") {
            if (existed) await api.remove(dest.drive.id, dest.path);
            await api.rename(at.drive.id, at.path, dest.path);
          } else {
            const e = await stat(at.drive, at.path);
            if (!e) return send(res, 404);
            if (e.isDir) return send(res, 501);   // folder copy: not over this bridge
            const r = await api.read(at.drive.id, at.path);
            if (r.status >= 400 || !r.body) return send(res, r.status >= 400 ? r.status : 502);
            await api.write(dest.drive.id, dest.path, r.body, e.size);
          }
          forget(at.drive, at.path); forget(dest.drive, dest.path);
          return send(res, existed ? 204 : 201);
        } catch (e) { return fail(res, e); }
      }
      default: await drain(req); return send(res, 405);
    }
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((e) => { log(`dav: ${e?.stack ?? e}`); if (!res.headersSent) send(res, 500); else res.destroy(); });
  });

  return {
    server,
    token,
    /** Listen on loopback; resolves to the URL to mount. */
    listen(port = 0) {
      return new Promise((ok, no) => {
        server.once("error", no);
        server.listen(port, "127.0.0.1", () => ok(`http://127.0.0.1:${/** @type {any} */ (server.address()).port}${base}`));
      });
    },
    close: () => new Promise((ok) => server.close(() => ok(undefined))),
    /** Drop cached listings (a drive went online, sign-in changed). */
    refresh() { listings.clear(); driveCache = { at: 0, map: new Map() }; },
  };
}

function parentOf(p) { const i = p.lastIndexOf("/"); return i < 0 ? "" : p.slice(0, i); }
function lastOf(p) { const i = p.lastIndexOf("/"); return i < 0 ? p : p.slice(i + 1); }
function xml(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
async function bytes(req) { const c = []; for await (const x of req) c.push(x); return Buffer.concat(c); }
async function text(req) { return (await bytes(req)).toString("utf8"); }
async function drain(req) { for await (const _ of req) { /* discard */ } }

/** A Node Readable from any async iterable of bytes (for callers that need .pipe). */
export const readable = (it) => Readable.from(it);
