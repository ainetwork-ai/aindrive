// App attestation (lib/sso/app-attest.ts, AIN SSO management-api §13.2):
// after a LEGACY sign-in aindrive reports what it verified — the Google sub
// after its own Google sign-in (any domain), a company address it verified by
// an emailed code after a password sign-in/sign-up — and nothing after wallet
// sign-ins, for unverified or non-company addresses, for accounts already
// linked, or without SSO client credentials. Best effort: the login never
// waits for it and never fails because of it.
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import bcrypt from "bcryptjs";
import { SiweMessage } from "siwe";
import { CLIENT_ID, CLIENT_SECRET, cookieJar, ISSUER, PUBLIC_URL } from "./sso-test-issuer";

process.env.AINDRIVE_DATA_DIR = mkdtempSync(join(tmpdir(), "aindrive-sso-attest-"));
process.env.AINDRIVE_PUBLIC_URL = PUBLIC_URL;
process.env.AINDRIVE_SESSION_SECRET = "sso-attest-test-secret-0123456789abcdef";
process.env.AINDRIVE_GOOGLE_CLIENT_IDS = "web-client.apps.googleusercontent.com";
const SSO_ENV = {
  AINDRIVE_SSO_ISSUER: ISSUER,
  AINDRIVE_SSO_CLIENT_ID: CLIENT_ID,
  AINDRIVE_SSO_CLIENT_SECRET: CLIENT_SECRET,
  AINDRIVE_SSO_ENABLED: "true",
};

const { jar, cookies } = cookieJar();
vi.mock("next/headers", () => ({ cookies }));
const sent: Array<{ to: string; text: string }> = [];
vi.mock("@/lib/email", () => ({ sendMail: async (m: { to: string; text: string }) => { sent.push(m); }, mailConfigured: () => true }));
let googleIdentity = { sub: "g-sub", email: "g@example.com", name: "G" };
vi.mock("@/lib/google-auth", async (orig) => ({
  ...(await orig<typeof import("@/lib/google-auth")>()),
  verifyGoogleIdToken: async () => googleIdentity,
}));
vi.mock("@/lib/siwe-verify", async (orig) => ({
  ...(await orig<typeof import("@/lib/siwe-verify")>()),
  verifyWalletSignature: vi.fn(async () => true),
}));

const { db } = await import("../db.js");
const wallet = await import("../wallet");
const attest = await import("../sso/app-attest");
const loginRoute = await import("../../app/api/auth/login/route.js");
const googleRoute = await import("../../app/api/auth/google/route.js");
const signupRoute = await import("../../app/api/auth/signup/route.js");
const requestCodeRoute = await import("../../app/api/auth/signup/request-code/route.js");
const walletLoginRoute = await import("../../app/api/wallet/login/route.js");

type Call = { url: string; authorization: string | null; cookie: string | null; body: Record<string, unknown> };
const calls: Call[] = [];
let respond: (body: Record<string, unknown>) => Response | Promise<Response> = () =>
  Response.json({ status: "pending", mappingId: "lgm_1", expiresAt: "2026-10-27T00:00:00.000Z" }, { status: 201 });
const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const headers = new Headers(init?.headers);
  if (url === `${ISSUER}/api/upstream/app-attest`) {
    const body = JSON.parse(String(init?.body ?? "null"));
    calls.push({ url, authorization: headers.get("authorization"), cookie: headers.get("cookie"), body });
    return respond(body);
  }
  return new Response("not found", { status: 404 });
}) as typeof fetch;

