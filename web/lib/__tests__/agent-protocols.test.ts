// A2A (+A2UI extension, streaming) and AG-UI endpoints, end to end through the
// route handlers with the CLI agent mocked. AG-UI events are validated against
// the official @ag-ui/core schemas; A2UI payloads against the A2UI shape.
import { describe, it, expect, beforeAll, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AINDRIVE_DATA_DIR = mkdtempSync(join(tmpdir(), "aindrive-protocols-"));
process.env.AINDRIVE_PUBLIC_URL = "http://drive.test";

vi.mock("next/headers", () => ({ cookies: () => Promise.resolve({ get: () => undefined }) }));
vi.mock("../rpc", () => ({
  AgentError: class extends Error {},
  callAgent: async (_d: string, _s: string, req: { method: string; path: string }) => {
    if (req.method === "list") return { entries: req.path === "" ? [{ name: "docs", isDir: true }, { name: "a.md", isDir: false, size: 5 }] : [{ name: "x.txt", isDir: false }] };
    if (req.method === "read") return { content: "# hello", encoding: "utf8" };
    return { ok: true };
  },
}));

const { db } = await import("../db.js");
const tokens = await import("../mcp-tokens");
const { EventSchemas } = await import("@ag-ui/core/schemas");
const aguiDrive = await import("../../app/agui/d/[driveId]/route.js");
const aguiRoot = await import("../../app/agui/route.js");
const a2a = await import("../../app/a2a/route.js");
const card = await import("../../app/.well-known/agent-card.json/route.js");
const { A2UI_A2A_EXTENSION, A2UI_MIME } = await import("../../shared/a2ui");

let readTok = "";
let otherTok = "";
const dctx = (driveId: string) => ({ params: Promise.resolve({ driveId }) });

beforeAll(() => {
  db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES ('o1','o@x.com','O','x')").run();
  db.prepare("INSERT INTO drives (id, owner_id, name, agent_token_hash, drive_secret) VALUES ('d1','o1','D1','h','s')").run();
  db.prepare("INSERT INTO drives (id, owner_id, name, agent_token_hash, drive_secret) VALUES ('d2','o1','D2','h','s')").run();
  readTok = tokens.issuePat({ userId: "o1", driveId: "d1", name: "t", scope: "read", ttlDays: null }).token;
  otherTok = tokens.issuePat({ userId: "o1", driveId: "d2", name: "t", scope: "read", ttlDays: null }).token;
});

function sseEvents(text: string): any[] {
  return text.split("\n\n").map((b) => b.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("")).filter(Boolean).map((d) => JSON.parse(d));
}

const runInput = (extra: Record<string, unknown> = {}) => ({
  threadId: "t1", runId: "r1", state: {}, messages: [], tools: [], context: [], forwardedProps: {}, ...extra,
});

async function agui(body: unknown, token = readTok, driveId = "d1") {
  const res = await aguiDrive.POST(new Request(`http://drive.test/agui/d/${driveId}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  }), dctx(driveId));
  return res;
}

describe("AG-UI", () => {
  it("streams a schema-valid run with an A2UI activity for a text command", async () => {
    const res = await agui(runInput({ messages: [{ id: "m1", role: "user", content: "ls" }] }));
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const events = sseEvents(await res.text());
    for (const e of events) {
      const r = EventSchemas.safeParse(e);
      expect(r.success, `${e.type}: ${JSON.stringify(r.error?.issues)?.slice(0, 300)}`).toBe(true);
    }
    expect(events.map((e) => e.type)).toEqual([
      "RUN_STARTED", "STEP_STARTED", "TOOL_CALL_START", "TOOL_CALL_ARGS", "TOOL_CALL_END", "TOOL_CALL_RESULT",
      "ACTIVITY_SNAPSHOT", "STATE_SNAPSHOT", "TEXT_MESSAGE_START", "TEXT_MESSAGE_CONTENT", "TEXT_MESSAGE_END",
      "STEP_FINISHED", "RUN_FINISHED",
    ]);
    const act = events.find((e) => e.type === "ACTIVITY_SNAPSHOT");
    expect(act.activityType).toBe("a2ui-surface");
    expect(act.content.a2ui_operations[0].createSurface.surfaceId).toMatch(/^aindrive-browser-/);
    expect(events.find((e) => e.type === "TOOL_CALL_START").toolCallName).toBe("list_files");
    expect(events.find((e) => e.type === "STATE_SNAPSHOT").snapshot).toMatchObject({ driveId: "d1", skill: "list_files" });
  });

  it("handles an A2UI click (CopilotKit forwardedProps.a2uiAction) and explicit skills", async () => {
    const click = sseEvents(await (await agui(runInput({
      forwardedProps: { a2uiAction: { userAction: { name: "aindrive.open", surfaceId: "s", sourceComponentId: "item_open", timestamp: "t", context: { path: "a.md", is_dir: false } } } },
    }))).text());
    expect(click.find((e) => e.type === "TOOL_CALL_START").toolCallName).toBe("read_file");
    expect(click.find((e) => e.type === "ACTIVITY_SNAPSHOT").content.a2ui_operations[2].updateDataModel.value.content).toBe("# hello");

    const direct = sseEvents(await (await agui(runInput({ forwardedProps: { skill: "search", args: { query: "a" } } }))).text());
    expect(direct.find((e) => e.type === "TOOL_CALL_START").toolCallName).toBe("search");
    const bad = sseEvents(await (await agui(runInput({ forwardedProps: { skill: "rm" } }))).text());
    expect(bad.map((e) => e.type)).toEqual(["RUN_STARTED", "RUN_ERROR"]);
  });

  it("read tokens can't write; auth and input are validated", async () => {
    const w = sseEvents(await (await agui(runInput({ forwardedProps: { skill: "write_file", args: { path: "x", content: "y" } } }))).text());
    expect(JSON.parse(w.find((e) => e.type === "TOOL_CALL_RESULT").content).error.code).toBe("forbidden");
    expect((await agui(runInput(), "")).status).toBe(401);
    expect((await agui(runInput(), otherTok)).status).toBe(403);
    expect((await agui({ nope: true })).status).toBe(400);
    const info = await (await aguiRoot.GET()).json();
    expect(info.protocol).toBe("ag-ui");
  });
});

async function a2aCall(body: unknown, headers: Record<string, string> = {}, token = readTok) {
  return a2a.POST(new Request("http://drive.test/a2a", {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: JSON.stringify(body),
  }));
}
const send = (parts: unknown[], metadata?: unknown, method = "message/send") => ({
  jsonrpc: "2.0", id: 1, method,
  params: { message: { kind: "message", role: "user", messageId: `m${Math.random()}`, parts, ...(metadata ? { metadata } : {}) } },
});

describe("A2A", () => {
  it("card advertises streaming, the A2UI extension and auth schemes", async () => {
    const c = await (await card.GET()).json();
    expect(c.capabilities.streaming).toBe(true);
    expect(c.capabilities.extensions[0].uri).toBe(A2UI_A2A_EXTENSION);
    expect(c.securitySchemes.bearer.scheme).toBe("bearer");
    expect(c.skills.map((s: any) => s.id)).toContain("list_files");
  });

  it("DataPart skill call with a drive token (pinned drive), no A2UI unless asked", async () => {
    const r = await (await a2aCall(send([{ kind: "data", data: { skill: "list_files", path: "" } }]))).json();
    const parts = r.result.parts;
    expect(parts[0].kind).toBe("text");
    expect(parts[1].data.entries.map((e: any) => e.name)).toEqual(["docs", "a.md"]);
    expect(parts).toHaveLength(2);
  });

  it("activating the A2UI extension adds an application/a2ui+json DataPart", async () => {
    const res = await a2aCall(send([{ kind: "text", text: "ls docs" }]), { "X-A2A-Extensions": A2UI_A2A_EXTENSION });
    expect(res.headers.get("x-a2a-extensions")).toBe(A2UI_A2A_EXTENSION);
    const parts = (await res.json()).result.parts;
    const ui = parts.find((p: any) => p.metadata?.mimeType === A2UI_MIME);
    expect(ui.data[0].createSurface).toBeDefined();
    expect(ui.data[2].updateDataModel.value.items[0].path).toBe("docs/x.txt");
  });

  it("an A2UI action DataPart answers with the next surface", async () => {
    const r = await (await a2aCall(send([{ kind: "data", data: { version: "v0.9", action: {
      name: "aindrive.open", surfaceId: "s", sourceComponentId: "item_open", timestamp: "t", context: { path: "a.md", is_dir: false },
    } } }]))).json();
    const ui = r.result.parts.find((p: any) => p.metadata?.mimeType === A2UI_MIME);
    expect(ui.data[2].updateDataModel.value.content).toBe("# hello");
  });

  it("message/stream returns SSE with the agent message", async () => {
    const res = await a2aCall(send([{ kind: "text", text: "cat a.md" }], undefined, "message/stream"));
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const events = sseEvents(await res.text());
    expect(events.length).toBeGreaterThan(0);
    const msg = events.map((e) => e.result).find((x) => x?.kind === "message");
    expect(msg.parts[1].content ?? msg.parts[1].data.content).toBe("# hello");
  });

  it("unauthenticated and cross-drive calls are refused", async () => {
    const anon = await (await a2aCall(send([{ kind: "text", text: "ls" }]), {}, "")).json();
    expect(anon.result.metadata.error).toBe(true);
    const cross = await (await a2aCall(send([{ kind: "data", data: { skill: "list_files", drive_id: "d2" } }]))).json();
    expect(cross.result.parts[0].text).toContain("forbidden");
  });
});
