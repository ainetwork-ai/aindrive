/**
 * Origin-side enforcement of resource-scoped delegations (`ain-rdlg+jwt`,
 * AIN SSO docs/specs/wallet-and-delegation.md §5; ain-integration plan task
 * 05, completion criterion G1: the allowed agent reads the one file, another
 * agent, organization or an expired token does not).
 *
 * An agent presents `Authorization: Bearer <ain-rdlg+jwt>` plus proof of
 * possession of the key in `cnf` (`X-AIN-PoP`, below) to fs/read or fs/list.
 * The token is verified against the configured AIN SSO issuer's JWKS
 * (lib/sso/oidc.ts `remoteJwks`, the same key set the ID, adapter and logout
 * tokens use), then the request runs only when ALL THREE hold (§5.4):
 *
 *   1. the user may — `sub` is linked to an aindrive account (`sso_identities`
 *      by (issuer, sub); no link → forbidden) and that account, right now, has
 *      `viewer+` at the path through ownership or a drive_members grant
 *      (`resolveRoleByUser`), with the paid carve-out and the reserved
 *      `.aindrive/` subtree applied as for any read. The grant never widens
 *      what the account may do;
 *   2. the grant names it — `aud` lists this server's public origin, `res`
 *      lists this file's key `${origin}#${driveId}#${sharedFileId}` or the key
 *      of an ANCESTOR folder (up to the drive root) with the action, the token
 *      is unexpired and its `jti` is not revoked (status endpoint, cached ≤ 60 s);
 *   3. the product context allows — aindrive has no per-product rule for a
 *      read; `prd` must be a known product (claims shape) and is otherwise
 *      informational here, as is `agt` (which agent asked): the origin binds
 *      the caller to the KEY in `cnf`, not to the agent name.
 *
 * Folder keys are the only "wildcard": a grant on a folder's key covers every
 * path below it (nearest-ancestor walk, like drive_members inheritance), and
 * the drive root key (`sharedFileId(driveId, "")`, the ref `scope=mine` lists)
 * covers the whole drive. `*` never appears in a resource key.
 *
 * Only `read` and `list` are honoured. `write`/`invoke` in `res[].actions`
 * never authorise a write, delete, share or member change — those routes do
 * not accept the token at all, and this module refuses the action (write via
 * delegation is a later step; see docs/PERMISSIONS.md "Delegated reads").
 *
 * The SDK (`@ain-sso/sdk/delegation`) lives in another repository; this file
 * re-implements `verifyResourceDelegation`, the status client and `mayAct` on
 * `jose`, mirroring packages/contracts/src/delegation.ts. Error bodies use the
 * contract shape (`lib/shared-items.ts` `ErrorBody`): auth_required (bad,
 * expired or unproven token), forbidden (not granted, user may not, revoked),
 * source_offline, temporary_failure. No message ever carries the token.
 */
import {
  calculateJwkThumbprint,
  compactVerify,
  decodeProtectedHeader,
  errors as joseErrors,
  importJWK,
  jwtVerify,
  type JWK,
  type JWTVerifyGetKey,
} from "jose";
import { z } from "zod";
import { adapterConfig, publicBase } from "./sso/config";
import { adapterJwksUrl, remoteJwks } from "./sso/oidc";
import { identityFor, isAccountBlocked } from "./sso/store.js";
import { atLeast, resolveRoleByUser, type Role } from "./access";
import { paidAccessDenial } from "./sale-access.js";
import { isSystemPath } from "@/shared/domain/policy/system-paths";
import { contractPath, sharedFileId, type ErrorCode } from "./shared-items";

// ── Contract (mirror of packages/contracts/src/delegation.ts) ────────────────

export const RESOURCE_DELEGATION_TOKEN_TYPE = "ain-rdlg+jwt";
export const RESOURCE_DELEGATION_MAX_TTL_S = 3600;
/** Proof-of-possession JWS carried in `X-AIN-PoP` (one per request). */
export const POP_HEADER = "x-ain-pop";
export const POP_TOKEN_TYPE = "ain-pop+jwt";
export const POP_WINDOW_S = 60;
/** Only the key types the spec lets a product bind in `cnf` that aindrive proves: EC P-256 and Ed25519. */
export const POP_ALGORITHMS = ["ES256", "EdDSA"];
/** Signing algorithms AIN SSO uses for its tokens (asymmetric only; never `none` or HS*). */
const TOKEN_ALGORITHMS = ["RS256", "ES256", "PS256", "EdDSA"];
const CLOCK_TOLERANCE_S = 5;
/** Actions this origin honours through a delegation today. */
export const DELEGATED_ACTIONS = ["read", "list"] as const;

