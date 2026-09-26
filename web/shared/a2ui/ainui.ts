/**
 * AINUI v1 — A2UI v0.9 with aindrive's custom catalog (spec: docs/AINUI.md).
 *
 * Same messages, component model, data binding and actions as ./index.ts; the
 * surfaces declare AINUI_CATALOG and may use, besides every basic component,
 * Grid, Tile, FileView, Breadcrumbs and Segmented. Private file bytes are never
 * embedded: the data model carries asset references ({$asset: …}) that each host
 * resolves through its own authorized route.
 *
 *   ainuiForSkill(skill, args, result, driveId, env)   one skill result → surface
 *   dispatchAinuiAction(action, deps)                  a click → skill(s) → surface
 *
 * Only clients that opt in get these (MCP `X-AINUI: 1`, AG-UI
 * `forwardedProps.ainui`, A2A `metadata.ainui`); everyone else keeps the basic
 * surfaces from ./index.ts, unchanged.
 *
 * Pure: no IO, no Node APIs. The server injects what needs IO — the skill
 * runner, the allow-list, the caller's write capability and lib/mime lookups —
 * through AinuiEnv / AinuiDeps (lib/ainui.ts), so the docs playground can use
 * the same code with a fake drive.
 */
import type { SkillResult } from "../agent-skills";
import {
  A2UI_BASIC_CATALOG, A2UI_VERSION, a2uiForSkill, baseOf, humanSize, parentOf,
  type A2uiAction, type A2uiComponent, type A2uiMessage,
} from "./index";

export const AINUI_VERSION = "v1" as const;
export const AINUI_CATALOG = "https://aindrive.ainetwork.ai/ainui/v1/catalog.json";
/** MCP request header a client sends to get AINUI surfaces. */
export const AINUI_HEADER = "x-ainui";

export type AinuiKind = "image" | "video" | "audio" | "pdf" | "folder" | "file";
export type AinuiView = "grid" | "list";
export type AssetVariant = "thumb" | "original";
/** A reference to private file bytes; hosts resolve it before drawing (spec §2). */
export type AssetRef = {
  $asset: { drive_id: string; path: string; variant: AssetVariant; mime: string; v?: number };
};
export type AinuiItem = {
  name: string;
  path: string;
  is_dir: boolean;
  kind: AinuiKind;
  mime: string;
  size: number | null;
  mtime: number | null;
  meta: string;
  drive_id: string;
  thumb: AssetRef | null;
  /** list-row label: kind emoji + name (+ 🔒). Extra field; hosts may ignore it. */
  label: string;
  locked?: boolean;
};

/** What the builders need to know about the caller and the files (injected; pure defaults). */
export type AinuiEnv = {
  /** write_file is on the caller's allow-list, scope and live role here → new/edit buttons. */
  canWrite?: boolean;
  /** delete_path likewise → the delete button. */
  canDelete?: boolean;
  /** Explicit folder view (aindrive.view); otherwise the grid rule decides. */
  view?: AinuiView;
  /** Label of the first breadcrumb (the drive name). Default "/". */
  rootLabel?: string;
  /** Mime by file name — the server passes lib/mime lookupMime. */
  mimeOf?: (path: string) => string | null;
  /** Is this a text file the editor can open — the server passes lib/mime classifyKind. */
  isText?: (path: string, mime: string) => boolean;
};

/** Files larger than this open read-only (no edit button; aindrive.edit refuses). */
export const MAX_EDIT_BYTES = 1024 * 1024;
const NEW_FILE_BASE = "untitled";
const NEW_FILE_EXT = ".txt";

// ── mime / kind ─────────────────────────────────────────────────────────────

