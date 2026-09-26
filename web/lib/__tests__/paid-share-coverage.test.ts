import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AINDRIVE_DATA_DIR = mkdtempSync(join(tmpdir(), "aindrive-paid-coverage-"));

const cookieJar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: () => Promise.resolve({
    get: (name: string) => {
      const value = cookieJar.get(name);
      return value === undefined ? undefined : { name, value };
    },
    set: (name: string, value: string) => { cookieJar.set(name, value); },
    delete: (name: string) => { cookieJar.delete(name); },
  }),
}));

const { db } = await import("../db.js");
const { sign } = await import("../session.js");
const shareRoute = await import("../../app/api/s/[token]/route.js");
const acceptRoute = await import("../../app/api/s/[token]/accept/route.js");

// "Already has what this paid link sells" must follow the read gate, not the
// role alone: a bare viewer of the PARENT folder can't read a paid subfolder
// (paid carve-out), so the link must ask them to pay — otherwise the drive
// shows the paywall, Buy leads here, here sends them back: no way to buy.
const DRIVE = "d-cov";
const TOKEN = "tok-cov";
const ctx = { params: Promise.resolve({ token: TOKEN }) };

beforeAll(() => {
  for (const [id, email] of [["o-cov", "o@c"], ["parent-viewer", "pv@c"], ["buyer", "b@c"], ["editor", "e@c"]]) {
    db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?,?,?,?)").run(id, email, "N", "x");
  }
  db.prepare("INSERT INTO drives (id, owner_id, name, agent_token_hash, drive_secret, payout_wallet) VALUES (?,?,?,?,?,?)")
    .run(DRIVE, "o-cov", "Grandma", "h", "s", "0x1111111111111111111111111111111111111111");
  db.prepare("INSERT INTO shares (id, drive_id, path, role, token, price_usdc, listed) VALUES (?,?,?,?,?,?,?)")
    .run("sh-cov", DRIVE, "recipes/chuseok", "viewer", TOKEN, 1, 1);
  const member = (id: string, user: string, path: string, role: string) =>
    db.prepare("INSERT INTO drive_members (id, drive_id, user_id, path, role) VALUES (?,?,?,?,?)").run(id, DRIVE, user, path, role);
  member("m-pv", "parent-viewer", "recipes", "viewer");      // free link to the parent folder
  member("m-b1", "buyer", "recipes", "viewer");
  member("m-b2", "buyer", "recipes/chuseok", "viewer");      // what a settled payment writes…
  db.prepare("INSERT INTO payment_receipts (id, drive_id, path, wallet, tx_hash, amount_usdc, network, share_id, account_id) VALUES (?,?,?,?,?,?,?,?,?)")
    .run("r-b", DRIVE, "recipes/chuseok", "0xb", "tx-b", 1, "base", "sh-cov", "buyer"); // …with its receipt
  member("m-e", "editor", "recipes", "editor");              // managers read paid content freely
});
beforeEach(() => cookieJar.clear());
const as = async (user: string) => cookieJar.set("aindrive_session", await sign(user));

describe("GET /s/:token — who already has a paid link's content", () => {
  it("a viewer of the parent folder, without a receipt, is asked to pay", async () => {
    await as("parent-viewer");
    expect((await shareRoute.GET(new Request(`http://x/api/s/${TOKEN}`), ctx)).status).toBe(402);
  });

  it("a buyer with the receipt is let through", async () => {
    await as("buyer");
    expect((await shareRoute.GET(new Request(`http://x/api/s/${TOKEN}`), ctx)).status).toBe(200);
  });

  it("an editor of the parent folder is let through (managers aren't charged)", async () => {
    await as("editor");
    expect((await shareRoute.GET(new Request(`http://x/api/s/${TOKEN}`), ctx)).status).toBe(200);
  });
});

describe("POST /s/:token/accept — same decision", () => {
  it("a viewer of the parent folder can't accept a paid link without paying", async () => {
    await as("parent-viewer");
    expect((await acceptRoute.POST(new Request(`http://x/api/s/${TOKEN}/accept`, { method: "POST" }), ctx)).status).toBe(402);
  });

  it("a buyer with the receipt can", async () => {
    await as("buyer");
    expect((await acceptRoute.POST(new Request(`http://x/api/s/${TOKEN}/accept`, { method: "POST" }), ctx)).status).toBe(200);
  });
});
