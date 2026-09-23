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

async function request<T>(server: string, method: string, path: string, body: unknown, cookie?: string): Promise<T> {
  // The server authenticates by cookie only (web/lib/session.ts). fetch()
  // silently drops a hand-written `Cookie` header, so put the session in the
  // native cookie jar and let CapacitorHttp attach it.
  if (cookie) {
    await CapacitorCookies.setCookie({ url: server, key: "aindrive_session", value: cookie });
  }
  const res = await fetch(server + path, {
    method,
    headers: { "content-type": "application/json" },
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

/** Delete the server-side drive (creator only). 404 is treated as already gone. */
export async function deleteDrive(server: string, sessionCookie: string, driveId: string): Promise<void> {
  try {
    await request<unknown>(server, "DELETE", `/api/drives/${encodeURIComponent(driveId)}`, undefined, sessionCookie);
  } catch (e) {
    if (!/→ 404:/.test(e instanceof Error ? e.message : String(e))) throw e;
  }
}
