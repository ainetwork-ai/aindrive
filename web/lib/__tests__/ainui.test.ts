// AINUI (docs/AINUI.md) builders and the action dispatcher, with a fake drive.
// Basic components inside AINUI surfaces must still validate against the
// OFFICIAL A2UI v0.9 schemas (extension props stripped); AINUI components
// against the props in spec §3.
import { describe, it, expect } from "vitest";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { A2uiComponent, A2uiMessage } from "../../shared/a2ui";
import {
  AINUI_CATALOG, MAX_EDIT_BYTES, ainuiEditor, ainuiFile, ainuiFolder, ainuiForSkill, defaultView, dispatchAinuiAction, toItem,
  type AinuiDeps, type AinuiEnv, type AinuiItem,
} from "../../shared/a2ui/ainui";
import type { SkillResult } from "../../shared/agent-skills";
import { classifyKind, lookupMime } from "../mime";

const core = path.resolve(__dirname, "../../node_modules/@a2ui/web_core/src/v0_9");
const { A2uiMessageSchema } = await import(pathToFileURL(`${core}/schema/server-to-client.js`).href);
const components = await import(pathToFileURL(`${core}/basic_catalog/components/basic_components.js`).href);
const BASIC = Object.fromEntries(
  Object.values(components)
    .filter((v: any) => v && typeof v.name === "string" && v.schema)
    .map((v: any) => [v.name, v.schema]),
) as Record<string, { safeParse: (x: unknown) => { success: boolean; error?: unknown } }>;

const isDyn = (v: unknown) => typeof v === "string" || typeof v === "number" || typeof v === "boolean"
  || (!!v && typeof v === "object" && typeof (v as { path?: unknown }).path === "string");
const isChildren = (v: unknown) => (Array.isArray(v) && v.every((x) => typeof x === "string"))
  || (!!v && typeof v === "object" && typeof (v as any).componentId === "string" && typeof (v as any).path === "string");
const isAction = (v: unknown) => !!v && typeof (v as any).event?.name === "string";

/** Spec §3 props: required / optional, and their shapes. */
const AINUI: Record<string, { req: Record<string, (v: unknown) => boolean>; opt: Record<string, (v: unknown) => boolean> }> = {
  FileUpload: { req: { label: isDyn, action: isAction }, opt: { maxBytes: (v) => typeof v === "number" && v > 0 } },
  X402Payment: { req: { amount: isDyn, currency: isDyn, network: isDyn, payTo: isDyn, action: isAction }, opt: {} },
  Grid: { req: { children: isChildren }, opt: { minItemWidth: (v) => typeof v === "number", gap: (v) => typeof v === "number" } },
  Tile: { req: { kind: isDyn, label: isDyn }, opt: { media: isDyn, caption: isDyn, action: isAction } },
  FileView: { req: { src: isDyn, name: isDyn }, opt: { mime: isDyn, size: isDyn } },
  Breadcrumbs: { req: { items: isDyn, action: isAction }, opt: {} },
  Segmented: {
    req: {
      options: (v) => Array.isArray(v) && v.every((o) => typeof o.value === "string" && typeof o.label === "string"),
      value: isDyn, action: isAction,
    },
    opt: {},
  },
};

