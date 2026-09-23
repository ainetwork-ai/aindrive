// Single source for file-type → icon + color mapping. Absorbs and extends the
// old inline EntryIcon (drive-shell-parts). Used by both the list rows and the
// grid cards so a ".png" reads the same teal-vs-purple everywhere.
//
// Color choice: Drive-toned type colors via Tailwind palette classes (folders
// take the drive accent; other types map to a small semantic palette). These
// are intentionally NOT design-token colors — they're a type taxonomy, the same
// way Badge uses amber for warnings. lucide icons, bundled (self-host §4).
import {
  Folder, FileText, FileCode, FileImage, FileType, FileSpreadsheet,
  FileBarChart, FileArchive, FileAudio, FileVideo, File as FileGeneric,
  FileType2, FileAxis3d, Lock,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import clsx from "clsx";
import { previewKindFor, type PreviewKind } from "@/lib/preview-kind";

export interface FileIcon {
  Icon: LucideIcon;
  /** Tailwind text-color class for the icon glyph. */
  className: string;
}

type Kind =
  | "folder" | "image" | "pdf" | "code" | "doc"
  | "sheet" | "slide" | "archive" | "audio" | "video" | "font" | "drawing" | "default";

const ICON: Record<Kind, FileIcon> = {
  folder: { Icon: Folder, className: "text-drive-accent" },
  image: { Icon: FileImage, className: "text-purple-500" },
  pdf: { Icon: FileType, className: "text-red-500" },
  code: { Icon: FileCode, className: "text-teal-600" },
  doc: { Icon: FileText, className: "text-blue-500" },
  sheet: { Icon: FileSpreadsheet, className: "text-emerald-600" },
  slide: { Icon: FileBarChart, className: "text-orange-500" },
  archive: { Icon: FileArchive, className: "text-amber-600" },
  audio: { Icon: FileAudio, className: "text-pink-500" },
  video: { Icon: FileVideo, className: "text-rose-500" },
  font: { Icon: FileType2, className: "text-slate-600" },
  drawing: { Icon: FileAxis3d, className: "text-indigo-500" },
  default: { Icon: FileGeneric, className: "text-drive-muted" },
};

// Extension overrides where the icon taxonomy is finer than the preview
// renderer (e.g. .doc and .ppt both "convert", but read as doc vs slide).
const EXT: Record<string, Kind> = {};
const add = (kind: Kind, exts: string[]) => exts.forEach((e) => (EXT[e] = kind));
add("doc", ["md", "markdown", "txt", "rtf", "doc", "dot", "docx", "odt", "ott", "pages", "wpd", "xps", "oxps"]);
add("sheet", ["csv", "tsv", "numbers"]);
add("slide", ["ppt", "pps", "pot", "odp", "key"]);
add("pdf", ["pdf"]);
add("image", ["ai", "eps", "ps"]);

// Everything else follows the preview renderer (lib/preview-kind), so a type
// that previews also gets a matching icon without a second table to update.
const BY_PREVIEW: Partial<Record<PreviewKind, Kind>> = {
  text: "code", markdown: "doc", image: "image", tiff: "image", psd: "image",
  pdf: "pdf", video: "video", audio: "audio", docx: "doc", sheet: "sheet",
  pptx: "slide", archive: "archive", font: "font", dxf: "drawing", converted: "doc",
};

function ext(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : "";
}

function kindForName(name: string): Kind | undefined {
  return EXT[ext(name)] ?? BY_PREVIEW[previewKindFor(name)];
}

/** Resolve a file/folder entry to its type icon + color. */
export function fileIcon(entry: { name: string; isDir: boolean; mime?: string }): FileIcon {
  if (entry.isDir) return ICON.folder;
  const mime = entry.mime ?? "";
  if (mime.startsWith("image/")) return ICON.image;
  if (mime === "application/pdf") return ICON.pdf;
  if (mime.startsWith("audio/")) return ICON.audio;
  if (mime.startsWith("video/")) return ICON.video;
  const byName = kindForName(entry.name);
  if (byName) return ICON[byName];
  if (mime.startsWith("text/")) return ICON.doc;
  return ICON.default;
}

/**
 * Resolve a showcase leaf name (no isDir/mime available — listings carry only
 * the leaf) to a type icon by extension. Defaults to a generic file.
 */
export function fileIconForName(leafName: string): FileIcon {
  const byName = kindForName(leafName);
  return byName ? ICON[byName] : ICON.default;
}

// Static so Tailwind's JIT scanner sees the full class strings (dynamic
// `w-${n}` would be purged). `glyph` sizes the type icon; `lock` the overlay.
const BADGE_SIZE = {
  sm: { glyph: "w-5 h-5", lock: "w-3 h-3" },
  lg: { glyph: "w-10 h-10", lock: "w-4 h-4" },
} as const;

/**
 * Locked/listed file glyph: the type icon with a small lock overlay. Used on
 * showcase cards where the buyer can't open the content yet.
 */
export function FileBadge({
  icon, locked, size = "sm", className,
}: {
  icon: FileIcon;
  locked?: boolean;
  size?: keyof typeof BADGE_SIZE;
  className?: string;
}) {
  const { Icon, className: tone } = icon;
  const s = BADGE_SIZE[size];
  return (
    <span className={clsx("relative inline-flex shrink-0", className)}>
      <Icon className={clsx(s.glyph, tone)} />
      {locked && (
        <span className="absolute -bottom-0.5 -right-0.5 flex items-center justify-center rounded-full bg-drive-panel p-px shadow-e1">
          <Lock className={clsx(s.lock, "text-drive-muted")} />
        </span>
      )}
    </span>
  );
}
