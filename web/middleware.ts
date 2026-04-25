import { NextRequest, NextResponse } from "next/server";

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data: blob: https:",
  "connect-src 'self' wss: https:",
  "frame-src 'self' blob:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
].join("; ");

export default async function middleware(
  req: NextRequest
): Promise<NextResponse> {
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

export const config = {
  matcher: [
    "/((?!_next/static|_next/image).*)",
  ],
};