function validate(messages: A2uiMessage[]): A2uiComponent[] {
  expect(messages[0]).toMatchObject({ createSurface: { catalogId: AINUI_CATALOG } });
  for (const m of messages) {
    const r = A2uiMessageSchema.safeParse(m);
    expect(r.success, JSON.stringify(r.error ?? m).slice(0, 400)).toBe(true);
  }
  const comps = (messages.find((m) => "updateComponents" in m) as { updateComponents: { components: A2uiComponent[] } })
    .updateComponents.components;
  const ids = new Set(comps.map((c) => c.id));
  expect(ids.has("root")).toBe(true);
  expect(ids.size).toBe(comps.length);
  for (const c of comps) {
    const { id: _id, component, weight: _w, ...props } = c;
    if (BASIC[component]) {
      // Extension props (spec §3) are ignored by basic renderers; the rest must be official.
      const basic: Record<string, unknown> = { ...props };
      if (component === "Button") { delete basic.tone; delete basic.confirm; }
      if (component === "Text" && basic.variant === "mono") delete basic.variant;
      const r = BASIC[component].safeParse(basic);
      expect(r.success, `${c.id} (${component}): ${JSON.stringify(r.error)?.slice(0, 300)}`).toBe(true);
    } else {
      const spec = AINUI[component];
      expect(spec, `unknown component ${component}`).toBeDefined();
      for (const [k, ok] of Object.entries(spec.req)) expect(ok(props[k]), `${c.id}.${k}`).toBe(true);
      for (const [k, v] of Object.entries(props)) {
        const check = spec.req[k] ?? spec.opt[k];
        expect(check, `${c.id}: unexpected prop ${k}`).toBeDefined();
        expect(check(v), `${c.id}.${k}`).toBe(true);
      }
    }
    for (const ref of [c.child, ...(Array.isArray(c.children) ? c.children : []), (c.children as any)?.componentId].filter(Boolean)) {
      expect(ids.has(ref as string), `${c.id} → missing ${ref}`).toBe(true);
    }
  }
  return comps;
}

const data = (msgs: A2uiMessage[]) => (msgs[2] as any).updateDataModel.value;
const byId = (comps: A2uiComponent[], id: string) => comps.find((c) => c.id === id);
const ok = (structured: unknown, text = ""): SkillResult => ({ kind: "ok", structured, text });
const SERVER_ENV: AinuiEnv = { mimeOf: lookupMime, isText: (p) => classifyKind(p).kind === "text" };

// Entries as the agent reports them (cli/src/rpc.js list: mime + mtimeMs per entry).
const PHOTOS = [
  { name: "sub", isDir: true, size: 4096, mtimeMs: 1, mime: "folder" },
  { name: "a.jpg", isDir: false, size: 2048, mtimeMs: 111, mime: "image/jpeg" },
  { name: "b.png", isDir: false, size: 10, mtimeMs: 112, mime: "image/png" },
  { name: "c.md", isDir: false, size: 5, mtimeMs: 113, mime: "text/markdown" },
];

