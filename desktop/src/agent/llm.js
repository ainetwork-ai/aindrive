// Mirrors the phone's Understander.java (model → SearchQuery) and its model download (ModelStore).
/**
 * The local model that reads a turn the rules were unsure about
 * (docs/superpowers/specs/2026-09-27-llm-understanding-design.md, "Mac").
 *
 * Two parts, both pure Node (node-llama-cpp is imported only when a model is really loaded,
 * so tests inject a fake generator):
 *
 *   createModelStore  the manifest (assets/llm/<id>.json) → a verified GGUF in the models dir:
 *                     resume-safe `.part` download, sha256 checked before the file gets its name
 *   createLlm         lazy load (one context, unloaded after 5 min idle), `understand()` = prompt →
 *                     JSON-schema-constrained generation → the rules' own SearchQuery + route
 *
 * The model only hands back words: `place` and `when` are resolved by the gazetteer and the parser's
 * date rules, `content` is filtered like the parser's keywords. It can never delete, move or share
 * (downgraded to find / collect), and anything that fails to parse, names a place that is not in the
 * message, or runs past the budget returns null — the rules' answer stands.
 */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { hasHangul } from "./java-regex.js";
import { asksToCollect, contentKeywords, isFollowUp, LARGE_BYTES, QueryParser, stripPlaceParticles } from "./query-parser.js";
import { intentOf, outOfScope, Route } from "./router.js";
import { SearchQuery } from "./search-query.js";
import { socialReply } from "./social-reply.js";

/** The prompt, word for word the phone's (the spec's "Prompt and output"). */
export const SYSTEM_PROMPT = `You turn one chat message to a file assistant into a JSON search. The assistant only knows the
files on this device: photos, screenshots, videos, recordings, PDFs, documents, spreadsheets,
presentations, archives. Output JSON only, one object:
{"route":"chat|out|files",
 "kind":"photo|screenshot|video|audio|pdf|document|spreadsheet|presentation|archive|null",
 "place":"<place name as written or null>", "when":"<time words as written or null>",
 "content":["<what the file shows or is about>"], "task":"find|count|collect|null",
 "limit":<int or 0>, "oldest":<bool>, "largest":<bool>}
route=chat for greetings and small talk; out for anything not about this device's files
(bookings, weather, general questions); files otherwise. Do not resolve dates. Do not guess a
place that is not in the message. content holds only words about the files, never verbs like
"show", "find", "list".`;

/**
 * Worked examples handed to the model as earlier turns of the chat (the system text above stays the spec's, word
 * for word). Without them a 3B model routes nearly everything to "chat" — the grammar makes it commit to `route`
 * before it has written anything else — and with them every sample turn routes right (measured in the PR).
 */
export const FEW_SHOT = [
  ["photos from Tokyo last summer", { route: "files", kind: "photo", place: "Tokyo", when: "last summer", content: [], task: "find", limit: 0, oldest: false, largest: false }],
  ["can you book me a flight to Rome", { route: "out", kind: null, place: null, when: null, content: [], task: null, limit: 0, oldest: false, largest: false }],
  ["good morning!", { route: "chat", kind: null, place: null, when: null, content: [], task: null, limit: 0, oldest: false, largest: false }],
  ["the 3 biggest videos of the dog", { route: "files", kind: "video", place: null, when: null, content: ["dog"], task: "find", limit: 3, oldest: false, largest: true }],
  ["do you still have the contract from the landlord", { route: "files", kind: "document", place: null, when: null, content: ["contract", "landlord"], task: "find", limit: 0, oldest: false, largest: false }],
  ["what did we discuss in yesterday's standup", { route: "files", kind: "audio", place: null, when: "yesterday", content: ["standup"], task: "find", limit: 0, oldest: false, largest: false }],
  ["지난달 제주에서 찍은 영상 몇 개야", { route: "files", kind: "video", place: "제주", when: "지난달", content: [], task: "count", limit: 0, oldest: false, largest: false }],
];

