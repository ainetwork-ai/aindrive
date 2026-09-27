/**
 * A tiny in-test AIN SSO: an RS256 key, its JWKS, and signers for the three
 * token kinds aindrive verifies (ID token, adapter request JWT, back-channel
 * logout token), plus a fake `fetch` for discovery / token / app-proof.
 * Not a test file itself (no `.test.ts`); imported by the sso-*.test.ts files.
 */
import { createHash, randomUUID } from "node:crypto";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTVerifyGetKey } from "jose";

export const ISSUER = "https://sso.example.test";
export const CLIENT_ID = "app_aindrive";
export const CLIENT_SECRET = "s3cret-for-tests";
export const PUBLIC_URL = "https://drive.example.test";

export type Signer = Awaited<ReturnType<typeof createTestIssuer>>;

export async function createTestIssuer(issuer = ISSUER) {
  const kp = await generateKeyPair("RS256");
  const other = await generateKeyPair("RS256"); // a key the JWKS does not publish
  const jwk = { ...(await exportJWK(kp.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  const keys: JWTVerifyGetKey = createLocalJWKSet({ keys: [jwk] });
  const nowS = () => Math.floor(Date.now() / 1000);

  async function sign(payload: Record<string, unknown>, opts: { typ?: string; key?: "k1" | "other"; iat?: number; exp?: number; alg?: string } = {}) {
    const iat = opts.iat ?? nowS();
    return new SignJWT(payload)
      .setProtectedHeader({ alg: opts.alg ?? "RS256", kid: "k1", ...(opts.typ ? { typ: opts.typ } : {}) })
      .setIssuedAt(iat)
      .setExpirationTime(opts.exp ?? iat + 60)
      .sign(opts.key === "other" ? other.privateKey : kp.privateKey);
  }

  return {
    issuer,
    keys,
    jwks: { keys: [jwk] },
    sign,
    idToken(claims: Record<string, unknown>, opts: { key?: "k1" | "other"; iat?: number; exp?: number } = {}) {
      return sign({ iss: issuer, aud: CLIENT_ID, ...claims }, { ...opts, exp: opts.exp ?? (opts.iat ?? nowS()) + 3600 });
    },
    /** Adapter request JWT bound to method, URL and body (adapter-protocol §3.1). */
    adapterToken(o: { method: string; url: string; body?: string; iss?: string; aud?: string; typ?: string; iat?: number; exp?: number; jti?: string; key?: "k1" | "other"; bsh?: string }) {
      const bsh = o.bsh ?? createHash("sha256").update(o.body ?? "").digest("base64url");
      return sign(
        { iss: o.iss ?? issuer, aud: o.aud ?? CLIENT_ID, jti: o.jti ?? randomUUID(), htm: o.method, htu: o.url, bsh },
        { typ: o.typ ?? "ain-adapter+jwt", iat: o.iat, exp: o.exp, key: o.key },
      );
    },
    logoutToken(claims: Record<string, unknown>, o: { typ?: string; iat?: number; exp?: number; aud?: string; noEvents?: boolean } = {}) {
      return sign(
        {
          iss: issuer,
          aud: o.aud ?? CLIENT_ID,
          jti: randomUUID(),
          ...(o.noEvents ? {} : { events: { "http://schemas.openid.net/event/backchannel-logout": {} } }),
          ...claims,
        },
        { typ: o.typ ?? "logout+jwt", iat: o.iat, exp: o.exp ?? (o.iat ?? nowS()) + 120 },
      );
    },
    metadata: {
      issuer,
      authorization_endpoint: `${issuer}/oidc/auth`,
      token_endpoint: `${issuer}/oidc/token`,
      jwks_uri: `${issuer}/oidc/jwks`,
      end_session_endpoint: `${issuer}/oidc/session/end`,
      authorization_response_iss_parameter_supported: true,
    },
  };
}

export type TokenEndpointCall = { authorization: string | null; body: URLSearchParams };

/**
 * A fetch that answers discovery, the token endpoint (with `respond` deciding
 * the token response) and app-proof. Everything else is a 404.
 */
export function fakeIssuerFetch(t: Awaited<ReturnType<typeof createTestIssuer>>, respond: (call: TokenEndpointCall) => Promise<Record<string, unknown>> | Record<string, unknown>) {
  const tokenCalls: TokenEndpointCall[] = [];
  const appProofs: { authorization: string | null; body: unknown }[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers = new Headers(init?.headers);
    if (url === `${t.issuer}/.well-known/openid-configuration`) return Response.json(t.metadata);
    if (url === t.metadata.token_endpoint) {
      const call = { authorization: headers.get("authorization"), body: new URLSearchParams(String(init?.body ?? "")) };
      tokenCalls.push(call);
      return Response.json(await respond(call));
    }
    if (url === `${t.issuer}/api/upstream/app-proof`) {
      appProofs.push({ authorization: headers.get("authorization"), body: JSON.parse(String(init?.body ?? "null")) });
      return Response.json({ mapping: { status: "linked" }, created: true }, { status: 201 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { impl, tokenCalls, appProofs };
}

/** A cookie jar standing in for next/headers cookies() in route tests. */
export function cookieJar() {
  const jar = new Map<string, string>();
  const api = {
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string, opts?: { maxAge?: number }) => {
      if (opts?.maxAge === 0 || value === "") jar.delete(name);
      else jar.set(name, value);
    },
    delete: (name: string) => { jar.delete(name); },
  };
  return { jar, cookies: () => Promise.resolve(api) };
}
