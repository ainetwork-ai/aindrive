// Mirrors mobile/android/app/src/main/java/ai/ainetwork/aindrive/index/FileIndex.java
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * One shared folder's file index: what the on-device agent searches instead of
 * walking the folder at question time. Every file is a row (kind, name, size,
 * when); photos also carry the EXIF time and a GPS-derived city/country.
 *
 * The phone keeps it in SQLite; here it is a JSON file in the app's data
 * directory (never in the user's folder), held in memory while the app runs —
 * a folder of tens of thousands of files is a few MB, and plain JSON needs no
 * Electron-built native module, so tests run under plain Node.
 */

/** Coarse file categories a person names in a question ("screenshots", "PDF", "영상"). */
export const PHOTO = "photo", SCREENSHOT = "screenshot", VIDEO = "video", AUDIO = "audio", PDF = "pdf", DOCUMENT = "document",
  SPREADSHEET = "spreadsheet", PRESENTATION = "presentation", ARCHIVE = "archive", OTHER = "other";

const SCREENSHOT_NAME = /screen[ _-]?shot|스크린샷|스크린 샷|캡처|캡쳐/i;

/** Category from mime + name — the phone's rules exactly. */
export function kindOf(mime, name) {
  const m = (mime ?? "").toLowerCase();
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
  const is = (...exts) => exts.includes(ext);
  if (m.startsWith("image/") || is("jpg", "jpeg", "png", "heic", "heif", "webp", "gif", "bmp", "dng", "raw")) return SCREENSHOT_NAME.test(name) ? SCREENSHOT : PHOTO;
  if (m.startsWith("video/") || is("mp4", "mov", "mkv", "avi", "webm", "3gp", "m4v")) return VIDEO;
  if (m.startsWith("audio/") || m === "application/ogg" || is("mp3", "m4a", "wav", "aac", "flac", "ogg", "oga", "opus", "amr", "wma", "3ga")) return AUDIO;
  if (m === "application/pdf" || ext === "pdf") return PDF;
  if (is("xls", "xlsx", "csv", "numbers", "ods") || m.includes("spreadsheet") || m.includes("excel")) return SPREADSHEET;
  if (is("ppt", "pptx", "key", "odp") || m.includes("presentation") || m.includes("powerpoint")) return PRESENTATION;
  if (is("zip", "rar", "7z", "tar", "gz", "tgz") || m.includes("zip") || m.includes("compressed")) return ARCHIVE;
  if (is("doc", "docx", "hwp", "hwpx", "txt", "md", "rtf", "odt", "pages") || m.startsWith("text/") || m.includes("word") || m.includes("hwp")) return DOCUMENT;
  return OTHER;
}

/**
 * @typedef {{ path: string, name: string, kind: string, mime?: string|null, mtimeMs: number, size: number,
 *   whenMs: number|null, lat: number|null, lon: number|null, country: string|null, city: string|null,
 *   transcript?: string|null, vec?: string|null }} Row  `vec`: the photo's CLIP vector (clip.js packVec), when recognised.  `path` is folder-relative with "/" separators and doubles as the row id.
 * @typedef {{ kind?: string|null, country?: string|null, city?: string|null, dateFrom?: number|null, dateTo?: number|null,
 *   minSize?: number|null, keywords?: string[], keywordsInTranscript?: boolean }} Filter
 */

export class FileIndex {
  /** @param {string|null} file where the index is kept (null = memory only, for tests) */
  constructor(file = null) {
    this.file = file;
    /** @type {Map<string, Row>} */
    this.rows = new Map();
    /** Which image model made the stored vectors (adoptImageModel). */
    this.imageModel = null;
    if (file && existsSync(file)) {
      try {
        const o = JSON.parse(readFileSync(file, "utf8"));
        if (o?.v === 1 && Array.isArray(o.rows)) for (const r of o.rows) this.rows.set(r.path, r);
        this.imageModel = typeof o?.imageModel === "string" ? o.imageModel : null;
      } catch { /* unreadable: rebuilt by the next index run */ }
    }
  }

  count() { return this.rows.size; }

  /** True when the file is unknown or changed since it was indexed. */
  needsIndex(path, mtimeMs, size) {
    const r = this.rows.get(path);
    return !r || r.mtimeMs !== mtimeMs || r.size !== size;
  }

  /** @param {Row} r  A changed file is recognised again: its old vector is not carried over. */
  upsert(r) { this.rows.set(r.path, r); }

  /** Vectors from another model are not comparable: drop them when the model changes (FileIndex.adoptImageModel). */
  adoptImageModel(name) {
    if (this.imageModel === name) return;
    for (const r of this.rows.values()) delete r.vec;
    this.imageModel = name;
  }

  /** Drop rows whose file is gone. */
  deleteMissing(live) {
    let n = 0;
    for (const p of [...this.rows.keys()]) if (!live.has(p)) { this.rows.delete(p); n++; }
    return n;
  }

  save() {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = this.file + ".tmp";
    writeFileSync(tmp, JSON.stringify({ v: 1, imageModel: this.imageModel, rows: [...this.rows.values()] }));
    renameSync(tmp, this.file);
  }

  /**
   * Filtered rows, newest first (largest first when a size floor is asked for). `limit` ≤ 0 = no limit.
   * @param {Filter} f
   * @returns {Row[]}
   */
  query(f, limit = 0) {
    const kws = (f.keywords ?? []).map((k) => k.toLowerCase());
    const city = f.city?.toLowerCase();
    const out = [];
    for (const r of this.rows.values()) {
      if (f.kind != null && r.kind !== f.kind) continue;
      if (f.country != null && r.country !== f.country) continue;
      if (city != null && r.city?.toLowerCase() !== city) continue;
      if (f.dateFrom != null && !(r.whenMs != null && r.whenMs >= f.dateFrom)) continue;
      if (f.dateTo != null && !(r.whenMs != null && r.whenMs < f.dateTo)) continue;
      if (f.minSize != null && !(r.size >= f.minSize)) continue;
      if (f.keywordsInTranscript && kws.length) {
        // Any keyword heard is a candidate (speech recognition drops words); callers rank by how many hit.
        const t = r.transcript?.toLowerCase();
        if (!t || !kws.some((k) => t.includes(k))) continue;
      } else {
        const n = r.name.toLowerCase();
        if (!kws.every((k) => n.includes(k))) continue;
      }
      out.push(r);
    }
    // SQLite's "ORDER BY when_ms DESC" puts NULLs last.
    const when = (r) => (r.whenMs == null ? -Infinity : r.whenMs);
    out.sort(f.minSize != null
      ? (a, b) => b.size - a.size || when(b) - when(a)
      : (a, b) => when(b) - when(a) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return limit > 0 ? out.slice(0, limit) : out;
  }
}