const KINDS = ["photo", "screenshot", "video", "audio", "pdf", "document", "spreadsheet", "presentation", "archive"];
/** What the grammar lets the model write: exactly the intermediate JSON, so the output always parses. */
export const OUTPUT_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    route: { enum: ["chat", "out", "files"] },
    kind: { enum: [...KINDS, null] },
    place: { type: ["string", "null"] },
    when: { type: ["string", "null"] },
    content: { type: "array", items: { type: "string" } },
    task: { enum: ["find", "count", "collect", null] },
    limit: { type: "integer" },
    oldest: { type: "boolean" },
    largest: { type: "boolean" },
  },
  required: ["route", "kind", "place", "when", "content", "task", "limit", "oldest", "largest"],
});
export const MAX_TOKENS = 160;
export const BUDGET_MS = 2000;
export const IDLE_MS = 5 * 60_000;

/** The message as the model sees it: the previous search first, so "only the ones from Paris" resolves. */
export function userPrompt(text, context) {
  const prev = context != null && context.scope == null && Object.keys(context).length ? JSON.stringify(context) : "none";
  return `Previous search: ${prev}\n${text}`;
}

// ────────────────────────────────────────────────────────────── model store

/** sha256 of a file, streamed (the model is 2 GB). */
export async function sha256File(path) {
  const h = createHash("sha256");
  await pipeline(createReadStream(path), async function* (src) { for await (const c of src) h.update(c); });
  return h.digest("hex");
}

/** Read a manifest (assets/llm/<id>.json — same shape as the phone's llm/gemma-4-e2b.json). */
export async function readManifest(file) {
  const m = JSON.parse(await readFile(file, "utf8"));
  if (!Array.isArray(m.files) || !m.files.length) throw new Error(`${file}: no files`);
  return m;
}

/**
 * @param {{ dir: string, manifest: { model: string, license: string, engine: string, files: { id: string, name: string, url: string, sha256: string, bytes: number }[] },
 *   fetchImpl?: typeof fetch, onChange?: () => void }} o
 */
export function createModelStore({ dir, manifest, fetchImpl = globalThis.fetch, onChange = () => {} }) {
  const files = manifest.files;
  const pathOf = (f) => join(dir, f.name);
  const partOf = (f) => join(dir, f.name + ".part");
  const total = files.reduce((n, f) => n + f.bytes, 0);
  let downloading = false, error = null, done = 0, doneBefore = 0;

  /** A file with its name is one that was verified: the download only renames after the sha256 matched. */
  const present = (f) => { try { return statSync(pathOf(f)).size === f.bytes; } catch { return false; } };
  const ready = () => files.every(present);

  function status() {
    const r = ready();
    return {
      downloading, error,
      done: downloading ? done : r ? total : files.reduce((n, f) => n + (present(f) ? f.bytes : 0), 0),
      total, ready: r,
      list: [{ id: "llm", role: "reads unclear questions", name: manifest.model, license: manifest.license, engine: manifest.engine, bytes: total, ready: r }],
    };
  }

  async function download(f) {
    mkdirSync(dir, { recursive: true });
    const part = partOf(f);
    let have = 0;
    try { have = statSync(part).size; } catch { /* fresh */ }
    if (have > f.bytes) { rmSync(part, { force: true }); have = 0; }
    if (have < f.bytes) {
      const res = await fetchImpl(f.url, { headers: have ? { Range: `bytes=${have}-` } : {}, redirect: "follow" });
      if (!res.ok || !res.body) throw new Error(`${f.name}: HTTP ${res.status}`);
      // 200 to a Range request = the server sent the whole file: start over
      if (res.status !== 206) { rmSync(part, { force: true }); have = 0; }
      const base = have;
      let got = 0, last = 0;
      const out = createWriteStream(part, { flags: "a" });
      await pipeline(Readable.fromWeb(res.body), async function* (src) {
        for await (const chunk of src) {
          got += chunk.length;
          done = doneBefore + base + got;
          if (Date.now() - last > 500) { last = Date.now(); onChange(); }
          yield chunk;
        }
      }, out);
    }
    if (statSync(part).size !== f.bytes) throw new Error(`${f.name}: ${statSync(part).size} bytes, expected ${f.bytes}`);
    const got = await sha256File(part);
    if (got !== f.sha256) { rmSync(part, { force: true }); throw new Error(`${f.name}: checksum mismatch (${got.slice(0, 12)}…)`); }
    renameSync(part, pathOf(f));
  }

  /** Start (or resume) the download; returns at once — progress through `status()` / onChange. */
  function ensure() {
    if (downloading || ready()) return status();
    downloading = true; error = null; doneBefore = 0; done = 0;
    onChange();
    (async () => {
      try {
        for (const f of files) {
          if (!present(f)) await download(f);
          doneBefore += f.bytes; done = doneBefore;
        }
      } catch (e) {
        error = e.message;
      } finally {
        downloading = false;
        onChange();
      }
    })();
    return status();
  }

  /** The download awaited (for scripts and tests); ensure() is what the shell's button calls. */
  async function ensureDone() {
    ensure();
    while (downloading) await new Promise((r) => setTimeout(r, 50));
    if (error) throw new Error(error);
    return status();
  }

  return { status, ensure, ensureDone, ready, modelPath: () => pathOf(files.find((f) => f.id === "model") ?? files[0]) };
}

