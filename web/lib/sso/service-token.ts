/**
 * aindrive's machine identity at AIN SSO: an OAuth 2.0 `client_credentials`
 * token for a resource server (RFC 8707 `resource`), obtained with aindrive's
 * app credentials (`AINDRIVE_SSO_CLIENT_ID` / `_SECRET`, client_secret_basic;
 * lib/sso/config.ts appCredentials) and cached until shortly before it expires,
 * one request in flight per resource. AIN SSO architecture §4.9; the mirror of
 * ainize-node's src/sso-service-token.ts.
 *
 * Today's one use: after a push of a repo whose root has `ainize.json`,
 * lib/git-project-hooks.ts binds it to an ainize project as aindrive itself
 * (`POST ${AINIZE_URL}/api/projects/auto`, resource = the ainize origin; ainize
 * trusts the token's `sub` through its AIN_SSO_SERVICE_APPS). The token is a
 * bearer secret for its five minutes: never logged, never in an error text.
 */
import { appCredentials } from "./config";

export class ServiceTokenError extends Error {
  constructor(message: string, readonly status: number | null = null) { super(message); this.name = "ServiceTokenError"; }
}

export interface ServiceTokenClientOptions {
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** Resolved at each call (tests stub the global). */
  fetch?: () => typeof fetch;
  now?: () => number;
  /** Seconds before `exp` at which a cached token counts as expired (default 30). */
  skewSeconds?: number;
}

type Cached = { token: string; expiresAt: number };
const META_TTL_MS = 10 * 60_000;
const isLoopback = (host: string) => ["localhost", "127.0.0.1", "[::1]", "::1"].includes(host);

function endpointOk(raw: unknown, issuer: URL): raw is string {
  if (typeof raw !== "string") return false;
  const u = URL.parse(raw);
  if (!u || u.search || u.hash || u.username || u.password) return false;
  if (u.protocol === "https:") return true;
  return u.protocol === "http:" && issuer.protocol === "http:" && isLoopback(u.hostname);
}

export class ServiceTokenClient {
  private readonly now: () => number;
  private readonly skew: number;
  private meta: { tokenEndpoint: string; at: number } | null = null;
  private readonly cache = new Map<string, Cached>();
  private readonly inflight = new Map<string, Promise<string>>();

  constructor(private readonly opts: ServiceTokenClientOptions) {
    this.now = opts.now ?? Date.now;
    this.skew = opts.skewSeconds ?? 30;
  }

  private f(): typeof fetch { return (this.opts.fetch ?? (() => fetch))(); }

  /** A live token for `resource` (its origin, e.g. https://ainize.ai). */
  token(resource: string): Promise<string> {
    const cached = this.cache.get(resource);
    if (cached && cached.expiresAt - this.skew * 1000 > this.now()) return Promise.resolve(cached.token);
    let p = this.inflight.get(resource);
    if (!p) {
      p = this.request(resource).finally(() => this.inflight.delete(resource));
      this.inflight.set(resource, p);
    }
    return p;
  }

  /** Drop a cached token (the resource server refused it). */
  forget(resource: string): void { this.cache.delete(resource); }

  private async tokenEndpoint(): Promise<string> {
    if (this.meta && this.now() - this.meta.at < META_TTL_MS) return this.meta.tokenEndpoint;
    const issuer = new URL(this.opts.issuer);
    const res = await this.f()(`${this.opts.issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`, { headers: { accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(5_000) });
    if (!res.ok) throw new ServiceTokenError(`AIN SSO discovery answered ${res.status}`, res.status);
    const meta = (await res.json()) as { issuer?: unknown; token_endpoint?: unknown };
    if (meta.issuer !== this.opts.issuer && meta.issuer !== this.opts.issuer.replace(/\/+$/, "")) throw new ServiceTokenError("AIN SSO discovery: issuer mismatch");
    if (!endpointOk(meta.token_endpoint, issuer) || new URL(meta.token_endpoint).origin !== issuer.origin) throw new ServiceTokenError("AIN SSO discovery: bad token_endpoint");
    this.meta = { tokenEndpoint: meta.token_endpoint, at: this.now() };
    return meta.token_endpoint;
  }

  private async request(resource: string): Promise<string> {
    const endpoint = await this.tokenEndpoint();
    const basic = Buffer.from(`${encodeURIComponent(this.opts.clientId)}:${encodeURIComponent(this.opts.clientSecret)}`).toString("base64");
    let res: Response;
    try {
      res = await this.f()(endpoint, {
        method: "POST",
        headers: { authorization: `Basic ${basic}`, "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams({ grant_type: "client_credentials", resource }),
        redirect: "error", signal: AbortSignal.timeout(10_000),
      });
    } catch (e) {
      throw new ServiceTokenError(`AIN SSO token endpoint unreachable: ${(e as Error).message}`);
    }
    const json = (await res.json().catch(() => ({}))) as { access_token?: unknown; token_type?: unknown; expires_in?: unknown; error?: unknown; error_description?: unknown };
    if (!res.ok || typeof json.access_token !== "string" || !json.access_token) {
      const what = typeof json.error === "string" ? `${json.error}${typeof json.error_description === "string" ? `: ${json.error_description}` : ""}` : `HTTP ${res.status}`;
      throw new ServiceTokenError(`AIN SSO refused a machine token for ${resource} (${what})`, res.status);
    }
    if (typeof json.token_type === "string" && json.token_type.toLowerCase() !== "bearer") throw new ServiceTokenError(`AIN SSO issued a ${json.token_type} token; only Bearer is usable`);
    const ttl = typeof json.expires_in === "number" && json.expires_in > 0 ? json.expires_in : 60;
    this.cache.set(resource, { token: json.access_token, expiresAt: this.now() + ttl * 1000 });
    return json.access_token;
  }
}

// One client per process for the configured credentials (a config change makes a new one).
const g = globalThis as unknown as { __aindrive_service_token?: { key: string; client: ServiceTokenClient } };

/**
 * A machine token for `resource` with aindrive's own credentials, or null when
 * aindrive has none (AINDRIVE_SSO_ISSUER / _CLIENT_ID / _CLIENT_SECRET not all
 * set). Throws ServiceTokenError when AIN SSO refuses or is unreachable.
 */
export async function serviceToken(resource: string): Promise<string | null> {
  const creds = appCredentials();
  if (!creds) return null;
  const key = `${creds.issuer}|${creds.clientId}|${creds.clientSecret}`;
  if (g.__aindrive_service_token?.key !== key) g.__aindrive_service_token = { key, client: new ServiceTokenClient(creds) };
  return g.__aindrive_service_token.client.token(resource);
}

/** Tests: forget every cached token. */
export function resetServiceTokensForTests(): void { delete g.__aindrive_service_token; }
