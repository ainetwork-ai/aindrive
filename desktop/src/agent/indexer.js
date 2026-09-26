// Mirrors mobile/android/app/src/main/java/ai/ainetwork/aindrive/index/{Indexer,ExifMeta}.java (the file pass;
// recognition — CLIP vectors, transcripts — is not on the Mac yet).
import { promises as fsp } from "node:fs";
import { join } from "node:path";
import exifr from "exifr";
import { kindOf, PHOTO, SCREENSHOT } from "./file-index.js";

/** Folders a person never means when they ask about their files. */
const SKIP_DIR = /^(\.|node_modules$|\$RECYCLE\.BIN$|System Volume Information$)/;
const PARALLEL = 8;

/** Every file under `root` (folder-relative "/" paths), skipping hidden and control folders. */
export async function walkFiles(root) {
  const out = [];
  const stack = [""];
  while (stack.length) {
    const rel = stack.pop();
    let ents;
    try { ents = await fsp.readdir(join(root, rel), { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (e.name.startsWith(".")) continue;
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!SKIP_DIR.test(e.name)) stack.push(p); }
      else if (e.isFile()) out.push(p);
    }
  }
  return out;
}

/**
 * EXIF dates are local wall-clock time with no zone unless OffsetTime* is present; without it
 * the Mac's zone is assumed — what every gallery does (ExifMeta.parseDate).
 */
export function parseExifDate(dt, offset) {
  if (dt instanceof Date) return isNaN(dt.getTime()) ? null : dt.getTime();
  if (typeof dt !== "string" || dt.startsWith("0000")) return null;
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(dt.trim());
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number);
  if (typeof offset === "string" && /^[+-]\d{2}:\d{2}$/.test(offset)) {
    const sign = offset[0] === "-" ? -1 : 1;
    const off = sign * (Number(offset.slice(1, 3)) * 60 + Number(offset.slice(4, 6)));
    return Date.UTC(y, mo - 1, d, h, mi, s) - off * 60_000;
  }
  return new Date(y, mo - 1, d, h, mi, s).getTime();
}

/** When and where a photo was taken, from its EXIF header only. */
export async function readExif(file) {
  const t = await exifr.parse(file, {
    pick: ["DateTimeOriginal", "OffsetTimeOriginal", "DateTime", "OffsetTime", "GPSLatitude", "GPSLongitude", "GPSLatitudeRef", "GPSLongitudeRef"],
    reviveValues: false, translateValues: false,
  }).catch(() => null);
  if (!t) return { takenAtMs: null, lat: null, lon: null };
  const takenAtMs = parseExifDate(t.DateTimeOriginal, t.OffsetTimeOriginal) ?? parseExifDate(t.DateTime, t.OffsetTime);
  const lat = degrees(t.GPSLatitude, t.GPSLatitudeRef, "S"), lon = degrees(t.GPSLongitude, t.GPSLongitudeRef, "W");
  const ok = lat != null && lon != null && !(lat === 0 && lon === 0);
  return { takenAtMs, lat: ok ? lat : null, lon: ok ? lon : null };
}

/** EXIF GPS [deg, min, sec] + hemisphere → signed decimal degrees. */
function degrees(dms, ref, negative) {
  const v = Array.isArray(dms) ? dms[0] + (dms[1] ?? 0) / 60 + (dms[2] ?? 0) / 3600 : typeof dms === "number" ? dms : NaN;
  if (!Number.isFinite(v)) return null;
  return String(ref ?? "").toUpperCase().startsWith(negative) ? -v : v;
}

/**
 * One pass over a folder: new or changed files get a row (photos: EXIF time + nearest city),
 * vanished ones are dropped. Incremental by mtime + size, like the phone.
 * @param {{ root: string, index: import("./file-index.js").FileIndex, geo: { nearest(lat: number, lon: number): { name: string, country: string } | null } | null,
 *   mimeOf?: (name: string) => string, onProgress?: (p: { done: number, total: number, phase: string }) => void, cancelled?: () => boolean }} o
 */
export async function indexFolder({ root, index, geo, mimeOf = () => "", onProgress = () => {}, cancelled = () => false }) {
  onProgress({ done: 0, total: 0, phase: "scanning" });
  const files = await walkFiles(root);
  const live = new Set(files);
  let done = 0, failed = 0, next = 0;
  const worker = async () => {
    while (next < files.length && !cancelled()) {
      const path = files[next++];
      try {
        const st = await fsp.stat(join(root, path));
        if (index.needsIndex(path, Math.round(st.mtimeMs), st.size)) {
          const name = path.slice(path.lastIndexOf("/") + 1);
          const mime = mimeOf(name) || null;
          const row = { path, name, mime, kind: kindOf(mime, name), mtimeMs: Math.round(st.mtimeMs), size: st.size,
            whenMs: st.mtimeMs > 0 ? Math.round(st.mtimeMs) : null, lat: null, lon: null, country: null, city: null };
          if (row.kind === PHOTO || row.kind === SCREENSHOT) {
            const m = await readExif(join(root, path));
            if (m.takenAtMs != null) row.whenMs = m.takenAtMs;
            if (m.lat != null && m.lon != null) {
              row.lat = m.lat; row.lon = m.lon;
              const c = geo?.nearest(m.lat, m.lon);
              if (c) { row.city = c.name; row.country = c.country; }
            }
          }
          index.upsert(row);
        }
      } catch { failed++; }
      if (++done % 200 === 0) onProgress({ done, total: files.length, phase: "indexing" });
    }
  };
  await Promise.all(Array.from({ length: PARALLEL }, worker));
  if (cancelled()) return { done, total: files.length, failed, removed: 0, cancelled: true };
  const removed = index.deleteMissing(live);
  index.save();
  onProgress({ done, total: files.length, phase: "done" });
  return { done, total: files.length, failed, removed };
}