const req = (path: string, body: unknown) =>
  new Request(`${PUBLIC_URL}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const login = (email: string, password = "pw-123456") => loginRoute.POST(req("/api/auth/login", { email, password }));
const google = () => googleRoute.POST(req("/api/auth/google", { idToken: "x".repeat(40) }));
const settle = () => new Promise((r) => setTimeout(r, 20));
const BASIC = `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")}`;

/** A password account; `evidence` = how (and when, relative to creation) aindrive verified its address. */
async function account(id: string, email: string, o: { evidence?: "signup" | "reset_password" | "attach_email"; offsetMs?: number; createdAgo?: string } = {}) {
  const hash = await bcrypt.hash("pw-123456", 4);
  db.prepare(`INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?,?,?,?, datetime('now', ?))`).run(id, email, id, hash, o.createdAgo ?? "+0 seconds");
  if (o.evidence) {
    const created = (db.prepare("SELECT CAST(strftime('%s', created_at) AS INTEGER) * 1000 AS ms FROM users WHERE id = ?").get(id) as { ms: number }).ms;
    db.prepare(`INSERT INTO email_verification_codes (id, email, purpose, code_hash, salt, consumed, expires_at, verified_at, created_at)
                VALUES (?, ?, ?, 'h', 's', 1, ?, ?, ?)`).run(`evc_${id}`, email.toLowerCase(), o.evidence, created + 600_000, created + (o.offsetMs ?? 200), created);
  }
}

beforeAll(async () => {
  vi.stubGlobal("fetch", fakeFetch);
  await account("u_emp", "emp@comcom.ai", { evidence: "signup" });
  await account("u_old", "old@comcom.ai"); // signed up before aindrive verified addresses
  await account("u_gmail", "someone@gmail.com", { evidence: "signup" });
  await account("u_reset", "reset@comcom.ai", { evidence: "reset_password", offsetMs: 3_600_000 });
  // Someone verified a sign-up code for this address long after the account
  // existed (their sign-up failed: the address was taken) — not this account's proof.
  await account("u_squat", "squat@comcom.ai", { evidence: "signup", createdAgo: "-1 hour", offsetMs: 3_600_000 });
  await account("u_linked", "linked@comcom.ai", { evidence: "signup" });
  await account("u_mixed", "Mixed@ComCom.AI", { evidence: "signup" });
  await account("u_sub", "x@eng.comcom.ai", { evidence: "signup" }); // a subdomain is another domain
  await account("u_org", "a@example.org", { evidence: "signup" });
  db.prepare("INSERT INTO sso_identities (issuer, subject, user_id, link_method, linked_at) VALUES (?, 'acc_l', 'u_linked', 'jit', ?)").run(ISSUER, Date.now());
});
beforeEach(() => {
  jar.clear();
  calls.length = 0;
  sent.length = 0;
  (globalThis as { __rl_buckets__?: Map<unknown, unknown> }).__rl_buckets__?.clear();
  Object.assign(process.env, SSO_ENV);
  for (const k of ["AINDRIVE_LEGACY_LOGIN", "AINDRIVE_SSO_ATTEST", "AINDRIVE_SSO_ATTEST_EMAIL_DOMAINS"]) delete process.env[k];
  respond = () => Response.json({ status: "pending", mappingId: "lgm_1", expiresAt: "2026-10-27T00:00:00.000Z" }, { status: 201 });
});

describe("password sign-in: the email form, only for a company address aindrive verified", () => {
  it("posts {legacyUserId, email, emailVerifiedBy: password, legacyLoginAt} with client_secret_basic and no cookies", async () => {
    const before = Date.now();
    const res = await login("emp@comcom.ai");
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const c = calls[0];
    expect(c.authorization).toBe(BASIC);
    expect(c.cookie).toBeNull();
    expect(Object.keys(c.body).sort()).toEqual(["email", "emailVerifiedBy", "legacyLoginAt", "legacyUserId"]);
    expect(c.body).toMatchObject({ legacyUserId: "u_emp", email: "emp@comcom.ai", emailVerifiedBy: "password" });
    const at = Date.parse(String(c.body.legacyLoginAt));
    expect(at).toBeGreaterThanOrEqual(before - 1000);
    expect(at).toBeLessThanOrEqual(Date.now() + 1000);
    expect(String(c.body.legacyLoginAt)).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/);
  });

  it("a verified password reset is the proof as well; the address goes lower-cased", async () => {
    await login("reset@comcom.ai");
    await login("mixed@comcom.ai");
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(calls.map((c) => c.body.email)).toEqual(["reset@comcom.ai", "mixed@comcom.ai"]);
  });

  it.each([
    ["an address aindrive never verified (pre-verification account)", "old@comcom.ai"],
    ["another domain", "someone@gmail.com"],
    ["a subdomain of the company domain", "x@eng.comcom.ai"],
    ["a sign-up code that was not this account's", "squat@comcom.ai"],
    ["an account already linked to AIN", "linked@comcom.ai"],
  ])("nothing is sent for %s", async (_label, email) => {
    expect((await login(email)).status).toBe(200);
    await settle();
    expect(calls).toHaveLength(0);
  });

  it("a failed sign-in attests nothing", async () => {
    expect((await login("emp@comcom.ai", "wrong")).status).toBe(401);
    await settle();
    expect(calls).toHaveLength(0);
  });

  it("AINDRIVE_SSO_ATTEST_EMAIL_DOMAINS picks the company domains; none = no email attestations", async () => {
    process.env.AINDRIVE_SSO_ATTEST_EMAIL_DOMAINS = "example.org, @Other.example";
    await login("emp@comcom.ai");
    await login("a@example.org");
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].body).toMatchObject({ legacyUserId: "u_org", email: "a@example.org" });
    process.env.AINDRIVE_SSO_ATTEST_EMAIL_DOMAINS = "none";
    await login("a@example.org");
    await settle();
    expect(calls).toHaveLength(1);
  });

  it("a new password account (sign-up with an emailed code) is attested like a sign-in", async () => {
    await requestCodeRoute.POST(req("/api/auth/signup/request-code", { email: "New.Hire@comcom.ai" }));
    const code = sent.at(-1)!.text.match(/\b\d{6}\b/)![0];
    const res = await signupRoute.POST(req("/api/auth/signup", { email: "New.Hire@comcom.ai", code, name: "New", password: "pw-12345678" }));
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const id = (db.prepare("SELECT id FROM users WHERE email = 'new.hire@comcom.ai'").get() as { id: string }).id;
    expect(calls[0].body).toMatchObject({ legacyUserId: id, email: "new.hire@comcom.ai", emailVerifiedBy: "password" });
  });
});

