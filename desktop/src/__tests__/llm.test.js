// llm.js without a model: a fake generator hands back canned JSON, and the store downloads from a fake fetch.
process.env.TZ = "Asia/Seoul";

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDeviceAgent } from "../agent/device-agent.js";
import { GeoLookup } from "../agent/geo-lookup.js";
import { createLlm, createModelStore, merge, OUTPUT_SCHEMA, sha256File, toTurn, userPrompt } from "../agent/llm.js";
import { QueryParser } from "../agent/query-parser.js";
import { understand } from "../agent/router.js";
import { inside, mimeOf } from "../mac-agent.js";

const geo = GeoLookup.loadDefault();
const now = new Date(2026, 8, 27, 12).getTime();
const ymd = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const out = (o) => JSON.stringify({ route: "files", kind: null, place: null, when: null, content: [], task: "find", limit: 0, oldest: false, largest: false, ...o });
const llmWith = (answers, opts = {}) => createLlm({
  modelPath: () => "/dev/null", geo, ...opts,
  loadGenerator: async () => ({ generate: async (user) => { const a = answers.shift(); return typeof a === "function" ? a(user) : a; } }),
});

test("valid JSON: place → gazetteer, when → the parser's date rules, content → keywords, task → count", async () => {
  const llm = llmWith([out({ kind: "audio", place: "Jeju", when: "last spring", content: ["Sam's wedding", "show the bank"], task: "count" })]);
  const t = await llm.understand({ text: "how many recordings from Sam's wedding in Jeju last spring", context: null, nowMs: now });
  assert.equal(t.route, "FILES");
  assert.equal(t.intent, "CountFiles");
  const q = t.query;
  assert.equal(q.kind, "audio");
  assert.equal(q.city, "Jeju City");
  assert.equal(q.country, "KR");
  assert.equal(ymd(q.dateFrom), "2025-03-01");
  assert.equal(ymd(q.dateTo), "2025-06-01");
  assert.deepEqual(q.keywords, ["Sam", "wedding", "bank"]);
  assert.equal(q.count, true);
  assert.equal(t.nextContext.city, "Jeju City");
});

test("a model can never delete, move or share; collect only when the message asks to collect", async () => {
  const del = toTurn(JSON.stringify({ route: "files", kind: "photo", place: null, when: null, content: [], task: "delete", limit: 0, oldest: false, largest: false }), { text: "delete the photos", context: null, nowMs: now, geo });
  assert.equal(del.intent, "FindFiles");
  assert.equal(del.query.delete, false);
  const mv = toTurn(JSON.stringify({ route: "files", kind: "photo", place: null, when: null, content: [], task: "move", limit: 0, oldest: false, largest: false }), { text: "move the photos into a folder", context: null, nowMs: now, geo });
  assert.equal(mv.intent, "CollectFiles");
  assert.equal(mv.query.move, false);
  assert.equal(mv.query.share, false);
  const folder = toTurn(out({ task: "collect" }), { text: "what's in this folder?", context: null, nowMs: now, geo });
  assert.equal(folder.intent, "FindFiles", "no folder is made for a question about the folder");
});

test("a place that is not in the message is dropped; one the gazetteer does not know is a content word", () => {
  const guess = toTurn(out({ kind: "photo", place: "Seoul" }), { text: "pics of the kids at the beach", context: null, nowMs: now, geo });
  assert.equal(guess.query.city, null);
  assert.equal(guess.query.country, null);
  const beach = toTurn(out({ kind: "photo", place: "beach", content: ["kids"] }), { text: "pics of the kids at the beach", context: null, nowMs: now, geo });
  assert.equal(beach.query.city, null);
  assert.deepEqual(beach.query.keywords, ["kids", "beach"]);
  const wedding = toTurn(out({ kind: "photo", place: "Sam's wedding" }), { text: "anything from Sam's wedding?", context: null, nowMs: now, geo });
  assert.deepEqual(wedding.query.keywords, ["Sam", "wedding"]);
  const ko = toTurn(out({ kind: "photo", place: "부산", when: "this summer" }), { text: "이번 여름에 부산에서 찍은 거 보여줘", context: null, nowMs: now, geo });
  assert.equal(ko.query.city, "Busan");
  assert.equal(ko.query.korean, true);
  assert.equal(ymd(ko.query.dateFrom), "2026-06-01");
});

