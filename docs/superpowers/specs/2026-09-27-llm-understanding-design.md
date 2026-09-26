# LLM-assisted understanding — phone (Gemma 4 E2B) and Mac (local GGUF) (2026-09-27)

Completes "P2 — Planner" of `2026-09-23-mobile-on-device-agent-design.md`, with what shipped
since: the rule parser (`QueryParser` + `Router`) answers most turns instantly and is checked
against the dialogue benchmark, SGD and Persona-chat; the phone already downloads Gemma 4 E2B
for call summaries; the Mac now runs the same rules (`desktop/src/agent/`).

## Problem

Rules break on phrasings nobody wrote a rule for. "What's in this folder?" made a folder (#146).
Every such miss is a new rule, and the benchmark only catches phrasings it contains.

## Decision (owner, 2026-09-27)

- **Phone:** ask the on-device model for turns like that one.
- **Mac:** add a local model (none there today).
- **aindrive-cloud:** unchanged — reached over A2A, files by MCP handoff. It is never asked to
  understand a turn: the question text would leave the device.

## Principles

1. **Rules first, model second.** The rules run on every turn (instant, offline, deterministic).
   The model is asked only when the rules are *unsure* (below). A turn the rules are sure about
   never waits for a model.
2. **One output shape.** The model produces the rules' own structure — `SearchQuery.toJson()` plus
   a route — never free text that code must interpret. Phone `SearchQuery.java` ↔ Mac
   `search-query.js` are already identical.
3. **Code owns dates and places.** The model returns the words ("last spring", "Jeju"); code
   resolves them with today's date and the gazetteer, as `QueryParser` does. Models are bad at
   date arithmetic and invent city spellings.
4. **The model cannot destroy or leak.** `delete`, `move` and `share` are set only by the rules
   (an explicit verb in the text). A model output claiming them is downgraded to `collect` / find.
5. **Fail closed.** Bad JSON, a timeout, no model → the rules' answer stands. Nothing the user
   sees depends on the model being present.
6. **Same benchmark, fresh holdout.** The hybrid must not lose a single point on the existing
   splits, and is judged on a holdout written *before* tuning (`test/resources/dialogues/llm-holdout.json`,
   phrasings the rules currently miss).

## When the rules are unsure (the trigger)

Exactly the branches in `Router.route` that decide on thin evidence, in both parsers:

| Rules' decision | Why it is thin | Model asked? |
|---|---|---|
| CHAT from `smallTalk` / greeting / closing patterns | pattern match | no |
| FILES with `named` kind word and ≥1 filter | strong | no |
| FILES from the follow-up / task-only / "few" branch | inherits context on ≤10 words | **yes** when `ignoredWords > 0` |
| FILES from the bare search-box branch (≤5 words, no sentence) | "Paris", "dog" | no |
| OUT (out of scope) | the sentence had no file word | **yes** when `weak` or a place/date/kind word was seen, or the turn follows a FILES turn |
| any FILES turn with `ignoredWords ≥ 2` | words the rules threw away | **yes** |

The model's answer *replaces* the rules' only when it parses and passes the guards; otherwise the
rules' answer is used as before. The trigger is a pure function of the rules' result, so it is
unit-tested without a model (`UnderstandTrigger` phone / `unsure()` Mac).

## Prompt and output

System (identical text on both platforms, English; the user's language is preserved in `korean`):

```
You turn one chat message to a file assistant into a JSON search. The assistant only knows the
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
"show", "find", "list".
```

User: the message, preceded by `Previous search: <context JSON or none>` so follow-ups resolve.

Post-processing (code, both platforms): `place` → `GeoLookup.byPlaceName`; `when` →
`QueryParser`'s date rules on that fragment; `content` → keywords; `task` → `collect`/`count`;
`route` → `Route`. Guards from principle 4. `followUp` = previous search reused.

Decoding: constrained to JSON where the runtime can (node-llama-cpp JSON-schema grammar on the
Mac; LiteRT-LM constrained decoding on the phone if 0.17.1 exposes it, else parse the first
`{…}` block). Temperature 0, ≤ 160 output tokens, wall-clock budget 4 s phone / 2 s Mac; over
budget = rules' answer.

## Phone

- `agent/Understander.java`: prompt → `Summarizer.generate` → parse → `SearchQuery` + route.
  Uses the already-downloaded Gemma 4 E2B (`llm/gemma-4-e2b.json`); loaded lazily by
  `AgentService.summarizerOrNull()`, released after the turn as the call report does.
- Hook: `AskRunner.route()` / `ask()` — after `Router.understand`, if `UnderstandTrigger.unsure(turn)`
  and the model is present, ask it; merge per the guards.
- No model downloaded → nothing changes (today's behaviour). The Model & agents sheet already
  shows the model; its line gains "also reads unclear questions".

## Mac

- Runtime: `node-llama-cpp` (`@node-llama-cpp/mac-arm64-metal` prebuilt; N-API, so no Electron
  ABI pin — unlike better-sqlite3). Runs in the main process (`desktop/src/agent/llm.js`),
  one context, unloaded after 5 min idle.
- Model: a small instruct GGUF with a Korean-capable tokenizer, ≈2–3 GB, Q4; candidates sized
  in the implementation PR (Gemma 3 4B-it QAT Q4_0, Qwen2.5-3B-Instruct Q4_K_M, Qwen3-4B Q4_K_M).
  Manifest mirrors the phone's (`desktop/assets/llm/<id>.json`: model, license, engine, files
  with url + sha256 + bytes); downloaded to `app.getPath("userData")/models/`, verified, shown
  through `status.models` exactly as the phone shows its download.
- Hook: `device-agent.js` — after `router.understand`, `unsure(turn)` → `llm.understand()` → guards.
- Packaging: `build-mac.mjs` must include the optional dep's binary for the target arch and
  keep the fuses off; the model is never bundled (downloaded on first use, opt-in button).

## Evaluation (before merge)

1. Existing splits (dev/test/holdout, SGD, Persona) run with the model *mocked to "unavailable"*:
   scores identical to today — the trigger alone must not change any decision.
2. `llm-holdout.json` (`mobile/scripts/make-llm-holdout.py`, hand-written 2026-09-27 before any
   tuning): 64 dialogues / 78 turns in phrasings the rules were never written for. **Rules-only
   baseline, recorded the day it was written: route 0.6923, intent 0.6410, JGA 0.4844 (38 misses).**
   Report rules-only vs hybrid per platform. Ship only where hybrid ≥ rules on every split, and
   never edit a label to fit an implementation — add a turn instead.
3. Latency on device: p50/p95 of a model-asked turn (S26, M1 Pro).

## Not in scope

Answer generation (the model writing the reply), photo-content search on the Mac (CLIP), iOS.
