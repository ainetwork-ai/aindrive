#!/usr/bin/env node
// diagnose.mjs — trace invariant analyzer (no external deps)

import { readFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { createReadStream } from 'node:fs';

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('Usage: diagnose.mjs [--merge] <file1.jsonl> [file2.jsonl ...]');
  process.exit(1);
}

let mergeMode = false;
let files = [];
for (const a of args) {
  if (a === '--merge') { mergeMode = true; }
  else { files.push(a); }
}

// ---------------------------------------------------------------------------
// Read + parse all jsonl files
// ---------------------------------------------------------------------------

function readJsonl(path) {
  if (!existsSync(path)) {
    console.error(`File not found: ${path}`);
    process.exit(1);
  }
  const lines = readFileSync(path, 'utf8').split('\n');
  const events = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // skip malformed lines silently
    }
  }
  return events;
}

let allEvents = [];
for (const f of files) {
  allEvents.push(...readJsonl(f));
}

if (allEvents.length === 0) {
  console.log('✓ no events');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Determine docIds — if --merge, treat same docId across files as one timeline
// Group by docId if multiple docIds present
// ---------------------------------------------------------------------------

const byDocId = new Map();
for (const ev of allEvents) {
  const id = ev.docId ?? '(unknown)';
  if (!byDocId.has(id)) byDocId.set(id, []);
  byDocId.get(id).push(ev);
}

// ---------------------------------------------------------------------------
// src sort order so request precedes response
// ---------------------------------------------------------------------------
const SRC_ORDER = { browser: 0, server: 1, agent: 2, cli: 3 };
function srcRank(s) { return SRC_ORDER[s] ?? 99; }

function sortEvents(events) {
  return events.slice().sort((a, b) => {
    const dt = (a.t ?? 0) - (b.t ?? 0);
    if (dt !== 0) return dt;
    return srcRank(a.src) - srcRank(b.src);
  });
}

// ---------------------------------------------------------------------------
// Hint table
// ---------------------------------------------------------------------------
const HINTS = {
  V9: 'autosave-flush followed by reload-event within 1s in the SAME session — autosave triggered fs.watch which echoed back as reload (loop)',
  V10:'reload-event followed by an immediate ydoc-update where textLen did not change — the reload was a no-op echo of our own write',
  V1: 'browser seeded text from disk after IndexedDB already loaded a Y.Doc state — this duplicates content',
  V2: 'autosave fired but no doc change since last save',
  V3: 'autosave may overwrite incoming remote edits',
  V4: 'willow replay produced a state different from the live Y.Doc',
  V5: 'client appears to have re-applied IDB content twice — duplication',
  V6: 'agent did not respond',
  V7: 'provider-sub-ok fired before provider-connect — impossible ordering',
  V8: 'we seeded ytext from disk multiple times in one session',
};

const CODE_POINTERS = {
  V9: 'cli/src/agent.js fs.watch — suppress changes to paths just written by our own write RPC',
  V10:'web/components/viewer.tsx reload handler — short-circuit when disk content equals current ytext',
  V1: 'web/components/viewer.tsx ~line 95',
  V2: 'web/components/viewer.tsx (autosave debounce handler)',
  V3: 'web/components/viewer.tsx (autosave flush)',
  V4: 'cli/src/rpc/yjs-read.ts (willow-replay)',
  V5: 'web/components/viewer.tsx ~line 95 (idb-load handler)',
  V6: 'server/src/rpc.ts (sendRpc timeout)',
  V7: 'web/components/viewer.tsx (provider setup order)',
  V8: 'web/components/viewer.tsx ~line 95 (disk-seed-apply guard)',
};

// ---------------------------------------------------------------------------
// Analyze one docId's events
// ---------------------------------------------------------------------------

function analyzeDocId(docId, rawEvents) {
  const events = sortEvents(rawEvents);

  const t0 = events[0].t ?? 0;
  const t1 = events[events.length - 1].t ?? 0;

  // count by src
  const srcCounts = { browser: 0, server: 0, agent: 0, cli: 0 };
  const sessions = new Set();
  for (const ev of events) {
    const s = ev.src ?? 'unknown';
    srcCounts[s] = (srcCounts[s] ?? 0) + 1;
    if (ev.session) sessions.add(ev.session);
  }

  const violations = [];

  function pushViolation(v) { violations.push(v); }

  // -------------------------------------------------------------------------
  // Per-session state machine
  // -------------------------------------------------------------------------

  // session state
  const sessionState = new Map(); // session -> state object

  function getState(session) {
    if (!sessionState.has(session)) {
      sessionState.set(session, {
        idbLoaded: false,
        idbLoadedTextLen: 0,
        whenReadyResolved: false,
        wsConnected: false,
        subOk: false,
        ytextLen: null,
        lastSV: null,
        diskBytes: null,
        willowEntries: 0,
        pendingAutosaves: 0,
        // tracking fields
        diskSeedCount: 0,
        lastAutosaveFlushIdx: -1,
        lastAutosaveFlushT: null,    // for V9: autosave→reload loop detection
        lastReloadT: null,           // for V10: reload→no-op-update detection
        lastReloadTextLen: null,
        hadYdocUpdateSinceFlush: false,
        incomingSync: false,       // true between ws-doc-fwd and ydoc-update(origin=remote)
        incomingSyncT: null,
      });
    }
    return sessionState.get(session);
  }

  // pending rpc-out: reqId -> { t, method, session }
  const pendingRpc = new Map();

  // -------------------------------------------------------------------------
  // Walk events
  // -------------------------------------------------------------------------

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    const session = ev.session ?? '(global)';
    const st = getState(session);
    const t = ev.t ?? 0;

    switch (ev.event) {

      // --- browser events ---

      case 'provider-connect':
        st.wsConnected = true;
        break;

      case 'provider-disconnect':
        st.wsConnected = false;
        st.subOk = false;
        break;

      case 'provider-sub-ok':
        // V7: subscribe before connect
        if (!st.wsConnected) {
          pushViolation({
            severity: 'ERROR', code: 'V7', name: 'subscribe-without-connect',
            t, session, docId,
            expected: 'provider-connect must precede provider-sub-ok',
            observed: 'provider-sub-ok fired but wsConnected=false',
            hint: HINTS.V7,
            pointer: CODE_POINTERS.V7,
          });
        }
        st.subOk = true;
        break;

      case 'idb-load':
        st.idbLoaded = true;
        st.idbLoadedTextLen = ev.textLen ?? 0;
        if (ev.textLen != null) st.ytextLen = ev.textLen;
        if (ev.svAfter != null) st.lastSV = ev.svAfter;
        break;

      case 'whenReady-resolved':
        st.whenReadyResolved = true;
        break;

      case 'disk-seed-apply': {
        st.diskSeedCount += 1;
        // V1: disk-seed-apply after idb-load only counts when IDB had non-empty content.
        // An empty IDB followed by a disk-seed is the legitimate first-open path.
        if (st.idbLoaded && st.idbLoadedTextLen > 0) {
          pushViolation({
            severity: 'ERROR', code: 'V1', name: 'disk-seed-after-idb-load',
            t, session, docId,
            expected: 'disk-seed-skip (IDB already had ytext)',
            observed: `disk-seed-apply byteLen=${ev.byteLen ?? '?'} (idb had textLen=${st.idbLoadedTextLen})`,
            hint: 'viewer.tsx synced-handler — wrap the seed block with `provider.whenReady` first',
            pointer: CODE_POINTERS.V1,
          });
        }
        // V8: multiple disk-seed in same session
        if (st.diskSeedCount > 1) {
          pushViolation({
            severity: 'ERROR', code: 'V8', name: 'multiple-disk-seed',
            t, session, docId,
            expected: 'at most one disk-seed-apply per session',
            observed: `disk-seed-apply count=${st.diskSeedCount} in session`,
            hint: HINTS.V8,
            pointer: CODE_POINTERS.V8,
          });
        }
        st.diskBytes = ev.byteLen ?? null;
        break;
      }

      case 'disk-seed-skip':
        // no state change needed; this is the happy path
        break;

      case 'ydoc-update': {
        const origin = ev.origin ?? null;
        // V10: ydoc-update from `remote` immediately after reload-event with no text-length change = echo
        if (st.lastReloadT != null && t - st.lastReloadT < 500 && origin === 'remote' &&
            ev.textLen != null && st.lastReloadTextLen === ev.textLen) {
          pushViolation({
            severity: 'WARN', code: 'V10', name: 'reload-echo-no-op',
            t, session, docId,
            expected: 'reload should be a no-op when disk content matches ytext',
            observed: `ydoc-update(remote) textLen=${ev.textLen} unchanged after reload-event`,
            hint: HINTS.V10,
            pointer: CODE_POINTERS.V10,
          });
        }
        // V5: immediately after idb-load, a local update increases textLen by idb-load.textLen
        // We detect: first local ydoc-update after idb-load where delta == idbTextLen
        if (st.idbLoaded && origin === 'local' && ev.textLen != null && st.ytextLen != null) {
          // look back: was idb-load just processed? check if we haven't seen a non-idb update yet
          // simpler heuristic: if the increase equals the idbTextLen (suggesting re-application)
          const prevLen = st.ytextLen;
          const newLen = ev.textLen;
          if (newLen === prevLen * 2 && prevLen > 0) {
            // textLen doubled — strong signal of double-apply
            pushViolation({
              severity: 'ERROR', code: 'V5', name: 'idb-not-subset',
              t, session, docId,
              expected: 'textLen should increase by new content only',
              observed: `ydoc-update(origin=local) textLen=${newLen} after idb-load textLen=${prevLen} — appears doubled`,
              hint: HINTS.V5,
              pointer: CODE_POINTERS.V5,
            });
          }
        }

        // V3: autosave-during-pull — if incomingSync was set and we get the remote update
        if (origin === 'remote') {
          st.incomingSync = false;
          st.incomingSyncT = null;
        }

        // track ytextLen
        if (ev.textLen != null) st.ytextLen = ev.textLen;
        if (ev.svAfter != null) st.lastSV = ev.svAfter;

        // signal that doc changed since last flush
        st.hadYdocUpdateSinceFlush = true;
        break;
      }

      case 'ws-doc-fwd': {
        // Server forwarded a sync frame — start incomingSync window
        // Only relevant for sessions: ws-doc-fwd is server-side, session might be absent
        // We use the session field if present, else '(global)'
        st.incomingSync = true;
        st.incomingSyncT = t;
        break;
      }

      case 'autosave-trigger': {
        // V2: no ydoc-update since last flush
        if (!st.hadYdocUpdateSinceFlush) {
          pushViolation({
            severity: 'WARN', code: 'V2', name: 'autosave-without-update',
            t, session, docId,
            expected: 'at least one ydoc-update since last autosave-flush',
            observed: 'autosave-trigger with no intervening ydoc-update',
            hint: HINTS.V2,
            pointer: CODE_POINTERS.V2,
          });
        }
        // V3: autosave during incoming sync window
        if (st.incomingSync) {
          pushViolation({
            severity: 'WARN', code: 'V3', name: 'autosave-during-pull',
            t, session, docId,
            expected: 'wait for incoming sync before flushing',
            observed: `autosave-trigger while ws-doc-fwd sync window open (started t=${st.incomingSyncT})`,
            hint: HINTS.V3,
            pointer: CODE_POINTERS.V3,
          });
        }
        st.pendingAutosaves += 1;
        break;
      }

      case 'autosave-flush':
        st.pendingAutosaves = Math.max(0, st.pendingAutosaves - 1);
        st.hadYdocUpdateSinceFlush = false;
        st.lastAutosaveFlushT = t;
        break;

      case 'reload-event': {
        // V9: autosave-flush followed by reload-event within 1s in same session = self-induced loop
        if (st.lastAutosaveFlushT != null && t - st.lastAutosaveFlushT < 1000) {
          pushViolation({
            severity: 'ERROR', code: 'V9', name: 'autosave-induced-reload-loop',
            t, session, docId,
            expected: 'reload-event only from external file change',
            observed: `reload-event ${t - st.lastAutosaveFlushT}ms after our autosave-flush`,
            hint: HINTS.V9,
            pointer: CODE_POINTERS.V9,
          });
        }
        st.lastReloadT = t;
        st.lastReloadTextLen = st.ytextLen;
        break;
      }

      // --- server events ---

      case 'rpc-out': {
        const reqId = ev.extra?.reqId;
        const method = ev.extra?.method;
        if (reqId) {
          pendingRpc.set(reqId, { t, method, session });
        }
        break;
      }

      case 'rpc-in-resp': {
        const reqId = ev.extra?.reqId;
        if (reqId && pendingRpc.has(reqId)) {
          pendingRpc.delete(reqId);
        }
        break;
      }

      // --- cli events ---

      case 'willow-replay': {
        st.willowEntries = ev.extra?.entries ?? st.willowEntries;
        // V4 checked at end
        break;
      }

    }
  }

  // -------------------------------------------------------------------------
  // Post-walk checks
  // -------------------------------------------------------------------------

  // V6: rpc-out with no response within 25s
  const RPC_TIMEOUT_MS = 25_000;
  const lastT = t1;
  for (const [reqId, { t: rpcT, method, session }] of pendingRpc) {
    // only flag if enough time has elapsed in the trace
    if (lastT - rpcT >= RPC_TIMEOUT_MS) {
      pushViolation({
        severity: 'ERROR', code: 'V6', name: 'rpc-timeout',
        t: rpcT, session, docId,
        expected: `rpc-in-resp for reqId=${reqId} within 25s`,
        observed: `no response after ${((lastT - rpcT) / 1000).toFixed(1)}s (method=${method ?? '?'})`,
        hint: HINTS.V6,
        pointer: CODE_POINTERS.V6,
      });
    }
  }

  // V4: willow-replay mismatch — compare willow finalByteLen vs any ydoc state
  // We look for paired rpc-out(yjs-read) + willow-replay events
  {
    const yjsReadRpcs = events.filter(
      ev => ev.event === 'rpc-out' && ev.extra?.method === 'yjs-read'
    );
    const willowReplays = events.filter(ev => ev.event === 'willow-replay');

    for (const rpc of yjsReadRpcs) {
      // find the next willow-replay after this rpc
      const replay = willowReplays.find(r => r.t >= rpc.t);
      if (!replay) continue;
      const finalByteLen = replay.extra?.finalByteLen;
      if (finalByteLen == null) continue;

      // find a subsequent rpc-in-resp with byteLen
      const resp = events.find(
        ev => ev.event === 'rpc-in-resp' &&
          ev.extra?.reqId === rpc.extra?.reqId &&
          ev.t >= replay.t
      );
      if (!resp) continue;
      const respByteLen = resp.extra?.byteLen;
      if (respByteLen == null) continue;

      if (finalByteLen !== respByteLen) {
        pushViolation({
          severity: 'INFO', code: 'V4', name: 'willow-replay-mismatch',
          t: replay.t, session: rpc.session ?? '(global)', docId,
          expected: `willow finalByteLen=${finalByteLen} to match rpc response byteLen=${respByteLen}`,
          observed: `mismatch: willow=${finalByteLen} vs rpc-resp=${respByteLen}`,
          hint: HINTS.V4,
          pointer: CODE_POINTERS.V4,
        });
      }
    }
  }

  return {
    docId,
    sessions: [...sessions],
    events,
    t0, t1,
    srcCounts,
    violations,
  };
}

