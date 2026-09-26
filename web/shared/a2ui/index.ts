/**
 * A2UI (Agent-to-User Interface, https://a2ui.org) surfaces for aindrive —
 * the ONE declarative UI definition every agent transport reuses:
 *
 *   A2A     DataPart { data: A2uiMessage[] }, metadata.mimeType A2UI_MIME
 *   AG-UI   ACTIVITY_SNAPSHOT { activityType: "a2ui-surface", content: { a2ui_operations } }
 *   MCP     tool result `_meta[A2UI_META_KEY]` (rendered by the MCP Apps view,
 *           app/mcp/ui) + an embedded `application/a2ui+json` resource on opt-in
 *
 * Spec: A2UI v0.9 (stable), basic catalog only — so any conforming renderer
 * (@a2ui/lit, @a2ui/react, CopilotKit, …) can draw it; there is no custom
 * catalog to install. Buttons emit `action.event`s named `aindrive.*`; the
 * resulting client→server `action` maps back to a skill via actionToSkill().
 *
 * Pure: no IO, no Node APIs — safe to import from client code (docs playground).
 *
 * AINUI (docs/AINUI.md) — the same messages with aindrive's custom catalog
 * (grid, thumbnail tiles, asset references, file viewer, write actions) — lives
 * in ./ainui.ts and is only sent to clients that opt in.
 */
import type { SkillResult } from "../agent-skills";

export const A2UI_VERSION = "v0.9" as const;
export const A2UI_MIME = "application/a2ui+json";
export const A2UI_BASIC_CATALOG = "https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json";
/** A2A extension URI (A2UI over A2A), advertised in the agent card. */
export const A2UI_A2A_EXTENSION = "https://a2ui.org/a2a-extension/a2ui/v0.9";
/** AG-UI activity type used by @ag-ui/a2ui-middleware / CopilotKit. */
export const AGUI_A2UI_ACTIVITY = "a2ui-surface";
export const AGUI_A2UI_OPERATIONS_KEY = "a2ui_operations";
/** Where MCP tool results carry the surface for UI-only consumption (not shown to the model). */
export const A2UI_META_KEY = "ai.aindrive/a2ui";

type Dyn = string | number | boolean | { path: string };
export type A2uiComponent = { id: string; component: string } & Record<string, unknown>;
export type A2uiMessage =
  | { version: typeof A2UI_VERSION; createSurface: { surfaceId: string; catalogId: string } }
  | { version: typeof A2UI_VERSION; updateComponents: { surfaceId: string; components: A2uiComponent[] } }
  | { version: typeof A2UI_VERSION; updateDataModel: { surfaceId: string; path?: string; value?: unknown } }
  | { version: typeof A2UI_VERSION; deleteSurface: { surfaceId: string } };

/** Client→server A2UI user action (v0.9 `action` object). */
export type A2uiAction = {
  name: string;
  surfaceId?: string;
  sourceComponentId?: string;
  timestamp?: string;
  context?: Record<string, unknown>;
};

// ── component helpers ──────────────────────────────────────────────────────

const text = (id: string, t: Dyn, variant?: string): A2uiComponent =>
  ({ id, component: "Text", text: t, ...(variant ? { variant } : {}) });
const button = (id: string, child: string, name: string, context: Record<string, Dyn>, variant?: string): A2uiComponent =>
  ({ id, component: "Button", child, action: { event: { name, context } }, ...(variant ? { variant } : {}) });
const row = (id: string, children: string[], extra: Record<string, unknown> = {}): A2uiComponent =>
  ({ id, component: "Row", children, ...extra });
const column = (id: string, children: string[]): A2uiComponent => ({ id, component: "Column", children });

function surface(prefix: string, components: A2uiComponent[], data: Record<string, unknown>): A2uiMessage[] {
  const surfaceId = `aindrive-${prefix}-${Math.random().toString(36).slice(2, 10)}`;
  return [
    { version: A2UI_VERSION, createSurface: { surfaceId, catalogId: A2UI_BASIC_CATALOG } },
    { version: A2UI_VERSION, updateComponents: { surfaceId, components } },
    { version: A2UI_VERSION, updateDataModel: { surfaceId, path: "/", value: data } },
  ];
}

