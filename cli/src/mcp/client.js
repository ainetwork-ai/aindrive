import { request } from "undici";
import { readGlobalCreds } from "../config.js";

/**
 * HTTP client for the aindrive web server, scoped to a single MCP session.
 *
 * Auth precedence (highest first):
 *   1. AINDRIVE_SESSION env (raw cookie value, e.g. "aindrive_session=...")
 *   2. AINDRIVE_WALLET_COOKIE env (raw cookie value, e.g. "aindrive_wallet=...")
 *   3. Credentials in ~/.aindrive/credentials.json (CLI login flow)
 *
 * Optional cap / payment headers (per call) layered on top.
 */
export async function createClient(opts = {}) {
  const creds = await readGlobalCreds();
  const server = (opts.server || process.env.AINDRIVE_SERVER || creds?.server || "http://localhost:3737").replace(/\/$/, "");
  const sessionCookie = process.env.AINDRIVE_SESSION || creds?.sessionCookie || null;
  const walletCookie = process.env.AINDRIVE_WALLET_COOKIE || null;
  const cap = opts.cap || process.env.AINDRIVE_CAP || null;

  const baseHeaders = {};
  const cookieParts = [];
  if (sessionCookie) cookieParts.push(normalizeCookie(sessionCookie, "aindrive_session"));
  if (walletCookie) cookieParts.push(normalizeCookie(walletCookie, "aindrive_wallet"));
  if (cookieParts.length) baseHeaders.cookie = cookieParts.join("; ");

  async function call(method, path, { body, headers, query, cap: callCap } = {}) {
    let url = server + path;
    if (query) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) {
        if (v == null) continue;
        qs.set(k, String(v));
      }
      const s = qs.toString();
      if (s) url += (url.includes("?") ? "&" : "?") + s;
    }
    const finalHeaders = { ...baseHeaders, ...(headers || {}) };
    if (body !== undefined) finalHeaders["content-type"] = "application/json";
    const useCap = callCap || cap;
    if (useCap) finalHeaders["x-aindrive-cap"] = useCap;

    const res = await request(url, {
      method,
      headers: finalHeaders,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.body.text();
    let parsed;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text }; }
    if (res.statusCode >= 400) {
      const msg = parsed?.error || text || `request failed (${res.statusCode})`;
      const err = new Error(`${method} ${path} → ${res.statusCode}: ${msg}`);
      err.status = res.statusCode;
      err.body = parsed;
      err.headers = res.headers;
      throw err;
    }
    return { status: res.statusCode, body: parsed, headers: res.headers };
  }

  return {
    server,
    hasOwnerAuth: !!sessionCookie,
    hasWallet: !!walletCookie,
    hasCap: !!cap,
    get: (path, opts = {}) => call("GET", path, opts),
    post: (path, body, opts = {}) => call("POST", path, { ...opts, body }),
    delete: (path, opts = {}) => call("DELETE", path, opts),
    raw: call,
  };
}

function normalizeCookie(value, expectedName) {
  // Accept raw "name=value" or just "value" → prepend expectedName.
  if (value.includes("=")) return value.split(";")[0].trim();
  return `${expectedName}=${value}`;
}