const issuerUrl = z.string().url().max(512).refine((u) => u.startsWith("https://") || u.startsWith("http://localhost") || u.startsWith("http://127.0.0.1"), "an issuer is an https origin");
const opaqueId = z.string().min(1).max(256).regex(/^[^\s/\\]+$/);

export const resourceAction = z.enum(["read", "list", "write", "invoke"]);
export type ResourceAction = z.infer<typeof resourceAction>;

export const resourceGrant = z.object({
  resource: z.string().min(1).max(1024).refine((r) => !r.includes("*"), "wildcards are not allowed"),
  actions: z.array(resourceAction).min(1).max(4),
}); // strip: see "Reader rule" below
export type ResourceGrant = z.infer<typeof resourceGrant>;

/**
 * Reader rule (contract 1.2, ain-integration docs/20-versioning.md §읽기 규칙):
 * the claims and the status answer are DOCUMENTS this origin reads, so an
 * unknown claim or field is ignored and stripped (RFC 7519 §4: "all claims
 * that are not understood by implementations MUST be ignored") instead of
 * failing every delegation the day AIN SSO adds one. Every KNOWN claim is
 * checked exactly as before: all of them are required, with the same shapes,
 * `exp - iat ≤ 1 h`, no wildcard in `res`, and `cnf` must carry exactly one
 * binding aindrive knows (`jkt` or `jwk`) — a `cnf` with only unknown members,
 * or with both, is refused. This is safe only because a claim that NARROWS
 * authority is never added in a 1.x minor; it comes with a new `typ` (2.0),
 * which `verifyResourceDelegation` refuses (`wrong_type`).
 */
const cnfBinding = z.object({ jkt: z.string().min(16).optional(), jwk: z.record(z.string(), z.unknown()).optional() })
  .refine((c) => (c.jkt === undefined) !== (c.jwk === undefined), "cnf must carry exactly one known key binding (jkt or jwk)")
  .transform((c): { jkt: string } | { jwk: Record<string, unknown> } => (c.jkt !== undefined ? { jkt: c.jkt } : { jwk: c.jwk as Record<string, unknown> }));

export const resourceDelegationClaims = z.object({
  iss: issuerUrl,
  sub: z.string().regex(/^acc_[A-Za-z0-9_-]{8,}$/),
  aud: z.array(issuerUrl).min(1).max(8),
  org: opaqueId.nullable(),
  agt: z.string().min(3).max(1024),
  res: z.array(resourceGrant).min(1).max(64),
  prd: z.enum(["ainteams", "ainmem", "aina", "ainspace", "afan", "aindrive", "ainize", "reference"]),
  cnf: cnfBinding,
  iat: z.number().int().positive(),
  exp: z.number().int().positive(),
  jti: opaqueId,
}).refine((c) => c.exp > c.iat && c.exp - c.iat <= RESOURCE_DELEGATION_MAX_TTL_S, { message: `exp - iat must be within ${RESOURCE_DELEGATION_MAX_TTL_S}s`, path: ["exp"] });
export type ResourceDelegationClaims = z.infer<typeof resourceDelegationClaims>;

export const resourceDelegationStatus = z.object({ jti: opaqueId, revoked: z.boolean(), checkedAt: z.string() }); // strip (reader rule)
export type ResourceDelegationStatus = z.infer<typeof resourceDelegationStatus>;