// ────────────────────────────────────────────────────────────── the model

/**
 * node-llama-cpp behind the generator interface llm.js uses: `generate(user, { signal })` → the JSON text.
 * One model + one context; the JSON-schema grammar means the text always parses.
 */
export async function loadRealGenerator(modelPath) {
  const { getLlama, LlamaChatSession } = await import("node-llama-cpp");
  // build: "never" — the prebuilt @node-llama-cpp/mac-* binary or nothing; the app never compiles llama.cpp.
  const llama = await getLlama({ build: "never", logLevel: "error" });
  const model = await llama.loadModel({ modelPath });
  const context = await model.createContext({ contextSize: 1024, sequences: 1 });
  const grammar = await llama.createGrammarForJsonSchema(OUTPUT_SCHEMA);
  const sequence = context.getSequence();
  const history = [{ type: "system", text: SYSTEM_PROMPT },
    ...FEW_SHOT.flatMap(([u, a]) => [{ type: "user", text: userPrompt(u, null) }, { type: "model", response: [JSON.stringify(a)] }])];
  return {
    async generate(user, { signal } = {}) {
      // A fresh session per turn: only the examples as history; their KV prefix is reused by the sequence.
      const session = new LlamaChatSession({ contextSequence: sequence, systemPrompt: SYSTEM_PROMPT });
      session.setChatHistory(history);
      try {
        return await session.prompt(user, { grammar, temperature: 0, maxTokens: MAX_TOKENS, signal, stopOnAbortSignal: false });
      } finally { session.dispose(); }
    },
    /** Evaluate the system prompt + examples once, so the first real turn does not spend its 2 s budget on them (≈4 s on an M1 Pro). */
    async prime() { await this.generate(userPrompt("hi", null), {}); },
    async dispose() { await context.dispose(); await model.dispose(); },
  };
}

/**
 * @param {{ modelPath: () => string | null, geo: { byPlaceName(name: string): { city: string | null, country: string } | null },
 *   loadGenerator?: (modelPath: string) => Promise<{ generate: Function, dispose?: Function }>,
 *   budgetMs?: number, idleMs?: number, log?: (msg: string) => void }} o
 *   modelPath: the verified model file, or null while there is none (then `ready()` is false and nothing loads)
 */
