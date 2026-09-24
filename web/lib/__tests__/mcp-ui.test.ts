// MCP Apps + A2UI over the drive MCP endpoint: tools advertise the ui:// view,
// the view resource is a self-contained HTML app, results carry the A2UI
// surface in _meta (and as an embedded resource on opt-in), and the app-only
// a2ui_action tool turns a click into the next surface.
import { describe, it, expect, beforeAll, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AINDRIVE_DATA_DIR = mkdtempSync(join(tmpdir(), "aindrive-mcpui-"));
process.env.AINDRIVE_PUBLIC_URL = "http://drive.test";

vi.mock("../rpc", () => ({
  AgentError: class extends Error {},
  callAgent: async (_d: string, _s: string, req: { method: string; path: string }) => {
    if (req.method === "list") {
      return { entries: req.path === "" ? [{ name: "docs", isDir: true }, { name: "a.md", isDir: false, size: 5 }] : [{ name: "x.txt", isDir: false, size: 1 }] };
    }
    if (req.method === "read") return { content: "# hello", encoding: "utf8" };
    return { ok: true };
  },
}));

const { db } = await import("../db.js");
const tokens = await import("../mcp-tokens");
const { exposeAppGlobal, mcpAppHtml, MCP_APP_URI, MCP_APP_MIME } = await import("../mcp-ui");
const mcpRoute = await import("../../app/mcp/d/[driveId]/route.js");

let token = "";
const ctx = { params: Promise.resolve({ driveId: "d1" }) };
function rpc(body: unknown, headers: Record<string, string> = {}) {
  return mcpRoute.POST(new Request("http://drive.test/mcp/d/d1", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}`, ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, ...body as object }),
  }), ctx);
}
async function result(res: Response): Promise<any> {
  const t = await res.text();
  const data = t.includes("data:") ? t.split("\n").find((l) => l.startsWith("data:"))!.slice(5) : t;
  return JSON.parse(data).result;
}

beforeAll(() => {
  db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES ('o1','o@x.com','O','x')").run();
  db.prepare("INSERT INTO drives (id, owner_id, name, agent_token_hash, drive_secret) VALUES ('d1','o1','D1','h','s')").run();
  token = tokens.issuePat({ userId: "o1", driveId: "d1", name: "t", scope: "read", ttlDays: null }).token;
});

describe("MCP Apps view", () => {
  it("exposeAppGlobal rewrites the bundle's export clause", () => {
    expect(exposeAppGlobal("var a=1;export{a as Foo,b as App};")).toBe("var a=1;globalThis.__mcpExtApps={App:b};");
    expect(() => exposeAppGlobal("var a=1;")).toThrow();
  });

  it("builds a self-contained HTML app from the official SDK bundle + renderer", () => {
    const html = mcpAppHtml();
    expect(html).toContain("globalThis.__mcpExtApps={App:");
    expect(html).toContain("function createA2uiRenderer");
    expect(html).toContain('name: "a2ui_action"');
    expect(html).not.toMatch(/^export /m);
    // only our own two closing script tags
    expect(html.match(/<\/script>/g)?.length).toBe(2);
  });

  it("tools/list advertises the view; a2ui_action is app-only", async () => {
    const r = await result(await rpc({ method: "tools/list" }));
    const byName = Object.fromEntries(r.tools.map((t: any) => [t.name, t]));
    expect(byName.list_files._meta.ui).toEqual({ resourceUri: MCP_APP_URI, visibility: ["model", "app"] });
    expect(byName.a2ui_action._meta.ui.visibility).toEqual(["app"]);
  });

  it("resources/list + read serve the ui:// app", async () => {
    const list = await result(await rpc({ method: "resources/list" }));
    expect(list.resources[0]).toMatchObject({ uri: MCP_APP_URI, mimeType: MCP_APP_MIME });
    const read = await result(await rpc({ method: "resources/read", params: { uri: MCP_APP_URI } }));
    expect(read.contents[0]).toMatchObject({ uri: MCP_APP_URI, mimeType: MCP_APP_MIME });
    expect(read.contents[0].text).toContain("<!doctype html>");
  });
});

describe("A2UI in tool results", () => {
  it("every result carries its surface in _meta; the embedded resource is opt-in", async () => {
    const plain = await result(await rpc({ method: "tools/call", params: { name: "list_files", arguments: {} } }));
    const surface = plain._meta["ai.aindrive/a2ui"];
    expect(surface[0].createSurface.catalogId).toContain("v0_9/catalogs/basic");
    expect(plain.content.map((c: any) => c.type)).toEqual(["text"]);

    const opted = await result(await rpc({ method: "tools/call", params: { name: "list_files", arguments: {} } }, { "x-a2ui": "1" }));
    const res = opted.content.find((c: any) => c.type === "resource");
    expect(res.resource.mimeType).toBe("application/a2ui+json");
    expect(JSON.parse(res.resource.text)[1].updateComponents.components.some((c: any) => c.id === "root")).toBe(true);
  });

  it("a2ui_action opens folders and files, pinned to the token's drive", async () => {
    const folder = await result(await rpc({ method: "tools/call", params: {
      name: "a2ui_action",
      arguments: { action: { name: "aindrive.open", surfaceId: "s", sourceComponentId: "item_open", timestamp: "t", context: { path: "docs", is_dir: true } } },
    } }));
    expect(folder.structuredContent.entries[0].name).toBe("x.txt");
    const file = await result(await rpc({ method: "tools/call", params: {
      name: "a2ui_action", arguments: { action: { name: "aindrive.open", context: { path: "a.md", is_dir: false } } },
    } }));
    expect(file._meta["ai.aindrive/a2ui"][2].updateDataModel.value.content).toBe("# hello");
    // another drive in the context is refused by runSkill's drive pin
    const other = await result(await rpc({ method: "tools/call", params: {
      name: "a2ui_action", arguments: { action: { name: "aindrive.open", context: { drive_id: "d2", path: "", is_dir: true } } },
    } }));
    expect(other.isError).toBe(true);
    const bogus = await result(await rpc({ method: "tools/call", params: { name: "a2ui_action", arguments: { action: { name: "rm -rf" } } } }));
    expect(bogus.isError).toBe(true);
  });
});