// Fallback used only when no mimeOf is injected (client code, e.g. the playground).
const EXT_MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  svg: "image/svg+xml", avif: "image/avif", heic: "image/heic", bmp: "image/bmp",
  mp4: "video/mp4", m4v: "video/x-m4v", webm: "video/webm", mov: "video/quicktime", mkv: "video/x-matroska",
  mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav", ogg: "audio/ogg", flac: "audio/flac", aac: "audio/aac",
  pdf: "application/pdf",
  txt: "text/plain", md: "text/markdown", csv: "text/csv", html: "text/html", css: "text/css",
  js: "application/javascript", ts: "application/typescript", json: "application/json", yaml: "application/yaml", yml: "application/yaml",
};
const TEXT_MIME_EXTRA = ["application/json", "application/xml", "application/yaml", "application/x-yaml", "application/javascript", "application/typescript", "application/x-sh"];
const OCTET = "application/octet-stream";

function fallbackMime(path: string): string | null {
  const dot = path.lastIndexOf(".");
  return dot < 0 ? null : EXT_MIME[path.slice(dot + 1).toLowerCase()] ?? null;
}

/**
 * The agent's per-entry mime (cli/src/rpc.js, mobile RpcHandler) wins unless it
 * is missing or generic; then the file name decides.
 */
export function resolveMime(path: string, agentMime: unknown, env: AinuiEnv = {}): string {
  if (typeof agentMime === "string" && agentMime && agentMime !== "folder" && agentMime !== OCTET) return agentMime;
  return (env.mimeOf ?? fallbackMime)(path) || OCTET;
}

export function kindOf(mime: string, isDir: boolean): AinuiKind {
  if (isDir) return "folder";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime === "application/pdf") return "pdf";
  return "file";
}

function isText(path: string, mime: string, env: AinuiEnv): boolean {
  if (env.isText) return env.isText(path, mime);
  return mime.startsWith("text/") || TEXT_MIME_EXTRA.some((p) => mime === p || mime.startsWith(p + ";"));
}

const KIND_EMOJI: Record<AinuiKind, string> = { folder: "📁", image: "🖼", video: "🎬", audio: "🎵", pdf: "📕", file: "📄" };
const THUMB_KINDS: readonly AinuiKind[] = ["image", "video", "pdf"];

export function assetRef(driveId: string, path: string, variant: AssetVariant, mime: string, v?: number | null): AssetRef {
  return { $asset: { drive_id: driveId, path, variant, mime, ...(typeof v === "number" && Number.isFinite(v) ? { v } : {}) } };
}

type RawEntry = { name: string; isDir: boolean; size?: number; mtimeMs?: number; mime?: string; locked?: boolean };

export function toItem(driveId: string, path: string, e: RawEntry, env: AinuiEnv, meta?: string): AinuiItem {
  const isDir = !!e.isDir;
  const mime = isDir ? "inode/directory" : resolveMime(path, e.mime, env);
  const kind = kindOf(mime, isDir);
  const mtime = typeof e.mtimeMs === "number" && Number.isFinite(e.mtimeMs) ? e.mtimeMs : null;
  const size = !isDir && typeof e.size === "number" && Number.isFinite(e.size) ? e.size : null;
  const lock = e.locked ? "🔒 " : "";
  return {
    name: e.name,
    path,
    is_dir: isDir,
    kind,
    mime,
    size,
    mtime,
    meta: lock + (meta ?? (isDir ? "folder" : humanSize(size))),
    drive_id: driveId,
    // Locked (paid, not bought) entries get no thumb: the carve-out 402s the bytes anyway.
    thumb: THUMB_KINDS.includes(kind) && !e.locked ? assetRef(driveId, path, "thumb", mime, mtime) : null,
    label: `${KIND_EMOJI[kind]} ${e.name}${e.locked ? " 🔒" : ""}`,
    ...(e.locked ? { locked: true } : {}),
  };
}

/** Grid when at least half of the folder's FILES are images/videos (folders don't count). */
export function defaultView(items: AinuiItem[]): AinuiView {
  const files = items.filter((i) => !i.is_dir);
  const media = files.filter((i) => i.kind === "image" || i.kind === "video").length;
  return files.length > 0 && media * 2 >= files.length ? "grid" : "list";
}

// ── component helpers ──────────────────────────────────────────────────────

type Dyn = string | number | boolean | { path: string };
const ev = (name: string, context: Record<string, Dyn>) => ({ event: { name, context } });
const text = (id: string, t: Dyn, variant?: string): A2uiComponent =>
  ({ id, component: "Text", text: t, ...(variant ? { variant } : {}) });