test("'what's in this folder?' → files with no filter: the folder's listing, not a new folder", () => {
  const t = toTurn(out({ kind: "archive", content: ["folder"], task: "collect" }), { text: "what's in this folder?", context: null, nowMs: now, geo });
  assert.equal(t.route, "FILES");
  assert.equal(t.intent, "FindFiles");
  assert.equal(t.query.collect, false);
  assert.deepEqual(t.query.keywords, []);
});

test("chat and out reuse the rules' replies; bad JSON, an unknown route and a timeout leave the rules' answer", async () => {
  const chat = toTurn(out({ route: "chat" }), { text: "hey what's up", context: null, nowMs: now, geo });
  assert.equal(chat.route, "CHAT");
  assert.deepEqual(chat.nextContext, { scope: "social" });
  assert.match(chat.reply, /\S/);
  const o = toTurn(out({ route: "out" }), { text: "book a table for 4", context: null, nowMs: now, geo });
  assert.equal(o.route, "OUT");
  assert.match(o.reply, /not something I can do/);
  assert.deepEqual(o.nextContext, { scope: "out" });
  assert.equal(toTurn("{not json", { text: "x", context: null, nowMs: now, geo }), null);
  assert.equal(toTurn(out({ route: "calls" }), { text: "x", context: null, nowMs: now, geo }), null);
  const slow = createLlm({ modelPath: () => "/dev/null", geo, budgetMs: 20, loadGenerator: async () => ({
    generate: (_u, { signal }) => new Promise((_, rej) => signal.addEventListener("abort", () => rej(signal.reason))) }) });
  assert.equal(await slow.understand({ text: "anything from Sam's wedding?", context: null, nowMs: now }), null);
  const none = createLlm({ modelPath: () => null, geo, loadGenerator: async () => { throw new Error("must not load"); } });
  assert.equal(none.ready(), false);
  assert.equal(await none.understand({ text: "x", context: null, nowMs: now }), null);
});

