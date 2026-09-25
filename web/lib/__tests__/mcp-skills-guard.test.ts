// runSkill guards reachable through remote MCP tokens: path canonicalization
// before the paywall check, the reserved `.aindrive/` subtree, and the paid
// visibility rules (R-VIS-PAID-001) on list/stat/search. The CLI agent is
// replaced by an in-memory tree.
import { describe, it, expect, beforeAll, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AINDRIVE_DATA_DIR = mkdtempSync(join(tmpdir(), "aindrive-mcp-guard-"));

const TREE: Record<string, { name: string; isDir: boolean }[]> = {
  "": [
    { name: "free.txt", isDir: false },
    { name: "paid", isDir: true },
    { name: "secret", isDir: true },
  ],
  paid: [{ name: "a.pdf", isDir: false }],
  secret: [{ name: "plan.txt", isDir: false }],
};
const reads: string[] = [];
const deletes: string[] = [];
vi.mock("../rpc", () => ({
  AgentError: class extends Error {},
  callAgent: async (_d: string, _s: string, req: { method: string; path: string }) => {
    if (req.method === "list") return { entries: TREE[req.path] ?? [] };
    if (req.method === "read") { reads.push(req.path); return { content: `content of ${req.path}` }; }
    if (req.method === "delete") { deletes.push(req.path); return { ok: true }; }
    return { ok: true };
  },
}));

const { db } = await import("../db.js");
const { runSkill, driveScopedDescriptors } = await import("../../shared/agent-skills");

const viewer = { userId: "viewer1", driveId: "d1", scope: "read" as const };
const owner = { userId: "owner1", driveId: "d1", scope: "write" as const };

beforeAll(() => {
  const u = db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?,?,?,?)");
  u.run("owner1", "o@example.com", "Owner", "x");
  u.run("viewer1", "v@example.com", "Viewer", "x");
  db.prepare("INSERT INTO drives (id, owner_id, name, agent_token_hash, drive_secret) VALUES (?,?,?,?,?)")
    .run("d1", "owner1", "D1", "h", "s");
  db.prepare("INSERT INTO drive_members (id, drive_id, user_id, path, role) VALUES (?,?,?,?,?)")
    .run("m1", "d1", "viewer1", "", "viewer");
  const sale = db.prepare(
    "INSERT INTO shares (id, drive_id, path, role, token, price_usdc, currency, listed) VALUES (?,?,?,?,?,?,?,?)",
  );
  sale.run("s-paid", "d1", "paid", "viewer", "tok1", 1, "USDC", 1);   // listed sale
  sale.run("s-secret", "d1", "secret", "viewer", "tok2", 1, "USDC", 0); // private (unlisted) sale
});

