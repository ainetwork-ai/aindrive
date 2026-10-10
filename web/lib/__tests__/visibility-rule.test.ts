// Plan task 06.5: folder list, search, preview, thumbnail and download apply
// ONE permission rule (lib/listing-visibility.ts for names, require-access.ts
// readDenial for bytes). This half: the names — whatever fs/list shows (and
// hides) is exactly what list_files, stat and search show — and the shared-file
// lists (/api/me/shared, /api/oauth/shared), which never surface a name the
// caller cannot open. The byte routes: visibility-bytes.test.ts. The delegated
// fs/list: resource-delegation.test.ts.
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AINDRIVE_DATA_DIR = mkdtempSync(join(tmpdir(), "aindrive-visibility-"));
process.env.AINDRIVE_PUBLIC_URL = "https://drive.test";

vi.mock("next/headers", async () => (await import("./visibility-fixture")).nextHeadersMock());
vi.mock("../rpc", async () => (await import("./visibility-fixture")).rpcMock());
const { agentCalls, seed, ORIGIN, ctx, get, signInAs, listingView: walkListing } = await import("./visibility-fixture");

const { db } = await import("../db.js");
const { sign } = await import("../session.js");
const oauth = await import("../oauth");
const acct = await import("../account-tokens");
const { runSkill } = await import("../../shared/agent-skills");
const listRoute = await import("../../app/api/drives/[driveId]/fs/list/route.js");
const meRoute = await import("../../app/api/me/shared/route.js");
const oauthRoute = await import("../../app/api/oauth/shared/route.js");

let clientId = "";
beforeAll(() => {
  seed(db);
  clientId = oauth.registerClient("Consumer", ["https://consumer.example/cb"]).client_id;
});
beforeEach(() => { agentCalls.length = 0; });
const as = (userId: string | null) => signInAs(sign, userId);
const listingView = () => walkListing(listRoute);
type Listed = { name: string; isDir: boolean; locked?: boolean };


describe("06.5: one rule for names — fs/list, list_files, stat, search", () => {
  it("a root viewer: listed sale locked, unlisted sales and .aindrive hidden, a bought sale open", async () => {
    await as("vic");
    const view = await listingView();
    expect([...view.keys()].sort()).toEqual(["bought", "bought/z.png", "listed", "pub", "pub/a.png", "pub/notes.md", "top.md"]);
    expect(view.get("listed")).toEqual({ isDir: true, locked: true });
    expect(view.get("bought")?.locked).toBe(false);
    for (const p of view.keys()) expect(p.toLowerCase()).not.toContain(".aindrive");
  });

  it("the skills see exactly the names fs/list shows (list_files per folder, search over the tree, stat per name)", async () => {
    await as("vic");
    const view = await listingView();
    // list_files: folder by folder, the same names and locks.
    for (const dir of ["", ...[...view].filter(([, v]) => v.isDir && !v.locked).map(([p]) => p)]) {
      const r = await runSkill({ userId: "vic" }, "list_files", { drive_id: "d1", path: dir });
      expect(r.kind).toBe("ok");
      const names = ((r as { structured: { entries: Listed[] } }).structured.entries).map((e) => (dir ? `${dir}/${e.name}` : e.name)).sort();
      expect(names).toEqual([...view.keys()].filter((p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "") === dir).sort());
    }
    // search: every match is a listed path; a hidden name is never found, however it is spelled.
    for (const q of ["png", "y", "hidden", "aindrive", "config", "x", "z"]) {
      const r = await runSkill({ userId: "vic" }, "search", { drive_id: "d1", query: q });
      expect(r.kind).toBe("ok");
      const matches = (r as { structured: { matches: { path: string }[] } }).structured.matches.map((m) => m.path);
      for (const p of matches) expect(view.has(p)).toBe(true);
      const expected = [...view.keys()].filter((p) => p.split("/").pop()!.toLowerCase().includes(q) && !p.startsWith("listed/"));
      expect(matches.sort()).toEqual(expected.sort());
    }
    // stat: a hidden name answers exactly like a name that does not exist.
    const missing = await runSkill({ userId: "vic" }, "stat", { drive_id: "d1", path: "no-such.png" });
    for (const p of ["hidden", "hidden2.png"]) {
      const r = await runSkill({ userId: "vic" }, "stat", { drive_id: "d1", path: p });
      expect(r).toEqual({ ...missing, message: `no entry at ${p}` });
    }
    expect(await runSkill({ userId: "vic" }, "stat", { drive_id: "d1", path: ".aindrive/config.json" })).toMatchObject({ kind: "err", code: "forbidden" });
  });

  it("an editor sees every sale (no locks) but still never the reserved subtree", async () => {
    await as("ed");
    const view = await listingView();
    expect([...view.keys()].sort()).toEqual([
      "bought", "bought/z.png", "hidden", "hidden/y.png", "hidden2.png", "listed", "listed/x.png", "pub", "pub/a.png", "pub/notes.md", "top.md",
    ]);
    const r = await runSkill({ userId: "ed" }, "search", { drive_id: "d1", query: "aindrive" });
    expect((r as { structured: { matches: unknown[] } }).structured.matches).toEqual([]);
  });

  it("an account with no grant sees nothing on any surface", async () => {
    await as("bob");
    expect((await listRoute.GET(get("list", ""), ctx)).status).toBe(403);
    expect(await runSkill({ userId: "bob" }, "search", { drive_id: "d1", query: "png" })).toMatchObject({ kind: "err", code: "forbidden" });
    expect(agentCalls).toEqual([]);
  });
});

