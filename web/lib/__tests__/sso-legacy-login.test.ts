// The rollout switches on the legacy sign-in paths (AIN SSO runbook
// migration-rollback.md): AINDRIVE_LEGACY_LOGIN=true | unlinked_only | false,
// email-OTP reset never for AIN-linked accounts, Google sign-in never links
// by email, and the boot checks that refuse a mistyped switch.
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import bcrypt from "bcryptjs";
import { SiweMessage } from "siwe";
import { CLIENT_ID, CLIENT_SECRET, cookieJar, ISSUER, PUBLIC_URL } from "./sso-test-issuer";

process.env.AINDRIVE_DATA_DIR = mkdtempSync(join(tmpdir(), "aindrive-sso-legacy-"));
process.env.AINDRIVE_PUBLIC_URL = PUBLIC_URL;
process.env.AINDRIVE_SESSION_SECRET = "sso-legacy-test-secret-0123456789abcdef";
process.env.AINDRIVE_SSO_ISSUER = ISSUER;
process.env.AINDRIVE_SSO_CLIENT_ID = CLIENT_ID;
process.env.AINDRIVE_SSO_CLIENT_SECRET = CLIENT_SECRET;
process.env.AINDRIVE_SSO_ENABLED = "true";
process.env.AINDRIVE_GOOGLE_CLIENT_IDS = "web-client.apps.googleusercontent.com";

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
const session = await import("../session");
const store = await import("../sso/store.js");
const policy = await import("../sso/policy");
const otp = await import("../otp");
const wallet = await import("../wallet");
const { ssoConfigErrors } = await import("../boot-checks.js");
const loginRoute = await import("../../app/api/auth/login/route.js");
const signupRoute = await import("../../app/api/auth/signup/route.js");
const requestCodeRoute = await import("../../app/api/auth/signup/request-code/route.js");
const forgotRoute = await import("../../app/api/auth/forgot-password/route.js");
const resetRoute = await import("../../app/api/auth/reset-password/route.js");
const googleRoute = await import("../../app/api/auth/google/route.js");
const walletLoginRoute = await import("../../app/api/wallet/login/route.js");

