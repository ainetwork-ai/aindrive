/**
 * Google sign-in: verify a Google ID token and resolve the aindrive account it
 * reaches. Used by POST /api/auth/google (the mobile app's one-tap sign-in and
 * any web "Sign in with Google" button).
 *
 * Trust: the token must be signed by Google (JWKS), issued by accounts.google.com,
 * addressed to one of OUR OAuth client ids (AINDRIVE_GOOGLE_CLIENT_IDS), unexpired,
 * and carry a Google-verified email. Resolution: a Google account already linked
 * (by `sub`) → that account; else, when no account uses that email, a new
 * account. An existing account is NEVER linked because its email matches: an
 * email address can be reassigned to another person (a company mailbox), and
 * matching on it would hand them the previous holder's account. That case is
 * refused with `email_in_use` — the owner signs in the way they signed up.
 * See docs/PERMISSIONS.md § Identity.
 */
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import bcrypt from "bcryptjs";
import { nanoid } from "nanoid";
import { db } from "./db";

const ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

/** OAuth client ids whose tokens we accept; the first is the "web" (server) client the app asks tokens for. */
export function googleClientIds(): string[] {
  return (process.env.AINDRIVE_GOOGLE_CLIENT_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

let jwks: JWTVerifyGetKey | null = null;
function googleKeys(): JWTVerifyGetKey {
  jwks ??= createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));
  return jwks;
}

export interface GoogleIdentity { sub: string; email: string; name: string }

export async function verifyGoogleIdToken(idToken: string, keys: JWTVerifyGetKey = googleKeys()): Promise<GoogleIdentity> {
  const audience = googleClientIds();
  if (!audience.length) throw new Error("google_not_configured");
  const { payload } = await jwtVerify(idToken, keys, { issuer: ISSUERS, audience });
  const email = typeof payload.email === "string" ? payload.email.toLowerCase() : "";
  if (!payload.sub || !email) throw new Error("no_email");
  if (payload.email_verified !== true && payload.email_verified !== "true") throw new Error("email_not_verified");
  const name = typeof payload.name === "string" && payload.name.trim() ? payload.name.trim() : email.split("@")[0];
  return { sub: payload.sub, email, name };
}

/** An account already uses the Google email, but no Google account is linked to it. */
export class GoogleEmailInUseError extends Error {
  constructor() {
    super("email_in_use");
    this.name = "GoogleEmailInUseError";
  }
}

/**
 * The account a verified Google identity reaches: the one linked to its `sub`,
 * or a new one. Throws GoogleEmailInUseError instead of linking by email.
 */
export function resolveAccountForGoogle(g: GoogleIdentity): { id: string; created: boolean } {
  return db.transaction(() => {
    const linked = db.prepare("SELECT account_id FROM account_google WHERE sub = ?").get(g.sub) as { account_id: string } | undefined;
    if (linked) return { id: linked.account_id, created: false };
    if (db.prepare("SELECT 1 FROM users WHERE lower(email) = ?").get(g.email)) throw new GoogleEmailInUseError();
    const id = nanoid(10);
    // No password: a random hash no login attempt can reproduce (reset-password can set one later).
    db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)")
      .run(id, g.email, g.name, bcrypt.hashSync(nanoid(24), 10));
    db.prepare("INSERT INTO account_google (sub, account_id, email) VALUES (?, ?, ?)").run(g.sub, id, g.email);
    return { id, created: true };
  })();
}