// ---------------------------------------------------------------------------
// Format output
// ---------------------------------------------------------------------------

function fmtMs(ms) { return `${(ms / 1000).toFixed(1)}s`; }
function fmtTs(t) { return new Date(t).toISOString(); }

function severityOrder(s) {
  return s === 'ERROR' ? 0 : s === 'WARN' ? 1 : 2;
}

function printReport(result) {
  const { docId, sessions, events, t0, t1, srcCounts, violations } = result;
  const duration = t1 - t0;
  const browserN = srcCounts.browser ?? 0;
  const serverN = srcCounts.server ?? 0;
  const cliN = (srcCounts.cli ?? 0) + (srcCounts.agent ?? 0);
  const total = events.length;
  const sessionList = sessions.length ? sessions.join(', ') : '(none)';

  console.log(`\n=== diagnose: docId=${docId} ===`);
  console.log(`Sessions: ${sessions.length} (${sessionList})`);
  console.log(`Events:   ${total} (browser=${browserN}, server=${serverN}, cli=${cliN})`);
  console.log(`Time:     ${fmtMs(duration)} (t0=${fmtTs(t0)} t1=${fmtTs(t1)})`);

  if (violations.length === 0) {
    console.log(`\n✓ no invariant violations across ${total} events.`);
    return;
  }

  // sort by severity then t
  const sorted = violations.slice().sort((a, b) => {
    const sd = severityOrder(a.severity) - severityOrder(b.severity);
    if (sd !== 0) return sd;
    return (a.t ?? 0) - (b.t ?? 0);
  });

  console.log('\nVIOLATIONS:');
  for (const v of sorted) {
    const relT = v.t - t0;
    console.log(`  [${v.severity}] ${v.code} ${v.name}   t=${relT}ms  session=${v.session}`);
    console.log(`    expected: ${v.expected}`);
    console.log(`    observed: ${v.observed}`);
    console.log(`    hint: ${v.hint}`);
    console.log(`    code:  ${v.pointer}`);
    console.log();
  }

  const errors = violations.filter(v => v.severity === 'ERROR').length;
  const warns  = violations.filter(v => v.severity === 'WARN').length;
  const infos  = violations.filter(v => v.severity === 'INFO').length;
  const parts = [];
  if (errors) parts.push(`${errors} ERROR`);
  if (warns)  parts.push(`${warns} WARN`);
  if (infos)  parts.push(`${infos} INFO`);
  console.log(`Summary: ${parts.join(', ')}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

for (const [docId, events] of byDocId) {
  const result = analyzeDocId(docId, events);
  printReport(result);
}
