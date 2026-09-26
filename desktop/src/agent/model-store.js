// Mirrors mobile/android/app/src/main/java/ai/ainetwork/aindrive/clip/ModelStore.java
/**
 * The recognition model's files on this Mac: downloaded once from the URLs in
 * the phone's manifest (assets/clip/mobileclip2-s2.json), each checked against
 * its sha256 before it is used — a truncated or tampered file is thrown away.
 */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/**
 * @typedef {{ id: string, name: string, url: string, sha256: string, bytes: number }} ModelFile
 * @param {{ dir: string, manifest: { files: ModelFile[] }, fetchImpl?: typeof fetch }} o
 */
export function createModelStore({ dir, manifest, fetchImpl = fetch }) {
  const pathOf = (f) => join(dir, f.name);
  /** A file counts once it is there with the right size; its hash was checked when it landed. */
  const have = (f) => { try { return statSync(pathOf(f)).size === f.bytes; } catch { return false; } };
  let downloading = null;
  const progress = { done: 0, total: manifest.files.reduce((n, f) => n + f.bytes, 0), error: /** @type {string|null} */ (null) };

  async function fetchOne(f, onBytes) {
    const dest = pathOf(f), tmp = dest + ".part";
    mkdirSync(dirname(dest), { recursive: true });
    const r = await fetchImpl(f.url, { redirect: "follow" });
    if (!r.ok || !r.body) throw new Error(`${f.name}: HTTP ${r.status}`);
    const hash = createHash("sha256");
    const counted = Readable.fromWeb(/** @type {any} */ (r.body)).on("data", (c) => { hash.update(c); onBytes(c.length); });
    await pipeline(counted, createWriteStream(tmp));
    const got = hash.digest("hex");
    if (got !== f.sha256) { rmSync(tmp, { force: true }); throw new Error(`${f.name}: checksum mismatch`); }
    renameSync(tmp, dest);
  }

  return {
    ready: () => manifest.files.every(have),
    file: (id) => { const f = manifest.files.find((x) => x.id === id); return f ? pathOf(f) : null; },
    status: () => ({ downloading: !!downloading, done: progress.done, total: progress.total, error: progress.error }),
    /** Download what is missing (once at a time); resolves when every file is there. */
    ensure(onProgress = () => {}) {
      if (downloading) return downloading;
      downloading = (async () => {
        progress.error = null;
        progress.done = manifest.files.filter(have).reduce((n, f) => n + f.bytes, 0);
        try {
          for (const f of manifest.files) {
            if (have(f)) continue;
            await fetchOne(f, (n) => { progress.done += n; onProgress(progress); });
          }
        } catch (e) { progress.error = e.message; throw e; }
        finally { downloading = null; onProgress(progress); }
      })();
      return downloading;
    },
    /** Hash every file again (tests, or a suspected corrupt download). */
    async verify() {
      for (const f of manifest.files) {
        if (!existsSync(pathOf(f))) return false;
        const h = createHash("sha256");
        await pipeline(createReadStream(pathOf(f)), h);
        if (h.digest("hex") !== f.sha256) return false;
      }
      return true;
    },
  };
}