const KNOWN_CLAIMS = new Set(Object.keys(resourceDelegationClaims.innerType().shape));
const KNOWN_GRANT = new Set(Object.keys(resourceGrant.shape));
const KNOWN_CNF = new Set(["jkt", "jwk"]);
const KNOWN_STATUS = new Set(Object.keys(resourceDelegationStatus.shape));
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
/** A key as it may appear in a log line: names only, bounded, never a value. */
const safeKey = (k: string) => k.replace(/[^A-Za-z0-9_#$.-]/g, "?").slice(0, 64);

/**
 * The paths (never the values) a reader dropped: top-level claims, members of
 * `cnf` and of each `res[i]` grant, or status fields. Used only to log that the
 * issuer is newer than this reader (reader rule 5).
 */
export function unknownDelegationPaths(kind: "claims" | "status", input: unknown): string[] {
  if (!isObj(input)) return [];
  const out: string[] = [];
  const known = kind === "claims" ? KNOWN_CLAIMS : KNOWN_STATUS;
  for (const k of Object.keys(input)) if (!known.has(k)) out.push(safeKey(k));
  if (kind === "claims") {
    if (isObj(input.cnf)) for (const k of Object.keys(input.cnf)) if (!KNOWN_CNF.has(k)) out.push(`cnf.${safeKey(k)}`);
    if (Array.isArray(input.res)) {
      const seen = new Set<string>();
      for (const r of input.res) if (isObj(r)) for (const k of Object.keys(r)) if (!KNOWN_GRANT.has(k)) seen.add(`res[].${safeKey(k)}`);
      out.push(...seen);
    }
  }
  return out.slice(0, 16);
}

const loggedUnknown = new Set<string>();
/** Logs each distinct set of dropped paths once per process (paths only; a token never reaches a log). */
function noteUnknown(kind: "claims" | "status", input: unknown) {
  const paths = unknownDelegationPaths(kind, input);
  if (!paths.length) return;
  const key = `${kind}:${paths.join(",")}`;
  if (loggedUnknown.has(key) || loggedUnknown.size >= 256) return;
  loggedUnknown.add(key);
  console.warn(`[rdlg] ignored unknown delegation ${kind} fields (issuer is newer than this reader): ${paths.join(", ")}`);
}

// ── Errors ───────────────────────────────────────────────────────────────────

export type ResourceDelegationErrorCode =
  | "invalid_token" // not a JWS, unknown key, bad signature, malformed
  | "wrong_type" // header `typ` is not `ain-rdlg+jwt`
  | "wrong_issuer"
  | "wrong_audience"
  | "expired" // `exp` passed, or `iat` more than 60 s in the future
  | "invalid_claims" // payload does not match the contract
  | "not_configured" // AINDRIVE_SSO_ISSUER unset: no issuer to trust
  | "jwks_unavailable"; // the JWKS could not be fetched (transient)

export class ResourceDelegationError extends Error {
  constructor(readonly code: ResourceDelegationErrorCode, message: string) {
    super(message);
    this.name = "ResourceDelegationError";
  }
}

/** A refusal in contract terms: `code` picks the HTTP status, `reason` is the stable machine reason (goes in `detail`). */
export type DelegationRefusal = { ok: false; code: ErrorCode; reason: string; message: string };
const refuse = (code: ErrorCode, reason: string, message: string): DelegationRefusal => ({ ok: false, code, reason, message });

// ── Token verification ───────────────────────────────────────────────────────

/** Cheap routing check: is this bearer an `ain-rdlg+jwt`? (Header only; nothing is trusted here.) */
export function isResourceDelegationToken(bearer: string | null | undefined): boolean {
  if (!bearer) return false;
  try { return decodeProtectedHeader(bearer).typ === RESOURCE_DELEGATION_TOKEN_TYPE; } catch { return false; }
}

export interface VerifyResourceDelegationOptions {
  /** Verification time (default: the wall clock). */
  now?: Date;
  /** The AIN SSO issuer (default: AINDRIVE_SSO_ISSUER). */
  issuer?: string;
  /** This server's public origin, which `aud` must list (default: AINDRIVE_PUBLIC_URL). */
  audience?: string;
  /** Key source (default: the issuer's `/oidc/jwks`, cached as for every other AIN-signed token). */
  keys?: JWTVerifyGetKey;
}

/**
 * Verifies an `ain-rdlg+jwt`: signature against the SSO JWKS, `typ`, `iss` =
 * the configured issuer, `aud` ∋ this origin, `exp` (5 s tolerance), `iat` no
 * more than 60 s in the future, and the contract's claim shapes (no wildcards,
 * ttl ≤ 1 h, known actions and products). Revocation and proof of possession
 * are NOT checked here (see `checkDelegationStatus` / `verifyProofOfPossession`).
 * Throws `ResourceDelegationError` with a stable `code`.
 */
export async function verifyResourceDelegation(token: string, opts: VerifyResourceDelegationOptions = {}): Promise<ResourceDelegationClaims> {
  const issuer = opts.issuer ?? adapterConfig()?.issuer;
  if (!issuer) throw new ResourceDelegationError("not_configured", "no AIN SSO issuer is configured");
  const audience = (opts.audience ?? publicBase()).replace(/\/+$/, "");
  const keys = opts.keys ?? remoteJwks(adapterJwksUrl(issuer));
  const now = opts.now ?? new Date();
  let payload: unknown;
  try {
    ({ payload } = await jwtVerify(token, keys, {
      typ: RESOURCE_DELEGATION_TOKEN_TYPE,
      issuer,
      audience,
      algorithms: TOKEN_ALGORITHMS,
      clockTolerance: CLOCK_TOLERANCE_S,
      currentDate: now,
      requiredClaims: ["iss", "sub", "aud", "iat", "exp", "jti", "agt", "res", "prd", "cnf"],
    }));
  } catch (err) {
    if (err instanceof joseErrors.JWTExpired) throw new ResourceDelegationError("expired", "delegation token expired");
    if (err instanceof joseErrors.JWTClaimValidationFailed) {
      if (err.claim === "aud") throw new ResourceDelegationError("wrong_audience", "delegation token is not for this origin");
      if (err.claim === "iss") throw new ResourceDelegationError("wrong_issuer", "delegation token is from another issuer");
      if (err.claim === "typ") throw new ResourceDelegationError("wrong_type", "not a resource delegation token");
      if (err.claim === "iat" || err.claim === "nbf") throw new ResourceDelegationError("expired", `delegation token rejected: ${err.code} (${err.claim})`);
      throw new ResourceDelegationError("invalid_claims", `delegation token rejected: ${err.code} (${err.claim})`);
    }
    if (err instanceof joseErrors.JWKSTimeout) throw new ResourceDelegationError("jwks_unavailable", "could not fetch the issuer's keys in time");
    if (err instanceof joseErrors.JOSEError) throw new ResourceDelegationError("invalid_token", `delegation token rejected: ${err.code}`);
    // A failed JWKS fetch surfaces as a plain fetch error: transient, not "invalid".
    throw new ResourceDelegationError("jwks_unavailable", `could not fetch the issuer's keys: ${(err as Error).name}`);
  }
  const parsed = resourceDelegationClaims.safeParse(payload);
  if (parsed.success) noteUnknown("claims", payload);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ResourceDelegationError("invalid_claims", `delegation claims invalid: ${first ? `${first.path.join(".")} ${first.message}` : "unknown"}`);
  }
  if (!parsed.data.aud.includes(audience)) throw new ResourceDelegationError("wrong_audience", "delegation token is not for this origin");
  // jose only bounds `iat` with maxTokenAge; the contract allows 60 s of skew and no more.
  const nowS = Math.floor(now.getTime() / 1000);
  if (nowS < parsed.data.iat - 60) throw new ResourceDelegationError("expired", "delegation token is not valid yet");
  return parsed.data;
}

// ── Resource keys ────────────────────────────────────────────────────────────

/** The contract key of one aindrive path: `${origin}#${driveId}#${sharedFileId}`. */
export function resourceKey(origin: string, driveId: string, path: string): string {
  return `${origin.replace(/\/+$/, "")}#${driveId}#${sharedFileId(driveId, path)}`;
}

/**
 * The keys a grant may name to cover `path`: the path's own key first, then
 * every ancestor folder up to the drive root (`/`). Walking up the canonical
 * contract path is the only inheritance a delegation has — there are no
 * wildcards — and it matches how drive_members grants inherit downward.
 */
export function coveringResourceKeys(origin: string, driveId: string, path: string): string[] {
  const own = contractPath(path);
  const keys = [resourceKey(origin, driveId, own)];
  let p = own;
  while (p !== "/") {
    p = p.slice(0, p.lastIndexOf("/")) || "/";
    keys.push(resourceKey(origin, driveId, p));
  }
  return keys;
}

// ── The three-check decision ─────────────────────────────────────────────────

export type DelegatedCaller = {
  kind: "delegation";
  /** The aindrive account linked to `claims.sub`. */
  userId: string;
  /** The account's live role at the path (viewer+). */
  role: Role;
  /** The grant that covered the request (its own key or an ancestor folder's). */
  resource: string;
  claims: ResourceDelegationClaims;
};

export type DelegationDecision = ({ ok: true } & DelegatedCaller) | DelegationRefusal;

export interface MayReadInput {
  claims: ResourceDelegationClaims;
  driveId: string;
  /** Any spelling; canonicalized here (`contractPath`) before keys are derived. */
  path: string;
  action: ResourceAction;
  /** Epoch seconds (default: now). */
  now?: number;
  /** Revocation status, already checked and cached (default: not revoked — callers MUST check). */
  revoked?: boolean;
  /** This server's public origin (default: AINDRIVE_PUBLIC_URL). */
  origin?: string;
  /** The `sub` → user link (default: `sso_identities` by (claims.iss, claims.sub)). */
  userIdFor?: (claims: ResourceDelegationClaims) => string | null;
}

/**
 * `mayAct` for aindrive reads. Refuses, in this order: revoked, expired,
 * wrong audience, an action other than read/list, a resource the grant does
 * not name (own key or an ancestor folder key), a `sub` with no linked account
 * (or a blocked one), an account without `viewer+` at the path, a reserved or
 * paid-and-unbought path. Pure apart from the DB reads for checks 1 and 2.
 */
export function mayReadWithDelegation(input: MayReadInput): DelegationDecision {
  const { claims, driveId, action } = input;
  const origin = (input.origin ?? publicBase()).replace(/\/+$/, "");
  const now = input.now ?? Math.floor(Date.now() / 1000);
  if (input.revoked) return refuse("forbidden", "revoked", "the delegation was revoked");
  if (now >= claims.exp + CLOCK_TOLERANCE_S || now < claims.iat - 60) return refuse("auth_required", "expired", "the delegation expired");
  if (!claims.aud.includes(origin)) return refuse("auth_required", "wrong_audience", "the delegation is not for this origin");
  // Reads only: a `write`/`invoke` grant is not honoured by any aindrive route yet.
  if (!(DELEGATED_ACTIONS as readonly string[]).includes(action)) {
    return refuse("forbidden", "action_not_supported", `action "${action}" is not available through a delegation (read and list only)`);
  }
  const keys = coveringResourceKeys(origin, driveId, input.path);
  const grant = claims.res.find((g) => keys.includes(g.resource) && g.actions.includes(action));
  if (!grant) return refuse("forbidden", "not_granted", "the delegation does not grant this action on this file");

  const userId = input.userIdFor ? input.userIdFor(claims) : identityFor(claims.iss, claims.sub)?.user_id ?? null;
  if (!userId) return refuse("forbidden", "sub_not_linked", "the delegated account is not linked to an account on this server");
  if (isAccountBlocked(userId)) return refuse("forbidden", "user_forbidden", "the delegated account may not use this server");
  const canonical = contractPath(input.path).slice(1); // aindrive's own spelling (no leading '/')
  if (isSystemPath(canonical)) return refuse("forbidden", "reserved_path", "reserved path");
  const role = resolveRoleByUser(driveId, userId, canonical);
  if (!atLeast(role, "viewer")) return refuse("forbidden", "user_forbidden", "the delegated account may not read this file");
  if (paidAccessDenial(driveId, canonical, role, userId)) return refuse("forbidden", "user_forbidden", "the delegated account has not bought this content");
  return { ok: true, kind: "delegation", userId, role: role as Role, resource: grant.resource, claims };
}

// ── Revocation status (GET {issuer}/api/delegations/:jti/status) ─────────────

export interface DelegationStatusClientOptions {
  issuer: string;
  /** Cache lifetime in seconds (default and maximum 60). */
  maxAgeSeconds?: number;
  fetch?: typeof fetch;
  now?: () => Date;
}

export class DelegationStatusUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DelegationStatusUnavailable";
  }
}

