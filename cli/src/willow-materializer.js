// The agent writes each collaborative document into the real file (spec D8): on
// every new update entry for doc/<path>/~u/…, at most every `debounceMs` per
// document, render it (materialize.js, the editor's own markdown) and write the
// file if the text differs. Guards: the path must be canonical and resolve inside
// the folder (safeResolve refuses escapes and .aindrive/), and a document with an
// update still waiting for one it depends on is not written (it would be partial).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { ANY_SUBSPACE, OPEN_END } from "@jsr/earthstar__willow-utils";
import { dirname } from "node:path";
import { safeResolve, suppressFsChange } from "./rpc.js";
import { appendUpdate, loadDoc, readUpdates } from "./willow-shared/doc.js";
import { nowMicros } from "./willow-shared/schemes.js";
import { partsOf } from "./willow-shared/bytes.js";
import { docToFile, fileToUpdate, kindFor, sameContent } from "./willow-shared/materialize.js";

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

export function startMaterializer({ root, store, log = { warn() {}, info() {} }, debounceMs = 2000 }) {
  const timers = new Map();
  let stopped = false;

  const write = async (docPath) => {
    const rel = docPath.join("/");
    let abs;
    try { abs = safeResolve(root, rel); } catch (e) { log.warn({ path: rel, err: e.message }, "willow: refusing to materialise"); return; }
    const doc = await loadDoc(store, docPath);
    if (doc.store.pendingStructs || doc.store.pendingDs) return; // waiting for an update it depends on
    const kind = kindFor(rel);
    const text = docToFile(doc, kind);
    // same content (for markdown: same meaning) → leave the file and its formatting alone
    if (existsSync(abs) && sameContent(kind, readFileSync(abs, "utf8"), text)) return;
    mkdirSync(dirname(abs), { recursive: true });
    suppressFsChange(rel);
    writeFileSync(abs, text);
    log.info({ path: rel, bytes: text.length }, "willow: materialised");
  };

  const schedule = (docPath) => {
    const k = docPath.join("/");
    clearTimeout(timers.get(k));
    timers.set(k, setTimeout(() => { timers.delete(k); if (!stopped) write(docPath).catch((e) => log.warn({ path: k, err: e.message }, "willow: materialise failed")); }, debounceMs));
  };

  const onEntry = (ev) => {
    const docPath = docPathOf(ev.detail.entry.path);
    if (docPath) schedule(docPath);
  };
  for (const name of ["entrypayloadset", "payloadingest"]) store.addEventListener(name, onEntry);

  return {
    stop() {
      stopped = true;
      for (const t of timers.values()) clearTimeout(t);
      for (const name of ["entrypayloadset", "payloadingest"]) store.removeEventListener(name, onEntry);
    },
    /** Writes every scheduled document now (tests, shutdown). */
    async flush() {
      const keys = [...timers.keys()];
      for (const k of keys) { clearTimeout(timers.get(k)); timers.delete(k); await write(k.split("/")); }
    },
  };
}

/**
 * A file changed on disk (or while the agent was off): turn the difference into one
 * update signed by the agent, so it reaches everyone and merges with their typing.
 * Only for documents Willow already has; "none" when nothing changed.
 */
export async function reconcileFile(root, store, key, rel) {
  const docPath = rel.split("/");
  if (!docPathOf(docPathEntry(docPath))) return "none"; // canonical paths only
  if ((await readUpdates(store, docPath)).length === 0) return "none";
  let text;
  try { text = readFileSync(safeResolve(root, rel), "utf8"); } catch { return "none"; }
  const doc = await loadDoc(store, docPath);
  if (doc.store.pendingStructs || doc.store.pendingDs) return "none";
  const kind = kindFor(rel);
  if (sameContent(kind, docToFile(doc, kind), text)) return "none";
  const update = fileToUpdate(doc, kind, text);
  if (!update) return "none";
  await appendUpdate(store, key, docPath, update, `disk-${nowMicros()}`);
  return "updated";
}

const docPathEntry = (docPath) => ["doc", ...docPath, "~u", "0"].map((c) => new TextEncoder().encode(c));

/** Every document the store has an update for (canonical paths only). */
export async function knownDocs(store) {
  const seen = new Map();
  const area = { includedSubspaceId: ANY_SUBSPACE, pathPrefix: [new TextEncoder().encode("doc")], timeRange: { start: 0n, end: OPEN_END } };
  for await (const [entry] of store.query({ area, maxCount: 0, maxSize: 0n }, "path")) {
    const d = docPathOf(entry.path);
    if (d) seen.set(d.join("/"), d);
  }
  return [...seen.values()];
}
