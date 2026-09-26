// AINUI negotiation end to end through the route handlers (MCP, AG-UI, A2A),
// with the CLI agent mocked by a small in-memory drive:
//   - without the opt-in, output is the basic A2UI exactly as before;
//   - with it, surfaces use the AINUI catalog and write actions run — but only
//     through the same allow-list / scope / role checks as a direct tool call.
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AINDRIVE_DATA_DIR = mkdtempSync(join(tmpdir(), "aindrive-ainui-"));
process.env.AINDRIVE_PUBLIC_URL = "http://drive.test";

vi.mock("next/headers", () => ({ cookies: () => Promise.resolve({ get: () => undefined }) }));

type F = { content: string; mtimeMs: number };
const FS: Record<string, F> = {};
const MIME: Record<string, string> = { jpg: "image/jpeg", png: "image/png", md: "text/markdown", txt: "text/plain" };
function entriesOf(dir: string) {
  const out = new Map<string, Record<string, unknown>>();
  for (const [p, f] of Object.entries(FS)) {
    const rel = dir ? (p.startsWith(dir + "/") ? p.slice(dir.length + 1) : null) : p;
    if (rel === null) continue;
    const [head, ...rest] = rel.split("/");
    out.set(head, rest.length
      ? { name: head, isDir: true, size: 4096, mtimeMs: 1, mime: "folder" }
      : { name: head, isDir: false, size: f.content.length, mtimeMs: f.mtimeMs, mime: MIME[head.split(".").pop()!] ?? "application/octet-stream" });
  }
  return [...out.values()];
}
vi.mock("../rpc", () => ({
  AgentError: class extends Error {},
  callAgent: async (_d: string, _s: string, req: { method: string; path: string; content?: string }) => {
    switch (req.method) {
      case "list": return { method: "list", entries: entriesOf(req.path) };
      case "read": return { method: "read", content: FS[req.path]?.content ?? "", encoding: "utf8", truncated: false };
      case "write": FS[req.path] = { content: req.content ?? "", mtimeMs: 5000 }; return { method: "write", ok: true };
      case "delete": for (const k of Object.keys(FS)) if (k === req.path || k.startsWith(req.path + "/")) delete FS[k]; return { method: "delete", ok: true };
      default: return { ok: true };
    }
  },
}));

const { db } = await import("../db.js");
const { sign } = await import("../session.js");
const tokens = await import("../mcp-tokens");
const { a2uiForSkill, A2UI_BASIC_CATALOG } = await import("../../shared/a2ui");
const { AINUI_CATALOG } = await import("../../shared/a2ui/ainui");
const { EventSchemas } = await import("@ag-ui/core/schemas");
const mcpRoute = await import("../../app/mcp/d/[driveId]/route.js");
const aguiDrive = await import("../../app/agui/d/[driveId]/route.js");
const a2a = await import("../../app/a2a/route.js");

let readTok = "";
let writeTok = "";
let viewerWriteTok = "";
let ownerJwt = "";

beforeAll(async () => {
  db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES ('o1','o@x.com','O','x'), ('v1','v@x.com','V','x')").run();
  db.prepare("INSERT INTO drives (id, owner_id, name, agent_token_hash, drive_secret) VALUES ('d1','o1','Family','h','s')").run();
  db.prepare("INSERT INTO drives (id, owner_id, name, agent_token_hash, drive_secret) VALUES ('d2','o1','Other','h','s')").run();
  db.prepare("INSERT INTO drive_members (id, drive_id, user_id, path, role) VALUES ('m1','d1','v1','','viewer')").run();
  readTok = tokens.issuePat({ userId: "o1", driveId: "d1", name: "r", scope: "read", ttlDays: null }).token;
  writeTok = tokens.issuePat({ userId: "o1", driveId: "d1", name: "w", scope: "write", ttlDays: null }).token;
  // A write-scoped token whose holder is only a viewer (e.g. downgraded after issue).
  viewerWriteTok = tokens.issuePat({ userId: "v1", driveId: "d1", name: "vw", scope: "write", ttlDays: null }).token;
  ownerJwt = await sign("o1");
});

beforeEach(() => {
  for (const k of Object.keys(FS)) delete FS[k];
  Object.assign(FS, {
    "Camera/a.jpg": { content: "JPEG1", mtimeMs: 101 },
    "Camera/b.png": { content: "PNG22", mtimeMs: 102 },
    "Camera/notes.md": { content: "# trip", mtimeMs: 103 },
    "readme.txt": { content: "hello", mtimeMs: 104 },
  });
});

// ── MCP ────────────────────────────────────────────────────────────────────

