/**
 * aindrive server calls used during pairing.
 * Mirrors cli/src/commands/login.js and cli/src/commands/serve.js — same
 * endpoints, same single-use 10-minute pairing link.
 */
import { CapacitorCookies } from "@capacitor/core";

export interface CliStart {
  linkId: string;
  deviceSecret: string;
}

export interface DrivePair {
  driveId: string;
  agentToken: string;
  driveSecret: string;
  serverUrl?: string;
  url?: string;
}

export function normalizeServer(raw: string): string {
  let s = raw.trim();
  if (!s) throw new Error("Enter a server address");
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  return s.replace(/\/+$/, "");
}

async function post<T>(server: string, path: string, body: unknown, cookie?: string): Promise<T> {
  return request<T>(server, "POST", path, body, cookie);
}

export async function request<T>(server: string, method: string, path: string, body: unknown, cookie?: string, extraHeaders?: Record<string, string>): Promise<T> {
  // The server authenticates by cookie only (web/lib/session.ts). fetch()
  // silently drops a hand-written `Cookie` header, so put the session in the
  // native cookie jar and let CapacitorHttp attach it.
  if (cookie) {
    await CapacitorCookies.setCookie({ url: server, key: "aindrive_session", value: cookie });
  }
  const res = await fetch(server + path, {
    method,
    headers: { "content-type": "application/json", ...extraHeaders },
    body: body === undefined ? undefined : JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = text;
    let parsed: { error?: string; limit?: number; current?: number } | null = null;
    try { parsed = JSON.parse(text); msg = parsed?.error || text; } catch { /* plain text */ }
    // Each shared folder is its own drive, so the per-account drive cap is
    // the one limit a phone user hits by accident. Say what to do about it.
    if (res.status === 429 && parsed?.error === "drive_limit_reached") {
      throw new Error(
        `This account already has ${parsed.current ?? "the maximum number of"} drives (limit ${parsed.limit ?? "reached"}). ` +
        "Delete drives you no longer use — Remove folder here deletes its drive, or use Manage → Payments → Delete drive on the web.",
      );
    }
    throw new Error(`${path} → ${res.status}: ${msg}`);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

/** A binary GET (a thumbnail) as an object URL, with the session cookie like request(). */
export async function requestBlobUrl(server: string, path: string, cookie?: string): Promise<string> {
  if (cookie) await CapacitorCookies.setCookie({ url: server, key: "aindrive_session", value: cookie });
  const res = await fetch(server + path);
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  const blob = await res.blob();
  if (!blob.size) throw new Error(`${path} → empty`);
  return URL.createObjectURL(blob);
}

export function startCliLogin(server: string): Promise<CliStart> {
  return post<CliStart>(server, "/api/auth/cli/start", {});
}

/** 202 = still waiting, 410 = link dead, 200 = approved. */
export async function pollCliLogin(
  server: string,
  linkId: string,
  deviceSecret: string,
): Promise<{ token: string; email?: string } | null> {
  const res = await fetch(server + "/api/auth/cli/poll", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ linkId, deviceSecret }),
  });
  if (res.status === 202) return null;
  const text = await res.text();
  if (res.status === 410) throw new Error("The login link has expired or was already used");
  if (!res.ok) throw new Error(`poll → ${res.status}: ${text}`);
  const { token, user } = JSON.parse(text);
  if (!token) throw new Error("The server did not return a session token");
  return { token, email: user?.email };
}

export function pairDrive(server: string, sessionCookie: string, name: string): Promise<DrivePair> {
  return post<DrivePair>(server, "/api/drives", { name }, sessionCookie);
}

/** Mint a viewer link for a path in the drive (editor+). Returns the public URL. */
export async function createShare(server: string, sessionCookie: string, driveId: string, path: string): Promise<{ url: string; token: string }> {
  return post<{ url: string; token: string }>(server, `/api/drives/${encodeURIComponent(driveId)}/shares`, { path, role: "viewer" }, sessionCookie);
}

/** Delete the server-side drive (creator only). 404 is treated as already gone. */
export async function deleteDrive(server: string, sessionCookie: string, driveId: string): Promise<void> {
  try {
    await request<unknown>(server, "DELETE", `/api/drives/${encodeURIComponent(driveId)}`, undefined, sessionCookie);
  } catch (e) {
    if (!/→ 404:/.test(e instanceof Error ? e.message : String(e))) throw e;
  }
}

// ---------------------------------------------------------------- other devices (same account)

export interface RemoteDrive { id: string; name: string; hostname: string | null; online: boolean; lastSeenAt?: string | null; owned?: boolean }

/** Every drive this account owns — the ones served by THIS phone and by any other device. */
export async function listDrives(server: string, sessionCookie: string): Promise<RemoteDrive[]> {
  const r = await request<{ drives: RemoteDrive[] }>(server, "GET", "/api/drives", undefined, sessionCookie);
  return r.drives;
}

export interface RemoteEntry { name: string; path: string; isDir: boolean; size: number; mtimeMs: number; mime?: string }

export async function remoteList(server: string, sessionCookie: string, driveId: string, path: string): Promise<RemoteEntry[]> {
  const r = await request<{ entries: RemoteEntry[] }>(server, "GET", `/api/drives/${encodeURIComponent(driveId)}/fs/list?path=${encodeURIComponent(path)}`, undefined, sessionCookie);
  return r.entries;
}

/** File bytes from another device, via the server relay (capped by the agent's 8 MiB read limit). */
export async function remoteRead(server: string, sessionCookie: string, driveId: string, path: string): Promise<{ base64: string; mime: string }> {
  const r = await request<{ content: string; encoding: string; mime: string }>(server, "GET", `/api/drives/${encodeURIComponent(driveId)}/fs/read?path=${encodeURIComponent(path)}&encoding=base64`, undefined, sessionCookie);
  return { base64: r.content, mime: r.mime };
}

/**
 * The agent on another device is reached through the web's agent-ask, which
 * needs an agent record on that drive. Phones ignore the record's LLM
 * settings (they run their own recogniser), so any valid provider will do.
 */
export async function ensureRemoteAgent(server: string, sessionCookie: string, driveId: string): Promise<string> {
  const list = await request<{ agents: { id: string; name: string }[] }>(server, "GET", `/api/drives/${encodeURIComponent(driveId)}/agents`, undefined, sessionCookie);
  const mine = list.agents.find((a) => a.name === "Phone agent") ?? list.agents[0];
  if (mine) return mine.id;
  const made = await post<{ agent: { id: string } }>(server, `/api/drives/${encodeURIComponent(driveId)}/agents`, {
    name: "Phone agent",
    description: "Finds files on this device by asking — photos by what they show, recordings by what was said.",
    knowledge: { strategy: "dump-all-text" },
    llm: { provider: "openai", model: "on-device" },
  }, sessionCookie);
  return made.agent.id;
}

export interface RemoteAsk {
  answer: string;
  sources: { path: string; snippet: string; matchedBy?: string }[];
  action?: { type: string; folder?: string; copied?: number; failed?: number; share?: boolean; skipped?: boolean; reason?: string };
}

/** `askId`: one id for every drive asked the same question — the server charges it as one ask (web/lib/ask-fanout.ts). */
export function askRemote(server: string, sessionCookie: string, driveId: string, agentId: string, q: string, askId?: string): Promise<RemoteAsk> {
  return request<RemoteAsk>(server, "POST", `/api/drives/${encodeURIComponent(driveId)}/agents/${encodeURIComponent(agentId)}/ask`, { q }, sessionCookie,
    askId ? { "x-aindrive-ask": askId } : undefined);
}
