// The agent's disk side (spec D8, plan 3 + its review): each collaborative document
// is written into its file, and edits made on disk become signed updates.
//
// The base: for every document the agent keeps the state its file was last in
// (a Yjs snapshot + text, in .aindrive/willow-base/). A disk edit is then merged
// three-way — base → file, applied to the CURRENT document — so edits the agent
// already has (other people's typing, an edit received just before a crash) are
// never reverted. Before writing, a file that changed since the base is merged
// first, so a user's save is never overwritten.
//
// Guards: one queue per document (no overlapping merges); canonical paths only,
// inside the folder, never through a symlink that leads out, never into .aindrive;
// markdown the editor cannot model (tables, frontmatter, …) is left to the file;
// a file deleted on disk detaches its document instead of being recreated; a
// document with an update still waiting for one it depends on is not written.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import * as Y from "yjs";
import { ANY_SUBSPACE, OPEN_END } from "@jsr/earthstar__willow-utils";
import { safeResolve, suppressFsChange } from "./rpc.js";
import { appendUpdate, loadDoc, readUpdates } from "./willow-shared/doc.js";
import { partsOf } from "./willow-shared/bytes.js";
import { nowMicros } from "./willow-shared/schemes.js";
import { baseOf, docToFile, fileToUpdate, isLossy, kindFor, sameContent, threeWayUpdate } from "./willow-shared/materialize.js";

/** The document path of an update entry, or null when it is not a well-formed, canonical one. */
export function docPathOf(path) {
  const parts = partsOf(path);
  const u = parts.indexOf("~u");
  if (parts[0] !== "doc" || u < 2 || parts.length > u + 2) return null;
  const doc = parts.slice(1, u);
  for (const c of doc) {
    if (!c || c === "." || c === ".." || c.includes("/") || c.includes("\\") || c.includes("\0") || c !== c.normalize("NFC")) return null;
  }
  return doc;
}

const enc = new TextEncoder();
const canonical = (docPath) => !!docPathOf(["doc", ...docPath, "~u", "0"].map((c) => enc.encode(c)));

/** Every document the store has an update for (canonical paths only). */
export async function knownDocs(store) {
  const seen = new Map();
  const area = { includedSubspaceId: ANY_SUBSPACE, pathPrefix: [enc.encode("doc")], timeRange: { start: 0n, end: OPEN_END } };
  for await (const [entry] of store.query({ area, maxCount: 0, maxSize: 0n }, "path")) {
    const d = docPathOf(entry.path);
    if (d) seen.set(d.join("/"), d);
  }
  return [...seen.values()];
}

const b64 = (b) => Buffer.from(b).toString("base64");
const unb64 = (s) => new Uint8Array(Buffer.from(s, "base64"));

/**
 * @param {{ root: string, store: any, key?: any, log?: any, debounceMs?: number }} o
 * `key` (the agent's device key) is needed to turn disk edits into updates.
 */
