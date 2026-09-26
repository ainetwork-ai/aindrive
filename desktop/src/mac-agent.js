/**
 * The Mac's `AindriveAgent` — the native plugin the mobile shell (mobile/src)
 * calls, implemented on this Mac instead of Android (Java) / iOS (Swift):
 *
 *   start/stop/status   one bundled CLI agent per drive (agents.js), restored at launch
 *   pickFolder/addFiles native dialogs
 *   list/read/write/…   the folder, read locally (Node fs) — like SafFs / DriveFs
 *   openFile            Quick Look, like iOS
 *   thumbnail           macOS thumbnails, served as app://thumb/…
 *   ask                 aindrive-on-device: the phone's agent over this Mac's folders (agent/)
 *
 * What only the phone has — call log, on-device recognition models, Google's
 * account picker, handoff links (served by the phone agent's `handoff-read`) —
 * answers with a clear "not on the Mac" instead of pretending.
 *
 * Paths (`folderUri`) are absolute folder paths the user picked here; every call
 * is refused unless the folder was picked (or served) on this Mac, and every
 * path inside it must stay inside it.
 */
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, promises as fsp, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { driveUrlOf, isFolder } from "./agents.js";
import { createDeviceAgent } from "./agent/device-agent.js";

const MIME = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp", ".heic": "image/heic", ".svg": "image/svg+xml",
  ".mp4": "video/mp4", ".mov": "video/quicktime", ".m4v": "video/x-m4v", ".webm": "video/webm",
  ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".wav": "audio/wav", ".aac": "audio/aac", ".ogg": "audio/ogg",
  ".pdf": "application/pdf", ".txt": "text/plain", ".md": "text/markdown", ".csv": "text/csv", ".json": "application/json",
  ".html": "text/html", ".xml": "application/xml", ".zip": "application/zip",
  ".doc": "application/msword", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint", ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};
export const mimeOf = (name) => MIME[extname(name).toLowerCase()] ?? "application/octet-stream";
const MAX_READ_BYTES = 40 * 1024 * 1024;

const present = (p) => { try { lstatSync(p); return true; } catch { return false; } };

/**
 * The real path of `p`, or of its nearest existing ancestor plus the rest. A
 * dangling symlink counts as existing — and cannot be resolved, so it is refused
 * rather than followed wherever it points.
 */
function realish(p) {
  let head = p;
  const tail = [];
  while (!present(head)) {
    const up = dirname(head);
    if (up === head) break;
    tail.unshift(basename(head));
    head = up;
  }
  let real;
  try { real = realpathSync.native(head); } catch { throw new Error("path is outside the folder"); }
  return join(real, ...tail);
}

/**
 * `rel` inside `root`, refusing anything that climbs out — by `..` or through a
 * symlink — and any `.aindrive` (a drive's credentials) at any depth.
 */
export function inside(root, rel = "") {
  // "/" only: on macOS a backslash is an ordinary character in a file name
  const segs = String(rel ?? "").split("/").filter((x) => x && x !== ".");
  if (segs.some((x) => x === "..")) throw new Error("path is outside the folder");
  if (segs.some((x) => x.toLowerCase() === ".aindrive")) throw new Error("that path is reserved");
  const abs = join(root, ...segs);
  const realRoot = realpathSync.native(root);
  const real = realish(abs);
  if (real !== realRoot && !real.startsWith(realRoot + sep)) throw new Error("path is outside the folder");
  return abs;
}

/** `name`, or "name (2).ext", "name (3).ext"… — the first that `dir` does not have. */
function freeName(dir, name) {
  if (!present(join(dir, name))) return name;
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 2; ; i++) if (!present(join(dir, `${stem} (${i})${ext}`))) return `${stem} (${i})${ext}`;
}