const button = (
  id: string, child: string, name: string, context: Record<string, Dyn>, extra: Record<string, unknown> = {},
): A2uiComponent => ({ id, component: "Button", child, action: ev(name, context), ...extra });
const row = (id: string, children: string[], extra: Record<string, unknown> = {}): A2uiComponent =>
  ({ id, component: "Row", children, ...extra });
const column = (id: string, children: string[]): A2uiComponent => ({ id, component: "Column", children });
const DRIVE = { path: "/drive_id" };

function ainuiSurface(prefix: string, components: A2uiComponent[], data: Record<string, unknown>): A2uiMessage[] {
  const surfaceId = `aindrive-${prefix}-${Math.random().toString(36).slice(2, 10)}`;
  return [
    { version: A2UI_VERSION, createSurface: { surfaceId, catalogId: AINUI_CATALOG } },
    { version: A2UI_VERSION, updateComponents: { surfaceId, components } },
    { version: A2UI_VERSION, updateDataModel: { surfaceId, path: "/", value: data } },
  ];
}

/** A basic-catalog surface is a valid AINUI surface: only the declared catalog changes. */
export function asAinui(messages: A2uiMessage[]): A2uiMessage[] {
  return messages.map((m) => ("createSurface" in m && m.createSurface.catalogId === A2UI_BASIC_CATALOG
    ? { ...m, createSurface: { ...m.createSurface, catalogId: AINUI_CATALOG } }
    : m));
}

export type Crumb = { label: string; path: string; is_dir: boolean };

/** Root first; the last item is the current location (renderers draw it as plain text). */
export function crumbsFor(path: string, isDir: boolean, rootLabel = "/"): Crumb[] {
  const segs = path ? path.split("/") : [];
  return [
    { label: rootLabel, path: "", is_dir: true },
    ...segs.map((s, i) => ({ label: s, path: segs.slice(0, i + 1).join("/"), is_dir: i < segs.length - 1 || isDir })),
  ];
}

const breadcrumbs = (): A2uiComponent => ({
  id: "crumbs",
  component: "Breadcrumbs",
  items: { path: "/crumbs" },
  // `path` binds to the tapped crumb (template-relative), per spec §3.
  action: ev("aindrive.open", { drive_id: DRIVE, path: { path: "path" }, is_dir: true }),
});

const cleanPath = (p: unknown) => (typeof p === "string" ? p.replace(/^\/+|\/+$/g, "") : "");

// ── surfaces ───────────────────────────────────────────────────────────────