describe("Google sign-in: the Google sub, any domain", () => {
  it("posts exactly {legacyUserId, googleSub, legacyLoginAt}", async () => {
    googleIdentity = { sub: "g-gmail-1", email: "person@gmail.com", name: "P" };
    const res = await google();
    expect(res.status).toBe(200);
    const { user } = await res.json();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(Object.keys(calls[0].body).sort()).toEqual(["googleSub", "legacyLoginAt", "legacyUserId"]);
    expect(calls[0].body).toMatchObject({ legacyUserId: user.id, googleSub: "g-gmail-1" });
    expect(calls[0].authorization).toBe(BASIC);
  });

  it("one call per login, whatever the answer (a 400 is not retried in another shape)", async () => {
    respond = () => Response.json({ error: "invalid_google_sub" }, { status: 400 });
    googleIdentity = { sub: "g-comcom-1", email: "dev@comcom.ai", name: "D" };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect((await google()).status).toBe(200);
      await vi.waitFor(() => expect(calls).toHaveLength(1));
      await settle();
      expect(calls).toHaveLength(1);
      expect(calls[0].body).toHaveProperty("googleSub", "g-comcom-1");
    } finally {
      warn.mockRestore();
    }
  });
});

describe("never", () => {
  it("after a wallet (SIWE) sign-in", async () => {
    const addr = "0x" + "8".repeat(40);
    const { nonce } = wallet.issueNonce("anon");
    const message = new SiweMessage({ domain: "drive.example.test", address: addr, statement: "sign in", uri: PUBLIC_URL, version: "1", chainId: 84532, nonce }).prepareMessage();
    const res = await walletLoginRoute.POST(req("/api/wallet/login", { address: addr, signature: "0xsig", nonce, message }));
    expect(res.status).toBe(200);
    await settle();
    expect(calls).toHaveLength(0);
  });

  it("without the SSO client secret, or with AINDRIVE_SSO_ATTEST=false", async () => {
    delete process.env.AINDRIVE_SSO_CLIENT_SECRET;
    await login("emp@comcom.ai");
    googleIdentity = { sub: "g-gmail-1", email: "person@gmail.com", name: "P" };
    await google();
    Object.assign(process.env, SSO_ENV);
    process.env.AINDRIVE_SSO_ATTEST = "false";
    await login("emp@comcom.ai");
    await google();
    await settle();
    expect(calls).toHaveLength(0);
  });

  it("with SSO sign-in off but the client credentials set, attestations still pre-link accounts", async () => {
    process.env.AINDRIVE_SSO_ENABLED = "false";
    await login("emp@comcom.ai");
    await vi.waitFor(() => expect(calls).toHaveLength(1));
  });
});

