// Icons: lucide, the same set the web app uses (web/components → lucide-react),
// rendered to SVG strings for the string-template UI. Only the icons imported
// here end up in the bundle.
import {
  ArrowDown, ArrowLeft, ArrowRightLeft, ArrowUp, Bot, Check, ChevronRight, CircleDollarSign, Copy, Download, EllipsisVertical,
  ExternalLink, File, History, FileAudio, FileCode, FileImage, FileText, FileVideo, Folder, FolderInput, FolderPlus, HardDrive, House,
  Info, Cpu, Globe, LayoutGrid, Link, List, Lock, LogOut, Mail, Menu, MessageSquare, Pencil, Phone, Plug, Plus, RefreshCw, Save, Search,
  Settings, Share2, Smartphone, Sparkles, Trash2, TrendingUp, Upload, UserMinus, Users, Wallet, X,
  type IconNode,
} from "lucide";

function svg(node: IconNode, size = 20, extra = ""): string {
  const inner = node.map(([tag, attrs]) => `<${tag} ${Object.entries(attrs).map(([k, v]) => `${k}="${v}"`).join(" ")}/>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"${extra}>${inner}</svg>`;
}

const nodes = {
  agent: Bot, back: ArrowLeft, check: Check, chevron: ChevronRight, close: X, copy: Copy, dollar: CircleDollarSign,
  download: Download, drive: HardDrive, edit: Pencil, external: ExternalLink, file: File, fileAudio: FileAudio, fileCode: FileCode,
  fileImage: FileImage, fileText: FileText, fileVideo: FileVideo, folder: Folder, folderPlus: FolderPlus, grid: LayoutGrid,
  home: House, history: History, info: Info, cpu: Cpu, globe: Globe, link: Link, list: List, lock: Lock, logout: LogOut, mail: Mail, menu: Menu, chat: MessageSquare,
  more: EllipsisVertical, move: FolderInput, phone: Smartphone, call: Phone, plug: Plug, plus: Plus, refresh: RefreshCw,
  save: Save, search: Search, settings: Settings, share: Share2, sparkle: Sparkles, trash: Trash2, sales: TrendingUp,
  upload: Upload, userMinus: UserMinus, users: Users, wallet: Wallet, swap: ArrowRightLeft, up: ArrowUp, down: ArrowDown,
} satisfies Record<string, IconNode>;

export type IconName = keyof typeof nodes;

/** `I.folder` → 20px SVG; `icon("folder", 16)` for other sizes. */
export function icon(name: IconName, size = 20): string { return svg(nodes[name], size); }

export const I = Object.fromEntries(Object.keys(nodes).map((k) => [k, icon(k as IconName)])) as Record<IconName, string>;

/** File-type glyph + colour class, mirroring web/components/file-icons.tsx. */
export function fileGlyph(name: string, isDir: boolean): { svg: string; cls: string } {
  if (isDir) return { svg: icon("folder", 22), cls: "ft-folder" };
  const e = (name.split(".").pop() ?? "").toLowerCase();
  if (["jpg", "jpeg", "png", "gif", "webp", "heic", "heif", "bmp", "svg"].includes(e)) return { svg: icon("fileImage", 22), cls: "ft-image" };
  if (["mp4", "mov", "mkv", "webm", "3gp", "avi"].includes(e)) return { svg: icon("fileVideo", 22), cls: "ft-video" };
  if (["mp3", "m4a", "aac", "wav", "ogg", "oga", "opus", "flac", "amr"].includes(e)) return { svg: icon("fileAudio", 22), cls: "ft-audio" };
  if (["js", "ts", "tsx", "jsx", "py", "rs", "go", "java", "kt", "swift", "c", "cpp", "h", "sh", "json", "yaml", "yml", "toml", "sql", "xml", "html", "css"].includes(e)) return { svg: icon("fileCode", 22), cls: "ft-code" };
  if (["pdf"].includes(e)) return { svg: icon("fileText", 22), cls: "ft-pdf" };
  if (["md", "markdown", "txt", "doc", "docx", "hwp", "rtf", "csv", "log"].includes(e)) return { svg: icon("fileText", 22), cls: "ft-doc" };
  return { svg: icon("file", 22), cls: "ft-other" };
}