export function ainuiFolder(opts: {
  driveId: string; path: string; items: AinuiItem[]; env?: AinuiEnv; query?: string; note?: string;
}): A2uiMessage[] {
  const env = opts.env ?? {};
  const view = env.view ?? defaultView(opts.items);
  const toolbar = ["search_field", "search_btn", "view"];
  if (env.canWrite) toolbar.push("new_btn");
  const body = opts.items.length ? (view === "grid" ? "grid" : "list") : "empty";
  const rootChildren = ["crumbs", "toolbar", body, ...(opts.note ? ["note"] : [])];
  const comps: A2uiComponent[] = [
    column("root", rootChildren),
    breadcrumbs(),
    row("toolbar", toolbar, { align: "center" }),
    { id: "search_field", component: "TextField", label: "Search file names", value: { path: "/query" }, weight: 1 },
    button("search_btn", "search_label", "aindrive.search",
      { drive_id: DRIVE, query: { path: "/query" }, path: { path: "/path" } }, { variant: "primary" }),
    text("search_label", "Search"),
    {
      id: "view",
      component: "Segmented",
      options: [{ value: "list", label: "List" }, { value: "grid", label: "Grid" }],
      value: { path: "/view" },
      action: ev("aindrive.view", { drive_id: DRIVE, path: { path: "/path" }, value: { path: "/view" } }),
    },
  ];
  if (env.canWrite) {
    comps.push(
      button("new_btn", "new_label", "aindrive.new_file", { drive_id: DRIVE, path: { path: "/path" }, name: { path: "/new_name" } }),
      text("new_label", "New file"),
    );
  }
  const open = ev("aindrive.open", { drive_id: { path: "drive_id" }, path: { path: "path" }, is_dir: { path: "is_dir" } });
  if (body === "grid") {
    comps.push(
      { id: "grid", component: "Grid", children: { componentId: "tile", path: "/items" }, minItemWidth: 128, gap: 8 },
      {
        id: "tile", component: "Tile",
        media: { path: "thumb" }, kind: { path: "kind" }, label: { path: "name" }, caption: { path: "meta" }, action: open,
      },
    );
  } else if (body === "list") {
    comps.push(
      { id: "list", component: "List", children: { componentId: "row", path: "/items" } },
      row("row", ["row_open", "row_meta"], { align: "center", justify: "spaceBetween" }),
      { id: "row_open", component: "Button", child: "row_label", action: open, variant: "borderless" },
      text("row_label", { path: "label" }),
      text("row_meta", { path: "meta" }, "caption"),
    );
  } else {
    comps.push(text("empty", "(empty)", "caption"));
  }
  if (opts.note) comps.push(text("note", opts.note, "caption"));
  return ainuiSurface("folder", comps, {
    drive_id: opts.driveId,
    path: opts.path,
    parent: parentOf(opts.path),
    title: opts.path ? baseOf(opts.path) : (env.rootLabel ?? "/"),
    crumbs: crumbsFor(opts.path, true, env.rootLabel),
    view,
    query: opts.query ?? "",
    new_name: "",
    items: opts.items,
  });
}

export function ainuiFile(opts: {
  driveId: string; path: string; mime: string; size: number | null; mtime: number | null; env?: AinuiEnv;
}): A2uiMessage[] {
  const env = opts.env ?? {};
  const name = baseOf(opts.path);
  const editable = !!env.canWrite && isText(opts.path, opts.mime, env) && (opts.size === null || opts.size <= MAX_EDIT_BYTES);
  const toolbar = ["back_btn", ...(editable ? ["edit_btn"] : []), ...(env.canDelete ? ["delete_btn"] : [])];
  const comps: A2uiComponent[] = [
    column("root", ["crumbs", "toolbar", "view"]),
    breadcrumbs(),
    row("toolbar", toolbar, { align: "center" }),
    button("back_btn", "back_label", "aindrive.open", { drive_id: DRIVE, path: { path: "/parent" }, is_dir: true }),
    text("back_label", "Back"),
  ];
  if (editable) {
    comps.push(
      button("edit_btn", "edit_label", "aindrive.edit", { drive_id: DRIVE, path: { path: "/path" } }),
      text("edit_label", "Edit"),
    );
  }
  if (env.canDelete) {
    comps.push(
      button("delete_btn", "delete_label", "aindrive.delete", { drive_id: DRIVE, path: { path: "/path" } },
        { tone: "danger", confirm: `Delete ${name}?` }),
      text("delete_label", "Delete"),
    );
  }
  comps.push({
    id: "view", component: "FileView",
    src: { path: "/src" }, name: { path: "/name" }, mime: { path: "/mime" }, size: { path: "/size" },
  });
  return ainuiSurface("file", comps, {
    drive_id: opts.driveId,
    path: opts.path,
    parent: parentOf(opts.path),
    title: name,
    crumbs: crumbsFor(opts.path, false, env.rootLabel),
    name,
    mime: opts.mime,
    kind: kindOf(opts.mime, false),
    size: opts.size,
    mtime: opts.mtime,
    src: assetRef(opts.driveId, opts.path, "original", opts.mime, opts.mtime),
  });
}

