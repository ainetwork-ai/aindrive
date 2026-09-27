/**
 * Verification of tokens AIN SSO sends TO aindrive, mirroring the AIN SSO
 * SDK (`verifyAdapterRequest`, `verifyBackchannelLogoutToken`):
 *
 *  - adapter request JWT (adapter-protocol §3): typ `ain-adapter+jwt`,
 *    iss, aud = our client_id, exp − iat ≤ 60 s and age ≤ 60 s, bound to the
 *    request by htm (method), htu (public URL, no query) and bsh (SHA-256 of
 *    the raw body), single-use jti;
 *  - back-channel logout token (OIDC Back-Channel Logout 1.0 §2.6): typ
 *    `logout+jwt`, iss, aud, iat freshness, the backchannel-logout `events`
 *    member, no nonce, sid and/or sub, single-use jti.
 *
 * Replay: jti values are remembered in SQLite (sso_replay), shared by every
 * request handler of this single-process server and kept across restarts.
 */
import { createHash } from "node:crypto";
import { errors as joseErrors, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";
import { z } from "zod";
import { AdapterError, checkAndStoreJti, type DesiredUserState } from "./store.js";
import { SSO_ALGORITHMS } from "./oidc";

export const ADAPTER_TOKEN_TYPE = "ain-adapter+jwt";
export const ADAPTER_TOKEN_MAX_LIFETIME = 60;
export const LOGOUT_TOKEN_TYPE = "logout+jwt";
export const BACKCHANNEL_LOGOUT_EVENT = "http://schemas.openid.net/event/backchannel-logout";
const CLOCK_TOLERANCE = 5;

/** base64url(SHA-256(body)); the empty body hashes too. */
export function bodyHash(body: Uint8Array | string | null | undefined): string {
  return createHash("sha256").update(body ?? "").digest("base64url");
}

/** Canonical htu: absolute URL without query and fragment. */
export function htuOf(url: string): string {
  const u = new URL(url);
  u.search = "";
  u.hash = "";
  return u.href;
}

const invalidToken = (message: string) => new AdapterError("invalid_token", 401, message, false);

// ── DesiredUserState (ain-sso.adapter.v1; @ain-sso/contracts adapter.ts) ──

const desiredUserState = z.object({
  schema: z.literal("ain-sso.adapter.v1"),
  sub: z.string().min(1).max(255),
  org: z.object({ id: z.string().min(1).max(255), slug: z.string(), name: z.string() }),
  version: z.number().int().positive(),
  status: z.enum(["active", "suspended", "deprovisioned"]),
  profile: z.object({ name: z.string().nullable(), email: z.string().nullable(), workEmail: z.string().nullable() }),
  appRole: z.string().nullable(),
  groups: z.array(z.object({ id: z.string(), slug: z.string(), name: z.string(), kind: z.enum(["team", "department", "access", "mail"]) })),
  legacyUserId: z.string().nullable(),
  ownershipTransferTo: z.string().nullable(),
  issuedAt: z.string(),
}); // zod strips unknown fields: forward compatible within v1 (§4.1)

export type VerifiedAdapterRequest = { claims: JWTPayload; state: DesiredUserState | null };

/**
 * adapter-protocol §3.2, all steps. Throws AdapterError: 401 invalid_token /
 * missing_token (no side effects, the jti is only consumed after every other
 * check passed), 400 invalid_request for a bad body, 503 when the JWKS is
 * unreachable.
 */
export async function verifyAdapterRequest(opts: {
  method: string;
  /** The URL AIN SSO signed: our public adapter base + route path. */
  expectedUrl: string;
  authorization: string | null;
  body: Uint8Array | null;
  issuer: string;
  audience: string;
  keys: JWTVerifyGetKey;
  now?: Date;
}): Promise<VerifiedAdapterRequest> {
  const m = opts.authorization ? /^Bearer[ ]+([A-Za-z0-9._~+/=-]+)$/i.exec(opts.authorization.trim()) : null;
  if (!m) throw new AdapterError("missing_token", 401, "Bearer token required.", false);
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(m[1], opts.keys, {
      issuer: opts.issuer,
      audience: opts.audience,
      algorithms: SSO_ALGORITHMS,
      typ: ADAPTER_TOKEN_TYPE,
      clockTolerance: CLOCK_TOLERANCE,
      currentDate: opts.now,
      maxTokenAge: ADAPTER_TOKEN_MAX_LIFETIME,
      requiredClaims: ["iat", "exp", "jti", "htm", "htu", "bsh"],
    }));
  } catch (err) {
    if (err instanceof joseErrors.JWKSTimeout) throw new AdapterError("temporarily_unavailable", 503, "Could not fetch the JWKS in time.", true);
    if (err instanceof joseErrors.JOSEError) throw invalidToken(`Token rejected: ${err.code}.`);
    throw err;
  }
  for (const k of ["jti", "htm", "htu", "bsh"] as const) {
    const v = payload[k];
    if (typeof v !== "string" || v.length === 0 || v.length > 2048) throw invalidToken(`Claim ${k} is invalid.`);
  }
  if ((payload.exp as number) - (payload.iat as number) > ADAPTER_TOKEN_MAX_LIFETIME) throw invalidToken("Token lifetime exceeds 60 seconds.");
  if (payload.htm !== opts.method.toUpperCase()) throw invalidToken("Token is bound to another HTTP method.");
  let same = false;
  try { same = htuOf(payload.htu as string) === htuOf(opts.expectedUrl); } catch { same = false; }
  if (!same) throw invalidToken("Token is bound to another URL.");
  if (payload.bsh !== bodyHash(opts.body)) throw invalidToken("Token is bound to another body.");

  // Replay check last, so malformed or mismatched requests never consume an identifier.
  if (!checkAndStoreJti(`adapter\u0000${payload.iss}\u0000${payload.jti}`, ((payload.exp as number) + CLOCK_TOLERANCE) * 1000)) {
    throw invalidToken("Token was already used.");
  }

  let state: DesiredUserState | null = null;
  if (opts.body && opts.body.length > 0) {
    let parsed: unknown;
    try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(opts.body)); } catch {
      throw new AdapterError("invalid_request", 400, "Body is not UTF-8 JSON.", false);
    }
    const r = desiredUserState.safeParse(parsed);
    if (!r.success) {
      const first = r.error.issues[0];
      throw new AdapterError("invalid_request", 400, `Body is not a valid DesiredUserState${first ? ` (${first.path.join(".")}: ${first.message})` : ""}.`, false);
    }
    state = r.data as DesiredUserState;
  }
  return { claims: payload, state };
}

