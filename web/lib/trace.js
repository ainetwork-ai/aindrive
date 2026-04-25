/**
 * Standard observability: structured stdout logging + in-memory ring buffer.
 *
 * No file writes. Events flow through:
 *   1. console.log(JSON.stringify(...))   ← captured by any log aggregator
 *   2. ringBuffer.push(...)                ← queryable via /api/dev/trace/dump
 *
 * Browser POSTs to /api/dev/trace which calls writeTrace() (server-side).
 * CLI agents POST to the same endpoint.
 *
 * For local debugging:  curl 'http://localhost:3737/api/dev/trace/dump?docId=XXX&limit=200' | jq
 *                       node server.js 2>&1 | grep '"event":' | jq
 */
import { createHash } from "node:crypto";
import { trace as pinoTrace } from "./logger.js";

const ENABLED = process.env.AINDRIVE_TRACE !== "off";
const RING_MAX = parseInt(process.env.AINDRIVE_TRACE_RING_SIZE || "10000", 10);

// Per-process ring buffer (pinned on globalThis so dev/HMR re-imports preserve it)
const ring = globalThis.__aindrive_trace_ring ?? [];
if (!globalThis.__aindrive_trace_ring) globalThis.__aindrive_trace_ring = ring;

export function isTraceEnabled() {
  return ENABLED;
}

export function docIdFor(driveId, path) {
  return createHash("sha1").update(`${driveId}:${path}`).digest("base64url").slice(0, 22);
}

export function hashSV(sv) {
  return "sha:" + createHash("sha1").update(sv).digest("hex").slice(0, 12);
}

/** Emit event(s). Always non-throwing. Cheap when disabled. */
export function writeTrace(entries) {
  if (!ENABLED) return;
  const arr = Array.isArray(entries) ? entries : [entries];
  for (const raw of arr) {
    if (!raw || !raw.docId) continue;
    const e = {
      t: raw.t || Date.now(),
      docId: raw.docId,
      src: raw.src || "unknown",
      event: raw.event || "unknown",
      ...(raw.session && { session: raw.session }),
      ...(raw.origin && { origin: raw.origin }),
      ...(raw.byteLen != null && { byteLen: raw.byteLen }),
      ...(raw.textLen != null && { textLen: raw.textLen }),
      ...(raw.svBefore && { svBefore: raw.svBefore }),
      ...(raw.svAfter && { svAfter: raw.svAfter }),
      ...(raw.extra && { extra: raw.extra }),
    };
    // Structured stdout — pickup by any log shipper
    try { pinoTrace.info(e, e.event); } catch {}
    // Ring buffer for live API queries
    ring.push(e);
    if (ring.length > RING_MAX) ring.shift();
  }
}

/** Convenience single-event emitter. */
export function trace(src, event, extra = {}) {
  if (!ENABLED) return;
  if (!extra.docId) return;
  writeTrace({ src, event, ...extra });
}

/**
 * Query the ring buffer.
 * @param {{ docId?: string; since?: number; limit?: number }} [opts]
 */
export function queryRing({ docId, since, limit = 500 } = {}) {
  let out = ring;
  if (docId) out = out.filter((e) => e.docId === docId);
  if (since != null) out = out.filter((e) => e.t >= since);
  if (limit && out.length > limit) out = out.slice(-limit);
  return out;
}

export function ringStats() {
  return { size: ring.length, max: RING_MAX };
}
