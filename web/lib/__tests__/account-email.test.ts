import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AINDRIVE_DATA_DIR = mkdtempSync(join(tmpdir(), "aindrive-attach-"));

// Auth + mail stubbed; OTP + DB are real (we assert real rows/updates).
let currentUser: { id: string; email: string; name: string } | null = null;
vi.mock("@/lib/session", () => ({ getUser: async () => currentUser, setCookie: async () => {} }));
vi.mock("@/lib/email", () => ({ sendMail: vi.fn(async () => {}), mailConfigured: () => true }));
vi.mock("@/lib/rate-limit", () => ({ tryConsume: () => ({ ok: true }), clientKey: () => "k" }));

const { db } = await import("../db.js");
const { POST: START } = await import("../../app/api/account/email/start/route.js");

// Seed a wallet-only account (synthetic email) and a real account.
db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?,?,?,?)")
  .run("w1", "0xabc0000000000000000000000000000000000001@wallet.aindrive.local", "wallet:0xabc", "x");
db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?,?,?,?)")
  .run("r1", "taken@example.com", "R1", "x");

const jsonReq = (body: unknown) => new Request("http://localhost/api/account/email/start", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});

describe("POST /api/account/email/start", () => {
  beforeEach(() => { currentUser = null; });

  it("401 when not logged in", async () => {
    expect((await START(jsonReq({ email: "new@example.com" }))).status).toBe(401);
  });

  it("403 when the account is not wallet-only", async () => {
    currentUser = { id: "r1", email: "taken@example.com", name: "R1" };
    expect((await START(jsonReq({ email: "new2@example.com" }))).status).toBe(403);
  });

  it("409 when the target email is already taken", async () => {
    currentUser = { id: "w1", email: "0xabc0000000000000000000000000000000000001@wallet.aindrive.local", name: "w" };
    expect((await START(jsonReq({ email: "taken@example.com" }))).status).toBe(409);
  });

  it("200 and issues an OTP for a free email on a wallet-only account", async () => {
    currentUser = { id: "w1", email: "0xabc0000000000000000000000000000000000001@wallet.aindrive.local", name: "w" };
    const res = await START(jsonReq({ email: "new@example.com" }));
    expect(res.status).toBe(200);
    const row = db.prepare("SELECT purpose FROM email_verification_codes WHERE email = ? AND consumed = 0").get("new@example.com");
    expect(row).toMatchObject({ purpose: "attach_email" });
  });
});

const { POST: VERIFY } = await import("../../app/api/account/email/verify/route.js");
const { issueOtpCode } = await import("../otp.js");

const vReq = (body: unknown) => new Request("http://localhost/api/account/email/verify", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});

describe("POST /api/account/email/verify", () => {
  beforeEach(() => { currentUser = null; });

  it("attaches the email + password to the wallet-only account on a valid code", async () => {
    currentUser = { id: "w1", email: "0xabc0000000000000000000000000000000000001@wallet.aindrive.local", name: "w" };
    const code = issueOtpCode("attach@example.com", "attach_email");
    const res = await VERIFY(vReq({ email: "attach@example.com", code, password: "hunter2hunter2" }));
    expect(res.status).toBe(200);
    const row = db.prepare("SELECT email, password_hash FROM users WHERE id = ?").get("w1") as { email: string; password_hash: string };
    expect(row.email).toBe("attach@example.com");
    expect(row.password_hash).not.toBe("x"); // real bcrypt hash now
  });

  it("422 on a wrong code", async () => {
    currentUser = { id: "w1", email: "attach@example.com", name: "w" }; // note: now real after prior test — reseed a fresh wallet-only user
    db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?,?,?,?)")
      .run("w2", "0xdef0000000000000000000000000000000000002@wallet.aindrive.local", "wallet:0xdef", "x");
    currentUser = { id: "w2", email: "0xdef0000000000000000000000000000000000002@wallet.aindrive.local", name: "w" };
    issueOtpCode("attach2@example.com", "attach_email");
    const res = await VERIFY(vReq({ email: "attach2@example.com", code: "000000", password: "hunter2hunter2" }));
    expect(res.status).toBe(422);
  });
});