export class LogoutTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LogoutTokenError";
  }
}

export type VerifiedLogoutToken = { iss: string; sub: string | null; sid: string | null; jti: string };

export async function verifyLogoutToken(token: string, opts: { issuer: string; audience: string; keys: JWTVerifyGetKey; now?: Date; maxAgeSeconds?: number }): Promise<VerifiedLogoutToken> {
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, opts.keys, {
      issuer: opts.issuer,
      audience: opts.audience,
      algorithms: SSO_ALGORITHMS,
      typ: LOGOUT_TOKEN_TYPE,
      clockTolerance: CLOCK_TOLERANCE,
      currentDate: opts.now,
      maxTokenAge: opts.maxAgeSeconds ?? 120,
      requiredClaims: ["iat", "exp", "jti", "events"],
    }));
  } catch (err) {
    // A JWKS timeout is transient (the provider retries): not "invalid".
    if (err instanceof joseErrors.JOSEError && !(err instanceof joseErrors.JWKSTimeout)) throw new LogoutTokenError(`logout token rejected: ${err.code}`);
    throw err;
  }
  const events = payload.events;
  if (!events || typeof events !== "object" || Array.isArray(events)) throw new LogoutTokenError("events claim missing");
  const member = (events as Record<string, unknown>)[BACKCHANNEL_LOGOUT_EVENT];
  if (!member || typeof member !== "object" || Array.isArray(member)) throw new LogoutTokenError("not a back-channel logout event");
  // A nonce marks an ID token; accepting one here would let an ID token pass as a logout token.
  if ("nonce" in payload) throw new LogoutTokenError("logout token must not contain nonce");
  const sub = typeof payload.sub === "string" && payload.sub.length > 0 ? payload.sub : null;
  const sid = typeof payload.sid === "string" && payload.sid.length > 0 ? payload.sid : null;
  if (!sub && !sid) throw new LogoutTokenError("logout token needs sub or sid");
  if (typeof payload.jti !== "string" || payload.jti.length === 0 || payload.jti.length > 512) throw new LogoutTokenError("invalid jti");
  if (!checkAndStoreJti(`logout\u0000${payload.iss}\u0000${payload.jti}`, ((payload.exp as number) + CLOCK_TOLERANCE) * 1000)) {
    throw new LogoutTokenError("logout token replayed");
  }
  return { iss: payload.iss as string, sub, sid, jti: payload.jti };
}