export function ainuiEditor(opts: { driveId: string; path: string; content: string; env?: AinuiEnv }): A2uiMessage[] {
  const env = opts.env ?? {};
  const name = baseOf(opts.path);
  const comps: A2uiComponent[] = [
    column("root", ["crumbs", "editor", "actions"]),
    breadcrumbs(),
    { id: "editor", component: "TextField", label: name, value: { path: "/content" }, variant: "longText" },
    row("actions", ["cancel_btn", "save_btn"], { align: "center", justify: "end" }),
    button("cancel_btn", "cancel_label", "aindrive.open", { drive_id: DRIVE, path: { path: "/path" }, is_dir: false }),
    text("cancel_label", "Cancel"),
    button("save_btn", "save_label", "aindrive.save",
      { drive_id: DRIVE, path: { path: "/path" }, content: { path: "/content" } }, { variant: "primary" }),
    text("save_label", "Save"),
  ];
  return ainuiSurface("editor", comps, {
    drive_id: opts.driveId,
    path: opts.path,
    parent: parentOf(opts.path),
    title: name,
    crumbs: crumbsFor(opts.path, false, env.rootLabel),
    name,
    content: opts.content,
  });
}

function utf8Bytes(s: string): number {
  return typeof TextEncoder === "function" ? new TextEncoder().encode(s).length : s.length;
}

/**
 * The AINUI surface for one skill call (tool result, AG-UI run, A2A reply).
 * Folder skills get the folder surface, file skills the file surface; the
 * rest (drive list, write/delete results, errors) are the basic surfaces
 * relabelled with the AINUI catalog — AINUI includes the basic catalog.
 */
export function ainuiForSkill(
  skill: string,
  args: Record<string, unknown>,
  result: SkillResult,
  driveId?: string,
  env: AinuiEnv = {},
): A2uiMessage[] {
  const drive = (typeof args.drive_id === "string" && args.drive_id) || driveId || "";
  const path = cleanPath(args.path);
  if (result.kind === "err") return asAinui(a2uiForSkill(skill, args, result, driveId));
  const s = (result.structured ?? {}) as Record<string, unknown>;

  switch (skill) {
    case "list_files": {
      const entries = (s.entries ?? []) as RawEntry[];
      return ainuiFolder({
        driveId: drive, path, env,
        items: entries.map((e) => toItem(drive, path ? `${path}/${e.name}` : e.name, e, env)),
      });
    }
    case "search": {
      const matches = (s.matches ?? []) as Array<{ path: string; isDir: boolean; locked?: boolean }>;
      return ainuiFolder({
        driveId: drive, path, env, query: typeof args.query === "string" ? args.query : "",
        note: s.truncated ? "Showing the first results only — refine the query for more." : undefined,
        // search reports no size/mtime: the caption is the match's folder, thumbs carry no `v`.
        items: matches.map((m) => toItem(drive, m.path, { name: baseOf(m.path), isDir: m.isDir, locked: m.locked }, env,
          `/${parentOf(m.path)}`)),
      });
    }
    case "stat": {
      const e = s as RawEntry;
      if (e.isDir || e.locked || !path) return asAinui(a2uiForSkill(skill, args, result, driveId));
      return ainuiFile({
        driveId: drive, path, env, mime: resolveMime(path, e.mime, env),
        size: typeof e.size === "number" ? e.size : null,
        mtime: typeof e.mtimeMs === "number" ? e.mtimeMs : null,
      });
    }
    case "read_file": {
      if (!path) return asAinui(a2uiForSkill(skill, args, result, driveId));
      const content = typeof s.content === "string" ? s.content : "";
      const size = s.truncated
        ? null
        : s.encoding === "base64" ? Math.floor(content.length * 3 / 4) - (content.endsWith("==") ? 2 : content.endsWith("=") ? 1 : 0)
          : utf8Bytes(content);
      return ainuiFile({ driveId: drive, path, env, mime: resolveMime(path, undefined, env), size, mtime: null });
    }
    default:
      return asAinui(a2uiForSkill(skill, args, result, driveId));
  }
}

// ── actions (renderer → agent) ─────────────────────────────────────────────

