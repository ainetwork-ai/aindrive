/**
 * Back-channel logout: a verified logout token (lib/sso/tokens.ts) with a
 * `sid` ends only the aindrive sessions created with that OIDC session; with
 * only `sub` it ends every session of the linked account (epoch bump: browser
 * cookies, CLI/mobile pairing tokens and bearer uses alike). Open
 * collaboration sockets of the ended sessions are closed. A sign-in of that
 * OIDC session (or AIN account) still waiting on /sso/link is cancelled, so it
 * can't be finished after the AIN session ended. Answers 200, or 400 for an
 * invalid token, always `Cache-Control: no-store`.
 */
import type { JWTVerifyGetKey } from "jose";
import { adapterConfig } from "./config";
import { adapterJwksUrl, discover, remoteJwks } from "./oidc";
import { LogoutTokenError, verifyLogoutToken } from "./tokens";
import { audit, cancelPendingLinks, disconnectUserSockets, endAllUserSessions, endSessionsBySid, identityFor } from "./store.js";

const MAX_BODY = 16 * 1024;

function reply(status: number, body?: Record<string, string>) {
  return new Response(body ? JSON.stringify(body) : null, {
    status,
    headers: { "cache-control": "no-store", ...(body ? { "content-type": "application/json" } : {}) },
  });
}

async function logoutKeys(issuer: string): Promise<JWTVerifyGetKey> {
  // Logout tokens are signed with the OIDC keys: the discovered jwks_uri,
  // falling back to AIN SSO's documented {issuer}/oidc/jwks.
  try { return remoteJwks((await discover(issuer)).jwks_uri); } catch { return remoteJwks(adapterJwksUrl(issuer)); }
}

export async function handleBackchannelLogout(req: Request, deps: { keys?: JWTVerifyGetKey; now?: Date } = {}): Promise<Response> {
  const cfg = adapterConfig();
  if (!cfg) return reply(404, { error: "not_found" });
  if (Number(req.headers.get("content-length") ?? "0") > MAX_BODY) return reply(400, { error: "invalid_request", error_description: "body too large" });
  let token: string | null = null;
  try {
    const text = await req.text();
    if (text.length > MAX_BODY) return reply(400, { error: "invalid_request", error_description: "body too large" });
    token = new URLSearchParams(text).get("logout_token");
  } catch {
    return reply(400, { error: "invalid_request" });
  }
  if (!token) return reply(400, { error: "invalid_request", error_description: "logout_token missing" });

  let logout;
  try {
    logout = await verifyLogoutToken(token, { issuer: cfg.issuer, audience: cfg.clientId, keys: deps.keys ?? (await logoutKeys(cfg.issuer)), now: deps.now });
  } catch (err) {
    if (err instanceof LogoutTokenError) return reply(400, { error: "invalid_request", error_description: err.message });
    console.error("[sso] back-channel logout failed:", (err as Error).message);
    return reply(500, { error: "server_error" });
  }

  try {
    if (logout.sid) {
      const ended = endSessionsBySid(cfg.issuer, logout.sid);
      const pendingLinks = cancelPendingLinks(cfg.issuer, { sid: logout.sid });
      if (ended.length) disconnectUserSockets({ sessionIds: ended.map((s) => s.id) });
      audit({ actor: "ain-sso", action: "backchannel_logout", issuer: cfg.issuer, subject: logout.sub, details: { sid: logout.sid, sessionsEnded: ended.length, pendingLinks } });
    } else if (logout.sub) {
      // Pending sign-ins exist precisely while the AIN account is not linked yet.
      const pendingLinks = cancelPendingLinks(cfg.issuer, { sub: logout.sub });
      const ident = identityFor(cfg.issuer, logout.sub);
      if (ident) {
        const ended = endAllUserSessions(ident.user_id, "backchannel_logout");
        disconnectUserSockets({ userId: ident.user_id });
        audit({ actor: "ain-sso", action: "backchannel_logout", issuer: cfg.issuer, subject: logout.sub, userId: ident.user_id, details: { allSessions: true, ssoSessionRows: ended, pendingLinks } });
      } else if (pendingLinks) {
        audit({ actor: "ain-sso", action: "backchannel_logout", issuer: cfg.issuer, subject: logout.sub, details: { allSessions: true, pendingLinks } });
      }
    }
  } catch (err) {
    console.error("[sso] back-channel logout apply failed:", (err as Error).message);
    return reply(500, { error: "server_error" });
  }
  return reply(200);
}