describe("06.5: the shared-file lists never surface a name the caller cannot open", () => {
  const issue = (userId: string) =>
    acct.issueAccountTokens({ userId, clientId, clientName: "Consumer", scopes: oauth.parseAccountScopes("drives:read") }).access_token;

  it("/api/me/shared and /api/oauth/shared: the grantee's own open grant only — never .aindrive, never an unlisted sale", async () => {
    await as("grantee");
    const me = await (await meRoute.GET(new Request(`${ORIGIN}/api/me/shared?scope=shared_with_me`))).json();
    const tok = await (await oauthRoute.GET(new Request(`${ORIGIN}/api/oauth/shared?scope=shared_with_me`, { headers: { authorization: `Bearer ${issue("grantee")}` } }))).json();
    for (const body of [me, tok]) {
      expect(body.items.map((i: { ref: { legacy: { path: string } } }) => i.ref.legacy.path)).toEqual(["/pub"]);
      expect(JSON.stringify(body).toLowerCase()).not.toContain("aindrive/");
      // A ref carries no thumbnail, preview or signed URL: bytes are fetched through the gated routes.
      for (const i of body.items) {
        expect(Object.keys(i.ref).filter((k) => /thumb|preview|url|token|content/i.test(k))).toEqual(["sourceUrl"]);
        expect(i.ref.sourceUrl).toBe(`${ORIGIN}/d/d1/pub`);
      }
    }
    // Searching the list by a hidden name finds nothing.
    for (const q of ["hidden", "aindrive", "y.png"]) {
      const r = await (await meRoute.GET(new Request(`${ORIGIN}/api/me/shared?scope=shared_with_me&q=${q}`))).json();
      expect(r.items).toEqual([]);
    }
  });

  it("a viewer's list has the root grant only: no child names (hidden or not) leak into it", async () => {
    await as("vic");
    const body = await (await meRoute.GET(new Request(`${ORIGIN}/api/me/shared?scope=shared_with_me`))).json();
    expect(body.items.map((i: { ref: { legacy: { path: string } } }) => i.ref.legacy.path)).toEqual(["/"]);
    const text = JSON.stringify(body);
    for (const name of ["hidden", "hidden2", "y.png", "x.png", "config.json"]) expect(text).not.toContain(name);
    // The list never asked the agent for anything (it cannot leak what it never saw).
    expect(agentCalls).toEqual([]);
  });
});
