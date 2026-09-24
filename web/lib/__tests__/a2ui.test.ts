// A2UI surfaces must validate against the OFFICIAL v0.9 schemas (@a2ui/web_core):
// the message envelope, and every component against its basic-catalog API — so
// any conforming renderer (Lit, React, CopilotKit, our MCP Apps view) draws them.
import { describe, it, expect } from "vitest";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  a2uiForSkill, actionToSkill, commandToSkill, parseA2uiAction,
  A2UI_BASIC_CATALOG, type A2uiMessage, type A2uiComponent,
} from "../../shared/a2ui";

const core = path.resolve(__dirname, "../../node_modules/@a2ui/web_core/src/v0_9");
const { A2uiMessageSchema } = await import(pathToFileURL(`${core}/schema/server-to-client.js`).href);
const components = await import(pathToFileURL(`${core}/basic_catalog/components/basic_components.js`).href);
const API = Object.fromEntries(
  Object.values(components)
    .filter((v: any) => v && typeof v.name === "string" && v.schema)
    .map((v: any) => [v.name, v.schema]),
) as Record<string, { safeParse: (x: unknown) => { success: boolean; error?: unknown } }>;

function validate(messages: A2uiMessage[]) {
  expect(messages[0]).toMatchObject({ createSurface: { catalogId: A2UI_BASIC_CATALOG } });
  for (const m of messages) {
    const r = A2uiMessageSchema.safeParse(m);
    expect(r.success, JSON.stringify(r.error ?? m).slice(0, 400)).toBe(true);
  }
  const comps = (messages.find((m) => "updateComponents" in m) as { updateComponents: { components: A2uiComponent[] } })
    .updateComponents.components;
  const ids = new Set(comps.map((c) => c.id));
  expect(ids.has("root")).toBe(true);
  for (const c of comps) {
    const schema = API[c.component];
    expect(schema, `unknown component ${c.component}`).toBeDefined();
    const { id: _id, component: _c, ...props } = c;
    const r = schema.safeParse(props);
    expect(r.success, `${c.id} (${c.component}): ${JSON.stringify(r.error)?.slice(0, 300)}`).toBe(true);
    // every referenced child exists
    for (const ref of [c.child, ...(Array.isArray(c.children) ? c.children : []), (c.children as any)?.componentId].filter(Boolean)) {
      expect(ids.has(ref as string), `${c.id} → missing ${ref}`).toBe(true);
    }
  }
  return comps;
}

const ok = (structured: unknown, text = "") => ({ kind: "ok" as const, structured, text });