export function createLlm({ modelPath, geo, loadGenerator = loadRealGenerator, budgetMs = BUDGET_MS, idleMs = IDLE_MS, log = () => {} }) {
  budgetMs = Number(budgetMs) > 0 ? Number(budgetMs) : BUDGET_MS;   // the manifest's, when it has one
  let loading = null, gen = null, idle = null, busy = false;

  const ready = () => { const p = modelPath(); return !!p && existsSync(p); };

  function touch() {
    if (idle) clearTimeout(idle);
    idle = setTimeout(() => { void unload(); }, idleMs);
    idle.unref?.();
  }

  async function load() {
    if (gen) return gen;
    loading ??= (async () => {
      const t0 = Date.now();
      const g = await loadGenerator(modelPath());
      await g.prime?.();
      log(`llm: loaded in ${Date.now() - t0} ms`);
      return g;
    })();
    try { gen = await loading; } finally { loading = null; }
    touch();
    return gen;
  }

  async function unload() {
    if (idle) { clearTimeout(idle); idle = null; }
    if (!gen || busy) { if (busy) touch(); return; }
    const g = gen; gen = null;
    try { await g.dispose?.(); } catch { /* already gone */ }
    log("llm: unloaded (idle)");
  }

  /** Load ahead of the first question (called when the model is present); a no-op without one. */
  function warm() { if (ready() && !gen && !loading) load().catch((e) => log(`llm: load failed: ${e.message}`)); }

  /**
   * The model's reading of a turn, as a router Turn — or null when the rules' answer should stand.
   * @param {{ text: string, context: object | null, nowMs: number }} o
   * @returns {Promise<import("./router.js").Turn | null>}
   */
  async function understand({ text, context, nowMs }) {
    if (!ready()) return null;
    let raw;
    const t0 = Date.now();
    try {
      const g = await load();
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(new Error("budget")), budgetMs);
      busy = true;
      try { raw = await g.generate(userPrompt(text, context), { signal: ac.signal }); }
      finally { busy = false; clearTimeout(timer); touch(); }
    } catch (e) {
      log(`llm: ${e?.message ?? e} after ${Date.now() - t0} ms`);
      return null;
    }
    const turn = toTurn(raw, { text, context, nowMs, geo });
    log(`llm: ${Date.now() - t0} ms ${turn ? turn.route : "rejected"} ${String(raw).slice(0, 200)}`);
    return turn;
  }

  return { ready, warm, understand, unload, loaded: () => !!gen };
}

/**
 * The rules' turn with the model's reading applied — upgrade-only, like the rest of aindrive's merges:
 *  - a FILES turn stays FILES (the rules had a file word or a context): the model only fills the slots the
 *    rules left empty (kind, place, date, keywords); the rules' task flags — share, delete, move, count,
 *    limit, order — are kept, they came from an explicit word;
 *  - a CHAT / OUT turn is replaced by the model's (that is the miss this exists for: "anything from Sam's wedding?")
 *    — unless the model's FILES has nothing to search for (no filter, no keyword, no task): "find me a flight to
 *    Chicago next Friday" as an empty listing is worse than "I can't help with that".
 * Measured on the holdout split: replacing FILES turns outright cost 81 of 194 asked turns ("send me a link to
 * those" lost its share, "limit it to a week ago" became a count); filling in costs none.
 * @param {import("./router.js").Turn} rules
 * @param {import("./router.js").Turn | null} model
 * @returns {import("./router.js").Turn}
 */
export function merge(rules, model, geo = null) {
  if (model == null) return rules;
  if (rules.route !== Route.FILES) return model.route === Route.FILES && !model.query.hasFilters() && !model.query.isTaskOnly() ? rules : model;
  if (model.route !== Route.FILES || rules.query == null) return rules;
  const q = Object.assign(new SearchQuery(), rules.query, { keywords: [...rules.query.keywords] });
  const m = model.query;
  if (q.kind == null) q.kind = m.kind;
  if (q.city == null && q.country == null) { q.city = m.city; q.country = m.country; }
  if (q.dateFrom == null && q.dateTo == null) { q.dateFrom = m.dateFrom; q.dateTo = m.dateTo; }
  if (q.keywords.length === 0) q.keywords = withoutPlace(m.keywords, q, geo);
  return { ...rules, intent: intentOf(q), query: q, nextContext: q.toJson(), basis: { ...rules.basis, branch: "llm" } };
}

/** The keywords minus any that name the query's own place ("Turkey" next to country TR): a place is a filter, never content. */
function withoutPlace(keywords, q, geo) {
  if (geo == null || (q.city == null && q.country == null)) return [...keywords];
  return keywords.filter((k) => {
    const p = geo.byPlaceName(k) ?? geo.byPlaceName(stripPlaceParticles(k));
    return p == null || !((q.city != null && p.city === q.city) || (p.city == null && p.country === q.country));
  });
}

