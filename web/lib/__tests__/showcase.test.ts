import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AINDRIVE_DATA_DIR = mkdtempSync(join(tmpdir(), "aindrive-showcase-"));

const { db } = await import("../db.js");
const { listShowcase } = await import("../showcase.js");

describe("listShowcase — leaf-DTO showcase of listed paid shares", () => {
  beforeAll(() => {
    db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?,?,?,?)")
      .run("owner1", "o@example.com", "Owner", "x");
    db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?,?,?,?)")
      .run("member1", "m@example.com", "Member", "x");
    db.prepare("INSERT INTO drives (id, owner_id, name, agent_token_hash, drive_secret) VALUES (?,?,?,?,?)")
      .run("d1", "owner1", "D1", "h", "s");
    // member1's only coverage: viewer at "docs".
    db.prepare("INSERT INTO drive_members (id, drive_id, user_id, path, role) VALUES (?,?,?,?,?)")
      .run("dm1", "d1", "member1", "docs", "viewer");

    const insert = db.prepare(`
      INSERT INTO shares (id, drive_id, path, role, token, price_usdc, currency, listed, expires_at)
      VALUES (?,?,?,?,?,?,?,?,?)
    `);
    // listed paid share at a nested path member1 does NOT cover
    insert.run("sh_nested", "d1", "premium/inner", "viewer", "tok_nested", 5, "USDC", 1, null);
    // paid but NOT listed — private, must never surface
    insert.run("sh_unlisted", "d1", "secret", "viewer", "tok_unlisted", 9, "USDC", 0, null);
    // listed paid share at a path member1 already covers
    insert.run("sh_covered", "d1", "docs", "viewer", "tok_covered", 3, "USDC", 1, null);
    // listed paid share at drive root ("")
    insert.run("sh_root", "d1", "", "viewer", "tok_root", 20, "USDC", 1, null);
    // listed paid share that has expired
    insert.run("sh_expired", "d1", "vault", "viewer", "tok_expired", 7, "USDC", 1, "2020-01-01T00:00:00.000Z");
  });

  it("does not expose paid shares with listed=0", () => {
    const items = listShowcase("d1", "member1");
    expect(items.some((i) => i.token === "tok_unlisted")).toBe(false);
  });

  it("excludes shares whose path the caller already covers", () => {
    const items = listShowcase("d1", "member1");
    expect(items.some((i) => i.token === "tok_covered")).toBe(false);
    // sanity: an uncovered listed share IS present
    expect(items.some((i) => i.token === "tok_nested")).toBe(true);
  });

  it("exposes only the leaf name — the full path never appears in the JSON", () => {
    const items = listShowcase("d1", "member1");
    const nested = items.find((i) => i.token === "tok_nested")!;
    expect(nested.leafName).toBe("inner");
    expect(nested.price).toBe(5);
    expect(nested.currency).toBe("USDC");
    // Security C1: no ancestor-name leak anywhere in the serialized result.
    const json = JSON.stringify(items);
    expect(json).not.toContain("premium/inner");
    expect(json).not.toContain("premium");
  });

  it('labels a root ("") share as "(drive)"', () => {
    const items = listShowcase("d1", "member1");
    const root = items.find((i) => i.token === "tok_root")!;
    expect(root.leafName).toBe("(drive)");
  });

  it("excludes expired listed shares [rev2-E]", () => {
    const items = listShowcase("d1", "member1");
    expect(items.some((i) => i.token === "tok_expired")).toBe(false);
  });
});