/** What a phone agent returns for a listing, for one directory. */
export async function listEntries(root, rel = "") {
  const dir = inside(root, rel);
  const out = [];
  for (const d of await fsp.readdir(dir, { withFileTypes: true })) {
    if (d.name.toLowerCase() === ".aindrive" || d.name === ".DS_Store") continue;
    const abs = join(dir, d.name);
    // a link that leads out of the folder is not part of it (and could not be opened)
    if (d.isSymbolicLink()) { try { inside(root, relative(root, abs).split(sep).join("/")); } catch { continue; } }
    let st;
    try { st = await fsp.stat(abs); } catch { continue; }
    const path = relative(root, abs).split(sep).join("/");
    out.push({ name: d.name.normalize("NFC"), path: path.normalize("NFC"), isDir: st.isDirectory(), size: st.isDirectory() ? 0 : st.size, mtimeMs: st.mtimeMs, mime: st.isDirectory() ? "" : mimeOf(d.name) });
  }
  return out.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
}

/** `<folder>/.aindrive/config.json` as the CLI keeps it — the shell paired, the CLI serves. */
export function writeDriveConfig(folder, cfg) {
  const dir = join(folder, ".aindrive");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, "config.json");
  let prev = {};
  try { prev = JSON.parse(readFileSync(file, "utf8")); } catch { /* new */ }
  const next = {
    ...prev,
    driveId: cfg.driveId,
    agentToken: cfg.agentToken,
    driveSecret: cfg.driveSecret,
    serverUrl: cfg.serverUrl,
    url: `${cfg.serverUrl.replace(/\/+$/, "")}/d/${cfg.driveId}`,
    pairedAt: prev.driveId === cfg.driveId ? prev.pairedAt ?? Date.now() : Date.now(),
  };
  if (prev.driveId === next.driveId && prev.agentToken === next.agentToken && prev.driveSecret === next.driveSecret && prev.serverUrl === next.serverUrl) return;
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
}

/**
 * @param {{
 *   agents: import("./agents.js").AgentManager,
 *   store: ReturnType<typeof import("./store.js").createStore>,
 *   electron: { dialog: any, nativeImage: any, shell: any, getWindow: () => any },
 *   thumbsDir: string,
 *   emit: (status: unknown) => void,
 * }} deps
 */
/** ~/.aindrive/handoffs.json — mirrors cli/src/handoffs.js (the CLI agents read it). Expired keys are dropped on write. */
export const HANDOFFS_FILE = join(homedir(), ".aindrive", "handoffs.json");

export function writeHandoffs(add, file = HANDOFFS_FILE, now = Date.now()) {
  let all = {};
  try { all = JSON.parse(readFileSync(file, "utf8")) ?? {}; } catch { /* first handoff */ }
  const next = {};
  for (const [k, v] of Object.entries({ ...all, ...add })) if (v?.expiresAt > now && typeof v.path === "string") next[k] = v;
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 });
  renameSync(tmp, file);
}

