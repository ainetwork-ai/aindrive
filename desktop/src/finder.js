/**
 * Remote drives in Finder, wiring: the aindrive server's fs/* routes as the
 * DriveApi webdav.js serves (`serverApi`), and mounting that server as
 * /Volumes/aindrive (`mountVolume`, `unmountVolume`). No Electron imports —
 * main.js injects the HTTP call (Electron's net, with the session cookie).
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";

export const MOUNT_POINT = "/Volumes/aindrive";

/**
 * @typedef {(method: string, path: string, o?: { headers?: Record<string, string>, body?: Buffer | AsyncIterable<Uint8Array>, json?: unknown }) =>
 *   Promise<{ status: number, headers: Record<string, string>, body: AsyncIterable<Uint8Array> }>} Request
 * `path` is server-relative (/api/…); the request carries the session.
 */

/** @param {Request} request @returns {import("./webdav.js").DriveApi} */
export function serverApi(request) {
  const d = (id, rest) => `/api/drives/${encodeURIComponent(id)}${rest}`;
  const q = (path) => `?path=${encodeURIComponent(path)}`;
  const text = async (body) => { const c = []; for await (const x of body) c.push(Buffer.from(x)); return Buffer.concat(c).toString("utf8"); };
  async function call(method, path, o) {
    const r = await request(method, path, o);
    if (r.status >= 400) {
      const msg = await text(r.body).catch(() => "");
      throw Object.assign(new Error(`${method} ${path.split("?")[0]} → ${r.status} ${msg.slice(0, 120)}`), { status: r.status });
    }
    return r;
  }
  const json = async (method, path, o) => { const t = await text((await call(method, path, o)).body); return t ? JSON.parse(t) : {}; };
  return {
    drives: async () => (await json("GET", "/api/drives")).drives ?? [],
    list: async (id, path) => (await json("GET", d(id, `/fs/list${q(path)}`))).entries ?? [],
    read: async (id, path, range) => {
      const r = await call("GET", d(id, `/fs/stream${q(path)}`), { headers: range ? { range } : {} });
      return { status: r.status, headers: r.headers, body: r.body };
    },
    write: async (id, path, body, length) => {
      await json("POST", d(id, `/fs/upload${q(path)}`), { body, headers: { "content-type": "application/octet-stream", ...(length !== undefined ? { "x-expected-length": String(length) } : {}) } });
    },
    mkdir: async (id, path) => { await json("POST", d(id, "/fs/mkdir"), { json: { path } }); },
    remove: async (id, path) => { await json("POST", d(id, "/fs/delete"), { json: { path } }); },
    rename: async (id, from, to) => { await json("POST", d(id, "/fs/rename"), { json: { from, to } }); },
  };
}

const run = (cmd, args) => new Promise((ok) => execFile(cmd, args, { timeout: 30_000 }, (e, out, err) => ok({ ok: !e, out: String(out), err: String(err || e?.message || "") })));

/** What is mounted at /Volumes/aindrive now (its URL), or null. */
export async function mountedUrl() {
  const r = await run("/sbin/mount", []);
  const line = r.out.split("\n").find((l) => l.includes(` on ${MOUNT_POINT} (`));
  return line ? line.split(" on ")[0] : null;
}

/** Mount `url` as /Volumes/aindrive (Finder's own WebDAV client, like Go ▸ Connect to Server). */
export async function mountVolume(url) {
  const now = await mountedUrl();
  if (now === url) return true;
  if (now) await unmountVolume();   // a previous run's server, now gone
  const r = await run("/usr/bin/osascript", ["-e", `mount volume "${url.replace(/"/g, "")}"`]);
  return r.ok && (await mountedUrl()) === url;
}

export async function unmountVolume() {
  if (!existsSync(MOUNT_POINT) || !(await mountedUrl())) return;
  const r = await run("/sbin/umount", [MOUNT_POINT]);
  if (!r.ok) await run("/usr/sbin/diskutil", ["unmount", "force", MOUNT_POINT]);
}