describe("best effort", () => {
  it("the sign-in does not wait for AIN SSO", async () => {
    respond = () => new Promise<Response>(() => {}); // never answers
    const res = await Promise.race([login("emp@comcom.ai"), new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 2_000))]);
    expect(res).not.toBe("timeout");
    expect((res as Response).status).toBe(200);
  });

  it("a network failure or a 5xx never fails the sign-in; logs carry no address or Google sub", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      respond = () => { throw new TypeError("fetch failed"); };
      expect((await login("emp@comcom.ai")).status).toBe(200);
      respond = () => new Response("boom", { status: 502 });
      googleIdentity = { sub: "g-secret-sub", email: "secret@gmail.com", name: "S" };
      expect((await google()).status).toBe(200);
      await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(2));
      const logged = warn.mock.calls.flat().join(" ");
      expect(logged).not.toContain("emp@comcom.ai");
      expect(logged).not.toContain("secret@gmail.com");
      expect(logged).not.toContain("g-secret-sub");
    } finally {
      warn.mockRestore();
    }
  });

  it("answers are audited: 2xx reported, 403/409/422 rejected (normal), others failed", async () => {
    const audit = () => db.prepare("SELECT action, details FROM sso_audit WHERE user_id = 'u_emp' ORDER BY id DESC LIMIT 1").get() as { action: string; details: string };
    for (const [status, action] of [[201, "app_attest_reported"], [409, "app_attest_rejected"], [403, "app_attest_rejected"], [422, "app_attest_rejected"], [401, "app_attest_failed"], [429, "app_attest_failed"]] as const) {
      respond = () => Response.json(status < 300 ? { status: "linked", mappingId: "m" } : { error: "some_code" }, { status });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      calls.length = 0;
      await login("emp@comcom.ai");
      await vi.waitFor(() => expect(JSON.parse(audit().details)).toMatchObject({ variant: "email", status }));
      warn.mockRestore();
      expect(audit().action).toBe(action);
      expect(audit().details).not.toContain("comcom.ai");
    }
  });

  it("the decision is a pure function of what aindrive verified", () => {
    const at = new Date().toISOString();
    expect(attest.attestationFor({ userId: "u_emp", method: "password" }, at)).toEqual({ legacyUserId: "u_emp", email: "emp@comcom.ai", emailVerifiedBy: "password", legacyLoginAt: at });
    expect(attest.attestationFor({ userId: "u_old", method: "password" }, at)).toBeNull();
    expect(attest.attestationFor({ userId: "u_old", method: "google", googleSub: "s" }, at)).toEqual({ legacyUserId: "u_old", googleSub: "s", legacyLoginAt: at });
    expect(attest.attestationFor({ userId: "u_linked", method: "google", googleSub: "s" }, at)).toBeNull();
    expect(attest.isAttestableEmail("a@comcom.ai")).toBe(true);
    expect(attest.isAttestableEmail("a@comcom.ai.evil.example")).toBe(false);
    expect(attest.isAttestableEmail("a@sso.aindrive.local")).toBe(false);
  });
});