export function createDisk({ root, store, key, log = { warn() {}, info() {} }, debounceMs = 2000 }) {
  const stateDir = join(root, ".aindrive", "willow-base");
  const realRoot = (() => { try { return realpathSync(root); } catch { return root; } })();
  const queues = new Map();
  const timers = new Map();
  const warnedLossy = new Set();
  let stopped = false;

  const stateFile = (rel) => join(stateDir, createHash("sha1").update(rel).digest("hex") + ".json");
  const loadState = (rel) => { try { return JSON.parse(readFileSync(stateFile(rel), "utf8")); } catch { return null; } };
  const saveState = (rel, st) => { mkdirSync(stateDir, { recursive: true }); const f = stateFile(rel); writeFileSync(f + ".tmp", JSON.stringify(st)); renameSync(f + ".tmp", f); };
  const baseOfState = (st) => st?.base ? { snapshot: unb64(st.base.snapshot), text: st.base.text, blocks: st.base.blocks } : null;
  const setBase = (rel, base) => saveState(rel, { base: { snapshot: b64(base.snapshot), text: base.text, blocks: base.blocks } });
  const detach = (rel) => saveState(rel, { detached: true });

  /** The file for `rel`, or null when writing there would leave the folder (review I8). */
  const target = (rel) => {
    let abs;
    try { abs = safeResolve(root, rel); } catch { return null; }
    try {
      let dir = dirname(abs);
      while (!existsSync(dir)) dir = dirname(dir);
      const real = realpathSync(dir);
      if (real !== realRoot && !real.startsWith(realRoot + sep)) return null;
      if (existsSync(abs) && lstatSync(abs).isSymbolicLink()) return null;
    } catch { return null; }
    return abs;
  };

  const queued = (rel, fn) => {
    const next = (queues.get(rel) ?? Promise.resolve()).then(fn, fn);
    queues.set(rel, next.catch(() => {}));
    return next;
  };

  /** Merge the file's edit (if any) into the document and write the merged document back. Runs inside the queue. */
  const reconcileLocked = async (rel) => {
    const docPath = rel.split("/");
    if (!canonical(docPath) || (await readUpdates(store, docPath)).length === 0) return "none";
    const abs = target(rel);
    if (!abs) return "none";
    const st = loadState(rel);
    if (!existsSync(abs)) {
      if (st?.base && !st.detached) { detach(rel); log.info({ path: rel }, "willow: file deleted on disk, document detached"); return "detached"; }
      return "none";
    }
    if (st?.detached) saveState(rel, {}); // the file is back: follow it again
    const kind = kindFor(rel);
    const text = readFileSync(abs, "utf8");
    if (isLossy(kind, text)) {
      if (!warnedLossy.has(rel)) { warnedLossy.add(rel); log.warn({ path: rel }, "willow: the editor cannot model this file (tables, frontmatter, …); the file stays the truth"); }
      return "lossy";
    }
    const doc = await loadDoc(store, docPath, { gc: false });
    if (doc.store.pendingStructs || doc.store.pendingDs) return "none";
    const base = baseOfState(st);
    const update = base ? threeWayUpdate(doc, kind, base, text) : sameContent(kind, docToFile(doc, kind), text) ? null : fileToUpdate(doc, kind, text);
    if (!update) { if (!base) setBase(rel, baseOf(doc, kind)); return "none"; }
    if (!key) return "none";
    Y.applyUpdate(doc, update);
    await appendUpdate(store, key, docPath, update, `disk-${nowMicros()}`);
    await writeLocked(rel, doc); // file and base agree again
    return "updated";
  };

  /** Write the document into its file and record the base. Runs inside the queue. */
  const writeLocked = async (rel, loaded) => {
    const docPath = rel.split("/");
    const abs = target(rel);
    if (!abs) { log.warn({ path: rel }, "willow: refusing to materialise outside the folder"); return; }
    const st = loadState(rel);
    if (st?.detached) return;
    if (!existsSync(abs) && st?.base) { detach(rel); return; } // deleted on disk: do not recreate
    const kind = kindFor(rel);
    if (existsSync(abs)) {
      const onDisk = readFileSync(abs, "utf8");
      if (isLossy(kind, onDisk)) return;
      const base = baseOfState(st);
      // the file changed since the base: take that edit first (review C2)
      if (!loaded && base && !sameContent(kind, base.text, onDisk)) { await reconcileLocked(rel); return; }
    }
    const doc = loaded ?? (await loadDoc(store, docPath, { gc: false }));
    if (doc.store.pendingStructs || doc.store.pendingDs) return;
    const text = docToFile(doc, kind);
    if (!existsSync(abs) || !sameContent(kind, readFileSync(abs, "utf8"), text)) {
      mkdirSync(dirname(abs), { recursive: true });
      suppressFsChange(rel);
      const tmp = `${abs}.aindrive-tmp-${process.pid}`;
      writeFileSync(tmp, text);
      renameSync(tmp, abs); // atomic: readers never see half a file
      log.info({ path: rel, bytes: text.length }, "willow: materialised");
    }
    setBase(rel, baseOf(doc, kind));
  };

  const materialize = (docPath) => {
    const rel = docPath.join("/");
    if (!canonical(docPath)) return Promise.resolve();
    return queued(rel, () => writeLocked(rel));
  };
  const reconcile = (rel) => queued(rel, () => reconcileLocked(rel));

  const schedule = (docPath) => {
    const k = docPath.join("/");
    clearTimeout(timers.get(k));
    timers.set(k, setTimeout(() => { timers.delete(k); if (!stopped) materialize(docPath).catch((e) => log.warn({ path: k, err: e.message }, "willow: materialise failed")); }, debounceMs));
  };
  const onEntry = (ev) => {
    const docPath = docPathOf(ev.detail.entry.path);
    if (docPath) schedule(docPath);
  };
  for (const name of ["entrypayloadset", "payloadingest"]) store.addEventListener(name, onEntry);

  return {
    materialize,
    reconcile,
    /** Startup and every reconnect: take whatever changed on disk meanwhile. */
    async reconcileAll() {
      for (const d of await knownDocs(store)) await reconcile(d.join("/")).catch((e) => log.warn({ err: e.message }, "willow: reconcile"));
    },
    async flush() {
      const keys = [...timers.keys()];
      for (const k of keys) { clearTimeout(timers.get(k)); timers.delete(k); await materialize(k.split("/")); }
    },
    stop() {
      stopped = true;
      for (const t of timers.values()) clearTimeout(t);
      for (const name of ["entrypayloadset", "payloadingest"]) store.removeEventListener(name, onEntry);
    },
  };
}

// ── earlier entry points, kept for callers and tests ─────────────────────────

export function startMaterializer({ root, store, log, debounceMs = 2000 }) {
  return createDisk({ root, store, log, debounceMs });
}

/** A one-off reconcile of `rel` (uses the persisted base when there is one). */
export async function reconcileFile(root, store, key, rel) {
  const disk = createDisk({ root, store, key });
  try { return await disk.reconcile(rel); } finally { disk.stop(); }
}