/** Injected IO for dispatchAinuiAction (server: lib/ainui.ts). */
export type AinuiDeps = {
  /** Run one skill as the caller (runSkill: scope, drive pin, live role, paid carve-out). */
  run: (skill: string, args: Record<string, unknown>) => Promise<SkillResult>;
  /** The SAME allow-list a direct tool call passes (MCP tools list, agent grant groups). */
  allowed: (skill: string) => boolean;
  /** Caller capabilities + mime lookups at a location. */
  env: (driveId: string, path: string) => AinuiEnv | Promise<AinuiEnv>;
  /** Drive for actions without context.drive_id (pinned endpoint). */
  driveId?: string;
};
export type AinuiStep = { skill: string; args: Record<string, unknown>; result: SkillResult };
export type AinuiReply =
  /** `steps` = skills that ran, in order; `final` = the result to report (may be synthetic). */
  | { kind: "done"; steps: AinuiStep[]; final: AinuiStep; surface: A2uiMessage[] }
  /** A skill the action needs is not on the caller's allow-list: nothing ran. */
  | { kind: "refused"; skill: string }
  /** Malformed or unknown action. */
  | { kind: "invalid"; error: string };

export const AINUI_ACTIONS = [
  "aindrive.open_drive", "aindrive.open", "aindrive.search", "aindrive.view",
  "aindrive.edit", "aindrive.new_file", "aindrive.save", "aindrive.delete",
] as const;

const err = (code: "invalid_params" | "forbidden" | "not_found" | "internal", message: string): SkillResult =>
  ({ kind: "err", code, message });

class Refused extends Error {
  constructor(readonly skill: string) { super(`refused: ${skill}`); }
}

/**
 * Answer an AINUI action. Multi-step actions run their follow-up server-side:
 * new_file → editor on the new file, save → file view, delete → parent folder.
 * Every skill passes deps.allowed first (refused → nothing runs) and runs
 * through deps.run (runSkill's own checks). A follow-up the caller may not run
 * falls back to the first skill's surface.
 */
