// With no AINDRIVE_SSO_* configuration aindrive must behave exactly as before
// the AIN SSO integration: no new endpoint answers, legacy session tokens keep
// verifying, every legacy sign-in works whatever AINDRIVE_LEGACY_LOGIN says,
// and newly minted session tokens have the same shape as before.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import bcrypt from "bcryptjs";
import { SignJWT, decodeJwt } from "jose";
import { cookieJar, PUBLIC_URL } from "./sso-test-issuer";

process.env.AINDRIVE_DATA_DIR = mkdtempSync(join(tmpdir(), "aindrive-sso-off-"));
process.env.AINDRIVE_PUBLIC_URL = PUBLIC_URL;
process.env.AINDRIVE_SESSION_SECRET = "sso-off-test-secret-0123456789abcdef";
for (const k of ["AINDRIVE_SSO_ISSUER", "AINDRIVE_SSO_CLIENT_ID", "AINDRIVE_SSO_CLIENT_SECRET", "AINDRIVE_SSO_ENABLED", "AINDRIVE_LEGACY_LOGIN"]) delete process.env[k];

const { jar, cookies } = cookieJar();
vi.mock("next/headers", () => ({ cookies }));
const sent: Array<{ to: string }> = [];
vi.mock("@/lib/email", () => ({ sendMail: async (m: { to: string }) => { sent.push(m); }, mailConfigured: () => true }));

const { db } = await import("../db.js");
const session = await import("../session");
const config = await import("../sso/config");
const { ssoConfigErrors } = await import("../boot-checks.js");
const ssoConfigRoute = await import("../../app/api/auth/sso/route.js");
const startRoute = await import("../../app/api/auth/sso/start/route.js");
const callbackRoute = await import("../../app/api/auth/sso/callback/route.js");
const linkRoute = await import("../../app/api/auth/sso/link/route.js");
const backchannelRoute = await import("../../app/api/auth/sso/backchannel-logout/route.js");
const healthRoute = await import("../../app/api/sso/v1/health/route.js");
const userRoute = await import("../../app/api/sso/v1/orgs/[orgId]/users/[sub]/route.js");
const loginRoute = await import("../../app/api/auth/login/route.js");
const forgotRoute = await import("../../app/api/auth/forgot-password/route.js");

const json = (url: string, body: unknown, method = "POST") =>
  new Request(url, { method, headers: { "content-type": "application/json", origin: PUBLIC_URL }, body: JSON.stringify(body) });

db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?,?,?,?)").run("u1", "alice@example.com", "Alice", await bcrypt.hash("password-1", 4));

beforeEach(() => {
  jar.clear();
  sent.length = 0;
  (globalThis as { __rl_buckets__?: Map<unknown, unknown> }).__rl_buckets__?.clear();
  delete process.env.AINDRIVE_LEGACY_LOGIN;
});

describe("AIN SSO unconfigured — nothing new is reachable", () => {
  it("the SSO config, sign-in and link endpoints answer 404", async () => {
    expect(config.ssoLoginEnabled()).toBe(false);
    expect(config.adapterConfig()).toBeNull();
    expect((ssoConfigRoute.GET()).status).toBe(404);
    expect((await startRoute.GET(new Request(`${PUBLIC_URL}/api/auth/sso/start`))).status).toBe(404);
    expect((await callbackRoute.GET(new Request(`${PUBLIC_URL}/api/auth/sso/callback?code=x&state=y`))).status).toBe(404);
    expect((await linkRoute.POST(json(`${PUBLIC_URL}/api/auth/sso/link`, { method: "new" }))).status).toBe(404);
  });

  it("the provisioning adapter and back-channel logout answer 404 and change nothing", async () => {
    expect((await healthRoute.GET(new Request(`${PUBLIC_URL}/api/sso/v1/health`))).status).toBe(404);
    const put = await userRoute.PUT(
      new Request(`${PUBLIC_URL}/api/sso/v1/orgs/org_1/users/acc_1`, { method: "PUT", body: "{}", headers: { authorization: "Bearer x.y.z" } }),
      { params: Promise.resolve({ orgId: "org_1", sub: "acc_1" }) },
    );
    expect(put.status).toBe(404);
    const bc = await backchannelRoute.POST(new Request(`${PUBLIC_URL}/api/auth/sso/backchannel-logout`, { method: "POST", body: "logout_token=x" }));
    expect(bc.status).toBe(404);
    expect((db.prepare("SELECT count(*) c FROM sso_memberships").get() as { c: number }).c).toBe(0);
    expect((db.prepare("SELECT count(*) c FROM sso_identities").get() as { c: number }).c).toBe(0);
  });

  it("boot checks have nothing to say about SSO when none of its variables is set", () => {
    expect(ssoConfigErrors({})).toEqual([]);
    expect(ssoConfigErrors({ AINDRIVE_SESSION_SECRET: "x" })).toEqual([]);
  });
});

describe("AIN SSO unconfigured — sessions and legacy sign-in unchanged", () => {
  it("a session token minted before this change still verifies", async () => {
    const old = await new SignJWT({ sub: "u1" }).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("30d")
      .sign(new TextEncoder().encode(process.env.AINDRIVE_SESSION_SECRET));
    expect(await session.verify(old)).toBe("u1");
    jar.set("aindrive_session", old);
    expect(await session.getUser()).toEqual({ id: "u1", email: "alice@example.com", name: "Alice" });
  });

  it("new session tokens keep the old shape: {sub, iat, exp} only", async () => {
    const t = await session.sign("u1");
    expect(Object.keys(decodeJwt(t)).sort()).toEqual(["exp", "iat", "sub"]);
  });

  it("password sign-in works — AINDRIVE_LEGACY_LOGIN is ignored while SSO login is off", async () => {
    process.env.AINDRIVE_LEGACY_LOGIN = "false";
    expect(config.legacyLoginMode()).toBe("true");
    const res = await loginRoute.POST(json(`${PUBLIC_URL}/api/auth/login`, { email: "alice@example.com", password: "password-1" }));
    expect(res.status).toBe(200);
    expect(await session.verify(jar.get("aindrive_session")!)).toBe("u1");
  });

  it("email reset still sends a code to an ordinary account", async () => {
    const res = await forgotRoute.POST(json(`${PUBLIC_URL}/api/auth/forgot-password`, { email: "alice@example.com" }));
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(1);
  });

  it("an ordinary account is 'unmanaged': no gate applies", async () => {
    const store = await import("../sso/store.js");
    expect(store.ssoAccountState("u1")).toBe("unmanaged");
    expect(store.isAccountBlocked("u1")).toBe(false);
    expect(store.isSsoLinked("u1")).toBe(false);
  });
});
