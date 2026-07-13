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