export function humanSize(n: unknown): string {
  if (typeof n !== "number" || !Number.isFinite(n)) return "";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0; let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${i === 0 ? v : v.toFixed(1)} ${u[i]}`;
}

export const parentOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
export const baseOf = (p: string) => (p.includes("/") ? p.slice(p.lastIndexOf("/") + 1) : p);

type Item = { label: string; meta: string; path: string; is_dir: boolean; drive_id: string };

/**
 * A browsable list: title, optional toolbar (up + search box), and a templated
 * List whose rows are borderless buttons firing `aindrive.open`
 * (or `aindrive.open_drive` for the drive picker).
 */
function listSurface(prefix: string, opts: {
  title: string; driveId: string; path: string; items: Item[]; toolbar: boolean;
  openAction?: "aindrive.open" | "aindrive.open_drive"; note?: string;
}): A2uiMessage[] {
  const open = opts.openAction ?? "aindrive.open";
  const rootChildren = ["title"];
  const comps: A2uiComponent[] = [text("title", { path: "/title" }, "h3")];
  if (opts.toolbar) {
    rootChildren.push("toolbar");
    const tb = ["search_field", "search_btn"];
    if (opts.path) tb.unshift("up_btn");
    comps.push(
      row("toolbar", tb, { align: "center" }),
      button("up_btn", "up_label", "aindrive.open", { drive_id: { path: "/drive_id" }, path: { path: "/parent" }, is_dir: true }),
      text("up_label", "⬆ Up"),
      { id: "search_field", component: "TextField", label: "Search file names", value: { path: "/query" }, weight: 1 },
      button("search_btn", "search_label", "aindrive.search",
        { drive_id: { path: "/drive_id" }, query: { path: "/query" }, path: { path: "/path" } }, "primary"),
      text("search_label", "Search"),
    );
  }
  rootChildren.push(opts.items.length ? "list" : "empty");
  comps.push(
    { id: "list", component: "List", children: { componentId: "item", path: "/items" } },
    row("item", ["item_open", "item_meta"], { align: "center", justify: "spaceBetween" }),
    button("item_open", "item_label", open,
      open === "aindrive.open_drive"
        ? { drive_id: { path: "drive_id" } }
        : { drive_id: { path: "drive_id" }, path: { path: "path" }, is_dir: { path: "is_dir" } },
      "borderless"),
    text("item_label", { path: "label" }),
    text("item_meta", { path: "meta" }, "caption"),
    text("empty", "(empty)", "caption"),
  );
  if (opts.note) { rootChildren.push("note"); comps.push(text("note", opts.note, "caption")); }
  comps.unshift(column("root", rootChildren));
  return surface(prefix, comps, {
    title: opts.title, drive_id: opts.driveId, path: opts.path, parent: parentOf(opts.path), query: "", items: opts.items,
  });
}

function cardSurface(prefix: string, title: string, body: string, driveId?: string, folder?: string): A2uiMessage[] {
  const rootChildren = ["title", "card"];
  const comps: A2uiComponent[] = [
    text("title", { path: "/title" }, "h3"),
    { id: "card", component: "Card", child: "body" },
    text("body", { path: "/body" }),
  ];
  if (driveId !== undefined && folder !== undefined) {
    rootChildren.push("open_btn");
    comps.push(
      button("open_btn", "open_label", "aindrive.open", { drive_id: { path: "/drive_id" }, path: { path: "/folder" }, is_dir: true }),
      text("open_label", "📁 Open folder"),
    );
  }
  comps.unshift(column("root", rootChildren));
  return surface(prefix, comps, { title, body, drive_id: driveId ?? "", folder: folder ?? "" });
}

const MAX_PREVIEW_CHARS = 20_000;
/** Inline image cap (base64 chars ≈ 1.5 MB of image) — larger ones get a note, not a data URL. */
const MAX_INLINE_IMAGE_B64 = 2_000_000;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg)$/i;

function previewSurface(driveId: string, path: string, r: Record<string, unknown>): A2uiMessage[] {
  let content = typeof r.content === "string" ? r.content : "";
  let encoding = r.encoding;
  // An SVG read as text is still an image.
  if (encoding !== "base64" && /\.svg$/i.test(path) && content.trimStart().startsWith("<")) {
    content = typeof btoa === "function" ? btoa(unescape(encodeURIComponent(content))) : Buffer.from(content, "utf8").toString("base64");
    encoding = "base64";
  }
  const isImage = encoding === "base64" && IMAGE_EXT.test(path) && content.length <= MAX_INLINE_IMAGE_B64;
  const comps: A2uiComponent[] = [
    column("root", ["title", "toolbar", "card"]),
    text("title", { path: "/title" }, "h3"),
    row("toolbar", ["back_btn"]),
    button("back_btn", "back_label", "aindrive.open", { drive_id: { path: "/drive_id" }, path: { path: "/parent" }, is_dir: true }),
    text("back_label", "⬅ Back to folder"),
    { id: "card", component: "Card", child: "body" },
  ];
  const data: Record<string, unknown> = { title: `📄 ${baseOf(path)}`, drive_id: driveId, parent: parentOf(path) };
  if (isImage) {
    const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
    const mime = ext === "svg" ? "image/svg+xml" : `image/${ext === "jpg" ? "jpeg" : ext}`;
    comps.push({ id: "body", component: "Image", url: { path: "/image_url" }, fit: "contain", variant: "largeFeature" });
    data.image_url = `data:${mime};base64,${content}`;
  } else {
    comps.push(text("body", { path: "/content" }));
    const shown = encoding === "base64"
      ? `(${IMAGE_EXT.test(path) ? "image too large to preview" : "binary file"}, ${humanSize(Math.floor(content.length * 3 / 4))})`
      : content;
    const clipped = shown.length > MAX_PREVIEW_CHARS ? `${shown.slice(0, MAX_PREVIEW_CHARS)}\n…(truncated)` : shown;
    data.content = /\.(md|markdown)$/i.test(path) || encoding === "base64" ? clipped : "```\n" + clipped + "\n```";
  }
  return surface("preview", comps, data);
}

/**
 * Build the A2UI surface for one skill call. `driveId` is the drive the call
 * ran against (from args or the pinned ctx); `args` are the skill arguments.
 */
export function a2uiForSkill(
  skill: string,
  args: Record<string, unknown>,
  result: SkillResult,
  driveId?: string,
): A2uiMessage[] {
  const drive = (typeof args.drive_id === "string" && args.drive_id) || driveId || "";
  const path = typeof args.path === "string" ? args.path.replace(/^\/+|\/+$/g, "") : "";

  if (result.kind === "err") {
    return cardSurface("error", "⚠️ Something went wrong", `[${result.code}] ${result.message}`);
  }
  const s = (result.structured ?? {}) as Record<string, unknown>;

  switch (skill) {
    case "list_drives": {
      const drives = (s.drives ?? []) as Array<{ id: string; name: string }>;
      return listSurface("drives", {
        title: "Your drives", driveId: "", path: "", toolbar: false, openAction: "aindrive.open_drive",
        items: drives.map((d) => ({ label: `💽 ${d.name}`, meta: d.id, path: "", is_dir: true, drive_id: d.id })),
      });
    }
    case "list_files": {
      const entries = (s.entries ?? []) as Array<{ name: string; isDir: boolean; size?: number; locked?: boolean }>;
      return listSurface("browser", {
        title: `📁 /${path}`, driveId: drive, path, toolbar: true,
        items: entries.map((e) => ({
          label: `${e.isDir ? "📁" : "📄"} ${e.name}${e.locked ? " 🔒" : ""}`,
          meta: e.isDir ? "folder" : humanSize(e.size),
          path: path ? `${path}/${e.name}` : e.name,
          is_dir: !!e.isDir,
          drive_id: drive,
        })),
      });
    }
    case "search": {
      const matches = (s.matches ?? []) as Array<{ path: string; isDir: boolean; locked?: boolean }>;
      return listSurface("search", {
        title: `🔍 "${String(args.query ?? "")}"`, driveId: drive, path, toolbar: true,
        note: s.truncated ? "Showing the first results only — refine the query for more." : undefined,
        items: matches.map((m) => ({
          label: `${m.isDir ? "📁" : "📄"} ${m.path}${m.locked ? " 🔒" : ""}`,
          meta: m.isDir ? "folder" : "", path: m.path, is_dir: !!m.isDir, drive_id: drive,
        })),
      });
    }
    case "read_file":
      return previewSurface(drive, path, s);
    case "write_file":
      return cardSurface("result", "✅ Saved", `Wrote /${path}`, drive, parentOf(path));
    case "delete_path":
      return cardSurface("result", "🗑 Deleted", `Deleted ${s.kind === "folder" ? "folder" : "file"} /${path}`, drive, parentOf(path));
    case "stat": {
      const e = s as { name?: string; isDir?: boolean; size?: number; mtimeMs?: number };
      const lines = [
        `Type: ${e.isDir ? "folder" : "file"}`,
        e.isDir ? "" : `Size: ${humanSize(e.size)}`,
        e.mtimeMs ? `Modified: ${new Date(e.mtimeMs).toISOString()}` : "",
      ].filter(Boolean).join("\n\n");
      return cardSurface("stat", `ℹ️ /${path}`, lines, drive, e.isDir ? path : parentOf(path));
    }
    default:
      return cardSurface("result", skill, result.text);
  }
}

// ── actions (renderer → agent) ─────────────────────────────────────────────

/**
 * Accept the shapes renderers actually send: a v0.9 client event
 * `{version, action}`, a bare `action` object, `{action}`, or AG-UI/CopilotKit's
 * `{userAction}` (forwardedProps.a2uiAction).
 */
export function parseA2uiAction(input: unknown): A2uiAction | null {
  if (!input || typeof input !== "object") return null;
  const o = input as Record<string, unknown>;
  const candidate = (o.action ?? o.userAction ?? o) as Record<string, unknown>;
  if (typeof candidate?.name !== "string") return null;
  const context = candidate.context && typeof candidate.context === "object" ? candidate.context as Record<string, unknown> : {};
  return { ...candidate, name: candidate.name, context } as A2uiAction;
}

export type SkillCall = { skill: string; args: Record<string, unknown> };

/** Map an aindrive A2UI action to the skill call that answers it. */
export function actionToSkill(action: A2uiAction, fallbackDriveId?: string): SkillCall | { error: string } {
  const c = action.context ?? {};
  const drive_id = (typeof c.drive_id === "string" && c.drive_id) || fallbackDriveId;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  switch (action.name) {
    case "aindrive.open_drive":
      if (!drive_id) return { error: "aindrive.open_drive needs context.drive_id" };
      return { skill: "list_files", args: { drive_id, path: "" } };
    case "aindrive.open": {
      if (!drive_id) return { error: "aindrive.open needs context.drive_id" };
      const isDir = c.is_dir === true || c.is_dir === "true";
      if (isDir) return { skill: "list_files", args: { drive_id, path: str(c.path) } };
      // Images are previewed inline, so fetch their bytes.
      return { skill: "read_file", args: { drive_id, path: str(c.path), ...(IMAGE_EXT.test(str(c.path)) ? { encoding: "base64" } : {}) } };
    }
    case "aindrive.search": {
      if (!drive_id) return { error: "aindrive.search needs context.drive_id" };
      const query = str(c.query).trim();
      if (!query) return { skill: "list_files", args: { drive_id, path: str(c.path) } };
      return { skill: "search", args: { drive_id, query, path: str(c.path) } };
    }
    default:
      return { error: `unknown action: ${action.name}` };
  }
}

/** Tiny text-command grammar shared by A2A TextParts and AG-UI user messages. */
export function commandToSkill(textIn: string, driveId?: string): SkillCall {
  const t = textIn.trim();
  const [cmd, ...rest] = t.split(/\s+/);
  const arg = rest.join(" ");
  const withDrive = (args: Record<string, unknown>) => (driveId ? { drive_id: driveId, ...args } : args);
  switch ((cmd ?? "").toLowerCase()) {
    case "drives": return { skill: "list_drives", args: {} };
    case "ls": return { skill: "list_files", args: withDrive({ path: arg }) };
    case "cat": case "open": return { skill: "read_file", args: withDrive({ path: arg }) };
    case "stat": return { skill: "stat", args: withDrive({ path: arg }) };
    case "find": case "search": return { skill: "search", args: withDrive({ query: arg }) };
    default:
      if (!t) return driveId ? { skill: "list_files", args: withDrive({ path: "" }) } : { skill: "list_drives", args: {} };
      return driveId ? { skill: "search", args: withDrive({ query: t }) } : { skill: "list_drives", args: {} };
  }
}
