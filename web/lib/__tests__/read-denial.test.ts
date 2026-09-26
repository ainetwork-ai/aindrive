import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point the DB at a throwaway dir BEFORE importing db.js (it opens on import).
process.env.AINDRIVE_DATA_DIR = mkdtempSync(join(tmpdir(), "aindrive-read-denial-"));

const { db } = await import("../db.js");
const { readDenial } = await import("../require-access");

// readDenial is the one "may this role READ this path" decision beyond the role
// itself. The fs/* gate and the drive page's stat both use it, so the page can
// never reveal (by stat) what the API withholds (by 402/403).
const DRIVE = "drive-read-denial";
const OWNER = "u-rd-owner";
const BUYER = "u-rd-buyer";
const OTHER = "u-rd-other";

beforeAll(() => {
  for (const [id, email] of [[OWNER, "rdo@e.com"], [BUYER, "rdb@e.com"], [OTHER, "rdt@e.com"]]) {
    db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?,?,?,?)").run(id, email, "N", "x");
  }
  db.prepare("INSERT INTO drives (id, owner_id, name, agent_token_hash, drive_secret) VALUES (?,?,?,?,?)")
    .run(DRIVE, OWNER, "D", "h", "s");
  db.prepare("INSERT INTO shares (id, drive_id, path, role, token, price_usdc, currency, listed) VALUES (?,?,?,?,?,?,?,?)")
    .run("s-rd-premium", DRIVE, "premium", "viewer", "tok-rd-premium", 10, "AIN", 1);
  db.prepare("INSERT INTO payment_receipts (id, drive_id, path, wallet, tx_hash, amount_usdc, network, share_id, account_id) VALUES (?,?,?,?,?,?,?,?,?)")
    .run("r-rd-buyer", DRIVE, "premium", "0xw", "tx-rd", 10, "base", "s-rd-premium", BUYER);
});

describe("readDenial — reads the API withholds beyond the role", () => {
  it("free path → readable", () => {
    expect(readDenial(DRIVE, "docs/readme.md", "viewer", OTHER)).toBeNull();
  });

  it("inside a paid folder, a viewer who hasn't bought it → payment", () => {
    expect(readDenial(DRIVE, "premium/lesson3.mp4", "viewer", OTHER)).toMatchObject({ kind: "payment", gatePath: "premium" });
  });

  it("inside a paid folder, the buyer → readable", () => {
    expect(readDenial(DRIVE, "premium/lesson3.mp4", "viewer", BUYER)).toBeNull();
  });

  it("the reserved .aindrive/ subtree → reserved, even for the owner", () => {
    expect(readDenial(DRIVE, ".aindrive/agents/a1.json", "owner", OWNER)).toEqual({ kind: "reserved" });
  });
});

describe("drive page — stats paths only through readDenial", () => {
  const src = readFileSync(join(__dirname, "../../app/d/[driveId]/page.tsx"), "utf8");
  it("uses the shared read decision", () => {
    expect(src).toMatch(/import \{[^}]*\breadDenial\b[^}]*\} from "@\/lib\/require-access"/);
    expect(src).toMatch(/readDenial\(driveId, p, role, user\.id\)/);
  });
  it("has exactly one agent stat call site — the gated one", () => {
    // a call passes arguments ("statEntry(driveId, …"); the definition declares them ("statEntry(driveId: …")
    expect(src.match(/statEntry\(driveId,/g)).toHaveLength(1);
  });
});
