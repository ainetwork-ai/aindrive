/**
 * OpenID Connect relying party for AIN SSO: discovery, authorization code +
 * PKCE (S256) + state + nonce, confidential token exchange
 * (client_secret_basic) and ID-token validation against the issuer's JWKS.
 * Same checks as the AIN SSO SDK's `@ain-sso/sdk/rp` (openid-client), written
 * on `jose`, which aindrive already uses. See lib/sso/README.md.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, errors as joseErrors, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";
import type { SsoLoginConfig } from "./config";

/** Asymmetric algorithms only (never `none` or HS*). */
export const SSO_ALGORITHMS = ["RS256", "ES256", "PS256", "EdDSA"];
export const SSO_SCOPE = "openid profile email org";

export type IssuerMetadata = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  end_session_endpoint?: string;
  authorization_response_iss_parameter_supported?: boolean;
};

export class SsoError extends Error {
  constructor(readonly code: string, message?: string) {
    super(message ?? code);
    this.name = "SsoError";
  }
}

// ── Keys ──────────────────────────────────────────────────────────────────

const g = globalThis as unknown as {
  __aindrive_sso_jwks?: Map<string, JWTVerifyGetKey>;
  __aindrive_sso_meta?: Map<string, { meta: IssuerMetadata; at: number }>;
};
const remoteSets = (g.__aindrive_sso_jwks ??= new Map());
const metaCache = (g.__aindrive_sso_meta ??= new Map());

/** One cached remote JWKS per URL; jose refetches on an unknown kid (rotation), rate limited. */
export function remoteJwks(url: string): JWTVerifyGetKey {
  let set = remoteSets.get(url);
  if (!set) {
    set = createRemoteJWKSet(new URL(url), { cooldownDuration: 30_000, cacheMaxAge: 10 * 60_000, timeoutDuration: 5_000 });
    remoteSets.set(url, set);
  }
  return set;
}

/** Tests replace the key source for an issuer's JWKS URL. */
export function setJwksForTests(url: string, keys: JWTVerifyGetKey | null) {
  if (keys) remoteSets.set(url, keys);
  else remoteSets.delete(url);
}

/** Where AIN SSO publishes the keys that sign adapter requests (adapter-protocol §3.2). */
export function adapterJwksUrl(issuer: string): string {
  return `${issuer.replace(/\/+$/, "")}/oidc/jwks`;
}

// ── Discovery ─────────────────────────────────────────────────────────────

const META_TTL_MS = 10 * 60 * 1000;

function endpointOk(raw: unknown, issuer: string): raw is string {
  if (typeof raw !== "string") return false;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" || (u.protocol === "http:" && new URL(issuer).protocol === "http:");
  } catch { return false; }
}

