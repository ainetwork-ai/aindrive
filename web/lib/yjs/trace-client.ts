"use client";

/**
 * Thin browser trace client. Batches events and POSTs to /api/dev/trace.
 * Flushes on beforeunload via navigator.sendBeacon.
 */

export type TraceEmitter = (event: string, extra?: Record<string, unknown>) => void;

/** Stable session id for this page load. */
export const SESSION_ID: string = `S-${Math.random().toString(36).slice(2, 8)}-${Date.now()}`;

/** Compute sha-1 hex of a Uint8Array using SubtleCrypto, return "sha:" + hex.slice(0,12). */
async function hashSV(sv: Uint8Array): Promise<string> {
  try {
    const buf = await crypto.subtle.digest("SHA-1", sv.buffer.slice(sv.byteOffset, sv.byteOffset + sv.byteLength) as ArrayBuffer);
    const hex = Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    return "sha:" + hex.slice(0, 12);
  } catch {
    return "sha:000000000000";
  }
}

export { hashSV };

interface TraceEvent {
  t: number;
  docId: string;
  session: string;
  src: string;
  event: string;
  [key: string]: unknown;
}

/**
 * Factory that returns an emit(event, extra?) function.
 * Buffers up to 20 events or 1 second, then POSTs to /api/dev/trace.
 * Registers beforeunload flush via sendBeacon.
 */
export function traceClient(
  docId: string,
  session: string,
  src = "browser"
): TraceEmitter {
  let disabled = false;
  const buffer: TraceEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  async function flush() {
    if (timer !== null) { clearTimeout(timer); timer = null; }
    if (buffer.length === 0) return;
    const batch = buffer.splice(0, buffer.length);
    try {
      const res = await fetch("/api/dev/trace", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(batch.length === 1 ? batch[0] : batch),
        keepalive: true,
      });
      if (res.ok) {
        const json = await res.json().catch(() => ({}));
        if (json && json.disabled === true) { disabled = true; }
      }
    } catch {
      // fire-and-forget, ignore errors
    }
  }

  function schedule() {
    if (timer !== null) return;
    timer = setTimeout(() => { void flush(); }, 1000);
  }

  function beaconFlush() {
    if (buffer.length === 0) return;
    const batch = buffer.splice(0, buffer.length);
    const body = JSON.stringify(batch.length === 1 ? batch[0] : batch);
    if (typeof navigator !== "undefined" && navigator.sendBeacon) {
      navigator.sendBeacon("/api/dev/trace", new Blob([body], { type: "application/json" }));
    }
  }

  if (typeof window !== "undefined") {
    window.addEventListener("beforeunload", beaconFlush);
  }

  return function emit(event: string, extra: Record<string, unknown> = {}) {
    if (disabled) return;
    const entry: TraceEvent = {
      t: Date.now(),
      docId,
      session,
      src,
      event,
      ...extra,
    };
    buffer.push(entry);
    if (buffer.length >= 20) {
      void flush();
    } else {
      schedule();
    }
  };
}
