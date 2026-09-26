import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";

/**
 * Connected apps: another app a person uses (e.g. ainmem, a family workspace)
 * whose "spaces" their folders can be shared into — turned on and off per
 * folder from this app's share sheet, on the web and on the phone.
 *
 * The app registers itself on the person's account (POST /api/apps, signed in
 * as them) with a spaces URL and a key. This server then calls the app, never
 * the browser (no CORS on either side):
 *
 *   GET  <spaces_url>?driveId&path   Bearer <key> → { spaces: AppSpace[] }
 *   PUT  <spaces_url>/<spaceId>      Bearer <key>   { driveId, path, shared }
 *
 * The app decides what sharing means on its side; this server only relays,
 * and only for the drive's creator. The URL is fetched server-side, so it must
 * be https on a public address (AINDRIVE_APPS_ALLOW_PRIVATE=1 lifts that for
 * local development).
 */

export interface ConnectedApp {
  id: string;
  name: string;
  origin: string;
}

export interface AppSpace {
  id: string;
  name: string;
  /** what the space belongs to (the app's workspace) */
  group?: string;
  icon?: string | null;
  members?: number;
  /** this folder is shared into the space */
  shared: boolean;
  /** the drive's folders shared into the space ("" = the whole drive) */
  sharedPaths?: string[];
}

type Row = ConnectedApp & { spaces_url: string; app_key: string };

const allowPrivate = () => process.env.AINDRIVE_APPS_ALLOW_PRIVATE === "1";

function privateAddress(ip: string): boolean {
  if (ip.includes(":")) {
    const v = ip.toLowerCase();
    if (v.startsWith("::ffff:")) return privateAddress(v.slice(7));
    return v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80");
  }
  const [a, b] = ip.split(".").map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

/** The spaces URL, if this server may call it. */
export async function checkSpacesUrl(raw: unknown): Promise<URL | string> {
  if (typeof raw !== "string" || raw.length > 500) return "url required";
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "url is not a URL";
  }
  if (u.username || u.password || u.hash) return "url must not carry credentials or a fragment";
  if (allowPrivate()) return u.protocol === "https:" || u.protocol === "http:" ? u : "url must be http(s)";
  if (u.protocol !== "https:") return "url must be https";
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) return "url must be a public address";
  const addrs = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  if (!addrs.length || addrs.some(privateAddress)) return "url must be a public address";
  return u;
}

export function listApps(userId: string): ConnectedApp[] {
  return db
    .prepare("SELECT id, name, origin FROM connected_apps WHERE user_id = ? ORDER BY created_at")
    .all(userId) as ConnectedApp[];
}

function appRow(userId: string, appId: string): Row | null {
  return (db
    .prepare("SELECT id, name, origin, spaces_url, app_key FROM connected_apps WHERE user_id = ? AND id = ?")
    .get(userId, appId) as Row | undefined) ?? null;
}

/** Adds the app to the account, or refreshes it (one row per app origin). */
export function upsertApp(userId: string, input: { name: string; url: URL; key: string }): ConnectedApp {
  const name = input.name.trim().slice(0, 60) || input.url.hostname;
  const origin = input.url.origin;
  db.prepare(
    `INSERT INTO connected_apps (id, user_id, name, origin, spaces_url, app_key) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, origin) DO UPDATE SET name = excluded.name, spaces_url = excluded.spaces_url,
       app_key = excluded.app_key, updated_at = datetime('now')`
  ).run(nanoid(12), userId, name, origin, input.url.toString().replace(/\/+$/, ""), input.key);
  return db.prepare("SELECT id, name, origin FROM connected_apps WHERE user_id = ? AND origin = ?").get(userId, origin) as ConnectedApp;
}

export function removeApp(userId: string, appId: string): boolean {
  return db.prepare("DELETE FROM connected_apps WHERE user_id = ? AND id = ?").run(userId, appId).changes > 0;
}

async function callApp(row: Row, method: "GET" | "PUT", path: string, body?: unknown): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  // re-checked on every call: a name that resolved publicly once may not now
  const ok = await checkSpacesUrl(row.spaces_url);
  if (typeof ok === "string") return { ok: false, status: 502, data: { error: ok } };
  const r = await fetch(`${row.spaces_url}${path}`, {
    method,
    headers: { authorization: `Bearer ${row.app_key}`, accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    redirect: "manual",
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  }).catch((e: Error) => e);
  if (r instanceof Error) return { ok: false, status: 502, data: { error: `${row.name} did not answer` } };
  const data = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: r.ok, status: r.status, data };
}

export interface AppSpaces {
  app: ConnectedApp;
  spaces: AppSpace[];
  error?: string;
}

/** Every connected app's spaces, and whether `path` of `driveId` is shared into each. */
export async function spacesForFolder(userId: string, driveId: string, path: string): Promise<AppSpaces[]> {
  const rows = db
    .prepare("SELECT id, name, origin, spaces_url, app_key FROM connected_apps WHERE user_id = ? ORDER BY created_at")
    .all(userId) as Row[];
  const q = `?${new URLSearchParams({ driveId, path })}`;
  return Promise.all(
    rows.map(async (row) => {
      const app = { id: row.id, name: row.name, origin: row.origin };
      const r = await callApp(row, "GET", q);
      if (!r.ok) return { app, spaces: [], error: String(r.data.error ?? `${row.name} answered ${r.status}`) };
      const spaces = Array.isArray(r.data.spaces) ? (r.data.spaces as AppSpace[]).filter((s) => typeof s?.id === "string" && typeof s?.name === "string") : [];
      return { app, spaces };
    })
  );
}

export async function setFolderShared(
  userId: string,
  appId: string,
  spaceId: string,
  input: { driveId: string; path: string; shared: boolean }
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const row = appRow(userId, appId);
  if (!row) return { ok: false, status: 404, error: "app not connected" };
  const r = await callApp(row, "PUT", `/${encodeURIComponent(spaceId)}`, input);
  return r.ok ? { ok: true } : { ok: false, status: r.status >= 500 ? 502 : r.status, error: String(r.data.error ?? `${row.name} answered ${r.status}`) };
}