test("a follow-up keeps the previous search, which the model is shown", async () => {
  const prev = { kind: "photo", city: "Paris", country: "FR", keywords: [], korean: false, limit: 0, oldestFirst: false, bySize: false };
  let seen = "";
  const llm = llmWith([(user) => { seen = user; return out({ kind: "video" }); }]);
  const t = await llm.understand({ text: "and the videos too", context: prev, nowMs: now });
  assert.match(seen, /^Previous search: \{"kind":"photo","city":"Paris"/);
  assert.equal(t.query.kind, "video");
  assert.equal(t.query.city, "Paris");
  assert.equal(t.query.followUp, true);
  assert.equal(userPrompt("hi", { scope: "out" }), "Previous search: none\nhi");
});

test("the model is loaded once, lazily, and let go after the idle time", async () => {
  let loads = 0, disposed = 0;
  const llm = createLlm({ modelPath: () => "/dev/null", geo, idleMs: 30, loadGenerator: async () => { loads++; return { generate: async () => out({ kind: "pdf" }), dispose: async () => { disposed++; } }; } });
  assert.equal(llm.loaded(), false);
  await llm.understand({ text: "a", context: null, nowMs: now });
  await llm.understand({ text: "b", context: null, nowMs: now });
  assert.equal(loads, 1);
  assert.equal(llm.loaded(), true);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(disposed, 1);
  assert.equal(llm.loaded(), false);
});

test("device-agent: the model is asked only when the rules are unsure, and its answer replaces theirs", async () => {
  const folder = mkdtempSync(join(tmpdir(), "aindrive-llm-"));
  writeFileSync(join(folder, "bank call 2026-03-02.m4a"), "x");
  writeFileSync(join(folder, "Screenshot 2026-09-01.png"), "x");
  const asked = [];
  const llm = { ready: () => true, understand: async ({ text, context, nowMs }) => { asked.push(text); return toTurn(out({ kind: "audio", content: ["bank"], task: "count" }), { text, context, nowMs, geo }); } };
  const agent = createDeviceAgent({ indexDir: mkdtempSync(join(tmpdir(), "aindrive-idx-")), inside, mimeOf, folders: () => [{ driveId: "d1", folder, label: "Home" }], llm });
  const sure = await agent.ask("screenshots", null);
  assert.deepEqual(asked, []);
  assert.deepEqual(sure.sources.map((s) => s.path), ["Screenshot 2026-09-01.png"]);
  // "what's the weather like in Jeju": the rules say out of scope, having seen a place → the model is asked
  const r = await agent.ask("what's the weather like in Jeju", null);
  assert.deepEqual(asked, ["what's the weather like in Jeju"]);
  assert.equal(r.action?.type, "count");
  assert.deepEqual(r.sources.map((s) => s.path), ["bank call 2026-03-02.m4a"]);
  // no model: byte-identical to the rules
  const plain = createDeviceAgent({ indexDir: mkdtempSync(join(tmpdir(), "aindrive-idx-")), inside, mimeOf, folders: () => [{ driveId: "d1", folder, label: "Home" }] });
  assert.equal((await plain.ask("what's the weather like in Jeju", null)).query, "out");
});

test("merge is upgrade-only: a files turn keeps its task words and filters, the model fills what is empty; chat/out are replaced", () => {
  const parser = new QueryParser(geo);
  const share = understand(parser, "send me a link to those", now, { kind: "photo", city: "Paris", country: "FR", keywords: [], korean: false, limit: 0, oldestFirst: false, bySize: false });
  assert.equal(share.intent, "ShareFiles");
  const m = toTurn(out({ kind: "video", place: "Paris", content: ["link"] }), { text: "send me a link to those", context: null, nowMs: now, geo });
  const kept = merge(share, m);
  assert.equal(kept.intent, "ShareFiles");
  assert.equal(kept.query.kind, "photo");
  assert.equal(kept.query.city, "Paris");
  assert.equal(merge(share, toTurn(out({ route: "out" }), { text: "x", context: null, nowMs: now, geo })).intent, "ShareFiles", "a files turn is never downgraded");
  const thin = understand(parser, "the stuff from the Jeju trip last spring, the videos", now, null);
  assert.equal(thin.route, "FILES");
  const filled = merge(thin, toTurn(out({ kind: "video", place: "Jeju", when: "last spring", content: ["trip"] }), { text: "the stuff from the Jeju trip last spring, the videos", context: null, nowMs: now, geo }));
  assert.equal(filled.query.city, "Jeju City");
  assert.equal(filled.query.kind, "video");
  assert.equal(filled.basis.branch, "llm");
  const social = understand(parser, "anything from Sam's wedding?", now, null);
  assert.equal(social.route, "CHAT");
  const fixed = merge(social, toTurn(out({ kind: "photo", content: ["Sam's wedding"] }), { text: "anything from Sam's wedding?", context: null, nowMs: now, geo }));
  assert.equal(fixed.route, "FILES");
  assert.deepEqual(fixed.query.keywords, ["Sam", "wedding"]);
  assert.equal(merge(social, null), social);
  const flight = understand(parser, "Find me a flight to Chicago next Friday.", now, null);
  assert.equal(flight.route, "OUT");
  assert.equal(merge(flight, toTurn(out({}), { text: "Find me a flight to Chicago next Friday.", context: null, nowMs: now, geo })), flight, "an empty files answer does not beat out-of-scope");
});

test("a resolved place is never also a content word, and follow-up cues are not content", () => {
  const t = toTurn(out({ kind: "photo", place: null, content: ["switch", "Turkey"] }), { text: "switch to Turkey", context: null, nowMs: now, geo });
  assert.deepEqual(t.query.keywords, ["Turkey"], "switch is a cue; Turkey stays until merge sees the rules' country");
  const parser = new QueryParser(geo);
  const rules = understand(parser, "switch to Turkey", now, { kind: "photo", keywords: [], korean: false, limit: 0, oldestFirst: false, bySize: false });
  assert.equal(rules.query.country, "TR");
  const m = toTurn(out({ kind: "photo", content: ["Turkey", "beach"] }), { text: "switch to Turkey", context: null, nowMs: now, geo });
  assert.deepEqual(merge(rules, m, geo).query.keywords, ["beach"]);
  const busan = toTurn(out({ kind: "photo", place: "부산", content: ["부산 바다"] }), { text: "부산 바다 사진", context: null, nowMs: now, geo });
  assert.equal(busan.query.city, "Busan");
  assert.deepEqual(busan.query.keywords, ["바다"]);
});

test("the schema is the spec's intermediate JSON", () => {
  assert.deepEqual(Object.keys(OUTPUT_SCHEMA.properties), ["route", "kind", "place", "when", "content", "task", "limit", "oldest", "largest"]);
  assert.deepEqual(OUTPUT_SCHEMA.properties.route.enum, ["chat", "out", "files"]);
  assert.deepEqual(OUTPUT_SCHEMA.properties.task.enum, ["find", "count", "collect", null]);
});

test("model store: download to a .part, verify sha256, rename; a bad checksum leaves nothing; a partial file resumes", async () => {
  const bytes = Buffer.from("a small pretend model file, big enough to split");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const manifest = { model: "Tiny", license: "MIT", engine: "llama.cpp", files: [{ id: "model", name: "tiny.gguf", url: "https://x.test/tiny.gguf", sha256, bytes: bytes.length }] };
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(init.headers.Range ?? "");
    const m = /bytes=(\d+)-/.exec(init.headers.Range ?? "");
    const from = m ? Number(m[1]) : 0;
    return new Response(bytes.subarray(from), { status: m ? 206 : 200 });
  };
  const dir = mkdtempSync(join(tmpdir(), "aindrive-models-"));
  const changes = [];
  const store = createModelStore({ dir, manifest, fetchImpl, onChange: () => changes.push(store.status().downloading) });
  assert.equal(store.ready(), false);
  assert.deepEqual(store.status().list, [{ id: "llm", role: "reads unclear questions", name: "Tiny", license: "MIT", engine: "llama.cpp", bytes: bytes.length, ready: false }]);
  const first = store.ensure();
  assert.equal(first.downloading, true);
  const done = await store.ensureDone();
  assert.equal(done.ready, true);
  assert.equal(done.done, bytes.length);
  assert.equal(store.modelPath(), join(dir, "tiny.gguf"));
  assert.equal(await sha256File(store.modelPath()), sha256);
  assert.deepEqual(readdirSync(dir), ["tiny.gguf"]);
  assert.deepEqual(calls, [""]);
  assert.equal(changes.at(-1), false);
  assert.equal(store.ensure().ready, true, "a second ensure is a no-op");

  // resume: half a .part already there
  const dir2 = mkdtempSync(join(tmpdir(), "aindrive-models-"));
  writeFileSync(join(dir2, "tiny.gguf.part"), bytes.subarray(0, 10));
  calls.length = 0;
  const store2 = createModelStore({ dir: dir2, manifest, fetchImpl });
  await store2.ensureDone();
  assert.deepEqual(calls, ["bytes=10-"]);
  assert.equal(readFileSync(join(dir2, "tiny.gguf")).equals(bytes), true);

  // wrong bytes: nothing is kept, the error is shown
  const dir3 = mkdtempSync(join(tmpdir(), "aindrive-models-"));
  const bad = createModelStore({ dir: dir3, manifest, fetchImpl: async () => new Response(Buffer.from("x".repeat(bytes.length)), { status: 200 }) });
  await assert.rejects(bad.ensureDone(), /checksum mismatch/);
  assert.equal(existsSync(join(dir3, "tiny.gguf")), false);
  assert.equal(existsSync(join(dir3, "tiny.gguf.part")), false);
  assert.match(bad.status().error, /checksum/);
  assert.equal(bad.status().ready, false);
});