/**
 * Bounded in-memory status cache (≤ 60 s, ≤ 10 000 entries). A fresh answer is
 * served from the cache; otherwise the issuer is asked. 404 = revoked. When the
 * issuer cannot be reached, a stale cached answer (whatever it said) is used —
 * a revocation seen once stays seen — and with no cached answer at all the
 * check fails closed (`DelegationStatusUnavailable` → temporary_failure).
 */
export function createDelegationStatusClient(opts: DelegationStatusClientOptions) {
  const maxAge = Math.min(Math.max(opts.maxAgeSeconds ?? 60, 1), 60) * 1000;
  const doFetch = opts.fetch ?? ((input, init) => fetch(input, init));
  const now = opts.now ?? (() => new Date());
  const base = opts.issuer.replace(/\/+$/, "");
  const cache = new Map<string, { at: number; status: ResourceDelegationStatus }>();

  const remember = (jti: string, t: number, status: ResourceDelegationStatus) => {
    if (cache.size >= 10_000) cache.delete(cache.keys().next().value as string);
    cache.delete(jti);
    cache.set(jti, { at: t, status });
    return status;
  };

  return {
    async check(jti: string): Promise<ResourceDelegationStatus> {
      const hit = cache.get(jti);
      const t = now().getTime();
      if (hit && t - hit.at < maxAge) return hit.status;
      try {
        const res = await doFetch(`${base}/api/delegations/${encodeURIComponent(jti)}/status`, {
          headers: { accept: "application/json" },
          redirect: "error",
          signal: AbortSignal.timeout(5_000),
        });
        if (res.status === 404) return remember(jti, t, { jti, revoked: true, checkedAt: now().toISOString() });
        if (!res.ok) throw new DelegationStatusUnavailable(`delegation status unavailable: HTTP ${res.status}`);
        const body: unknown = await res.json();
        const status = resourceDelegationStatus.parse(body);
        noteUnknown("status", body);
        if (status.jti !== jti) throw new DelegationStatusUnavailable("delegation status mismatch");
        return remember(jti, t, status);
      } catch (err) {
        if (hit) return hit.status; // stale, but the last thing the issuer told us
        if (err instanceof DelegationStatusUnavailable) throw err;
        throw new DelegationStatusUnavailable(`delegation status unavailable: ${(err as Error).name}`);
      }
    },
    /** Drops a cached answer (e.g. after this server itself learned of a revocation). */
    forget(jti: string) {
      cache.delete(jti);
    },
    clear() {
      cache.clear();
    },
  };
}