/** A string the message really contains (case-blind; "부산에서" holds "부산"), else null. */
function inMessage(text, s) {
  if (typeof s !== "string") return null;
  const v = s.trim();
  if (!v || !text.toLowerCase().includes(v.toLowerCase())) return null;
  return v;
}

/**
 * The model's JSON → the rules' Turn, with every guard of the spec. Exported for tests (pure).
 * @param {string} raw the generated text
 * @param {{ text: string, context: object | null, nowMs: number, geo: { byPlaceName(name: string): any } }} o
 */
export function toTurn(raw, { text, context, nowMs, geo }) {
  let o;
  try { o = JSON.parse(raw); } catch { return null; }
  if (o == null || typeof o !== "object" || Array.isArray(o)) return null;
  const ko = hasHangul(text);
  const wasOut = context?.scope === "out";
  switch (o.route) {
    case "chat":
      return { route: Route.CHAT, intent: "Chat", reply: socialReply(text, ko, false), query: null, nextContext: { scope: "social" }, social: true, basis: { branch: "llm", weak: false, seen: false, afterFiles: false } };
    case "out":
      return { route: Route.OUT, intent: "OutOfScope", reply: outOfScope(ko, wasOut, false), query: null, nextContext: { scope: "out" }, social: false, basis: { branch: "llm", weak: false, seen: false, afterFiles: false } };
    case "files": break;
    default: return null;
  }
  const q = new SearchQuery();
  q.korean = ko;
  if (KINDS.includes(o.kind)) q.kind = o.kind;
  // A place the message does not contain is a guess (principle 3): dropped. The gazetteer decides what it is;
  // one it does not know ("the beach", "Sam's wedding") is a content word, like any other word about the files.
  const place = inMessage(text, o.place);
  let placeWords = [];
  if (place != null) {
    const p = geo.byPlaceName(place) ?? geo.byPlaceName(stripPlaceParticles(place));
    if (p != null) { q.city = p.city; q.country = p.country; }
    else placeWords = [place];
  }
  // Dates: only the words, resolved by the parser's rules against today. Not held to the message's spelling:
  // a Korean turn comes back as "this summer", and a wrong date is a miss, not a leak.
  const w = typeof o.when === "string" ? QueryParser.dateWindow(o.when, nowMs) : null;
  if (w != null) { q.dateFrom = w.dateFrom; q.dateTo = w.dateTo; }
  q.keywords = contentKeywords([...(Array.isArray(o.content) ? o.content.filter((c) => typeof c === "string") : []), ...placeWords]);
  // Principle 4: delete / move / share come only from the rules; a claimed move or share is at most a collect, and a
  // collect only when the message has a collect word — a model must not make folders for "what's in this folder?".
  if (o.task === "count") q.count = true;
  else if ((o.task === "collect" || o.task === "move" || o.task === "share") && asksToCollect(text)) q.collect = true;
  const limit = Number(o.limit);
  q.limit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 500) : 0;
  q.oldestFirst = o.oldest === true;
  if (o.largest === true) { q.bySize = true; if (q.limit === 0) q.minSize = LARGE_BYTES; }
  // A follow-up keeps the previous search the way parse() does.
  const prev = context != null && context.scope == null ? SearchQuery.fromJson(context) : null;
  if (prev != null && (isFollowUp(text) || q.isTaskOnly())) {
    if (q.kind == null) q.kind = prev.kind;
    if (q.city == null && q.country == null) { q.city = prev.city; q.country = prev.country; }
    if (q.dateFrom == null && q.dateTo == null) { q.dateFrom = prev.dateFrom; q.dateTo = prev.dateTo; }
    if (q.minSize == null) q.minSize = prev.minSize;
    if (q.limit === 0) q.limit = prev.limit;
    q.oldestFirst ||= prev.oldestFirst;
    q.bySize ||= prev.bySize;
    for (const k of prev.keywords) if (!q.keywords.includes(k)) q.keywords.unshift(k);
    q.followUp = true;
  }
  q.keywords = withoutPlace(q.keywords, q, geo);
  return { route: Route.FILES, intent: intentOf(q), reply: null, query: q, nextContext: q.toJson(), social: false, basis: { branch: "llm", weak: false, seen: q.hasFilters(), afterFiles: prev != null } };
}