describe("AINUI builders", () => {
  it("folder: breadcrumbs, toolbar, grid of tiles over items with asset thumbs", () => {
    const msgs = ainuiForSkill("list_files", { path: "Camera" }, ok({ entries: PHOTOS }), "d1", { ...SERVER_ENV, rootLabel: "Family" });
    const comps = validate(msgs);
    const d = data(msgs);
    expect(d).toMatchObject({ drive_id: "d1", path: "Camera", parent: "", view: "grid", query: "", new_name: "" });
    expect(d.crumbs).toEqual([{ label: "Family", path: "", is_dir: true }, { label: "Camera", path: "Camera", is_dir: true }]);
    expect(byId(comps, "root")!.children).toEqual(["crumbs", "toolbar", "grid"]);
    expect(byId(comps, "toolbar")!.children).toEqual(["search_field", "search_btn", "view"]);
    expect(byId(comps, "grid")).toMatchObject({ component: "Grid", children: { componentId: "tile", path: "/items" } });
    expect(byId(comps, "tile")).toMatchObject({
      component: "Tile", media: { path: "thumb" }, kind: { path: "kind" }, label: { path: "name" }, caption: { path: "meta" },
      action: { event: { name: "aindrive.open", context: { drive_id: { path: "drive_id" }, path: { path: "path" }, is_dir: { path: "is_dir" } } } },
    });
    expect(byId(comps, "view")).toMatchObject({ component: "Segmented", value: { path: "/view" }, action: { event: { name: "aindrive.view" } } });
    expect(byId(comps, "crumbs")).toMatchObject({ component: "Breadcrumbs", items: { path: "/crumbs" }, action: { event: { name: "aindrive.open" } } });

    const [sub, jpg, png, md] = d.items as AinuiItem[];
    expect(sub).toMatchObject({ name: "sub", path: "Camera/sub", is_dir: true, kind: "folder", size: null, thumb: null, drive_id: "d1" });
    expect(jpg).toEqual({
      name: "a.jpg", path: "Camera/a.jpg", is_dir: false, kind: "image", mime: "image/jpeg", size: 2048, mtime: 111,
      meta: "2.0 KB", drive_id: "d1", label: "🖼 a.jpg",
      thumb: { $asset: { drive_id: "d1", path: "Camera/a.jpg", variant: "thumb", mime: "image/jpeg", v: 111 } },
    });
    expect(png.thumb!.$asset.v).toBe(112);
    expect(md).toMatchObject({ kind: "file", mime: "text/markdown", thumb: null });
    // no bytes, no drive URLs in the surface
    expect(JSON.stringify(msgs)).not.toMatch(/data:|\/api\/drives/);
  });

  it("kinds and thumbs: mime from the agent, else the file name (lib/mime); thumbs for image/video/pdf only", () => {
    const e = (name: string, mime?: string, extra: object = {}) => toItem("d1", name, { name, isDir: false, size: 1, mtimeMs: 5, mime, ...extra }, SERVER_ENV);
    expect(e("clip.mov", "application/octet-stream")).toMatchObject({ kind: "video", mime: "video/quicktime" });
    expect(e("x.heic")).toMatchObject({ kind: "image", mime: "image/heic" });
    expect(e("song.mp3", "audio/mpeg")).toMatchObject({ kind: "audio", thumb: null });
    expect(e("doc.pdf", "application/pdf").thumb).toEqual({ $asset: { drive_id: "d1", path: "doc.pdf", variant: "thumb", mime: "application/pdf", v: 5 } });
    expect(e("v.mp4", "video/mp4").thumb?.$asset.variant).toBe("thumb");
    expect(e("blob.bin")).toMatchObject({ kind: "file", mime: "application/octet-stream", thumb: null });
    // paid-and-locked: shown, but no thumb (its bytes would 402)
    expect(e("paid.jpg", "image/jpeg", { locked: true })).toMatchObject({ kind: "image", thumb: null, locked: true, meta: "🔒 1 B" });
    // pure fallback without lib/mime (client code)
    expect(toItem("d1", "p.webp", { name: "p.webp", isDir: false }, {})).toMatchObject({ kind: "image", mime: "image/webp", mtime: null });
    expect(toItem("d1", "p.webp", { name: "p.webp", isDir: false }, {}).thumb!.$asset).not.toHaveProperty("v");
  });

  it("default view: grid when at least half of the FILES are images/videos; explicit view wins", () => {
    const items = (names: string[]) => names.map((n) => toItem("d", n, { name: n, isDir: !n.includes(".") }, SERVER_ENV));
    expect(defaultView(items(["a.jpg", "b.mp4", "c.txt"]))).toBe("grid");
    expect(defaultView(items(["a.jpg", "c.txt"]))).toBe("grid");
    expect(defaultView(items(["a.jpg", "c.txt", "d.pdf"]))).toBe("list");
    expect(defaultView(items(["dir1", "dir2", "dir3", "a.jpg", "b.txt"]))).toBe("grid"); // folders don't count
    expect(defaultView(items(["dir1", "dir2"]))).toBe("list");
    expect(defaultView([])).toBe("list");

    const list = ainuiForSkill("list_files", { path: "" }, ok({ entries: PHOTOS }), "d1", { ...SERVER_ENV, view: "list" });
    const comps = validate(list);
    expect(data(list).view).toBe("list");
    expect(byId(comps, "root")!.children).toContain("list");
    expect(byId(comps, "list")).toMatchObject({ component: "List", children: { componentId: "row", path: "/items" } });
    expect(byId(comps, "row_label")).toMatchObject({ text: { path: "label" } });
    const docs = ainuiForSkill("list_files", { path: "" }, ok({ entries: [PHOTOS[3]] }), "d1", SERVER_ENV);
    expect(data(docs).view).toBe("list");
    const empty = ainuiForSkill("list_files", { path: "" }, ok({ entries: [] }), "d1", SERVER_ENV);
    expect(byId(validate(empty), "root")!.children).toEqual(["crumbs", "toolbar", "empty"]);
  });

  it("new-file button only when the caller may write", () => {
    const ro = validate(ainuiFolder({ driveId: "d1", path: "a", items: [], env: SERVER_ENV }));
    expect(byId(ro, "new_btn")).toBeUndefined();
    expect(byId(ro, "upload")).toBeUndefined();
    const rw = validate(ainuiFolder({ driveId: "d1", path: "a", items: [], env: { ...SERVER_ENV, canWrite: true } }));
    expect(byId(rw, "toolbar")!.children).toEqual(["search_field", "search_btn", "view", "new_btn", "upload"]);
    expect(byId(rw, "new_btn")).toMatchObject({
      action: { event: { name: "aindrive.new_file", context: { drive_id: { path: "/drive_id" }, path: { path: "/path" }, name: { path: "/new_name" } } } },
    });
  });

  it("file: FileView over an original asset; edit (text + write) and delete (danger, confirm) by capability", () => {
    const base = { driveId: "d1", path: "docs/n.md", mime: "text/markdown", size: 12, mtime: 77 };
    const ro = ainuiFile({ ...base, env: SERVER_ENV });
    const roComps = validate(ro);
    expect(byId(roComps, "toolbar")!.children).toEqual(["back_btn"]);
    expect(byId(roComps, "view")).toMatchObject({ component: "FileView", src: { path: "/src" }, name: { path: "/name" }, mime: { path: "/mime" }, size: { path: "/size" } });
    expect(data(ro)).toMatchObject({
      name: "n.md", mime: "text/markdown", size: 12, parent: "docs",
      src: { $asset: { drive_id: "d1", path: "docs/n.md", variant: "original", mime: "text/markdown", v: 77 } },
    });
    expect(data(ro).crumbs.at(-1)).toEqual({ label: "n.md", path: "docs/n.md", is_dir: false });

    const rw = validate(ainuiFile({ ...base, env: { ...SERVER_ENV, canWrite: true, canDelete: true } }));
    expect(byId(rw, "toolbar")!.children).toEqual(["back_btn", "edit_btn", "delete_btn"]);
    expect(byId(rw, "edit_btn")).toMatchObject({ action: { event: { name: "aindrive.edit" } } });
    expect(byId(rw, "delete_btn")).toMatchObject({ tone: "danger", confirm: "Delete n.md?", action: { event: { name: "aindrive.delete" } } });
    // binary or too large: no editor
    const img = validate(ainuiFile({ ...base, path: "p.jpg", mime: "image/jpeg", env: { ...SERVER_ENV, canWrite: true, canDelete: true } }));
    expect(byId(img, "toolbar")!.children).toEqual(["back_btn", "delete_btn"]);
    const big = validate(ainuiFile({ ...base, size: MAX_EDIT_BYTES + 1, env: { ...SERVER_ENV, canWrite: true } }));
    expect(byId(big, "edit_btn")).toBeUndefined();
  });

  it("editor: longText field bound to /content with save/cancel", () => {
    const msgs = ainuiEditor({ driveId: "d1", path: "a/b.txt", content: "hi", env: SERVER_ENV });
    const comps = validate(msgs);
    expect(byId(comps, "editor")).toMatchObject({ component: "TextField", variant: "longText", value: { path: "/content" } });
    expect(byId(comps, "save_btn")).toMatchObject({
      action: { event: { name: "aindrive.save", context: { drive_id: { path: "/drive_id" }, path: { path: "/path" }, content: { path: "/content" } } } },
    });
    expect(byId(comps, "cancel_btn")).toMatchObject({ action: { event: { name: "aindrive.open", context: { is_dir: false } } } });
    expect(data(msgs)).toMatchObject({ path: "a/b.txt", content: "hi", name: "b.txt" });
  });

  it("other skills: file surfaces for stat/read_file, AINUI-labelled basic surfaces for the rest", () => {
    const st = ainuiForSkill("stat", { path: "p/x.png" }, ok({ name: "x.png", isDir: false, size: 3, mtimeMs: 9, mime: "image/png" }), "d1", SERVER_ENV);
    validate(st);
    expect(data(st).src.$asset).toEqual({ drive_id: "d1", path: "p/x.png", variant: "original", mime: "image/png", v: 9 });
    const rd = ainuiForSkill("read_file", { path: "a.md" }, ok({ content: "héllo", encoding: "utf8" }), "d1", SERVER_ENV);
    validate(rd);
    expect(data(rd)).toMatchObject({ size: 6, mime: "text/markdown" });
    expect(JSON.stringify(rd)).not.toContain("héllo"); // no inline bytes
    const search = ainuiForSkill("search", { query: "a", path: "" }, ok({ matches: [{ path: "x/a.jpg", isDir: false }], truncated: true }), "d1", SERVER_ENV);
    const sc = validate(search);
    expect(data(search)).toMatchObject({ query: "a", view: "grid" });
    expect(data(search).items[0]).toMatchObject({ name: "a.jpg", path: "x/a.jpg", kind: "image", meta: "/x" });
    expect(byId(sc, "note")).toBeDefined();
    validate(ainuiForSkill("list_drives", {}, ok({ drives: [{ id: "d1", name: "Team" }] })));
    validate(ainuiForSkill("write_file", { path: "a.txt" }, ok({ ok: true }), "d1"));
    validate(ainuiForSkill("delete_path", { path: "a" }, ok({ path: "a", kind: "folder" }), "d1"));
    validate(ainuiForSkill("stat", { path: "dir" }, ok({ name: "dir", isDir: true }), "d1"));
    validate(ainuiForSkill("list_files", {}, { kind: "err", code: "forbidden", message: "nope" }, "d1"));
  });
});

