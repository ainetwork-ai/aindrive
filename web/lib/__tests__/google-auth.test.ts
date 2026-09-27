import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPair, SignJWT, createLocalJWKSet, exportJWK, type JWTVerifyGetKey } from "jose";

process.env.AINDRIVE_DATA_DIR = mkdtempSync(join(tmpdir(), "aindrive-google-"));
process.env.AINDRIVE_GOOGLE_CLIENT_IDS = "web-client.apps.googleusercontent.com";

const { db } = await import("../db.js");
const { verifyGoogleIdToken, resolveAccountForGoogle, GoogleEmailInUseError } = await import("../google-auth");

let privateKey: CryptoKey, keys: JWTVerifyGetKey;
beforeAll(async () => {
  const kp = await generateKeyPair("RS256");
  privateKey = kp.privateKey as CryptoKey;
  const jwk = { ...(await exportJWK(kp.publicKey)), kid: "k1", alg: "RS256" };
  keys = createLocalJWKSet({ keys: [jwk] });
});

const token = (claims: Record<string, unknown>, aud = "web-client.apps.googleusercontent.com", iss = "https://accounts.google.com") =>
  new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuer(iss).setAudience(aud)
    .setIssuedAt().setExpirationTime("5m").sign(privateKey);

describe("google sign-in", () => {
  it("accepts a Google token for our client with a verified email", async () => {
    const g = await verifyGoogleIdToken(await token({ sub: "g1", email: "A@Example.com", email_verified: true, name: "Ann" }), keys);
    expect(g).toEqual({ sub: "g1", email: "a@example.com", name: "Ann" });
  });

  it("rejects another app's token, another issuer, and unverified emails", async () => {
    await expect(verifyGoogleIdToken(await token({ sub: "g1", email: "a@x.com", email_verified: true }, "someone-else"), keys)).rejects.toThrow();
    await expect(verifyGoogleIdToken(await token({ sub: "g1", email: "a@x.com", email_verified: true }, undefined, "https://evil.example"), keys)).rejects.toThrow();
    await expect(verifyGoogleIdToken(await token({ sub: "g1", email: "a@x.com", email_verified: false }), keys)).rejects.toThrow("email_not_verified");
  });

  it("creates an account once, then reaches the same one", () => {
    const a = resolveAccountForGoogle({ sub: "new-sub", email: "new@example.com", name: "New" });
    expect(a.created).toBe(true);
    expect(resolveAccountForGoogle({ sub: "new-sub", email: "new@example.com", name: "New" })).toEqual({ id: a.id, created: false });
  });

  // An email address can be reassigned to another person; matching on it
  // would hand them the previous holder's account (AIN SSO ADR-0004).
  it("never links an existing account because its email matches", () => {
    db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?,?,?,?)").run("e1", "owner@example.com", "Owner", "x");
    expect(() => resolveAccountForGoogle({ sub: "owner-sub", email: "owner@example.com", name: "Owner" })).toThrow(GoogleEmailInUseError);
    expect(() => resolveAccountForGoogle({ sub: "owner-sub", email: "OWNER@example.com".toLowerCase(), name: "Owner" })).toThrow("email_in_use");
    expect(db.prepare("SELECT count(*) c FROM account_google WHERE sub = 'owner-sub'").get()).toEqual({ c: 0 });
    expect(db.prepare("SELECT count(*) c FROM users WHERE lower(email) = 'owner@example.com'").get()).toEqual({ c: 1 });
  });

  it("a Google account linked before keeps reaching its account", () => {
    db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?,?,?,?)").run("e2", "linked@example.com", "Linked", "x");
    db.prepare("INSERT INTO account_google (sub, account_id, email) VALUES (?,?,?)").run("linked-sub", "e2", "linked@example.com");
    expect(resolveAccountForGoogle({ sub: "linked-sub", email: "linked@example.com", name: "Linked" })).toEqual({ id: "e2", created: false });
  });
});
