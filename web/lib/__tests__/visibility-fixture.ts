// Shared fixture of visibility-rule.test.ts (names, shared lists) and
// visibility-bytes.test.ts (preview/thumbnail/stream/download) — plan task
// 06.5. Two files, not one: each gets its own worker. On Node 24 (not CI's
// Node 22) better-sqlite3 11 aborts natively when a Statement is collected
// under GC pressure ("Assertion failed: (env) != nullptr" in
// Statement::~Statement) — pre-existing on main, e.g. sso-concurrency.test.ts;
// a smaller worker keeps these files clear of it there too.

/** Cookie store behind the mocked next/headers. */
export const cookieJar = new Map<string, string>();
export const nextHeadersMock = () => ({
  cookies: () => Promise.resolve({
    get: (name: string) => {
      const value = cookieJar.get(name);
      return value === undefined ? undefined : { name, value };
    },
    set: (name: string, value: string) => { cookieJar.set(name, value); },
    delete: (name: string) => { cookieJar.delete(name); },
  }),
});

// The drive's agent: an in-memory tree. It deliberately returns the reserved
// `.aindrive` folder (and a case twin) in listings, as a careless agent could:
// the web must hide it on its own.
export const FILES: Record<string, string> = {
  "pub/a.png": "PNGDATA-a",
  "pub/notes.md": "notes",
  "listed/x.png": "PNGDATA-x", // listed sale: shown locked, not readable
  "hidden/y.png": "PNGDATA-y", // unlisted sale: hidden
  "hidden2.png": "PNGDATA-h2", // unlisted sale on one file: hidden
  "bought/z.png": "PNGDATA-z", // unlisted sale the viewer bought: open
  "top.md": "top",
  ".aindrive/config.json": "{\"driveSecret\":\"s\"}",
  ".AINDRIVE/agents.json": "{}",
};
export const ALL_FILES = Object.keys(FILES);
export const IMAGES = ALL_FILES.filter((p) => p.endsWith(".png"));
export const agentCalls: { method: string; path: string }[] = [];

export function rpcMock() {
  class AgentError extends Error {
    status: number;
    constructor(msg: string, status = 502) { super(msg); this.status = status; }
  }
  const entryOf = (p: string) => {
    const name = p.split("/").pop()!;
    const isDir = !(p in FILES);
    return { name, path: p, isDir, size: isDir ? 0 : FILES[p].length, mtimeMs: 1000, ext: isDir ? "" : name.split(".").pop(), mime: isDir ? "folder" : name.endsWith(".png") ? "image/png" : "text/markdown" };
  };
  const exists = (p: string) => p in FILES || Object.keys(FILES).some((k) => k.startsWith(`${p}/`));
  return {
    AgentError,
    isOnline: () => true,
    callAgent: async (_driveId: string, _secret: string, params: { method: string; path: string; offset?: number; length?: number }) => {
      agentCalls.push({ method: params.method, path: params.path });
      switch (params.method) {
        case "list": {
          const prefix = params.path ? `${params.path}/` : "";
          const names = new Set<string>();
          for (const k of Object.keys(FILES)) if (k.startsWith(prefix)) names.add(k.slice(prefix.length).split("/")[0]);
          return { entries: [...names].sort().map((n) => entryOf(prefix + n)) };
        }
        case "stat": return { entry: exists(params.path) ? entryOf(params.path) : null };
        case "read": {
          if (!(params.path in FILES)) throw new AgentError("ENOENT", 502);
          return { content: FILES[params.path] };
        }
        case "thumbnail": return { data: Buffer.from(`thumb:${params.path}`).toString("base64") };
        case "download-chunk": {
          const buf = Buffer.from(FILES[params.path] ?? "");
          const slice = buf.subarray(params.offset ?? 0, (params.offset ?? 0) + (params.length ?? buf.length));
          return { data: slice.toString("base64"), eof: (params.offset ?? 0) + slice.length >= buf.length };
        }
      }
      throw new AgentError("unsupported", 400);
    },
  };
}