const req = (path: string, body: unknown) =>
  new Request(`${PUBLIC_URL}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const login = (email: string, password: string) => loginRoute.POST(req("/api/auth/login", { email, password }));
const mode = (m: "true" | "unlinked_only" | "false") => { process.env.AINDRIVE_LEGACY_LOGIN = m; };

beforeAll(async () => {
  const hash = await bcrypt.hash("pw-123456", 4);
  for (const [id, email] of [["u_plain", "plain@example.com"], ["u_linked", "linked@example.com"]]) {
    db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?,?,?,?)").run(id, email, id, hash);
  }
  store.linkExistingUser({ issuer: ISSUER, subject: "acc_linked", userId: "u_linked", method: "test", actor: "test" });
  db.prepare("INSERT INTO account_google (sub, account_id, email) VALUES (?,?,?)").run("g-linked", "u_linked", "linked@example.com");
});
beforeEach(() => {
  jar.clear();
  sent.length = 0;
  (globalThis as { __rl_buckets__?: Map<unknown, unknown> }).__rl_buckets__?.clear();
  mode("true");
});

describe("AINDRIVE_LEGACY_LOGIN", () => {
  it("true: every account signs in with its password", async () => {
    expect((await login("plain@example.com", "pw-123456")).status).toBe(200);
    expect((await login("linked@example.com", "pw-123456")).status).toBe(200);
  });

  it("unlinked_only: AIN-linked accounts must use AIN; others keep their password", async () => {
    mode("unlinked_only");
    expect((await login("plain@example.com", "pw-123456")).status).toBe(200);
    const res = await login("linked@example.com", "pw-123456");
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("sso_required");
    // A wrong password learns nothing about the link.
    expect((await login("linked@example.com", "wrong")).status).toBe(401);
  });

  it("false: no legacy sign-in, signup or email reset for anyone", async () => {
    mode("false");
    expect((await (await login("plain@example.com", "pw-123456")).json()).error).toBe("legacy_login_disabled");
    expect((await signupRoute.POST(req("/api/auth/signup", { email: "new@example.com", name: "N", password: "longpassword" }))).status).toBe(403);
    expect((await requestCodeRoute.POST(req("/api/auth/signup/request-code", { email: "new@example.com" }))).status).toBe(403);
    expect((await forgotRoute.POST(req("/api/auth/forgot-password", { email: "plain@example.com" }))).status).toBe(403);
    expect(sent).toHaveLength(0);
  });

  it("is ignored while SSO login is off (that IS the rollback)", async () => {
    mode("false");
    process.env.AINDRIVE_SSO_ENABLED = "false";
    try {
      expect((await login("linked@example.com", "pw-123456")).status).toBe(200);
    } finally {
      process.env.AINDRIVE_SSO_ENABLED = "true";
    }
  });
});

describe("email-OTP reset is never available to an AIN-linked account", () => {
  it("forgot-password answers the same 200 but sends nothing to a linked account", async () => {
    const res = await forgotRoute.POST(req("/api/auth/forgot-password", { email: "linked@example.com" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(sent).toHaveLength(0);
    await forgotRoute.POST(req("/api/auth/forgot-password", { email: "plain@example.com" }));
    expect(sent.map((m) => m.to)).toEqual(["plain@example.com"]);
  });

  it("a code issued before the account was linked cannot reset it (under any switch)", async () => {
    for (const m of ["true", "unlinked_only"] as const) {
      mode(m);
      const code = otp.issueOtpCode("linked@example.com", "reset_password");
      const res = await resetRoute.POST(req("/api/auth/reset-password", { email: "linked@example.com", code, newPassword: "takeover-password" }));
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe("reset_unavailable");
    }
    expect((await login("linked@example.com", "takeover-password")).status).toBe(401);
    expect(policy.passwordResetRefusal("u_plain")).toBeNull();
  });
});

describe("Google sign-in never links by email", () => {
  it("an existing account with that email is refused (409 email_in_use), not taken over", async () => {
    googleIdentity = { sub: "g-new-person", email: "plain@example.com", name: "Someone" };
    const res = await googleRoute.POST(req("/api/auth/google", { idToken: "x".repeat(40) }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("email_in_use");
    expect(jar.get("aindrive_session")).toBeUndefined();
    expect(db.prepare("SELECT 1 FROM account_google WHERE sub = 'g-new-person'").get()).toBeUndefined();
  });

  it("a new email still creates an account, a linked Google sub still signs in", async () => {
    googleIdentity = { sub: "g-fresh", email: "fresh@example.com", name: "Fresh" };
    expect((await googleRoute.POST(req("/api/auth/google", { idToken: "x".repeat(40) }))).status).toBe(200);
    googleIdentity = { sub: "g-linked", email: "linked@example.com", name: "L" };
    expect((await googleRoute.POST(req("/api/auth/google", { idToken: "x".repeat(40) }))).status).toBe(200);
  });

  it("follows the switches: unlinked_only refuses an AIN-linked account, false refuses all", async () => {
    mode("unlinked_only");
    googleIdentity = { sub: "g-linked", email: "linked@example.com", name: "L" };
    expect((await (await googleRoute.POST(req("/api/auth/google", { idToken: "x".repeat(40) }))).json()).error).toBe("sso_required");
    mode("false");
    googleIdentity = { sub: "g-other", email: "other@example.com", name: "O" };
    expect((await googleRoute.POST(req("/api/auth/google", { idToken: "x".repeat(40) }))).status).toBe(403);
    expect(db.prepare("SELECT 1 FROM users WHERE email = 'other@example.com'").get()).toBeUndefined();
  });
});

describe("wallet (SIWE) sign-in follows the same rules", () => {
  const addr = "0x" + "7".repeat(40);
  function signed() {
    const { nonce } = wallet.issueNonce("anon");
    const message = new SiweMessage({ domain: "drive.example.test", address: addr, statement: "sign in", uri: PUBLIC_URL, version: "1", chainId: 84532, nonce }).prepareMessage();
    return walletLoginRoute.POST(req("/api/wallet/login", { address: addr, signature: "0xsig", nonce, message }));
  }
  it("a suspended account's wallet cannot sign in; false refuses before creating an account", async () => {
    mode("false");
    expect((await signed()).status).toBe(403);
    expect(wallet.walletLoginAccount(addr)).toBeNull();
    mode("true");
    expect((await signed()).status).toBe(200);
    const accountId = wallet.walletLoginAccount(addr)!.accountId;
    db.prepare(`INSERT INTO sso_memberships (issuer, org_id, subject, user_id, status, applied_version, updated_at) VALUES (?, 'o', 'acc_w', ?, 'suspended', 1, ?)`)
      .run(ISSUER, accountId, Date.now());
    const res = await signed();
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("account_suspended");
  });
});

describe("boot checks refuse a mistyped switch (production only)", () => {
  it("flags invalid values and half-configured SSO", () => {
    expect(ssoConfigErrors({ AINDRIVE_LEGACY_LOGIN: "flase" })[0]).toMatch(/AINDRIVE_LEGACY_LOGIN/);
    expect(ssoConfigErrors({ AINDRIVE_SSO_ENABLED: "yes" })[0]).toMatch(/AINDRIVE_SSO_ENABLED/);
    expect(ssoConfigErrors({ AINDRIVE_SSO_ISSUER: "https://auth.example" }).join()).toMatch(/set together/);
    expect(ssoConfigErrors({ AINDRIVE_SSO_ISSUER: "http://auth.example", AINDRIVE_SSO_CLIENT_ID: "c" }).join()).toMatch(/https/);
    expect(ssoConfigErrors({ AINDRIVE_SSO_ENABLED: "true", AINDRIVE_SSO_ISSUER: "https://auth.example", AINDRIVE_SSO_CLIENT_ID: "c" }).join()).toMatch(/CLIENT_SECRET/);
    expect(ssoConfigErrors({ AINDRIVE_SSO_ENABLED: "true", AINDRIVE_SSO_ISSUER: "https://auth.example", AINDRIVE_SSO_CLIENT_ID: "c", AINDRIVE_SSO_CLIENT_SECRET: "s", AINDRIVE_LEGACY_LOGIN: "unlinked_only" })).toEqual([]);
  });

  it("the placeholder domains are reserved for signup", () => {
    expect(store.isReservedEmail("x@sso.aindrive.local")).toBe(true);
    expect(store.isReservedEmail("0xabc@wallet.aindrive.local")).toBe(true);
    expect(store.isReservedEmail("a@example.com")).toBe(false);
  });

  it("session tokens of a linked account remain ordinary until an SSO event ends them", async () => {
    const t = await session.sign("u_linked");
    expect(await session.verify(t)).toBe("u_linked");
  });
});
