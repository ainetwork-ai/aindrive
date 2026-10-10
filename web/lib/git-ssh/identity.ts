/**
 * Who is at the other end of an SSH connection: the offered public key →
 * its SHA256 fingerprint → AIN SSO's key directory (lib/sso-ssh-keys.ts) →
 * the AIN subject → the aindrive account linked to it (sso_identities,
 * lib/sso/store.js identityFor — the same link every SSO sign-in uses).
 *
 * The result is a user id, nothing more: what that user may do with a repo is
 * decided afterwards by gateDriveRoleForUser (lib/require-access.ts), the same
 * gate every drive route applies. Refused here, before any gate:
 *   - a key AIN SSO does not know;
 *   - a key whose directory record is for a different public key than the
 *     one offered (the fingerprint is only an index — the bytes must match);
 *   - a subject with no linked aindrive account;
 *   - a linked account that no longer exists, or that AIN SSO blocked
 *     (sso_memberships rows and none active — lib/sso/store.js ssoAccountState).
 * Signature verification of the key is the SSH server's job (lib/git-ssh/server.ts).
 */
import { db } from "../db";
import { identityFor, ssoAccountState } from "../sso/store.js";
import { sshFingerprint, type SshKeyDirectory, type SshKeyRecord } from "../sso-ssh-keys";

export type SshIdentity = { userId: string; subject: string; email: string; name: string; fingerprint: string };

export type IdentityRefusal =
  | "unknown_key"      // AIN SSO has no account for this fingerprint
  | "key_mismatch"     // the record's public key is not the offered one
  | "not_linked"       // the AIN account has no aindrive account
  | "no_account"       // the linked aindrive account row is gone
  | "blocked";         // AIN SSO suspended / offboarded the account

export type IdentityResult = { ok: true; identity: SshIdentity } | { ok: false; reason: IdentityRefusal };

export type IdentityDeps = {
  directory: SshKeyDirectory;
  issuer: string;
  identityFor?: (issuer: string, subject: string) => { user_id: string } | undefined;
  userRow?: (userId: string) => { id: string; email: string; name: string } | undefined;
  accountState?: (userId: string) => "unmanaged" | "active" | "blocked";
};

/** The raw key blob of an `ssh-ed25519 AAAA… comment` / `ssh-rsa AAAA…` line, or null. */
export function publicKeyBlobOf(publicKey: string): Buffer | null {
  const parts = String(publicKey ?? "").trim().split(/\s+/);
  const b64 = parts.length >= 2 ? parts[1] : parts[0];
  if (!b64 || !/^[A-Za-z0-9+/]+=*$/.test(b64)) return null;
  let blob: Buffer;
  try { blob = Buffer.from(b64, "base64"); } catch { return null; }
  // An SSH key blob starts with its algorithm as a length-prefixed string.
  if (blob.length < 8) return null;
  const typeLen = blob.readUInt32BE(0);
  if (typeLen < 7 || typeLen > 64 || 4 + typeLen > blob.length) return null;
  const type = blob.subarray(4, 4 + typeLen).toString("latin1");
  if (parts.length >= 2 && parts[0] !== type) return null;
  return blob;
}

/** Does the directory record describe exactly the offered key? */
export function recordMatchesKey(rec: SshKeyRecord, offered: Buffer): boolean {
  const blob = publicKeyBlobOf(rec.public_key);
  return !!blob && blob.length === offered.length && blob.equals(offered);
}

export async function resolveSshIdentity(offeredKeyBlob: Buffer, deps: IdentityDeps): Promise<IdentityResult> {
  const fingerprint = sshFingerprint(offeredKeyBlob);
  const rec = await deps.directory.byFingerprint(fingerprint);
  if (!rec) return { ok: false, reason: "unknown_key" };
  if (!recordMatchesKey(rec, offeredKeyBlob)) return { ok: false, reason: "key_mismatch" };
  const ident = (deps.identityFor ?? defaultIdentityFor)(deps.issuer, rec.subject);
  if (!ident) return { ok: false, reason: "not_linked" };
  const user = (deps.userRow ?? defaultUserRow)(ident.user_id);
  if (!user) return { ok: false, reason: "no_account" };
  if ((deps.accountState ?? defaultAccountState)(user.id) === "blocked") return { ok: false, reason: "blocked" };
  return { ok: true, identity: { userId: user.id, subject: rec.subject, email: user.email, name: user.name, fingerprint } };
}

function defaultIdentityFor(issuer: string, subject: string): { user_id: string } | undefined {
  return identityFor(issuer, subject) as { user_id: string } | undefined;
}
function defaultUserRow(userId: string): { id: string; email: string; name: string } | undefined {
  return db.prepare("SELECT id, email, name FROM users WHERE id = ?").get(userId) as { id: string; email: string; name: string } | undefined;
}
function defaultAccountState(userId: string): "unmanaged" | "active" | "blocked" {
  return ssoAccountState(userId) as "unmanaged" | "active" | "blocked";
}
