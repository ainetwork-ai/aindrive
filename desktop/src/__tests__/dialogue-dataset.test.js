// Mirrors mobile/android/app/src/test/java/ai/ainetwork/aindrive/agent/DialogueDatasetTest.java
/**
 * The aindrive dialogue benchmark (mobile/android/app/src/test/resources/dialogues/):
 * DSTC8-style multi-turn dialogues about the phone's files, each user turn
 * annotated with route, intent and the full dialogue state. Every dialogue is
 * replayed through router.understand with the context carried turn to turn, and
 * scored exactly as the phone's test does — the Mac must score what the phone scores.
 */
process.env.TZ = "Asia/Seoul";   // dates are local-time, as on the phone; pin the zone so runs agree

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { GeoLookup } from "../agent/geo-lookup.js";
import { QueryParser, contentWords } from "../agent/query-parser.js";
import { understand } from "../agent/router.js";

/** Floors: the Java test's. */
const MIN_JGA = { dev: 0.99, test: 0.99, holdout: 0.97 }, MIN_INTENT = 0.99, MIN_ROUTE = 0.99;
const SLOTS = ["kind", "city", "country", "date_from", "date_to", "content", "limit", "oldest", "largest"];
const DIALOGUES = fileURLToPath(new URL("../../../mobile/android/app/src/test/resources/dialogues/", import.meta.url));

const parser = new QueryParser(GeoLookup.loadDefault());

/** Local midnight of "yyyy-MM-dd" (AskScenariosTest.at). */
const at = (ymd) => { const [y, m, d] = ymd.split("-").map(Number); return new Date(y, m - 1, d).getTime(); };
const ymd = (ms) => { const d = new Date(ms); return `${String(d.getFullYear()).padStart(4, "0")}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

/** "Receipts" / "receipt", "Flowers" / "flower": content is compared case- and plural-blind. */
function norm(w) {
  const s = w.toLowerCase();
  if (s.endsWith("ies") && s.length > 4) return s.slice(0, -3) + "y";
  if (s.endsWith("es") && (s.endsWith("ches") || s.endsWith("shes") || s.endsWith("xes"))) return s.slice(0, -2);
  if (s.endsWith("s") && !s.endsWith("ss") && s.length > 3) return s.slice(0, -1);
  return s;
}
const list = (a) => `[${a.sort().join(", ")}]`;
const str = (o, k) => (o[k] == null ? "-" : String(o[k]));

function wantState(st) {
  const c = [];
  for (const phrase of st.content ?? []) for (const w of String(phrase).split(/[\t\n\x0B\f\r ]+/)) c.push(norm(w));
  return {
    kind: str(st, "kind"), city: str(st, "city"), country: str(st, "country"), date_from: str(st, "date_from"), date_to: str(st, "date_to"),
    content: list(c), limit: String(st.limit ?? 0), oldest: String(st.oldest === true), largest: String(st.largest === true),
  };
}

function gotState(q) {
  return {
    kind: q?.kind ?? "-", city: q?.city ?? "-", country: q?.country ?? "-",
    date_from: q?.dateFrom == null ? "-" : ymd(q.dateFrom), date_to: q?.dateTo == null ? "-" : ymd(q.dateTo),
    content: list(q ? contentWords(q.keywords).map(norm) : []),
    limit: String(q ? q.limit : 0), oldest: String(!!q?.oldestFirst), largest: String(!!q?.bySize),
  };
}

const ctx = (before, u) => (before.length ? `[${before.slice(-2).join(" / ")}] ` : "") + "» " + u;
const f4 = (x) => x.toFixed(4);

/** Replays one split; returns the scores and the report text (same format as build/dialogue-report-<split>.txt). */
function runSplit(split) {
  const data = JSON.parse(readFileSync(DIALOGUES + split + ".json", "utf8"));
  const now = at(data.today) + 12 * 3600 * 1000;   // noon "today"
  const s = { turns: 0, route: 0, intent: 0, fileTurns: 0, joint: 0, dialogues: 0, success: 0, slotRight: Object.fromEntries(SLOTS.map((k) => [k, 0])), misses: new Map() };
  const miss = (what, line) => { if (!s.misses.has(what)) s.misses.set(what, []); s.misses.get(what).push(line); };
  for (const dlg of data.dialogues) {
    let context = null, allRight = true;
    const transcript = [];
    for (const want of dlg.turns) {
      const u = want.utterance;
      const got = understand(parser, u, now, context);
      context = got.nextContext;
      s.turns++;
      const route = got.route.toLowerCase();
      const routeOk = route === want.route, intentOk = got.intent === want.intent;
      if (routeOk) s.route++; else miss(`route ${want.route}→${route}`, ctx(transcript, u));
      if (intentOk) s.intent++; else if (routeOk) miss(`intent ${want.intent}→${got.intent}`, ctx(transcript, u));
      let ok = routeOk && intentOk;
      if (want.route === "files" && want.state != null) {
        s.fileTurns++;
        const w = wantState(want.state), g = gotState(got.query);
        let joint = intentOk;
        for (const k of SLOTS) {
          if (w[k] === g[k]) s.slotRight[k]++;
          else { joint = false; miss("slot " + k, `${ctx(transcript, u)}\n      want ${w[k]}  got ${g[k]}`); }
        }
        if (joint) s.joint++;
        ok &&= joint;
      }
      if (want.route === "calls" && want.share === true && !(got.query?.share)) { ok = false; miss("calls share", ctx(transcript, u)); }
      allRight &&= ok;
      transcript.push(u);
    }
    s.dialogues++;
    if (allRight) s.success++;
  }
  let r = `\n== ${split}: ${s.dialogues} dialogues, ${s.turns} turns (${s.fileTurns} file turns)\n`;
  r += `route ${f4(s.route / s.turns)}  intent ${f4(s.intent / s.turns)}  JGA ${f4(s.joint / s.fileTurns)}  dialogue success ${f4(s.success / s.dialogues)}\n`;
  for (const k of SLOTS) r += `  ${k.padEnd(9)} ${f4(s.slotRight[k] / s.fileTurns)}\n`;
  for (const key of [...s.misses.keys()].sort()) {
    const ex = s.misses.get(key);
    r += `-- ${key}: ${ex.length}\n`;
    for (const line of ex.slice(0, 12)) r += `   ${line}\n`;
  }
  return { jga: s.joint / s.fileTurns, intent: s.intent / s.turns, route: s.route / s.turns, report: r };
}

for (const split of ["dev", "test", "holdout"]) {
  test(`dialogue benchmark: ${split}`, { skip: !existsSync(DIALOGUES + split + ".json") && `${split}.json not present` }, () => {
    const { jga, intent, route, report } = runSplit(split);
    console.log(report);
    assert.ok(jga >= MIN_JGA[split] && intent >= MIN_INTENT && route >= MIN_ROUTE, report);
  });
}