// ── dispatcher ─────────────────────────────────────────────────────────────

type FakeFile = { content: string; mtimeMs: number; locked?: boolean };

/** A fake drive + skill runner with runSkill's result shapes, and an allow-list. */
function fakeDrive(files: Record<string, FakeFile>, opts: { allow?: string[]; env?: AinuiEnv } = {}) {
  const calls: Array<{ skill: string; args: Record<string, unknown> }> = [];
  const dirs = () => new Set(Object.keys(files).flatMap((p) => p.split("/").slice(0, -1).map((_, i, a) => a.slice(0, i + 1).join("/"))));
  const entries = (dir: string) => {
    const out = new Map<string, any>();
    for (const [p, f] of Object.entries(files)) {
      const rel = dir ? (p.startsWith(dir + "/") ? p.slice(dir.length + 1) : null) : p;
      if (rel === null) continue;
      const [head, ...rest] = rel.split("/");
      out.set(head, rest.length
        ? { name: head, isDir: true, mime: "folder" }
        : { name: head, isDir: false, size: f.content.length, mtimeMs: f.mtimeMs, mime: lookupMime(head) ?? "application/octet-stream", ...(f.locked ? { locked: true } : {}) });
    }
    return [...out.values()];
  };
  const run = async (skill: string, args: Record<string, unknown>): Promise<SkillResult> => {
    calls.push({ skill, args });
    const p = String(args.path ?? "");
    switch (skill) {
      case "list_files":
        return p && !dirs().has(p) ? { kind: "err", code: "internal", message: "ENOENT" } : ok({ entries: entries(p) }, "listed");
      case "stat": {
        const parent = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
        const e = entries(parent).find((x) => x.name === p.slice(p.lastIndexOf("/") + 1));
        return e ? ok(e, JSON.stringify(e)) : { kind: "err", code: "not_found", message: `no entry at ${p}` };
      }
      case "read_file": {
        const f = files[p];
        if (!f) return { kind: "err", code: "internal", message: "ENOENT" };
        if (f.locked) return { kind: "err", code: "forbidden", message: `payment required for ${p}` };
        return ok({ content: f.content, encoding: "utf8", truncated: f.content.startsWith("TRUNC") }, f.content);
      }
      case "write_file":
        if (typeof args.content !== "string") return { kind: "err", code: "invalid_params", message: "content (string) required" };
        files[p] = { content: args.content, mtimeMs: 999 };
        return ok({ ok: true }, `wrote ${p}`);
      case "delete_path":
        for (const k of Object.keys(files)) if (k === p || k.startsWith(p + "/")) delete files[k];
        return ok({ ok: true, path: p, kind: "file" }, `deleted ${p}`);
      case "search":
        return ok({ matches: Object.keys(files).filter((k) => k.includes(String(args.query))).map((k) => ({ path: k, isDir: false })), truncated: false }, "found");
      default:
        return { kind: "err", code: "invalid_params", message: `unknown skill: ${skill}` };
    }
  };
  const allow = opts.allow ?? ["list_files", "read_file", "stat", "search", "write_file", "delete_path"];
  const deps: AinuiDeps = {
    run,
    allowed: (s) => allow.includes(s),
    env: () => ({ ...SERVER_ENV, canWrite: allow.includes("write_file"), canDelete: allow.includes("delete_path"), ...opts.env }),
    driveId: "d1",
  };
  return { files, calls, deps };
}

