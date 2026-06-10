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
  Lock,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import clsx from "clsx";

export interface FileIcon {
  Icon: LucideIcon;
  /** Tailwind text-color class for the icon glyph. */
  className: string;
}

type Kind =
  | "folder" | "image" | "pdf" | "code" | "doc"
  | "sheet" | "slide" | "archive" | "audio" | "video" | "default";

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
  default: { Icon: FileGeneric, className: "text-drive-muted" },
};

// Extension groups. mime checks (image/* etc.) take precedence for robustness,
// extension fills the gaps (code/sheet/slide have no single mime convention).
const EXT: Record<string, Kind> = {};
const add = (kind: Kind, exts: string[]) => exts.forEach((e) => (EXT[e] = kind));
add("code", ["ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "rs", "go", "java",
  "rb", "php", "c", "h", "cpp", "cs", "swift", "kt", "json", "yaml", "yml",
  "toml", "html", "htm", "css", "scss", "sh", "bash", "sql"]);
add("doc", ["md", "markdown", "txt", "rtf", "doc", "docx", "odt"]);
add("sheet", ["csv", "tsv", "xls", "xlsx", "ods"]);
add("slide", ["ppt", "pptx", "odp", "key"]);
add("pdf", ["pdf"]);
add("archive", ["zip", "tar", "gz", "tgz", "rar", "7z", "bz2", "xz"]);
add("audio", ["mp3", "wav", "flac", "aac", "ogg", "m4a"]);
add("video", ["mp4", "mov", "avi", "mkv", "webm", "m4v"]);
add("image", ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif"]);

function ext(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : "";
}

/** Resolve a file/folder entry to its type icon + color. */
export function fileIcon(entry: { name: string; isDir: boolean; mime?: string }): FileIcon {
  if (entry.isDir) return ICON.folder;
  const mime = entry.mime ?? "";
  if (mime.startsWith("image/")) return ICON.image;
  if (mime === "application/pdf") return ICON.pdf;
  if (mime.startsWith("audio/")) return ICON.audio;
  if (mime.startsWith("video/")) return ICON.video;
  const byExt = EXT[ext(entry.name)];
  if (byExt) return ICON[byExt];
  if (mime.startsWith("text/")) return ICON.doc;
  return ICON.default;
}

/**
 * Resolve a showcase leaf name (no isDir/mime available — listings carry only
 * the leaf) to a type icon by extension. Defaults to a generic file.
 */
export function fileIconForName(leafName: string): FileIcon {
  const byExt = EXT[ext(leafName)];
  return byExt ? ICON[byExt] : ICON.default;
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
