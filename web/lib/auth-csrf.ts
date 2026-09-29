/**
 * CSRF guard for the auth POSTs that set or end the session cookie: password
 * sign-in and sign-up, Google, wallet (SIWE) sign-in, sign-out.
 *
 * Login CSRF: a page on another site can auto-submit a top-level form POST
 * with `enctype=text/plain` whose body parses as JSON — a "simple" request, no
 * preflight — and the SameSite=Lax session cookie in the answer is stored,
 * because the POST is a top-level navigation. The browser would then be signed
 * in to the attacker's account (and an OAuth app could be connected to it).
 * The middleware never sees /api, so each route asks here first:
 *
 *   - a browser that says the request comes from another origin (`Origin`
 *     present and not this server — `null` included — or `Sec-Fetch-Site`
 *     cross-site / same-site) → 403 `bad origin`;
 *   - a JSON route whose body is not `application/json` → 415. A form can only
 *     send urlencoded, multipart or text/plain, and a cross-site fetch with
 *     `application/json` needs a CORS preflight these routes never grant.
 *
 * Requests with neither header pass: native clients (mobile/ and desktop/ send
 * through CapacitorHttp / the main process, no Origin) and scripts, none of
 * which can store a cookie in someone's browser.
 */
import { NextResponse } from "next/server";
import { isSameOrigin } from "./oauth";

const JSON_TYPE = /^application\/json\s*(;|$)/i;

export function authPostRefusal(req: Request, opts: { json: boolean }): NextResponse | null {
  const origin = req.headers.get("origin");
  const site = req.headers.get("sec-fetch-site");
  if ((origin !== null && !isSameOrigin(req)) || site === "cross-site" || site === "same-site") {
    return NextResponse.json({ error: "bad origin" }, { status: 403 });
  }
  if (opts.json && !JSON_TYPE.test(req.headers.get("content-type") ?? "")) {
    return NextResponse.json({ error: "unsupported_media_type" }, { status: 415 });
  }
  return null;
}