type Db = import("better-sqlite3").Database;

/**
 * d1 (owner1): vic = viewer at the root (bought the unlisted `bought` sale),
 * ed = editor at the root, bob = nothing, grantee = viewer at `pub` plus a
 * stray grant row on `.aindrive`. Sales: `listed` (listed), `hidden`,
 * `hidden2.png`, `bought` (unlisted).
 */
export function seed(db: Db) {
  const u = db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?,?,?,?)");
  for (const id of ["owner1", "vic", "ed", "bob", "grantee"]) u.run(id, `${id}@example.com`, id, "x");
  db.prepare("INSERT INTO drives (id, owner_id, name, agent_token_hash, drive_secret, last_seen_at, created_at) VALUES (?,?,?,?,?,?,?)")
    .run("d1", "owner1", "Team Drive", "h", "s", "2026-09-28 10:00:00", "2026-09-01 00:00:00");
  const m = db.prepare("INSERT INTO drive_members (id, drive_id, user_id, path, role, created_at) VALUES (?,?,?,?,?,?)");
  m.run("m_vic", "d1", "vic", "", "viewer", "2026-09-10 00:00:00");
  m.run("m_ed", "d1", "ed", "", "editor", "2026-09-10 00:00:00");
  m.run("m_g1", "d1", "grantee", "pub", "viewer", "2026-09-10 00:00:00");
  // A grant row on the reserved subtree (never creatable through the API, but a
  // stray row must not surface the name in the shared-file list either).
  m.run("m_g2", "d1", "grantee", ".aindrive", "viewer", "2026-09-11 00:00:00");
  const s = db.prepare("INSERT INTO shares (id, drive_id, path, role, token, price_usdc, currency, listed) VALUES (?,?,?,?,?,?,?,?)");
  s.run("s_listed", "d1", "listed", "viewer", "tok_l", 5, "USDC", 1);
  s.run("s_hidden", "d1", "hidden", "viewer", "tok_h", 5, "USDC", 0);
  s.run("s_hidden2", "d1", "hidden2.png", "viewer", "tok_h2", 5, "USDC", 0);
  s.run("s_bought", "d1", "bought", "viewer", "tok_b", 5, "USDC", 0);
  db.prepare("INSERT INTO payment_receipts (id, drive_id, path, wallet, tx_hash, amount_usdc, currency, network, share_id, account_id) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run("r1", "d1", "bought", "0xabc", "0xtx1", 5, "USDC", "base", "s_bought", "vic");
}

export const ORIGIN = "https://drive.test";
export const ctx = { params: Promise.resolve({ driveId: "d1" }) };
export const get = (route: string, path: string) => new Request(`${ORIGIN}/api/drives/d1/fs/${route}?path=${encodeURIComponent(path)}`);

export async function signInAs(sign: (userId: string) => Promise<string>, userId: string | null) {
  cookieJar.clear();
  if (userId) cookieJar.set("aindrive_session", await sign(userId));
}

type Listed = { name: string; isDir: boolean; locked?: boolean };
type ListRoute = { GET: (req: Request, c: typeof ctx) => Promise<Response> };
/** Walk fs/list from the root as the current cookie: every path the listing shows, and whether it is locked. */
export async function listingView(listRoute: ListRoute): Promise<Map<string, { isDir: boolean; locked: boolean }>> {
  const seen = new Map<string, { isDir: boolean; locked: boolean }>();
  const walk = async (dir: string) => {
    const res = await listRoute.GET(get("list", dir), ctx);
    if (res.status !== 200) return;
    const body = await res.json() as { entries: Listed[] };
    for (const e of body.entries) {
      const p = dir ? `${dir}/${e.name}` : e.name;
      seen.set(p, { isDir: e.isDir, locked: !!e.locked });
      if (e.isDir && !e.locked) await walk(p);
    }
  };
  await walk("");
  return seen;
}