type StatusClient = ReturnType<typeof createDelegationStatusClient>;
const g = globalThis as unknown as {
  __aindrive_rdlg_status?: Map<string, StatusClient>;
  __aindrive_rdlg_pop?: Map<string, number>;
  __aindrive_rdlg_fetch?: typeof fetch;
};
const statusClients = (g.__aindrive_rdlg_status ??= new Map());

/** The process-wide status client for `issuer` (one cache per issuer). */
export function delegationStatusClient(issuer: string): StatusClient {
  let c = statusClients.get(issuer);
  if (!c) {
    c = createDelegationStatusClient({ issuer, fetch: g.__aindrive_rdlg_fetch });
    statusClients.set(issuer, c);
  }
  return c;
}

/** Tests replace the fetch behind the process-wide status clients (and drop their caches). */
export function setDelegationStatusFetchForTests(fetchImpl: typeof fetch | null) {
  g.__aindrive_rdlg_fetch = fetchImpl ?? undefined;
  statusClients.clear();
}

// ── Proof of possession (X-AIN-PoP) ──────────────────────────────────────────

/**
 * `X-AIN-PoP`: a compact JWS (typ `ain-pop+jwt`, alg ES256 or EdDSA) over
 * `{htm, htu, iat, jti}` — the HTTP method, this server's public URL of the
 * request without query, the signing time (± 60 s) and a request id that is
 * accepted once per delegation. With `cnf.jkt` the JWS header carries the
 * public `jwk` and its RFC 7638 SHA-256 thumbprint must equal `jkt`; with
 * `cnf.jwk` that key verifies the JWS (a header `jwk`, if present, must be the
 * same key). Like DPoP, but bound to the delegation's key instead of a bearer.
 */
