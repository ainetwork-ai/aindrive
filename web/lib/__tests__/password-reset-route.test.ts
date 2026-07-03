import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import bcrypt from "bcryptjs";

process.env.AINDRIVE_DATA_DIR = mkdtempSync(join(tmpdir(), "aindrive-reset-route-"));

// Capture outgoing mail instead of sending; the 6-digit code is only delivered
// by email, so tests recover it from the captured body.
const sent: Array<{ to: string; text: string }> = [];
vi.mock("@/lib/email", () => ({
  sendMail: async (m: { to: string; text: string }) => { sent.push(m); },
  mailConfigured: () => true,
}));

const { db } = await import("../db.js");
const { POST: forgot } = await import("../../app/api/auth/forgot-password/route.js");
const { POST: reset } = await import("../../app/api/auth/reset-password/route.js");

const req = (body: object, ip = "1.2.3.4") =>
  new Request("http://x/api", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip }, body: JSON.stringify(body) });
const codeFromLastMail = () => sent.at(-1)!.text.match(/\b(\d{6})\b/)![1];

beforeAll(async () => {
  db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?,?,?,?)")
    .run("u1", "alice@example.com", "Alice", await bcrypt.hash("oldpassword", 10));
});
beforeEach(() => {
  sent.length = 0;
  db.prepare("DELETE FROM email_verification_codes").run();
  // The rate limiter is a module-level globalThis Map; clear it so per-email /
  // per-IP limits from earlier tests don't bleed into the next one.
  (globalThis as { __rl_buckets__?: Map<unknown, unknown> }).__rl_buckets__?.clear();
});

describe("POST /api/auth/forgot-password — anti-enumeration", () => {
  it("returns 200 and sends a code for a registered email", async () => {
    const res = await forgot(req({ email: "alice@example.com" }, "10.0.0.1"));
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("alice@example.com");
  });
  it("returns the SAME 200 and sends NOTHING for an unregistered email", async () => {
    const res = await forgot(req({ email: "nobody@example.com" }, "10.0.0.2"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(sent).toHaveLength(0);
  });
});

describe("POST /api/auth/reset-password — full flow", () => {
  it("resets the password with the emailed code, and the new password works", async () => {
    await forgot(req({ email: "alice@example.com" }, "10.0.0.3"));
    const code = codeFromLastMail();
    const res = await reset(req({ email: "alice@example.com", code, newPassword: "brandnewpass" }, "10.0.0.3"));
    expect(res.status).toBe(200);
    const row = db.prepare("SELECT password_hash FROM users WHERE id = 'u1'").get() as { password_hash: string };
    expect(await bcrypt.compare("brandnewpass", row.password_hash)).toBe(true);
  });

  it("rejects a wrong code (400 invalid_code) without changing the password", async () => {
    await forgot(req({ email: "alice@example.com" }, "10.0.0.4"));
    const res = await reset(req({ email: "alice@example.com", code: "000000", newPassword: "anotherpass" }, "10.0.0.4"));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_code");
  });

  it("rejects a too-short new password (400 invalid input)", async () => {
    await forgot(req({ email: "alice@example.com" }, "10.0.0.5"));
    const res = await reset(req({ email: "alice@example.com", code: codeFromLastMail(), newPassword: "short" }, "10.0.0.5"));
    expect(res.status).toBe(400);
  });
});