export function createMacAgent({ agents, store, electron, thumbsDir, indexDir = join(thumbsDir, "..", "index"), emit }) {
  const { dialog, nativeImage, shell, getWindow } = electron;
  /** driveId → { folder, label, localOnly } for everything started here */
  const drives = () => store.get().drives ?? [];
  const picked = () => new Set(store.get().picked ?? []);

  /** Only folders the user picked on this Mac, and never a path outside them. */
  function folderOf(uri) {
    if (typeof uri !== "string" || !picked().has(uri)) throw new Error("That folder was not picked on this Mac");
    if (!isFolder(uri)) throw new Error(deleted(uri) ? "No such file: the folder does not exist any more" : "That folder is not available — is its disk connected?");
    return uri;
  }

  /**
   * Missing because it was deleted — not because its disk is away. Only when the
   * folder sat on the same device as its parent (so it was not a disk's root)
   * and that parent is still here on that device. The shell deletes the drive on
   * the server for a deleted folder, so "not sure" must never read as deleted.
   */
  function deleted(uri) {
    const dev = (store.get().pickedDev ?? {})[uri];
    if (dev === undefined) return false;
    try { return statSync(dirname(uri)).dev === dev; } catch { return false; }
  }

  /** aindrive-on-device: the phone's agent over the folders this Mac holds (agent/device-agent.js). */
  const device = createDeviceAgent({
    indexDir, inside, mimeOf,
    folders: () => drives().filter((d) => isFolder(d.folder)).map((d) => ({ driveId: d.driveId, folder: d.folder, label: d.label ?? basename(d.folder) })),
    onChange: () => emit(status()),
  });
  const indexSoon = (d) => { if (d && isFolder(d.folder)) void device.reindex({ driveId: d.driveId, folder: d.folder, label: d.label ?? basename(d.folder) }); };
  // Folders restored at launch are indexed too (incremental: only new or changed files are read).
  setTimeout(() => { for (const d of drives()) indexSoon(d); }, 2000).unref?.();

  function status() {
    const list = agents.list();
    const byFolder = new Map(list.map((f) => [f.folder, f]));
    const out = drives().map((d) => {
      const a = d.localOnly ? null : byFolder.get(d.folder);
      const running = d.localOnly ? isFolder(d.folder) : !!a && a.state !== "stopped";
      return {
        driveId: d.driveId,
        folderLabel: d.label ?? basename(d.folder),
        running,
        p2p: !d.localOnly,
        connected: a?.state === "online",
        rpcCount: 0,
        lastError: a?.state === "error" ? a.detail : null,
        index: device.indexStatus(d.driveId),
      };
    });
    return { running: out.some((d) => d.running), connected: out.some((d) => d.connected), drives: out };
  }
  agents.on("change", () => emit(status()));

  /** Take a drive's credentials out of its folder (they would let anyone reading it serve as the drive). */
  function forgetConfig(folder, driveId) {
    const file = join(folder, ".aindrive", "config.json");
    try {
      const c = JSON.parse(readFileSync(file, "utf8"));
      if (c.driveId === driveId) rmSync(file, { force: true });
    } catch { /* already gone */ }
  }

  function remember(entry) {
    store.update((s) => ({ ...s, drives: [...(s.drives ?? []).filter((d) => d.driveId !== entry.driveId), entry] }));
  }

  return {
    status,

    /** Restore what was running when the app last quit (the phone's foreground service does the same). */
    restore() {
      for (const d of drives()) {
        try { if (!d.localOnly) agents.start(d.folder); } catch (e) { console.error("restore", d.folder, e); }
      }
    },

    async pickFolder() {
      const r = await dialog.showOpenDialog(getWindow() ?? undefined, {
        title: "Choose a folder", buttonLabel: "Choose", properties: ["openDirectory", "createDirectory"],
        message: "Its files stay on this Mac; aindrive shows them on the web while this app runs.",
      });
      if (r.canceled || !r.filePaths[0]) throw new Error("cancelled");
      const uri = r.filePaths[0];
      // the folder's device, if it is its parent's (a disk's root is not): see deleted()
      let dev;
      try { const own = statSync(uri).dev; if (statSync(dirname(uri)).dev === own) dev = own; } catch { /* unknown */ }
      store.update((s) => ({ ...s, picked: [...new Set([...(s.picked ?? []), uri])], pickedDev: { ...(s.pickedDev ?? {}), ...(dev === undefined ? {} : { [uri]: dev }) } }));
      return { uri, label: basename(uri) };
    },

    async requestCallLog() { return { granted: false }; },

    async addFiles({ folderUri, path }) {
      const root = folderOf(folderUri);
      const dest = inside(root, path ?? "");
      const r = await dialog.showOpenDialog(getWindow() ?? undefined, { title: "Add files", buttonLabel: "Add", properties: ["openFile", "multiSelections"] });
      if (r.canceled) return { added: [], failed: [] };
      const added = [], failed = [];
      for (const src of r.filePaths) {
        // never over an existing file: a second copy gets "name (2).ext"
        const name = freeName(dest, basename(src));
        try { copyFileSync(src, join(dest, name), constants.COPYFILE_EXCL); added.push(name); } catch { failed.push(basename(src)); }
      }
      return { added, failed };
    },

    async mkdir({ folderUri, path }) { await fsp.mkdir(inside(folderOf(folderUri), path), { recursive: true }); },
    async rename({ folderUri, from, to }) {
      const root = folderOf(folderUri);
      const src = inside(root, from), dst = inside(root, to);
      // a rename or move never replaces another file — renaming to a different letter case of itself is fine
      if (present(dst)) {
        const a = lstatSync(src), b = lstatSync(dst);
        if (a.dev !== b.dev || a.ino !== b.ino) throw new Error(`"${basename(dst)}" already exists there`);
      }
      await fsp.rename(src, dst);
    },
    async writeText({ folderUri, path, text }) { await fsp.writeFile(inside(folderOf(folderUri), path), String(text ?? ""), "utf8"); },
    async delete({ folderUri, path }) {
      const root = folderOf(folderUri);
      const abs = inside(root, path);
      if (abs === root) throw new Error("can't delete the shared folder itself");
      await fsp.rm(abs, { recursive: true, force: true });
    },
    async listFolder({ folderUri, path }) { return { entries: await listEntries(folderOf(folderUri), path ?? "") }; },

    async openFile({ folderUri, path }) {
      const abs = inside(folderOf(folderUri), path);
      // Quick Look shows it without running anything, like the phone's viewer
      if (process.platform === "darwin") spawn("qlmanage", ["-p", abs], { stdio: "ignore", detached: true }).unref();
      else shell.showItemInFolder(abs);
    },

    async readFile({ folderUri, path, maxPx }) {
      const abs = inside(folderOf(folderUri), path);
      const name = basename(abs);
      const mime = mimeOf(name);
      if (mime.startsWith("image/") && mime !== "image/svg+xml") {
        const img = nativeImage.createFromPath(abs);
        if (!img.isEmpty()) {
          const { width, height } = img.getSize();
          const max = maxPx ?? 1600;
          const k = Math.min(1, max / Math.max(width, height));
          const out = k < 1 ? img.resize({ width: Math.round(width * k), height: Math.round(height * k), quality: "good" }) : img;
          return { mime: "image/jpeg", name, base64: out.toJPEG(85).toString("base64") };
        }
      }
      if (statSync(abs).size > MAX_READ_BYTES) throw new Error("That file is too large to show here — open it instead");
      return { mime, name, base64: (await fsp.readFile(abs)).toString("base64") };
    },

    async thumbnail({ folderUri, path, px }) {
      const abs = inside(folderOf(folderUri), path);
      const size = Math.max(32, Math.min(1024, px ?? 256));
      const st = statSync(abs);
      const key = createHash("sha1").update(`${abs}|${st.mtimeMs}|${size}`).digest("hex");
      const file = join(thumbsDir, `${key}.jpg`);
      try { statSync(file); } catch {
        mkdirSync(thumbsDir, { recursive: true });
        let img = null;
        try { img = await nativeImage.createThumbnailFromPath(abs, { width: size, height: size }); } catch { /* not macOS, or no preview */ }
        if (!img || img.isEmpty()) {
          const full = nativeImage.createFromPath(abs);
          if (full.isEmpty()) throw new Error("no thumbnail");
          const { width, height } = full.getSize();
          const k = Math.min(1, size / Math.max(width, height));
          img = full.resize({ width: Math.round(width * k), height: Math.round(height * k) });
        }
        writeFileSync(file, img.toJPEG(80));
      }
      return { path: `app://thumb/${key}.jpg` };
    },

    async googleSignIn() {
      throw new Error("Google sign-in isn't on the Mac app yet — use “Other ways to sign in”: it opens aindrive in your browser.");
    },

    /**
     * Files the owner confirmed handing to another agent (aindrive-cloud): a random key per file in
     * ~/.aindrive/handoffs.json, which this Mac's CLI agents serve over `handoff-read` (cli/src/handoffs.js)
     * — only those keys, only until they expire. Mirrors AindriveAgentPlugin.registerHandoffs on the phone.
     */
    async registerHandoffs({ files, ttlSeconds = 900 } = {}) {
      if (!Array.isArray(files) || !files.length) throw new Error("missing files");
      const expiresAt = Date.now() + Number(ttlSeconds) * 1000 + 60_000;
      const out = [], entries = {};
      for (const f of files) {
        const abs = realpathSync.native(inside(folderOf(f?.folderUri), f?.path));
        const st = statSync(abs);
        if (!st.isFile()) throw new Error(`Not a file: ${f.path}`);
        const key = randomBytes(18).toString("base64url");
        entries[key] = { path: abs, expiresAt };
        out.push({ key, path: f.path, name: basename(abs), mime: mimeOf(abs), size: st.size });
      }
      writeHandoffs(entries);
      return { files: out };
    },

    async start(config) {
      const folder = folderOf(config?.folderUri);
      if (config.source) throw new Error("Agent sources (calls, camera roll) are phone-only");
      if (!config.localOnly) {
        if (!config.driveId || !config.agentToken || !config.driveSecret || !/^https?:\/\//.test(config.serverUrl ?? "")) throw new Error("missing drive credentials");
        writeDriveConfig(folder, config);
      }
      // one entry per folder: a folder that goes from local-only to connected keeps one agent
      store.update((s) => ({ ...s, drives: (s.drives ?? []).filter((d) => d.folder !== folder || d.driveId === config.driveId) }));
      remember({ driveId: config.driveId, folder, label: config.folderLabel ?? basename(folder), localOnly: !!config.localOnly, server: config.serverUrl });
      indexSoon(drives().find((d) => d.driveId === config.driveId));
      if (config.localOnly) agents.stop(folder);
      else agents.start(folder);
      const s = status();
      emit(s);
      return s;
    },

    async stop(opts) {
      const ids = opts?.driveId ? [opts.driveId] : drives().map((d) => d.driveId);
      for (const id of ids) {
        const d = drives().find((x) => x.driveId === id);
        if (!d) continue;
        agents.remove(d.folder);
        device.forget(id);
        store.update((s) => ({ ...s, drives: (s.drives ?? []).filter((x) => x.driveId !== id) }));
        // the shell keeps the credentials it needs to turn it on again; the folder should not
        if (!d.localOnly) forgetConfig(d.folder, id);
      }
      const s = status();
      emit(s);
      return s;
    },

    async reindex(opts) {
      for (const d of drives()) if (!opts?.driveId || d.driveId === opts.driveId) indexSoon(d);
      return status();
    },
    async ensureModels() { return status(); },

    /** The phone's on-device agent, on this Mac's folders: small talk, dates, places (EXIF GPS), kinds, names, tasks. */
    async ask({ query, context, driveId }) {
      return device.ask(String(query ?? ""), context ?? null, driveId);
    },

    /**
     * v0.1 kept folders it shared by path. They are handed to the shell once
     * (`adoptable`), which lists and serves them like any folder it paired —
     * nothing is served behind its back.
     */
    migrate() {
      const old = store.get().folders ?? [];
      if (!old.length) return;
      store.update((s) => ({
        ...s,
        folders: [],
        picked: [...new Set([...(s.picked ?? []), ...old.map((f) => f.path)])],
        adopt: [...(s.adopt ?? []), ...old.filter((f) => driveUrlOf(f.path)).map((f) => ({ path: f.path, paused: !!f.paused }))],
      }));
    },

    /** Folders paired before this shell existed, with their drive — once; the shell saves them. */
    async adoptable() {
      const out = [];
      for (const entry of store.get().adopt ?? []) {
        const folder = typeof entry === "string" ? entry : entry.path;
        try {
          const c = JSON.parse(readFileSync(join(folder, ".aindrive", "config.json"), "utf8"));
          if (c.driveId && c.agentToken && c.driveSecret && c.serverUrl) {
            // a folder paused in the old app stays off
            out.push({ folder: { uri: folder, label: basename(folder) }, drive: { driveId: c.driveId, agentToken: c.agentToken, driveSecret: c.driveSecret, url: c.url }, serverUrl: c.serverUrl, on: !(typeof entry === "object" && entry.paused) });
          }
        } catch { /* gone or unpaired */ }
      }
      store.update((s) => ({ ...s, adopt: [] }));
      return { folders: out };
    },
  };
}