const act = (name: string, context: Record<string, unknown>) => ({ name, surfaceId: "s", sourceComponentId: "c", context });
const surfaceOf = (r: Awaited<ReturnType<typeof dispatchAinuiAction>>) => {
  expect(r.kind).toBe("done");
  return (r as Extract<typeof r, { kind: "done" }>).surface;
};
const READ_ONLY = ["list_files", "read_file", "stat", "search"];

describe("AINUI actions", () => {
  const seed = (): Record<string, FakeFile> => ({
    "docs/a.md": { content: "# A", mtimeMs: 10 },
    "docs/pic.jpg": { content: "JPEGBYTES", mtimeMs: 11 },
    "docs/big.txt": { content: "TRUNC…", mtimeMs: 12 },
    "paid/p.pdf": { content: "PDF", mtimeMs: 13, locked: true },
    "top.txt": { content: "t", mtimeMs: 14 },
  });

  it("open: folder → list_files; file → stat + FileView asset (no bytes read)", async () => {
    const { deps, calls } = fakeDrive(seed());
    const folder = surfaceOf(await dispatchAinuiAction(act("aindrive.open", { path: "docs", is_dir: true }), deps));
    expect(data(folder).items.map((i: AinuiItem) => i.name)).toEqual(["a.md", "pic.jpg", "big.txt"]);
    const file = await dispatchAinuiAction(act("aindrive.open", { drive_id: "d1", path: "docs/pic.jpg", is_dir: false }), deps);
    const s = surfaceOf(file);
    validate(s);
    expect(data(s).src).toEqual({ $asset: { drive_id: "d1", path: "docs/pic.jpg", variant: "original", mime: "image/jpeg", v: 11 } });
    expect(JSON.stringify(s)).not.toContain("JPEGBYTES");
    expect(calls.map((c) => c.skill)).toEqual(["list_files", "stat"]);
    // a folder opened as a file still lands on the folder
    expect(data(surfaceOf(await dispatchAinuiAction(act("aindrive.open", { path: "docs", is_dir: false }), deps))).items).toHaveLength(3);
    // open_drive → root
    expect(data(surfaceOf(await dispatchAinuiAction(act("aindrive.open_drive", { drive_id: "d1" }), deps))).path).toBe("");
  });

  it("open on a paid file nobody bought is refused like read_file", async () => {
    const { deps } = fakeDrive(seed());
    const r = await dispatchAinuiAction(act("aindrive.open", { path: "paid/p.pdf", is_dir: false }), deps);
    expect(r.kind === "done" && r.final.result).toMatchObject({ kind: "err", code: "forbidden" });
  });

  it("view: explicit list/grid wins; search: results as a folder, empty query → list", async () => {
    const { deps } = fakeDrive(seed());
    const g = surfaceOf(await dispatchAinuiAction(act("aindrive.view", { path: "docs", value: "grid" }), deps));
    expect(data(g).view).toBe("grid");
    const l = surfaceOf(await dispatchAinuiAction(act("aindrive.view", { path: "docs", value: "list" }), deps));
    expect(data(l).view).toBe("list");
    const q = surfaceOf(await dispatchAinuiAction(act("aindrive.search", { path: "", query: " pic " }), deps));
    expect(data(q).items.map((i: AinuiItem) => i.path)).toEqual(["docs/pic.jpg"]);
    const none = await dispatchAinuiAction(act("aindrive.search", { path: "docs", query: "" }), deps);
    expect(none.kind === "done" && none.final.skill).toBe("list_files");
  });

  it("edit → read_file(utf8) → editor; binary, truncated and read-only are refused", async () => {
    const { deps, calls } = fakeDrive(seed());
    const r = await dispatchAinuiAction(act("aindrive.edit", { path: "docs/a.md" }), deps);
    const s = surfaceOf(r);
    validate(s);
    expect(data(s)).toMatchObject({ path: "docs/a.md", content: "# A" });
    expect(calls.at(-1)).toEqual({ skill: "read_file", args: { drive_id: "d1", path: "docs/a.md", encoding: "utf8" } });

    const bin = await dispatchAinuiAction(act("aindrive.edit", { path: "docs/pic.jpg" }), deps);
    expect(bin.kind === "done" && bin.final.result).toMatchObject({ kind: "err", code: "invalid_params" });
    const trunc = await dispatchAinuiAction(act("aindrive.edit", { path: "docs/big.txt" }), deps);
    expect(trunc.kind === "done" && trunc.final.result).toMatchObject({ kind: "err", message: expect.stringContaining("too large") });

    const viewer = fakeDrive(seed(), { env: { canWrite: false } });
    const denied = await dispatchAinuiAction(act("aindrive.edit", { path: "docs/a.md" }), viewer.deps);
    expect(denied.kind === "done" && denied.final.result).toMatchObject({ kind: "err", code: "forbidden" });
    expect(viewer.calls).toEqual([]);
    const ro = fakeDrive(seed(), { allow: READ_ONLY });
    expect(await dispatchAinuiAction(act("aindrive.edit", { path: "docs/a.md" }), ro.deps)).toEqual({ kind: "refused", skill: "write_file" });
    expect(ro.calls).toEqual([]);
  });

  it("new_file → write_file(path/name, '') → editor on the new file; never clobbers", async () => {
    const { deps, files, calls } = fakeDrive(seed());
    const r = await dispatchAinuiAction(act("aindrive.new_file", { path: "docs", name: "todo.md" }), deps);
    const s = surfaceOf(r);
    validate(s);
    expect(data(s)).toMatchObject({ path: "docs/todo.md", content: "" });
    expect(files["docs/todo.md"].content).toBe("");
    expect(calls.map((c) => c.skill)).toEqual(["list_files", "write_file"]);
    expect(r.kind === "done" && r.final.skill).toBe("write_file");

    // no name → untitled.txt, then untitled-2.txt
    expect(data(surfaceOf(await dispatchAinuiAction(act("aindrive.new_file", { path: "docs", name: "" }), deps))).path).toBe("docs/untitled.txt");
    expect(data(surfaceOf(await dispatchAinuiAction(act("aindrive.new_file", { path: "docs" }), deps))).path).toBe("docs/untitled-2.txt");
    expect(data(surfaceOf(await dispatchAinuiAction(act("aindrive.new_file", { path: "", name: "root.txt" }), deps))).path).toBe("root.txt");

    // an existing name is refused and left alone
    const clash = await dispatchAinuiAction(act("aindrive.new_file", { path: "docs", name: "a.md" }), deps);
    expect(clash.kind === "done" && clash.final.result).toMatchObject({ kind: "err", message: "already exists: a.md" });
    expect(files["docs/a.md"].content).toBe("# A");
    const slash = await dispatchAinuiAction(act("aindrive.new_file", { path: "docs", name: "../x" }), deps);
    expect(slash.kind === "done" && slash.final.result).toMatchObject({ kind: "err", code: "invalid_params" });

    const ro = fakeDrive(seed(), { allow: READ_ONLY });
    expect(await dispatchAinuiAction(act("aindrive.new_file", { path: "docs", name: "x.md" }), ro.deps)).toEqual({ kind: "refused", skill: "write_file" });
    expect(ro.calls).toEqual([]);
    expect(ro.files["docs/x.md"]).toBeUndefined();
  });

  it("save → write_file → stat → file view (card if the follow-up can't run)", async () => {
    const { deps, files, calls } = fakeDrive(seed());
    const r = await dispatchAinuiAction(act("aindrive.save", { path: "docs/a.md", content: "# B" }), deps);
    const s = surfaceOf(r);
    validate(s);
    expect(files["docs/a.md"].content).toBe("# B");
    expect(calls.map((c) => c.skill)).toEqual(["write_file", "stat"]);
    expect(data(s)).toMatchObject({ path: "docs/a.md", src: { $asset: { variant: "original", v: 999 } } });

    const writeOnly = fakeDrive(seed(), { allow: ["write_file"] });
    const w = await dispatchAinuiAction(act("aindrive.save", { path: "docs/a.md", content: "# C" }), writeOnly.deps);
    expect(writeOnly.files["docs/a.md"].content).toBe("# C");
    expect(JSON.stringify(surfaceOf(w))).toContain("Saved");
    expect(w.kind === "done" && w.final.skill).toBe("write_file");

    const ro = fakeDrive(seed(), { allow: READ_ONLY });
    expect(await dispatchAinuiAction(act("aindrive.save", { path: "docs/a.md", content: "x" }), ro.deps)).toEqual({ kind: "refused", skill: "write_file" });
    expect(ro.files["docs/a.md"].content).toBe("# A");
  });

  it("delete → delete_path → list_files(parent) → folder", async () => {
    const { deps, files, calls } = fakeDrive(seed());
    const r = await dispatchAinuiAction(act("aindrive.delete", { path: "docs/pic.jpg" }), deps);
    const s = surfaceOf(r);
    validate(s);
    expect(files["docs/pic.jpg"]).toBeUndefined();
    expect(calls.map((c) => c.skill)).toEqual(["delete_path", "list_files"]);
    expect(data(s).path).toBe("docs");
    expect(data(s).items.map((i: AinuiItem) => i.name)).toEqual(["a.md", "big.txt"]);

    const ro = fakeDrive(seed(), { allow: READ_ONLY });
    expect(await dispatchAinuiAction(act("aindrive.delete", { path: "top.txt" }), ro.deps)).toEqual({ kind: "refused", skill: "delete_path" });
    expect(ro.files["top.txt"]).toBeDefined();
  });

  it("unknown actions and missing drive ids are invalid", async () => {
    const { deps } = fakeDrive(seed());
    expect(await dispatchAinuiAction(act("rm -rf", {}), deps)).toMatchObject({ kind: "invalid" });
    expect(await dispatchAinuiAction(act("aindrive.open", { path: "" }), { ...deps, driveId: undefined })).toMatchObject({ kind: "invalid" });
  });
});