describe("runSkill guards", () => {
  it("canonicalizes the path before the paywall check", async () => {
    for (const p of ["paid/a.pdf", "/paid/a.pdf", "./paid/a.pdf", "paid//a.pdf", "paid/./a.pdf"]) {
      const r = await runSkill(viewer, "read_file", { path: p });
      expect(r.kind, p).toBe("err");
    }
    expect(reads).toEqual([]);
    const ok = await runSkill(viewer, "read_file", { path: "/free.txt" });
    expect(ok.kind).toBe("ok");
    expect(reads).toEqual(["free.txt"]);
  });

  it("rejects traversal", async () => {
    const r = await runSkill(owner, "read_file", { path: "../etc/passwd" });
    expect(r).toMatchObject({ kind: "err", code: "invalid_params" });
  });

  it("never exposes .aindrive, even to the owner", async () => {
    for (const p of [".aindrive/config.json", "/.aindrive/config.json", "./.aindrive//config.json", ".aindrive"]) {
      for (const name of ["read_file", "list_files", "stat"]) {
        const r = await runSkill(owner, name, { path: p });
        expect(r, `${name} ${p}`).toMatchObject({ kind: "err", code: "forbidden" });
      }
    }
    const w = await runSkill(owner, "write_file", { path: ".aindrive/config.json", content: "{}" });
    expect(w).toMatchObject({ kind: "err", code: "forbidden" });
    for (const p of [".aindrive", ".aindrive/config.json", "./.aindrive"]) {
      const d = await runSkill(owner, "delete_path", { path: p });
      expect(d, `delete ${p}`).toMatchObject({ kind: "err", code: "forbidden" });
    }
    expect(deletes).toEqual([]);
  });

  it("delete_path: editor only, never the root, never under a read scope", async () => {
    // read-scoped token and a viewer role are both refused before the agent is asked
    expect(await runSkill(viewer, "delete_path", { path: "free.txt" })).toMatchObject({ kind: "err", code: "forbidden" });
    expect(await runSkill({ ...viewer, scope: "write" }, "delete_path", { path: "free.txt" }))
      .toMatchObject({ kind: "err", code: "forbidden" });
    for (const p of ["", "/", ".", "./"]) {
      expect(await runSkill(owner, "delete_path", { path: p }), `root ${JSON.stringify(p)}`)
        .toMatchObject({ kind: "err", code: "invalid_params" });
    }
    expect(await runSkill(owner, "delete_path", { path: "../etc" })).toMatchObject({ kind: "err", code: "invalid_params" });
    expect(await runSkill(owner, "delete_path", { path: "missing.txt" })).toMatchObject({ kind: "err", code: "not_found" });
    expect(deletes).toEqual([]);

    const f = await runSkill(owner, "delete_path", { path: "/free.txt" });
    expect(f).toMatchObject({ kind: "ok", structured: { path: "free.txt", kind: "file" } });
    const d = await runSkill(owner, "delete_path", { path: "secret" });
    expect(d).toMatchObject({ kind: "ok", structured: { path: "secret", kind: "folder" } });
    expect(deletes).toEqual(["free.txt", "secret"]);
  });

  it("drive-scoped tools/list offers delete_path only to write tokens", () => {
    expect(driveScopedDescriptors("write").map((d) => d.name)).toContain("delete_path");
    expect(driveScopedDescriptors("read").map((d) => d.name)).not.toContain("delete_path");
  });

  it("list_files: listed sale shows locked, unlisted sale is hidden, paid folder can't be opened", async () => {
    const r = await runSkill(viewer, "list_files", {});
    expect(r.kind).toBe("ok");
    const entries = (r as { structured: { entries: { name: string; locked?: boolean }[] } }).structured.entries;
    expect(entries.map((e) => e.name)).toEqual(["free.txt", "paid"]);
    expect(entries.find((e) => e.name === "paid")?.locked).toBe(true);
    expect((await runSkill(viewer, "list_files", { path: "paid" })).kind).toBe("err");

    const asOwner = await runSkill(owner, "list_files", {});
    expect((asOwner as { structured: { entries: unknown[] } }).structured.entries).toHaveLength(3);
  });

  it("stat hides unlisted paid entries from a non-entitled viewer", async () => {
    expect(await runSkill(viewer, "stat", { path: "secret" })).toMatchObject({ kind: "err", code: "not_found" });
    expect((await runSkill(owner, "stat", { path: "secret" })).kind).toBe("ok");
  });

  it("search never enters paid subtrees or reveals unlisted sales", async () => {
    const r = await runSkill(viewer, "search", { query: "a" });
    const paths = (r as { structured: { matches: { path: string }[] } }).structured.matches.map((m) => m.path);
    expect(paths).toEqual(["paid"]);
    const asOwner = await runSkill(owner, "search", { query: "a" });
    const all = (asOwner as { structured: { matches: { path: string }[] } }).structured.matches.map((m) => m.path);
    expect(all).toEqual(expect.arrayContaining(["paid", "paid/a.pdf", "secret/plan.txt"]));
  });
});