export async function discover(issuer: string, fetchImpl: typeof fetch = fetch): Promise<IssuerMetadata> {
  const cached = metaCache.get(issuer);
  if (cached && Date.now() - cached.at < META_TTL_MS) return cached.meta;
  const res = await fetchImpl(`${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`, {
    headers: { accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) throw new SsoError("discovery_failed", `discovery answered ${res.status}`);
  const meta = (await res.json()) as Partial<IssuerMetadata>;
  // The document must describe exactly the configured issuer (mix-up defence).
  if (meta.issuer !== issuer) throw new SsoError("discovery_failed", "issuer mismatch in discovery");
  for (const k of ["authorization_endpoint", "token_endpoint", "jwks_uri"] as const) {
    if (!endpointOk(meta[k], issuer)) throw new SsoError("discovery_failed", `bad ${k}`);
  }
  if (meta.end_session_endpoint !== undefined && !endpointOk(meta.end_session_endpoint, issuer)) delete meta.end_session_endpoint;
  const out = meta as IssuerMetadata;
  metaCache.set(issuer, { meta: out, at: Date.now() });
  return out;
}

/** Cached metadata only (no network), e.g. for the logout redirect. */
export function cachedMetadata(issuer: string): IssuerMetadata | null {
  return metaCache.get(issuer)?.meta ?? null;
}

export function clearDiscoveryCache() {
  metaCache.clear();
}

// ── Authorization request ─────────────────────────────────────────────────

const b64url = (buf: Buffer) => buf.toString("base64url");
export const randomToken = (bytes = 32) => b64url(randomBytes(bytes));
export const pkceChallenge = (verifier: string) => b64url(createHash("sha256").update(verifier).digest());

export type PendingAuthorization = { state: string; nonce: string; codeVerifier: string; redirectUri: string };

/**
 * `none` — silent check (lib/sso/silent.ts): AIN SSO answers at once, signed
 * in or `login_required`. `create` — OIDC Prompt Create: AIN SSO's sign-up page.
 */
export type SsoPrompt = "none" | "create";
/** `google` — AIN SSO skips its own sign-in page and goes straight to Google. */
export type SsoIdpHint = "google";

export function parsePrompt(raw: string | null | undefined): SsoPrompt | null {
  return raw === "none" || raw === "create" ? raw : null;
}
export function parseIdpHint(raw: string | null | undefined): SsoIdpHint | null {
  return raw === "google" ? raw : null;
}

export function buildAuthorizationUrl(
  meta: IssuerMetadata,
  clientId: string,
  redirectUri: string,
  opts: { prompt?: SsoPrompt | null; idp?: SsoIdpHint | null } = {},
): { url: string; pending: PendingAuthorization } {
  const pending = { state: randomToken(), nonce: randomToken(), codeVerifier: randomToken(48), redirectUri };
  const u = new URL(meta.authorization_endpoint);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", clientId);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("scope", SSO_SCOPE);
  u.searchParams.set("state", pending.state);
  u.searchParams.set("nonce", pending.nonce);
  u.searchParams.set("code_challenge", pkceChallenge(pending.codeVerifier));
  u.searchParams.set("code_challenge_method", "S256");
  if (opts.prompt) u.searchParams.set("prompt", opts.prompt);
  if (opts.idp) u.searchParams.set("ain_idp", opts.idp);
  return { url: u.toString(), pending };
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

// ── Callback: code exchange + ID token ────────────────────────────────────

export type OrgClaim = { id: string; slug: string; name: string; role: string; groups: string[] };

export type SsoIdentity = {
  sub: string;
  name: string | null;
  email: string | null;
  emailVerified: boolean;
  /** Organizations that assign aindrive to this account (scope `org`). */
  orgs: OrgClaim[];
  /** The organization selected at the SSO, only if it is one of `orgs`. */
  activeOrg: string | null;
  /** OIDC session id; the local session is keyed by it for back-channel logout. */
  sid: string | null;
  amr: string[];
};

function parseOrgs(raw: unknown): OrgClaim[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((o) => {
    if (!o || typeof o !== "object") return [];
    const r = o as Record<string, unknown>;
    if (typeof r.id !== "string" || !r.id) return [];
    return [{
      id: r.id,
      slug: typeof r.slug === "string" ? r.slug : "",
      name: typeof r.name === "string" ? r.name : "",
      role: typeof r.role === "string" ? r.role : "",
      groups: Array.isArray(r.groups) ? r.groups.filter((x): x is string => typeof x === "string") : [],
    }];
  });
}

/**
 * ID token validation (OIDC Core §3.1.3.7): signature by the issuer's JWKS
 * with an asymmetric alg, iss, aud ∋ client_id (azp = client_id when present
 * or when there are several audiences), exp/iat, nonce = the one we sent.
 */
export async function validateIdToken(idToken: string, opts: { issuer: string; clientId: string; nonce: string; keys: JWTVerifyGetKey; now?: Date }): Promise<SsoIdentity> {
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(idToken, opts.keys, {
      issuer: opts.issuer,
      audience: opts.clientId,
      algorithms: SSO_ALGORITHMS,
      clockTolerance: 5,
      maxTokenAge: 600,
      currentDate: opts.now,
      requiredClaims: ["sub", "iat", "exp"],
    }));
  } catch (err) {
    if (err instanceof joseErrors.JOSEError) throw new SsoError("invalid_id_token", err.code);
    throw err;
  }
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if ((aud.length > 1 || payload.azp !== undefined) && payload.azp !== opts.clientId) throw new SsoError("invalid_id_token", "azp mismatch");
  if (typeof payload.nonce !== "string" || !safeEqual(payload.nonce, opts.nonce)) throw new SsoError("invalid_id_token", "nonce mismatch");
  if (typeof payload.sub !== "string" || !payload.sub || payload.sub.length > 255) throw new SsoError("invalid_id_token", "bad sub");
  const orgs = parseOrgs(payload.orgs);
  const active = typeof payload.active_org === "string" && orgs.some((o) => o.id === payload.active_org) ? (payload.active_org as string) : null;
  return {
    sub: payload.sub,
    name: typeof payload.name === "string" ? payload.name : null,
    email: typeof payload.email === "string" ? payload.email : null,
    emailVerified: payload.email_verified === true,
    orgs,
    activeOrg: active,
    sid: typeof payload.sid === "string" && payload.sid ? payload.sid : null,
    amr: Array.isArray(payload.amr) ? payload.amr.filter((x): x is string => typeof x === "string") : [],
  };
}

/** The org a session acts for: the SSO's selected org, else the only assigned one, else none (personal). */
export function sessionOrg(identity: Pick<SsoIdentity, "orgs" | "activeOrg">): string | null {
  if (identity.activeOrg) return identity.activeOrg;
  return identity.orgs.length === 1 ? identity.orgs[0].id : null;
}

/**
 * Completes the redirect: RFC 9207 `iss` (required when the issuer
 * advertises it), `state` bound to this browser's pending request, then the
 * code + PKCE verifier are exchanged with client_secret_basic and the ID token
 * is validated. An error response (e.g. access_denied for unassigned users)
 * becomes an SsoError with that code.
 */
export async function completeAuthorization(opts: {
  config: SsoLoginConfig;
  meta: IssuerMetadata;
  params: URLSearchParams;
  pending: PendingAuthorization;
  keys?: JWTVerifyGetKey;
  fetchImpl?: typeof fetch;
  now?: Date;
}): Promise<SsoIdentity> {
  const { config, meta, params, pending } = opts;
  const iss = params.get("iss");
  if (iss !== null && iss !== config.issuer) throw new SsoError("issuer_mismatch");
  if (iss === null && meta.authorization_response_iss_parameter_supported) throw new SsoError("issuer_missing");
  const state = params.get("state");
  if (!state || !safeEqual(state, pending.state)) throw new SsoError("state_mismatch");
  const error = params.get("error");
  if (error) throw new SsoError(/^[a-z_]{1,64}$/.test(error) ? error : "authorization_error");
  const code = params.get("code");
  if (!code) throw new SsoError("missing_code");

  const basic = Buffer.from(`${encodeURIComponent(config.clientId)}:${encodeURIComponent(config.clientSecret)}`).toString("base64");
  const res = await (opts.fetchImpl ?? fetch)(meta.token_endpoint, {
    method: "POST",
    headers: { authorization: `Basic ${basic}`, "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: pending.redirectUri,
      code_verifier: pending.codeVerifier,
    }).toString(),
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok || !body) throw new SsoError("token_exchange_failed", typeof body?.error === "string" ? body.error : `status ${res.status}`);
  if (typeof body.id_token !== "string") throw new SsoError("invalid_response", "no id_token");
  return validateIdToken(body.id_token, {
    issuer: config.issuer,
    clientId: config.clientId,
    nonce: pending.nonce,
    keys: opts.keys ?? remoteJwks(meta.jwks_uri),
    now: opts.now,
  });
}

/** RP-initiated logout URL, when the issuer has an end_session_endpoint. */
export function endSessionUrl(meta: IssuerMetadata | null, clientId: string, postLogoutRedirectUri: string): string | null {
  if (!meta?.end_session_endpoint) return null;
  const u = new URL(meta.end_session_endpoint);
  u.searchParams.set("client_id", clientId);
  u.searchParams.set("post_logout_redirect_uri", postLogoutRedirectUri);
  return u.toString();
}