describe("A2UI surfaces", () => {
  it("file browser (list_files) validates and wires open/search actions", () => {
    const msgs = a2uiForSkill("list_files", { path: "docs" }, ok({ entries: [
      { name: "a.md", isDir: false, size: 2048 }, { name: "img", isDir: true }, { name: "paid", isDir: true, locked: true },
    ] }), "d1");
    const comps = validate(msgs);
    const data = (msgs[2] as any).updateDataModel.value;
    expect(data.items.map((i: any) => i.path)).toEqual(["docs/a.md", "docs/img", "docs/paid"]);
    expect(data.items[0]).toMatchObject({ is_dir: false, drive_id: "d1", meta: "2.0 KB" });
    expect(data.parent).toBe("");
    expect(comps.find((c) => c.id === "item_open")).toMatchObject({ action: { event: { name: "aindrive.open" } } });
    expect(comps.find((c) => c.id === "up_btn")).toBeDefined();
  });

  it("every skill (and errors) produces a valid surface", () => {
    validate(a2uiForSkill("list_drives", {}, ok({ drives: [{ id: "d1", name: "Team" }] })));
    validate(a2uiForSkill("list_files", { path: "" }, ok({ entries: [] }), "d1"));
    validate(a2uiForSkill("search", { query: "a", path: "" }, ok({ matches: [{ path: "x/a.txt", isDir: false }], truncated: true }), "d1"));
    validate(a2uiForSkill("read_file", { path: "n.md" }, ok({ content: "# hi", encoding: "utf8" }), "d1"));
    validate(a2uiForSkill("read_file", { path: "p.png" }, ok({ content: "iVBORw0KGgo=", encoding: "base64" }), "d1"));
    validate(a2uiForSkill("write_file", { path: "a/b.txt" }, ok({ ok: true }), "d1"));
    validate(a2uiForSkill("delete_path", { path: "a" }, ok({ path: "a", kind: "folder" }), "d1"));
    validate(a2uiForSkill("stat", { path: "a.txt" }, ok({ name: "a.txt", isDir: false, size: 3 }), "d1"));
    validate(a2uiForSkill("list_files", {}, { kind: "err", code: "forbidden", message: "nope" }));
  });

  it("preview embeds images as data URLs and fences non-markdown text", () => {
    const img = a2uiForSkill("read_file", { path: "p.png" }, ok({ content: "AAAA", encoding: "base64" }), "d1");
    expect((img[2] as any).updateDataModel.value.image_url).toBe("data:image/png;base64,AAAA");
    const svg = a2uiForSkill("read_file", { path: "d.svg" }, ok({ content: "<svg/>", encoding: "utf8" }), "d1");
    expect((svg[2] as any).updateDataModel.value.image_url).toBe("data:image/svg+xml;base64,PHN2Zy8+");
    const txt = a2uiForSkill("read_file", { path: "a.ts" }, ok({ content: "x", encoding: "utf8" }), "d1");
    expect((txt[2] as any).updateDataModel.value.content).toBe("```\nx\n```");
  });
});

describe("A2UI actions → skills", () => {
  it("parses every action envelope renderers send", () => {
    const a = { name: "aindrive.open", surfaceId: "s", sourceComponentId: "item_open", timestamp: "t", context: { path: "x" } };
    for (const env of [a, { action: a }, { version: "v0.9", action: a }, { userAction: a }]) {
      expect(parseA2uiAction(env)?.name).toBe("aindrive.open");
    }
    expect(parseA2uiAction({ nope: 1 })).toBeNull();
  });

  it("maps open/open_drive/search", () => {
    expect(actionToSkill({ name: "aindrive.open", context: { drive_id: "d1", path: "a", is_dir: true } }))
      .toEqual({ skill: "list_files", args: { drive_id: "d1", path: "a" } });
    expect(actionToSkill({ name: "aindrive.open", context: { path: "a.txt", is_dir: false } }, "d2"))
      .toEqual({ skill: "read_file", args: { drive_id: "d2", path: "a.txt" } });
    expect(actionToSkill({ name: "aindrive.open_drive", context: { drive_id: "d3" } }))
      .toEqual({ skill: "list_files", args: { drive_id: "d3", path: "" } });
    expect(actionToSkill({ name: "aindrive.search", context: { drive_id: "d1", query: " q ", path: "" } }))
      .toEqual({ skill: "search", args: { drive_id: "d1", query: "q", path: "" } });
    expect(actionToSkill({ name: "aindrive.open", context: { drive_id: "d1", path: "p/x.PNG", is_dir: false } }))
      .toEqual({ skill: "read_file", args: { drive_id: "d1", path: "p/x.PNG", encoding: "base64" } });
    expect(actionToSkill({ name: "evil" })).toHaveProperty("error");
  });

  it("text commands", () => {
    expect(commandToSkill("ls docs", "d1")).toEqual({ skill: "list_files", args: { drive_id: "d1", path: "docs" } });
    expect(commandToSkill("cat a.md", "d1")).toEqual({ skill: "read_file", args: { drive_id: "d1", path: "a.md" } });
    expect(commandToSkill("drives")).toEqual({ skill: "list_drives", args: {} });
    expect(commandToSkill("report 2026", "d1")).toEqual({ skill: "search", args: { drive_id: "d1", query: "report 2026" } });
  });
});
