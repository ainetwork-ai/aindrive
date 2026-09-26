// The trigger table of docs/superpowers/specs/2026-09-27-llm-understanding-design.md, branch by branch.
process.env.TZ = "Asia/Seoul";

import { test } from "node:test";
import assert from "node:assert/strict";
import { GeoLookup } from "../agent/geo-lookup.js";
import { QueryParser } from "../agent/query-parser.js";
import { understand } from "../agent/router.js";
import { SearchQuery } from "../agent/search-query.js";
import { unsure } from "../agent/unsure.js";

const parser = new QueryParser(GeoLookup.loadDefault());
const now = new Date(2026, 8, 27, 12).getTime();
const turn = (text, context = null) => understand(parser, text, now, context);
const paris = { kind: "photo", city: "Paris", country: "FR", keywords: [], korean: false, limit: 0, oldestFirst: false, bySize: false };

test("chat from a pattern, greetings, closings and call reports are never asked", () => {
  for (const t of ["hi", "thanks, that's all", "how are you?", "I love hiking on weekends"]) {
    const r = turn(t);
    assert.equal(r.route, "CHAT", t);
    assert.equal(unsure(r), false, t);
  }
  const calls = turn("who do I call the most?");
  assert.equal(calls.route, "CALLS");
  assert.equal(unsure(calls), false);
});

test("the social fall-through is asked when it is a question or saw a place/date/kind word", () => {
  const q = turn("anything from Sam's wedding?");
  assert.equal(q.route, "CHAT");
  assert.equal(q.basis.branch, "social");
  assert.equal(q.basis.question, true);
  assert.equal(unsure(q), true);
  const seen = turn("show me the stuff from the Jeju trip last spring");
  assert.equal(seen.route, "CHAT");
  assert.equal(seen.basis.seen, true);
  assert.equal(unsure(seen), true);
  const plain = turn("I love hiking on weekends");
  assert.equal(plain.basis.branch, "social");
  assert.equal(unsure(plain), false);
  assert.equal(unsure(turn("that sounds fun")), false);
});

test("files from a kind word with a filter, and a bare search-box query, are sure", () => {
  const strong = turn("photos taken in Paris last summer");
  assert.equal(strong.basis.branch, "named");
  assert.equal(unsure(strong), false);
  const box = turn("Paris");
  assert.equal(box.basis.branch, "searchBox");
  assert.equal(unsure(box), false);
});

test("any files turn with two or more ignored words is unsure", () => {
  const r = turn("photos taken in Paris last summer");
  r.query.ignoredWords = 2;
  assert.equal(unsure(r), true);
  r.query.ignoredWords = 1;
  assert.equal(unsure(r), false);
});

test("a follow-up branch turn is unsure only when it dropped a word", () => {
  const clean = turn("only the ones from Paris", paris);
  assert.equal(clean.route, "FILES");
  assert.equal(clean.basis.branch, "followUp");
  assert.equal(unsure(clean), false);
  const dropped = { ...clean, query: Object.assign(new SearchQuery(), clean.query, { ignoredWords: 1 }) };
  assert.equal(unsure(dropped), true);
  // the query can be handed in separately (the phone's signature)
  assert.equal(unsure(clean, dropped.query), true);
});

test("out of scope: asked when a weak kind word or a place/date/kind word was seen, or it follows a files turn", () => {
  const plain = turn("book a table for 4");
  assert.equal(plain.route, "OUT");
  assert.equal(unsure(plain), false);
  const weak = turn("can you play some jazz songs");
  assert.equal(weak.route, "OUT");
  assert.equal(weak.basis.weak, true);
  assert.equal(unsure(weak), true);
  const seen = turn("what's the weather like in Jeju");
  assert.equal(seen.route, "OUT");
  assert.equal(seen.basis.seen, true);
  assert.equal(unsure(seen), true);
  const after = turn("how tall is the Eiffel tower", paris);
  assert.equal(after.route, "OUT");
  assert.equal(after.basis.afterFiles, true);
  assert.equal(after.basis.seen, false);
  assert.equal(unsure(after), true);
  const afterOut = turn("how tall is the Eiffel tower", { scope: "out" });
  assert.equal(afterOut.route, "OUT");
  assert.equal(unsure(afterOut), false);
});

test("basis is informational: routes, intents and contexts are the ones the rules gave before", () => {
  const r = turn("show me the stuff from the Jeju trip last spring");
  assert.deepEqual(Object.keys(r).sort(), ["basis", "intent", "nextContext", "query", "reply", "route", "social"]);
  assert.deepEqual(Object.keys(r.basis).sort(), ["afterFiles", "branch", "question", "seen", "weak"]);
  assert.equal(unsure(null), false);
});
