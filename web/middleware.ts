import { NextRequest, NextResponse } from "next/server";
import { checkedCookieSecure, silentSsoStartPath, SSO_CHECKED_COOKIE, SSO_CHECKED_MAX_AGE } from "@/lib/sso/silent";

const CSP = [
  "default-src 'self'",
  // accounts.google.com: Google Identity Services — the "Continue with Google"
  // button's script, its stylesheet and its iframe/popup (components/google-signin-button)
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://accounts.google.com/gsi/client",
  "style-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/style",
  "font-src 'self' data:",
  "img-src 'self' data: blob: https:",
  "connect-src 'self' wss: https:",
  // Wallet connect flows iframe these origins: WalletConnect's Verify
  // anti-phishing attestation (verify/secure.walletconnect.*) and the
  // Coinbase/Base smart-wallet communicator (keys.coinbase.com). Without them
  // the connect modal's iframe is CSP-blocked and Base/Coinbase Wallet fail,
  // while injected wallets (OKX/MetaMask, no iframe) still work. Domains per
  // Reown's recommended CSP (connect-src already covered by the https:/wss:
  // wildcards above).
  "frame-src 'self' blob: https://accounts.google.com https://verify.walletconnect.com https://verify.walletconnect.org https://secure.walletconnect.com https://secure.walletconnect.org https://keys.coinbase.com",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
].join("; ");

/**
 * Silent AIN SSO (lib/sso/silent.ts): a browser opening a page without an
 * aindrive session goes once to /api/auth/sso/start?prompt=none and comes back
 * signed in, or anonymous. Off unless AIN SSO sign-in is configured and enabled.
 * The `ain_sso_checked` cookie is set on this redirect, so the next page view
 * (and every one for 30 minutes) is served normally.
 */
function silentSsoRedirect(req: NextRequest): NextResponse | null {
  const start = silentSsoStartPath({
    method: req.method,
    pathname: req.nextUrl.pathname,
    search: req.nextUrl.search,
    headers: req.headers,
    cookies: req.cookies,
  });
  if (!start) return null;
  // Absolute (middleware requires it), on the public origin: behind the TLS
  // proxy req.url may carry the container's bind address.
  const base = (process.env.AINDRIVE_PUBLIC_URL || req.nextUrl.origin).replace(/\/+$/, "");
  const res = new NextResponse(null, { status: 302, headers: { Location: `${base}${start}`, "Cache-Control": "no-store" } });
  res.cookies.set(SSO_CHECKED_COOKIE, "1", {
    httpOnly: true,
    sameSite: "lax",
    secure: checkedCookieSecure(),
    path: "/",
    maxAge: SSO_CHECKED_MAX_AGE,
  });
  return res;
}

export default async function middleware(
  req: NextRequest
): Promise<NextResponse> {
  const silent = silentSsoRedirect(req);
  if (silent) return silent;

  const res = NextResponse.next();
  const h = res.headers;

  if (!h.has("X-Content-Type-Options")) {
    h.set("X-Content-Type-Options", "nosniff");
  }
  if (!h.has("X-Frame-Options")) {
    h.set("X-Frame-Options", "SAMEORIGIN");
  }
  if (!h.has("Referrer-Policy")) {
    h.set("Referrer-Policy", "strict-origin-when-cross-origin");
  }
  if (!h.has("Permissions-Policy")) {
    h.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  }
  if (!h.has("Content-Security-Policy")) {
    h.set("Content-Security-Policy", CSP);
  }
  if (
    process.env.NODE_ENV === "production" &&
    !h.has("Strict-Transport-Security")
  ) {
    h.set(
      "Strict-Transport-Security",
      "max-age=63072000; includeSubDomains; preload"
    );
  }

  return res;
}

// Exclude /api from the matcher. These security response headers (CSP,
// X-Frame-Options, …) protect *rendered documents*; they do nothing for JSON
// API responses. More importantly, when middleware matches a route, Next.js
// buffers the request body up to middlewareClientMaxBodySize (10 MB) — which
// truncated large uploads to /api/.../fs/write and /yjs mid-JSON, 500-ing every
// file over ~7.5 MB (a base64 body > 10 MB). Not matching /api avoids the
// buffering entirely; the route handlers stream their own bodies and enforce
// their own size caps (AINDRIVE_MAX_WRITE_BYTES).
//
// /mcp and /a2a are JSON-RPC endpoints for the same reason: an MCP write_file
// carries the file as base64 in one JSON body, so going through middleware cut
// every file over ~7.5 MB mid-JSON and the SDK answered "Parse error: Invalid
// JSON" (the AIN Teams / AINMem NAS archives hit it on 2026-09-29).
//
// /<slug>/git/… is git smart-HTTP (app/[slug]/git/[...path], the friendly form
// of /api/drives/<id>/git/…): a push body is a pack that may well exceed 10 MB,
// and git needs the route's raw 401/JSON and pack bytes, so it stays out of the
// middleware like /api does. (A git client never trips the silent-SSO redirect
// — not a browser navigation — but the body cap alone would break pushes.)
// `config` must be a literal (Next analyses it statically at build time); the
// test keeps MIDDLEWARE_MATCHER and the literal in step.
export const MIDDLEWARE_MATCHER = "/((?!_next/static|_next/image|api/|mcp(?:/|$)|a2a(?:/|$)|[^/]+/git(?:/|$)).*)";

export const config = {
  matcher: ["/((?!_next/static|_next/image|api/|mcp(?:/|$)|a2a(?:/|$)|[^/]+/git(?:/|$)).*)"],
};
