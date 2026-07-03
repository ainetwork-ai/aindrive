import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import bcrypt from "bcryptjs";

process.env.AINDRIVE_DATA_DIR = mkdtempSync(join(tmpdir(), "aindrive-signup-verify-"));

const cookieJar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: () => Promise.resolve({
    get: (n: string) => (cookieJar.has(n) ? { name: n, value: cookieJar.get(n) } : undefined),
    set: (n: string, v: string) => { cookieJar.set(n, v); },
    delete: (n: string) => { cookieJar.delete(n); },
  }),
}));

const sent: Array<{ to: string; text: string }> = [];
vi.mock("@/lib/email", () => ({
  sendMail: async (m: { to: string; text: string }) => { sent.push(m); },
  mailConfigured: () => true,
}));

const { db } = await import("../db.js");
const { POST: requestCode } = await import("../../app/api/auth/signup/request-code/route.js");
const { POST: signup } = await import("../../app/api/auth/signup/route.js");

const req = (body: object, ip = "9.9.9.9") =>
  new Request("http://x/api", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip }, body: JSON.stringify(body) });
const codeFromLastMail = () => sent.at(-1)!.text.match(/\b(\d{6})\b/)![1];

beforeEach(() => {
  sent.length = 0; cookieJar.clear();
  db.prepare("DELETE FROM email_verification_codes").run();
  db.prepare("DELETE FROM users").run();
  (globalThis as { __rl_buckets__?: Map<unknown, unknown> }).__rl_buckets__?.clear();
});

describe("signup verify-before-create", () => {
  it("request-code emails a signup code for a new email", async () => {
    const res = await requestCode(req({ email: "new@example.com" }, "1.1.1.1"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(sent).toHaveLength(1);
  });

  it("request-code returns alreadyRegistered (and sends nothing) for an existing email", async () => {
    db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?,?,?,?)")
      .run("u0", "taken@example.com", "T", await bcrypt.hash("x".repeat(8), 10));
    const res = await requestCode(req({ email: "taken@example.com" }, "1.1.1.2"));
    expect(await res.json()).toEqual({ ok: true, alreadyRegistered: true });
    expect(sent).toHaveLength(0);
  });

  it("signup with the emailed code creates the account + sets a session", async () => {
    await requestCode(req({ email: "alice@example.com" }, "1.1.1.3"));
    const res = await signup(req({ email: "alice@example.com", code: codeFromLastMail(), name: "Alice", password: "supersecret" }, "1.1.1.3"));
    expect(res.status).toBe(200);
    const user = db.prepare("SELECT id, name FROM users WHERE lower(email)=lower(?)").get("alice@example.com") as { id: string; name: string } | undefined;
    expect(user?.name).toBe("Alice");
    expect(cookieJar.get("aindrive_session")).toBeTruthy(); // session issued
  });

  it("signup is REJECTED without a valid code — no account created", async () => {
    await requestCode(req({ email: "bob@example.com" }, "1.1.1.4"));
    const res = await signup(req({ email: "bob@example.com", code: "000000", name: "Bob", password: "supersecret" }, "1.1.1.4"));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_code");
    expect(db.prepare("SELECT id FROM users WHERE lower(email)=lower(?)").get("bob@example.com")).toBeUndefined();
  });

  it("signup missing the code field is a 400 (schema)", async () => {
    const res = await signup(req({ email: "c@example.com", name: "C", password: "supersecret" }, "1.1.1.5"));
    expect(res.status).toBe(400);
  });

  it("a code can't be reused for a second signup", async () => {
    await requestCode(req({ email: "dana@example.com" }, "1.1.1.6"));
    const code = codeFromLastMail();
    await signup(req({ email: "dana@example.com", code, name: "Dana", password: "supersecret" }, "1.1.1.6"));
    // delete the account and try to reuse the same code → consumed already
    db.prepare("DELETE FROM users WHERE lower(email)=lower(?)").run("dana@example.com");
    const res = await signup(req({ email: "dana@example.com", code, name: "Dana2", password: "supersecret" }, "1.1.1.6"));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("no_active_code");
  });
});