export type PopVerifyInput = {
  claims: ResourceDelegationClaims;
  method: string;
  /** The public URL the client signed (`${publicBase()}${pathname}`). */
  expectedUrl: string;
  header: string | null;
  now?: Date;
};

const popSeen = (g.__aindrive_rdlg_pop ??= new Map());
const POP_SEEN_MAX = 10_000;

function rememberPopJti(key: string, expiresAtMs: number, nowMs: number): boolean {
  if (popSeen.size >= POP_SEEN_MAX) {
    for (const [k, exp] of popSeen) if (exp <= nowMs) popSeen.delete(k);
    while (popSeen.size >= POP_SEEN_MAX) popSeen.delete(popSeen.keys().next().value as string);
  }
  const prev = popSeen.get(key);
  if (prev !== undefined && prev > nowMs) return false;
  popSeen.set(key, expiresAtMs);
  return true;
}

/** Canonical htu: absolute URL without query and fragment. */
function htuOf(url: string): string {
  const u = new URL(url);
  u.search = "";
  u.hash = "";
  return u.href;
}

function publicJwkOf(raw: unknown): JWK | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const jwk = raw as JWK;
  if (typeof jwk.kty !== "string") return null;
  // A private-key member in a proof key is a client bug at best; refuse it outright.
  for (const k of ["d", "p", "q", "dp", "dq", "qi", "k", "oth"]) if (k in jwk) return null;
  if (jwk.kty === "EC" && jwk.crv !== "P-256") return null;
  if (jwk.kty === "OKP" && jwk.crv !== "Ed25519") return null;
  if (jwk.kty !== "EC" && jwk.kty !== "OKP") return null;
  return jwk;
}

