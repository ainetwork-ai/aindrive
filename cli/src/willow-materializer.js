// The agent writes each collaborative document into the real file (spec D8): on
// every new update entry for doc/<path>/~u/…, at most every `debounceMs` per
// document, render it (materialize.js, the editor's own markdown) and write the
// file if the text differs. Guards: the path must be canonical and resolve inside
// the folder (safeResolve refuses escapes and .aindrive/), and a document with an
// update still waiting for one it depends on is not written (it would be partial).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { safeResolve, suppressFsChange } from "./rpc.js";
import { loadDoc } from "./willow-shared/doc.js";
import { partsOf } from "./willow-shared/bytes.js";
import { docToFile, kindFor } from "./willow-shared/materialize.js";

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
    const text = docToFile(doc, kindFor(rel));
    if (existsSync(abs) && readFileSync(abs, "utf8") === text) return;
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
