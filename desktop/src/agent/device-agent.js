// The Mac's aindrive-on-device: one file index per folder this Mac holds, the phone's query understanding
// (router.js) and answers (ask-runner.js), and the phone's multi-folder merge (AgentService.ask).
import { copyFile, mkdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createAskRunner } from "./ask-runner.js";
import { FileIndex } from "./file-index.js";
import { GeoLookup } from "./geo-lookup.js";
import { indexFolder } from "./indexer.js";
import { contentWords, QueryParser } from "./query-parser.js";
import * as router from "./router.js";

/**
 * @param {{ indexDir: string, folders: () => { driveId: string, folder: string, label: string }[],
 *   inside: (root: string, rel: string) => string, mimeOf: (name: string) => string, onChange?: () => void }} o
 */
export function createDeviceAgent({ indexDir, folders, inside, mimeOf, onChange = () => {} }) {
  let geo = null;
  const geoLookup = () => (geo ??= GeoLookup.loadDefault());
  /** driveId → { index, runner, state } */
  const byDrive = new Map();

  function entry(d) {
    let e = byDrive.get(d.driveId);
    if (!e) {
      const index = new FileIndex(join(indexDir, d.driveId.replace(/[^A-Za-z0-9_-]/g, "_") + ".json"));
      const ops = {
        copy: async (from, to) => { const dest = inside(d.folder, to); await mkdir(dirname(dest), { recursive: true }); await copyFile(inside(d.folder, from), dest); },
        move: async (from, to) => { const dest = inside(d.folder, to); await mkdir(dirname(dest), { recursive: true }); await rename(inside(d.folder, from), dest); },
      };
      const parser = new QueryParser(geoLookup());
      const runner = createAskRunner({ index, geo: geoLookup(), parser, router, contentWords, ops });
      e = { index, runner, parser, state: { running: false, done: 0, total: 0, failed: 0, phase: "idle", lastRunMs: 0 }, cancel: false };
      byDrive.set(d.driveId, e);
    }
    return e;
  }

  /** Index one folder (incremental); a second call while one runs is a no-op. */
  async function reindex(d) {
    const e = entry(d);
    if (e.state.running) return;
    e.state.running = true; e.cancel = false; onChange();
    let last = 0;
    try {
      const r = await indexFolder({ root: d.folder, index: e.index, geo: geoLookup(), mimeOf, cancelled: () => e.cancel,
        onProgress: (p) => { Object.assign(e.state, p); if (Date.now() - last > 500 || p.phase === "done") { last = Date.now(); onChange(); } } });
      e.state.failed = r.failed;
      e.state.phase = r.cancelled ? "cancelled" : "done";
      e.state.lastRunMs = Date.now();
    } catch (err) {
      e.state.phase = `error: ${err.message}`;
    } finally { e.state.running = false; onChange(); }
  }

  function indexStatus(driveId) {
    const e = byDrive.get(driveId);
    if (!e) return undefined;
    return { indexed: e.index.count(), ...e.state, recognised: 0, toRecognise: 0, recognisedTotal: 0 };
  }

  function forget(driveId) { const e = byDrive.get(driveId); if (e) e.cancel = true; byDrive.delete(driveId); }

  /**
   * One question over every folder (or just `driveId`). Small talk and out-of-scope turns are answered
   * once, before any folder is searched; folders that only matched loosely are dropped when another
   * matched exactly; the same photo copied into a collected folder is listed once.
   */
  async function ask(query, context, driveId) {
    const all = folders().filter((d) => !driveId || d.driveId === driveId);
    if (!all.length) throw new Error(driveId ? "That folder isn't open on this Mac" : "No folder is shared on this Mac yet");
    const routed = entry(all[0]).runner.route(query, context);
    // A turn the router reads as chat but that names a file here ("AI Network - 2.001") is a search by name:
    // the router knows language, only the index knows what is on this Mac.
    if (routed?.query === "chat") {
      await ensureIndexed(all);
      const named = byName(all, query);
      if (named) return named;
    }
    if (routed) return { ...routed, answer: forMac(routed.answer) };
    await ensureIndexed(all);
    const results = [];
    for (const d of all) results.push({ d, r: await entry(d).runner.ask(query, context) });
    if (results.length === 1) {
      const { d, r } = results[0];
      for (const s of r.sources) s.driveId = d.driveId;
      if (r.action) r.action.driveId = d.driveId;
      return r;
    }
    const anyExact = results.some(({ r }) => r.sources.length && !r.relaxed);
    const sources = [], parts = [], seen = new Set();
    let action = null;
    for (const { d, r } of results) {
      if (anyExact && r.relaxed) continue;
      const s = r.sources.filter((x) => { const k = x.path.split("/").pop() + "|" + x.snippet; if (seen.has(k)) return false; seen.add(k); return true; });
      if (r.sources.length && !s.length) continue;
      for (const x of s) sources.push({ ...x, driveId: d.driveId, drive: d.label });
      if (s.length) parts.push(`${d.label}: ${r.answer}`);
      if (r.action && !r.action.skipped && !action?.folder) action = { ...r.action, driveId: d.driveId };
    }
    let answer = parts.join(" ");
    if (!answer) {
      // Nobody matched: the most telling miss ("…but none of them show food" > "photos here are from …"), biggest folder first.
      const rank = (a) => (/but none of them show|해당하는 건 없어요/.test(a) ? 2 : / are from |이런 곳에서/.test(a) ? 1 : 0);
      const best = [...results].sort((x, y) => rank(y.r.answer) - rank(x.r.answer) || entry(y.d).index.count() - entry(x.d).index.count())[0];
      answer = best.r.answer;
    }
    const context0 = results.find(({ r }) => r.context)?.r.context ?? null;
    return { answer, sources, query: results[0].r.query, context: context0, ...(action ? { action } : {}) };
  }

  /** A folder never indexed yet is indexed before its first answer (a later run is incremental and in the background). */
  async function ensureIndexed(all) {
    for (const d of all) { const e = entry(d); if (!e.index.count() && !e.state.running) await reindex(d); }
  }

  function byName(all, query) {
    const text = query.trim().toLowerCase();
    if (text.length < 3) return null;
    const sources = [];
    for (const d of all) {
      for (const r of entry(d).index.rows.values()) {
        const n = r.name.toLowerCase();
        if (n === text || n.startsWith(text + ".") || (text.length >= 5 && n.includes(text))) sources.push({ path: r.path, snippet: r.kind, matchedBy: "name", driveId: d.driveId, drive: d.label });
        if (sources.length >= 50) break;
      }
    }
    if (!sources.length) return null;
    return { answer: `Found ${sources.length} file${sources.length === 1 ? "" : "s"} named “${query.trim()}”.`, sources, query: "name", context: null };
  }

  return { ask, reindex, indexStatus, forget };
}

/** The phone's replies, said by the Mac: the router's words are shared (and parity-tested) with the phone. */
export function forMac(text) {
  return String(text ?? "")
    .replace(/\bon your phone\b/g, "on this Mac").replace(/\bthis phone\b/g, "this Mac").replace(/\bon my phone\b/g, "on my Mac")
    .replace(/\ba phone assistant\b/g, "a Mac assistant").replace(/\bliving on your phone\b/g, "living on your Mac")
    .replace(/ and (your )?call history/g, "").replace(/, or “who do I call the most\?”/g, "")
    .replace(/\n· sort my call history by who I talk to most and summarize it/g, "")
    .replace(/이 폰/g, "이 Mac").replace(/폰에 있는/g, "Mac에 있는");
}