/** Returns null when the proof is valid; otherwise the refusal (always auth_required). */
export async function verifyProofOfPossession(input: PopVerifyInput): Promise<DelegationRefusal | null> {
  const bad = (reason: string, message: string) => refuse("auth_required", reason, message);
  const raw = input.header?.trim();
  if (!raw) return bad("pop_required", `proof of possession required (${POP_HEADER} header)`);
  if (raw.length > 8192 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(raw)) return bad("pop_invalid", "proof of possession is not a compact JWS");

  let header: ReturnType<typeof decodeProtectedHeader>;
  try { header = decodeProtectedHeader(raw); } catch { return bad("pop_invalid", "proof of possession header is malformed"); }
  if (header.typ !== POP_TOKEN_TYPE) return bad("pop_invalid", `proof of possession must have typ ${POP_TOKEN_TYPE}`);
  if (!header.alg || !POP_ALGORITHMS.includes(header.alg)) return bad("pop_invalid", "proof of possession uses an unsupported algorithm");

  // Which key must have signed it: the one in `cnf`.
  const headerJwk = header.jwk === undefined ? undefined : publicJwkOf(header.jwk);
  if (header.jwk !== undefined && !headerJwk) return bad("pop_invalid", "proof of possession carries an unusable key");
  let jwk: JWK;
  try {
    if ("jkt" in input.claims.cnf) {
      if (!headerJwk) return bad("pop_invalid", "proof of possession must carry the public key in its header (cnf.jkt)");
      if ((await calculateJwkThumbprint(headerJwk, "sha256")) !== input.claims.cnf.jkt) return bad("pop_invalid", "proof of possession key does not match the delegation's cnf.jkt");
      jwk = headerJwk;
    } else {
      const bound = publicJwkOf(input.claims.cnf.jwk);
      if (!bound) return bad("pop_invalid", "the delegation's cnf.jwk is not a usable public key");
      if (headerJwk && (await calculateJwkThumbprint(headerJwk, "sha256")) !== (await calculateJwkThumbprint(bound, "sha256"))) {
        return bad("pop_invalid", "proof of possession key does not match the delegation's cnf.jwk");
      }
      jwk = bound;
    }
  } catch {
    return bad("pop_invalid", "proof of possession key is malformed");
  }

  let payload: Record<string, unknown>;
  try {
    const key = await importJWK(jwk, header.alg);
    const { payload: bytes } = await compactVerify(raw, key, { algorithms: POP_ALGORITHMS });
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return bad("pop_invalid", "proof of possession payload is not an object");
    payload = parsed as Record<string, unknown>;
  } catch {
    return bad("pop_invalid", "proof of possession signature is invalid");
  }

  const { htm, htu, iat, jti } = payload;
  if (typeof htm !== "string" || htm.toUpperCase() !== input.method.toUpperCase()) return bad("pop_invalid", "proof of possession is bound to another HTTP method");
  let sameUrl = false;
  try { sameUrl = typeof htu === "string" && htuOf(htu) === htuOf(input.expectedUrl); } catch { sameUrl = false; }
  if (!sameUrl) return bad("pop_invalid", "proof of possession is bound to another URL");
  const nowS = Math.floor((input.now ?? new Date()).getTime() / 1000);
  if (typeof iat !== "number" || !Number.isFinite(iat) || Math.abs(nowS - iat) > POP_WINDOW_S) return bad("pop_invalid", "proof of possession is outside the 60 s window");
  if (typeof jti !== "string" || jti.length === 0 || jti.length > 256) return bad("pop_invalid", "proof of possession needs a jti");
  // Replay check last, so a malformed proof never consumes an id.
  if (!rememberPopJti(`${input.claims.jti}\u0000${jti}`, (iat + POP_WINDOW_S + CLOCK_TOLERANCE_S) * 1000, nowS * 1000)) {
    return bad("pop_replayed", "proof of possession was already used");
  }
  return null;
}

