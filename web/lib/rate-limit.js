/**
 * In-memory token-bucket rate limiter.
 * Pinned to globalThis so it survives Next.js HMR reloads.
 */

const STORE_KEY = "__rl_buckets__";
const MAX_ENTRIES = 50_000;

function getStore() {
  if (!globalThis[STORE_KEY]) {
    globalThis[STORE_KEY] = new Map();
  }
  return globalThis[STORE_KEY];
}

/**
 * Prune buckets that have been idle for more than 10× their windowMs.
 * Also enforces the MAX_ENTRIES cap by removing oldest entries.
 */
function prune(store, now) {
  for (const [key, bucket] of store) {
    if (now - bucket.lastAccess > bucket.windowMs * 10) {
      store.delete(key);
    }
  }
  // If still over cap, remove oldest by insertion order (Map preserves it).
  if (store.size > MAX_ENTRIES) {
    const overflow = store.size - MAX_ENTRIES;
    let removed = 0;
    for (const key of store.keys()) {
      store.delete(key);
      if (++removed >= overflow) break;
    }
  }
}

/**
 * tryConsume({ name, key, limit, windowMs })
 * Returns { ok: true } or { ok: false, retryAfterMs }.
 *
 * @param {{ name: string, key: string, limit: number, windowMs: number }} opts
 * @returns {{ ok: true } | { ok: false, retryAfterMs: number }}
 */
export function tryConsume({ name, key, limit, windowMs }) {
  const store = getStore();
  const bucketKey = `${name}:${key}`;
  const now = Date.now();

  // Periodic prune — run roughly 1% of the time to keep overhead low.
  if (Math.random() < 0.01) {
    prune(store, now);
  }

  let bucket = store.get(bucketKey);
  if (!bucket) {
    bucket = { tokens: limit, windowStart: now, windowMs, lastAccess: now };
    store.set(bucketKey, bucket);
  } else {
    bucket.lastAccess = now;
    // Refill tokens if the window has rolled over.
    const elapsed = now - bucket.windowStart;
    if (elapsed >= windowMs) {
      const windows = Math.floor(elapsed / windowMs);
      bucket.tokens = Math.min(limit, bucket.tokens + windows * limit);
      bucket.windowStart += windows * windowMs;
    }
  }

  if (bucket.tokens > 0) {
    bucket.tokens -= 1;
    return { ok: true };
  }

  // Calculate how long until the current window resets.
  const retryAfterMs = windowMs - (now - bucket.windowStart);
  return { ok: false, retryAfterMs: Math.max(retryAfterMs, 0) };
}

/**
 * clientKey(req, name)
 * Returns a namespaced key based on the client IP.
 */
export function clientKey(req, name) {
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0].trim() ||
    req.headers.get("x-real-ip") ||
    "anon";
  return `${name}:${ip}`;
}
