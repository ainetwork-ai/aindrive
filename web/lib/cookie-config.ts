import { env } from "./env";

/**
 * Single source of truth for httpOnly cookie attributes (session + wallet).
 *
 * Previously session.ts and wallet.ts disagreed on the `secure` flag:
 * session required NODE_ENV=production AND https publicUrl, while wallet
 * only checked publicUrl. In dev environments with an https tunnel
 * (ngrok / cloudflared) this asymmetry caused only one of the two cookies
 * to be set, producing infinite 401 loops.
 *
 * The rule is now uniform: `secure` follows the public URL scheme.
 * If the server is reachable over https (whether in dev or production),
 * both cookies are Secure. If it's plain http, neither is.
 */
export function cookieOptions() {
  return {
    httpOnly: true as const,
    sameSite: "lax" as const,
    secure: env.publicUrl.startsWith("https://"),
    path: "/" as const,
    maxAge: 60 * 60 * 24 * 30, // 30 days
  };
}