// ── Request → caller ─────────────────────────────────────────────────────────

export function bearerOf(req: Request): string | null {
  const m = req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

function refusalFor(err: unknown): DelegationRefusal {
  if (err instanceof ResourceDelegationError) {
    if (err.code === "jwks_unavailable") return refuse("temporary_failure", err.code, "the issuer's keys are unavailable; retry later");
    if (err.code === "not_configured") return refuse("auth_required", err.code, "resource delegations are not accepted by this server");
    return refuse("auth_required", err.code, err.message);
  }
  if (err instanceof DelegationStatusUnavailable) return refuse("temporary_failure", "status_unavailable", "the delegation's revocation status is unavailable; retry later");
  throw err;
}

/**
 * The whole origin-side check for one request carrying an `ain-rdlg+jwt`:
 * verify the token, prove possession of its key, ask (or recall) its
 * revocation status, then the three checks. Never throws for a client error;
 * a refusal names the contract error code. The token is never logged.
 */
export async function resolveDelegatedCaller(
  req: Request,
  target: { driveId: string; path: string; action: ResourceAction },
  deps: { now?: Date; keys?: JWTVerifyGetKey } = {},
): Promise<DelegationDecision> {
  const bearer = bearerOf(req);
  if (!bearer) return refuse("auth_required", "missing_token", "a delegation token is required");
  const now = deps.now ?? new Date();
  let claims: ResourceDelegationClaims;
  try {
    claims = await verifyResourceDelegation(bearer, { now, keys: deps.keys });
  } catch (err) {
    return refusalFor(err);
  }
  const expectedUrl = `${publicBase()}${new URL(req.url).pathname}`;
  const pop = await verifyProofOfPossession({ claims, method: req.method, expectedUrl, header: req.headers.get(POP_HEADER), now });
  if (pop) return pop;
  let revoked: boolean;
  try {
    ({ revoked } = await delegationStatusClient(claims.iss).check(claims.jti));
  } catch (err) {
    return refusalFor(err);
  }
  return mayReadWithDelegation({ claims, revoked, now: Math.floor(now.getTime() / 1000), ...target });
}

/** Contract error code for an agent RPC failure on a delegated read. */
export function delegatedAgentErrorCode(err: { status?: number; message?: string }): ErrorCode {
  const status = err.status ?? 500;
  if (status === 504 && /offline/i.test(err.message ?? "")) return "source_offline";
  if (status === 404) return "resource_deleted";
  // The device's own "file is gone" (the agent relays errno text with a 502): the
  // resource is deleted, not a transient failure a consumer should retry.
  if (/\bENOENT\b|no such file or directory/i.test(err.message ?? "")) return "resource_deleted";
  if (status >= 500) return "temporary_failure";
  return "unsupported_input";
}

/**
 * The message a delegated caller sees for an agent failure: fixed per code.
 * The agent's own text is never relayed — it can carry the owner's absolute
 * local path or the names of files the caller cannot list (plan task 06.5;
 * contract errors.ts: "never includes file names of resources the caller
 * cannot see").
 */
export function delegatedAgentMessage(code: ErrorCode): string {
  switch (code) {
    case "source_offline": return "the drive's device is not connected";
    case "resource_deleted": return "the file is no longer there";
    case "temporary_failure": return "the drive could not answer right now";
    default: return "the drive could not serve this request";
  }
}
