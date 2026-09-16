/**
 * aindrive server calls used during pairing.
 * Mirrors cli/src/commands/login.js and cli/src/commands/serve.js — same
 * endpoints, same single-use 10-minute pairing link.
 */
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
  if (!s) throw new Error("서버 주소를 입력하세요");
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  return s.replace(/\/+$/, "");
}

async function post<T>(server: string, path: string, body: unknown, cookie?: string): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cookie) headers.cookie = `aindrive_session=${cookie}`;
  const res = await fetch(server + path, {
    method: "POST",
    headers,
    body: JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = text;
    try { msg = JSON.parse(text).error || text; } catch { /* plain text */ }
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
  if (res.status === 410) throw new Error("로그인 링크가 만료되었거나 이미 사용되었습니다");
  if (!res.ok) throw new Error(`poll → ${res.status}: ${text}`);
  const { token, user } = JSON.parse(text);
  if (!token) throw new Error("서버가 세션 토큰을 반환하지 않았습니다");
  return { token, email: user?.email };
}

export function pairDrive(server: string, sessionCookie: string, name: string): Promise<DrivePair> {
  return post<DrivePair>(server, "/api/drives", { name }, sessionCookie);
}