export async function dispatchAinuiAction(action: A2uiAction, deps: AinuiDeps): Promise<AinuiReply> {
  const c = action.context ?? {};
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const drive_id = str(c.drive_id) || deps.driveId || "";
  if (!(AINUI_ACTIONS as readonly string[]).includes(action.name)) return { kind: "invalid", error: `unknown action: ${action.name}` };
  if (!drive_id) return { kind: "invalid", error: `${action.name} needs context.drive_id` };
  const path = cleanPath(c.path);
  const steps: AinuiStep[] = [];

  const need = (...skills: string[]) => { for (const s of skills) if (!deps.allowed(s)) throw new Refused(s); };
  const run = async (skill: string, args: Record<string, unknown>): Promise<AinuiStep> => {
    need(skill);
    const step = { skill, args, result: await deps.run(skill, args) };
    steps.push(step);
    return step;
  };
  const done = (final: AinuiStep, surface: A2uiMessage[]): AinuiReply => ({ kind: "done", steps, final, surface });
  /** Reply with a step's plain surface (an error card, or the result card of a write whose follow-up can't run). */
  const basic = (skill: string, args: Record<string, unknown>, result: SkillResult): AinuiReply =>
    done({ skill, args, result }, asAinui(a2uiForSkill(skill, args, result, drive_id)));

  const folder = async (dir: string, view?: AinuiView): Promise<AinuiReply> => {
    const s = await run("list_files", { drive_id, path: dir });
    const env = await deps.env(drive_id, dir);
    return done(s, ainuiForSkill(s.skill, s.args, s.result, drive_id, { ...env, ...(view ? { view } : {}) }));
  };

  const file = async (p: string): Promise<AinuiReply> => {
    const s = await run("stat", { drive_id, path: p });
    if (s.result.kind === "ok") {
      const e = s.result.structured as RawEntry;
      if (e.isDir && deps.allowed("list_files")) return folder(p);
      // As read_file: a paid file nobody bought isn't opened (its bytes would 402 anyway).
      if (e.locked) return basic("stat", s.args, err("forbidden", `payment required for ${p}`));
    }
    return done(s, ainuiForSkill(s.skill, s.args, s.result, drive_id, await deps.env(drive_id, p)));
  };

  try {
    switch (action.name) {
      case "aindrive.open_drive":
        return await folder("");
      case "aindrive.open":
        return c.is_dir === true || c.is_dir === "true" ? await folder(path) : await file(path);
      case "aindrive.view": {
        const v = str(c.value);
        return await folder(path, v === "grid" || v === "list" ? v : undefined);
      }
      case "aindrive.search": {
        const query = str(c.query).trim();
        if (!query) return await folder(path);
        const s = await run("search", { drive_id, query, path });
        return done(s, ainuiForSkill(s.skill, s.args, s.result, drive_id, await deps.env(drive_id, path)));
      }
      case "aindrive.edit": {
        // Opening an editor the caller can't save from is refused like the save itself.
        need("read_file", "write_file");
        const args = { drive_id, path, encoding: "utf8" };
        const env = await deps.env(drive_id, path);
        if (!env.canWrite) return basic("read_file", args, err("forbidden", "forbidden (no write access here)"));
        const mime = resolveMime(path, undefined, env);
        if (!isText(path, mime, env)) return basic("read_file", args, err("invalid_params", `not a text file: ${path}`));
        const s = await run("read_file", args);
        if (s.result.kind === "err") return basic(s.skill, s.args, s.result);
        const r = s.result.structured as { content?: unknown; truncated?: boolean };
        const content = typeof r.content === "string" ? r.content : "";
        // Saving a truncated read would cut the file: too-large files stay read-only.
        if (r.truncated || utf8Bytes(content) > MAX_EDIT_BYTES) {
          return basic(s.skill, s.args, err("invalid_params", `file too large to edit here (limit ${MAX_EDIT_BYTES} bytes)`));
        }
        return done(s, ainuiEditor({ driveId: drive_id, path, content, env }));
      }
      case "aindrive.new_file": {
        need("list_files", "write_file");
        const name = str(c.name).trim();
        if (/[/\\]/.test(name) || name === "." || name === "..") {
          return basic("write_file", { drive_id, path }, err("invalid_params", `invalid file name: ${name}`));
        }
        const l = await run("list_files", { drive_id, path });
        if (l.result.kind === "err") return basic(l.skill, l.args, l.result);
        const taken = new Set(((l.result.structured as { entries?: RawEntry[] }).entries ?? []).map((e) => e.name));
        let fileName = name;
        if (!fileName) {
          fileName = `${NEW_FILE_BASE}${NEW_FILE_EXT}`;
          for (let i = 2; taken.has(fileName); i++) fileName = `${NEW_FILE_BASE}-${i}${NEW_FILE_EXT}`;
        } else if (taken.has(fileName)) {
          // Never clobber: new_file only creates.
          return basic("write_file", { drive_id, path }, err("invalid_params", `already exists: ${fileName}`));
        }
        const target = path ? `${path}/${fileName}` : fileName;
        const w = await run("write_file", { drive_id, path: target, content: "" });
        if (w.result.kind === "err") return basic(w.skill, w.args, w.result);
        return done(w, ainuiEditor({ driveId: drive_id, path: target, content: "", env: await deps.env(drive_id, target) }));
      }
      case "aindrive.save": {
        const w = await run("write_file", { drive_id, path, content: c.content });
        if (w.result.kind === "err" || !deps.allowed("stat")) return basic(w.skill, w.args, w.result);
        const s = await run("stat", { drive_id, path });
        if (s.result.kind === "err") return basic(w.skill, w.args, w.result);
        return done(s, ainuiForSkill(s.skill, s.args, s.result, drive_id, await deps.env(drive_id, path)));
      }
      case "aindrive.delete": {
        const d = await run("delete_path", { drive_id, path });
        if (d.result.kind === "err" || !deps.allowed("list_files")) return basic(d.skill, d.args, d.result);
        const parent = parentOf(path);
        const l = await run("list_files", { drive_id, path: parent });
        if (l.result.kind === "err") return basic(d.skill, d.args, d.result);
        return done(l, ainuiForSkill(l.skill, l.args, l.result, drive_id, await deps.env(drive_id, parent)));
      }
    }
  } catch (e) {
    if (e instanceof Refused) return { kind: "refused", skill: e.skill };
    throw e;
  }
  return { kind: "invalid", error: `unknown action: ${action.name}` };
}
