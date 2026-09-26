// Mirrors mobile/android/app/src/test/java/ai/ainetwork/aindrive/agent/RouterTest.java (+ SmallTalkTest.java)
/**
 * Out-of-scope conversations must never reach the file index, and file
 * questions always must — checked on the same corpora as the phone:
 * sgd-user-turns.tsv.gz (every USER turn of the Schema-Guided Dialogue corpus,
 * CC BY-SA 4.0) and persona-chat-turns.tsv.gz (Synthetic-Persona-Chat, CC BY 4.0),
 * each replayed turn by turn with its context carried.
 */
process.env.TZ = "Asia/Seoul";

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { GeoLookup } from "../agent/geo-lookup.js";
import { QueryParser } from "../agent/query-parser.js";
import { Route, route, understand } from "../agent/router.js";
import { smallTalk } from "../agent/small-talk.js";

const RES = fileURLToPath(new URL("../../../mobile/android/app/src/test/resources/", import.meta.url));
const NOW = new Date(2026, 8, 24).getTime();
const parser = new QueryParser(GeoLookup.loadDefault());

/** The rows of a gzipped TSV, split on tabs. */
const rows = (name) => gunzipSync(readFileSync(RES + name)).toString("utf8").split("\n").filter((l) => l !== "").map((l) => l.split("\t"));

test("every Schema-Guided Dialogue turn stays out of the index", () => {
  const failures = [];
  let dialogues = 0, turns = 0, chat = 0, dialogue = null, context = null;
  for (const c of rows("sgd-user-turns.tsv.gz")) {
    if (c[0] !== dialogue) { dialogue = c[0]; context = null; dialogues++; }
    turns++;
    const d = understand(parser, c[3], NOW, context);
    context = d.nextContext;
    if (d.route === Route.FILES || d.route === Route.CALLS) failures.push(`${d.route}\t${c[1]}\t${c[3]}`);
    else if (d.route === Route.CHAT) chat++;
  }
  assert.equal(dialogues, 22825);
  assert.equal(turns, 231642);
  console.log(`SGD: ${turns} turns, ${chat} small talk, ${failures.length} reached the index`);
  assert.ok(failures.length === 0, `${failures.length} of ${turns} out-of-scope turns reached the index:\n${failures.slice(0, 80).join("\n")}`);
});

test("Persona-chat is conversation, not search", () => {
  const searched = [], refused = [];
  let conversations = 0, turns = 0, conv = null, context = null;
  for (const c of rows("persona-chat-turns.tsv.gz")) {
    if (c[0] !== conv) { conv = c[0]; context = null; conversations++; }
    turns++;
    const t = understand(parser, c[2], NOW, context);
    context = t.nextContext;
    if (t.route === Route.FILES || t.route === Route.CALLS) searched.push(`${t.route}\t${c[2]}`);
    else if (t.route === Route.OUT) refused.push(c[2]);
  }
  const social = 1 - (searched.length + refused.length) / turns;
  const report = `persona chat: ${conversations} conversations, ${turns} turns, ${social.toFixed(4)} answered socially, ${searched.length} searched, ${refused.length} refused`
    + searched.slice(0, 40).map((s) => "\n  SEARCHED " + s).join("") + refused.slice(0, 40).map((s) => "\n  REFUSED " + s).join("");
  console.log(report);
  assert.ok(searched.length === 0 && social >= 0.97, report);
});

test("every file question reaches the index", () => {
  const questions = readFileSync(RES + "ask-scenarios.tsv", "utf8").split("\n").filter((l) => l !== "" && !l.startsWith("#")).map((l) => l.split("\t")[1]);
  for (const s of JSON.parse(readFileSync(RES + "task-scenarios.json", "utf8")).scenarios) questions.push(s.q);
  questions.push(
    "Collect all food photos taken this month", "show me photos of cars", "sunset pictures", "photos of my cat",
    "dog photos", "receipts from last month", "food photos from Tokyo", "who likes me the most and proof?",
    "Sort my call history by who I talk to most and summarize what we usually talk about, and share it",
    "Who do I call the most?", "my music", "songs on my phone", "my notes from last week", "large videos",
    "meeting recordings about the budget", "dog", "sunset", "Paris", "last winter in Tokyo", "PDFs",
    "biggest files", "delete the screenshots from last year", "how many photos did I take in Paris?",
    "파리에서 찍은 사진", "이번달 음식 사진 모아서 공유해줘", "예산 얘기한 회의 녹음", "많이 통화한 사람 순으로 정리하고 요약해줘",
    "누가 나를 제일 좋아해?", "지난주 스크린샷 지워줘", "내 노래", "강아지");
  const failures = questions.map((q) => [route(parser, q, NOW, null, false).route, q]).filter(([r]) => r !== Route.FILES && r !== Route.CALLS);
  assert.deepEqual(failures, [], `${failures.length} of ${questions.length} file questions were turned away`);
});

test("a city typed in lowercase is still the city", () => {
  for (const [q, city] of [["photos from tokyo", "Tokyo"], ["pictures from paris", "Paris"], ["photos taken in seoul", "Seoul"], ["london photos", "London"]]) {
    const got = route(parser, q, NOW, null, false).query;
    assert.equal(got.city, city, q);
    assert.deepEqual(got.keywords, [], q);
  }
});

test("follow-ups of a file question stay file questions", () => {
  const prev = route(parser, "photos from Paris", NOW, null, false).query;
  for (const f of ["only the ones from 2024", "and share them", "from last summer", "the videos too", "그중 2024년 것만", "put them in a folder"]) {
    assert.equal(route(parser, f, NOW, prev, false).route, Route.FILES, f);
  }
});

test("understand() carries the phone's context shapes", () => {
  const files = understand(parser, "dog photos from Paris", NOW, null);
  assert.equal(files.intent, "FindFiles");
  assert.deepEqual(files.nextContext, { kind: "photo", country: "FR", city: "Paris", keywords: ["dog"], korean: false, limit: 0, oldestFirst: false, bySize: false });
  const share = understand(parser, "and share them", NOW, JSON.parse(JSON.stringify(files.nextContext)));
  assert.equal(share.intent, "ShareFiles");
  assert.equal(share.query.city, "Paris");
  assert.deepEqual(understand(parser, "book me a table for 4", NOW, null).nextContext, { scope: "out" });
  const social = understand(parser, "I love hiking with my dog", NOW, null);
  assert.equal(social.route, Route.CHAT);
  assert.ok(social.social);
  assert.deepEqual(social.nextContext, { scope: "social" });
  assert.equal(understand(parser, "who do I call the most?", NOW, files.nextContext).nextContext, files.nextContext);
});

// SmallTalkTest.java
test("greetings are not searches", () => {
  for (const q of ["hi", "Hi!", "hello", "hey", "thanks", "thank you", "help", "what can you do?", "안녕", "안녕하세요", "ㅎㅇ", "고마워", "감사합니다", "도움말"]) {
    assert.notEqual(smallTalk(q), null, q);
  }
});

test("real questions are searches", () => {
  for (const q of ["hi-res photos", "photos from Paris", "안녕 파일", "help.pdf", "thanks letter", "dog photos"]) {
    assert.equal(smallTalk(q), null, q);
  }
});
