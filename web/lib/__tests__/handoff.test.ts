import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AINDRIVE_DATA_DIR = mkdtempSync(join(tmpdir(), "aindrive-handoff-"));
const { db } = await import("../db.js");
const { createHandoffs, openHandoff, logFetch, listHandoffs, revokeHandoffs } = await import("../handoff");

db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?,?,?,?)").run("u1", "u1@example.com", "U1", "x");
db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?,?,?,?)").run("u2", "u2@example.com", "U2", "x");
const file = (k: string) => ({ deviceKey: k.padEnd(20, "x"), name: `${k}.jpg`, mime: "image/jpeg", size: 1234 });

describe("file handoff links", () => {
  it("opens with the right secret only", () => {
    const [l] = createHandoffs("u1", "d1", [file("a")], "Weather Agent", 600);
    expect("row" in openHandoff(l.id, l.secret)).toBe(true);
    expect(openHandoff(l.id, "wrong")).toEqual({ error: "not_found" });
    expect(openHandoff("nope", l.secret)).toEqual({ error: "not_found" });
  });

  it("expires", () => {
    const [l] = createHandoffs("u1", "d1", [file("b")], "A", 600);
    db.prepare("UPDATE file_handoffs SET expires_at = datetime('now', '-1 second') WHERE id = ?").run(l.id);
    expect(openHandoff(l.id, l.secret)).toEqual({ error: "expired" });
  });

  it("is revocable by its owner only, one link or a whole audience", () => {
    const [a, b] = createHandoffs("u1", "d1", [file("c"), file("d")], "Agent X", 600);
    expect(revokeHandoffs("u2", { id: a.id })).toBe(0);
    expect(revokeHandoffs("u1", { id: a.id })).toBe(1);
    expect(openHandoff(a.id, a.secret)).toEqual({ error: "revoked" });
    expect(revokeHandoffs("u1", { audience: "Agent X" })).toBe(1);
    expect(openHandoff(b.id, b.secret)).toEqual({ error: "revoked" });
  });

  it("logs fetches for the audit list, and caps the lifetime", () => {
    const [l] = createHandoffs("u1", "d1", [file("e")], "Auditor", 10 * 24 * 3600);
    logFetch(l.id, "1.2.3.4", "agent/1.0", 200);
    logFetch(l.id, "1.2.3.4", "agent/1.0", 200);
    const row = (listHandoffs("u1") as { id: string; fetches: number; expires_at: string }[]).find((r) => r.id === l.id)!;
    expect(row.fetches).toBe(2);
    expect(Date.parse(row.expires_at.replace(" ", "T") + "Z") - Date.now()).toBeLessThanOrEqual(3600 * 1000 + 2000);
  });
});