function mcp(token: string, body: unknown, headers: Record<string, string> = {}) {
  return mcpRoute.POST(new Request("http://drive.test/mcp/d/d1", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}`, ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, ...body as object }),
  }), { params: Promise.resolve({ driveId: "d1" }) });
}
async function result(res: Response): Promise<any> {
  const t = await res.text();
  const data = t.includes("data:") ? t.split("\n").find((l) => l.startsWith("data:"))!.slice(5) : t;
  return JSON.parse(data).result;
}
const call = (token: string, name: string, args: Record<string, unknown>, ainui = true) =>
  mcp(token, { method: "tools/call", params: { name, arguments: args } }, ainui ? { "x-ainui": "1" } : {}).then(result);
const action = (token: string, name: string, context: Record<string, unknown>, ainui = true) =>
  call(token, "a2ui_action", { action: { name, surfaceId: "s", sourceComponentId: "c", timestamp: "t", context } }, ainui);
const surf = (r: any) => r._meta["ai.aindrive/a2ui"];
const model = (r: any) => surf(r)[2].updateDataModel.value;
const comps = (r: any) => surf(r)[1].updateComponents.components as Array<{ id: string; component: string } & Record<string, any>>;
/** surfaceIds are random; everything else must match. */
const normalize = (msgs: unknown) => JSON.parse(JSON.stringify(msgs).replace(/aindrive-[a-z]+-[a-z0-9]+/g, "SURFACE"));

describe("MCP negotiation (X-AINUI)", () => {
  it("without the header: the exact basic surface and result as before", async () => {
    for (const [name, args] of [["list_files", { path: "Camera" }], ["read_file", { path: "readme.txt" }], ["stat", { path: "readme.txt" }]] as const) {
      const r = await call(readTok, name, args, false);
      const { runSkill } = await import("../../shared/agent-skills");
      const direct = await runSkill({ userId: "o1", driveId: "d1", scope: "read" }, name, args);
      expect(Object.keys(r).sort()).toEqual(["_meta", "content", "structuredContent"]);
      expect(r.content).toEqual([{ type: "text", text: (direct as any).text }]);
      expect(r.structuredContent).toEqual((direct as any).structured);
      expect(normalize(surf(r))).toEqual(normalize(a2uiForSkill(name, args, direct, "d1")));
      expect(surf(r)[0].createSurface.catalogId).toBe(A2UI_BASIC_CATALOG);
    }
    // basic click on a file still previews inline
    const file = await action(readTok, "aindrive.open", { path: "readme.txt", is_dir: false }, false);
    expect(model(file).content).toBe("```\nhello\n```");
    // AINUI-only actions are unknown to a basic client — nothing runs
    const del = await action(writeTok, "aindrive.delete", { path: "readme.txt" }, false);
    expect(del).toMatchObject({ isError: true, content: [{ text: "unknown action: aindrive.delete" }] });
    expect(FS["readme.txt"]).toBeDefined();
  });

  it("with the header: AINUI folder (grid rule, asset thumbs); text + structured result unchanged", async () => {
    const plain = await call(readTok, "list_files", { path: "Camera" }, false);
    const r = await call(readTok, "list_files", { path: "Camera" });
    expect(r.content).toEqual(plain.content);
    expect(r.structuredContent).toEqual(plain.structuredContent);
    expect(surf(r)[0].createSurface.catalogId).toBe(AINUI_CATALOG);
    const d = model(r);
    expect(d).toMatchObject({ drive_id: "d1", path: "Camera", view: "grid" });
    expect(d.crumbs[0]).toEqual({ label: "Family", path: "", is_dir: true });
    expect(d.items.find((i: any) => i.name === "a.jpg")).toMatchObject({
      kind: "image", mime: "image/jpeg", size: 5, mtime: 101,
      thumb: { $asset: { drive_id: "d1", path: "Camera/a.jpg", variant: "thumb", mime: "image/jpeg", v: 101 } },
    });
    expect(comps(r).some((c) => c.component === "Grid")).toBe(true);
    // read token: no write affordances
    expect(comps(r).find((c) => c.id === "new_btn")).toBeUndefined();
    const w = await call(writeTok, "list_files", { path: "Camera" });
    expect(comps(w).find((c) => c.id === "new_btn")).toBeDefined();
    // a write-scoped token of a viewer gets no write buttons either (live role)
    const vw = await call(viewerWriteTok, "list_files", { path: "Camera" });
    expect(comps(vw).find((c) => c.id === "new_btn")).toBeUndefined();
  });

  it("open on a file: stat + FileView asset, no inline bytes", async () => {
    const r = await action(readTok, "aindrive.open", { path: "Camera/a.jpg", is_dir: false });
    expect(r.isError).toBeUndefined();
    expect(model(r).src).toEqual({ $asset: { drive_id: "d1", path: "Camera/a.jpg", variant: "original", mime: "image/jpeg", v: 101 } });
    expect(JSON.stringify(r)).not.toContain("JPEG1");
    expect(r.structuredContent).toMatchObject({ name: "a.jpg", isDir: false });
    expect(comps(r).find((c) => c.id === "delete_btn")).toBeUndefined();
    const w = await action(writeTok, "aindrive.open", { path: "Camera/notes.md", is_dir: false });
    expect(comps(w).map((c) => c.id)).toEqual(expect.arrayContaining(["edit_btn", "delete_btn"]));
  });

  it("view / search reply with folders", async () => {
    expect(model(await action(readTok, "aindrive.view", { path: "Camera", value: "list" })).view).toBe("list");
    const s = await action(readTok, "aindrive.search", { path: "", query: "png" });
    expect(model(s).items.map((i: any) => i.path)).toEqual(["Camera/b.png"]);
  });

  it("write actions with a write token: new_file → editor, save → file, delete → parent folder", async () => {
    const created = await action(writeTok, "aindrive.new_file", { path: "Camera", name: "todo.md" });
    expect(created.isError).toBeUndefined();
    expect(model(created)).toMatchObject({ path: "Camera/todo.md", content: "" });
    expect(comps(created).find((c) => c.id === "editor")).toMatchObject({ variant: "longText" });
    expect(FS["Camera/todo.md"]).toEqual({ content: "", mtimeMs: 5000 });

    const edited = await action(writeTok, "aindrive.edit", { path: "Camera/notes.md" });
    expect(model(edited).content).toBe("# trip");

    const saved = await action(writeTok, "aindrive.save", { path: "Camera/todo.md", content: "- milk" });
    expect(FS["Camera/todo.md"].content).toBe("- milk");
    expect(model(saved)).toMatchObject({ path: "Camera/todo.md", size: 6, src: { $asset: { variant: "original", v: 5000 } } });

    const gone = await action(writeTok, "aindrive.delete", { path: "Camera/todo.md" });
    expect(FS["Camera/todo.md"]).toBeUndefined();
    expect(model(gone).path).toBe("Camera");
    expect(model(gone).items.map((i: any) => i.name)).not.toContain("todo.md");
  });

  it("write actions are refused exactly like the tools: read scope, viewer role, other drive", async () => {
    for (const [name, ctx, tool] of [
      ["aindrive.delete", { path: "readme.txt" }, "delete_path"],
      ["aindrive.save", { path: "readme.txt", content: "x" }, "write_file"],
      ["aindrive.new_file", { path: "", name: "n.txt" }, "write_file"],
      ["aindrive.edit", { path: "readme.txt" }, "write_file"],
    ] as const) {
      const r = await action(readTok, name, ctx);
      expect(r).toMatchObject({ isError: true, content: [{ text: `unknown tool: ${tool}` }] });
    }
    // write scope but only a viewer: runSkill says no
    const v = await action(viewerWriteTok, "aindrive.save", { path: "readme.txt", content: "x" });
    expect(v.isError).toBe(true);
    expect(v.content[0].text).toContain("forbidden");
    const vd = await action(viewerWriteTok, "aindrive.delete", { path: "readme.txt" });
    expect(vd.isError).toBe(true);
    // pinned drive
    const other = await action(writeTok, "aindrive.delete", { drive_id: "d2", path: "readme.txt" });
    expect(other.isError).toBe(true);
    expect(FS["readme.txt"]).toEqual({ content: "hello", mtimeMs: 104 });
    expect(FS["n.txt"]).toBeUndefined();
  });
});

// ── AG-UI ──────────────────────────────────────────────────────────────────

function sseEvents(text: string): any[] {
  return text.split("\n\n").map((b) => b.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("")).filter(Boolean).map((d) => JSON.parse(d));
}
async function agui(body: Record<string, unknown>, token: string) {
  const res = await aguiDrive.POST(new Request("http://drive.test/agui/d/d1", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream", authorization: `Bearer ${token}` },
    body: JSON.stringify({ threadId: "t1", runId: "r1", state: {}, messages: [], tools: [], context: [], forwardedProps: {}, ...body }),
  }), { params: Promise.resolve({ driveId: "d1" }) });
  const events = sseEvents(await res.text());
  for (const e of events) {
    const r = EventSchemas.safeParse(e);
    expect(r.success, `${e.type}: ${JSON.stringify(r.error?.issues)?.slice(0, 300)}`).toBe(true);
  }
  return events;
}
const activity = (events: any[]) => events.find((e) => e.type === "ACTIVITY_SNAPSHOT").content.a2ui_operations;

describe("AG-UI negotiation (forwardedProps.ainui)", () => {
  it("off: basic surface; on: AINUI surface for the same command", async () => {
    const basic = await agui({ messages: [{ id: "m", role: "user", content: "ls Camera" }] }, readTok);
    expect(activity(basic)[0].createSurface.catalogId).toBe(A2UI_BASIC_CATALOG);
    const on = await agui({ messages: [{ id: "m", role: "user", content: "ls Camera" }], forwardedProps: { ainui: true } }, readTok);
    expect(activity(on)[0].createSurface.catalogId).toBe(AINUI_CATALOG);
    expect(activity(on)[2].updateDataModel.value.view).toBe("grid");
    expect(on.map((e) => e.type)).toEqual([
      "RUN_STARTED", "STEP_STARTED", "TOOL_CALL_START", "TOOL_CALL_ARGS", "TOOL_CALL_END", "TOOL_CALL_RESULT",
      "ACTIVITY_SNAPSHOT", "STATE_SNAPSHOT", "TEXT_MESSAGE_START", "TEXT_MESSAGE_CONTENT", "TEXT_MESSAGE_END",
      "STEP_FINISHED", "RUN_FINISHED",
    ]);
  });

  it("a multi-step click reports each skill; a read grant can't write", async () => {
    const click = (name: string, context: Record<string, unknown>) =>
      ({ forwardedProps: { ainui: true, a2uiAction: { userAction: { name, surfaceId: "s", sourceComponentId: "c", timestamp: "t", context } } } });
    const ev = await agui(click("aindrive.new_file", { path: "Camera", name: "x.md" }), ownerJwt);
    expect(ev.filter((e) => e.type === "TOOL_CALL_START").map((e) => e.toolCallName)).toEqual(["list_files", "write_file"]);
    expect(activity(ev)[2].updateDataModel.value).toMatchObject({ path: "Camera/x.md", content: "" });
    expect(FS["Camera/x.md"]).toBeDefined();

    const denied = await agui(click("aindrive.delete", { path: "readme.txt" }), readTok);
    // a drive PAT's grant covers write skills; its read scope is enforced by runSkill
    const result = denied.find((e) => e.type === "TOOL_CALL_RESULT");
    expect(JSON.parse(result.content).error.code).toBe("forbidden");
    expect(FS["readme.txt"]).toBeDefined();
  });
});

// ── A2A ────────────────────────────────────────────────────────────────────

async function a2aSend(parts: unknown[], token: string, metadata?: Record<string, unknown>) {
  const res = await a2a.POST(new Request("http://drive.test/a2a", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "message/send",
      params: { message: { kind: "message", role: "user", messageId: `m${Math.random()}`, parts, ...(metadata ? { metadata } : {}) } },
    }),
  }));
  return (await res.json()).result;
}
const uiPart = (r: any) => r.parts.find((p: any) => p.metadata?.mimeType === "application/a2ui+json");

describe("A2A negotiation (metadata.ainui)", () => {
  it("off: no UI unless asked; on: an AINUI DataPart", async () => {
    const off = await a2aSend([{ kind: "data", data: { skill: "list_files", path: "Camera" } }], readTok);
    expect(off.parts).toHaveLength(2);
    const on = await a2aSend([{ kind: "data", data: { skill: "list_files", path: "Camera" } }], readTok, { ainui: true });
    expect(on.parts[1].data.entries.map((e: any) => e.name)).toEqual(["a.jpg", "b.png", "notes.md"]);
    expect(uiPart(on).data[0].createSurface.catalogId).toBe(AINUI_CATALOG);
    expect(uiPart(on).data[2].updateDataModel.value.items[0].thumb.$asset.variant).toBe("thumb");
  });

  it("actions: delete → parent folder as the owner; refused for a read token", async () => {
    const act = (name: string, context: Record<string, unknown>) =>
      [{ kind: "data", data: { version: "v0.9", action: { name, surfaceId: "s", sourceComponentId: "c", timestamp: "t", context } } }];
    const ro = await a2aSend(act("aindrive.delete", { drive_id: "d1", path: "readme.txt" }), readTok, { ainui: true });
    expect(ro.parts[0].text).toContain("forbidden");
    expect(FS["readme.txt"]).toBeDefined();
    const ok = await a2aSend(act("aindrive.delete", { drive_id: "d1", path: "Camera/b.png" }), ownerJwt, { ainui: true });
    expect(FS["Camera/b.png"]).toBeUndefined();
    expect(uiPart(ok).data[2].updateDataModel.value).toMatchObject({ path: "Camera" });
  });
});
