// web/shared/willow/policy.ts
// Who may write where (spec D4): every peer runs this at ingest, so a non-member's
// entry is refused by the server and by any device alike. Grants mirror the
// server's drive_members rows and are signed by the owner's device or by aindrive's
// attestation key (spec §5).
import { canonicalJson, fromHex, toHex } from "./bytes";
import { sign, verify, type DeviceKeypair } from "./keys";
import { resolvePerson, type Cert, type Person, type Revocation, type Trust } from "./cert";

export type Role = "viewer" | "commenter" | "editor" | "owner";
export type Grant = {
  v: 1; driveId: string; userId: string; role: Role; pathPrefix: string[]; expiresAt?: string; issuedAt: string;
  issuer: { type: "attestation" | "device"; key: string }; sig: string;
};
export type PolicyCtx = { driveId: string; ownerUserId: string; grants: Grant[]; certs: Cert[]; revocations: Revocation[]; trust: Trust };
export type EntryMeta = { subspaceHex: string; path: string[]; timestamp: bigint };
export type Verdict =
  | { ok: true; person: Person | null }
  | { ok: false; reason: "unknown-device" | "revoked" | "not-a-member" | "outside-grant" | "expired" | "bad-grant" };

const grantBody = (g: Omit<Grant, "sig">) => canonicalJson({ kind: "aindrive-grant", ...g });
const WRITE: Role[] = ["editor", "owner"];

export async function signGrant(signer: DeviceKeypair, issuerType: "attestation" | "device", g: Omit<Grant, "v" | "sig" | "issuer">): Promise<Grant> {
  const full = { v: 1 as const, ...g, issuer: { type: issuerType, key: toHex(signer.publicKey) } };
  return { ...full, sig: toHex(await sign(signer, grantBody(full))) };
}

const isPrefix = (prefix: string[], path: string[]) => prefix.length <= path.length && prefix.every((c, i) => path[i] === c);

async function grantValid(g: Grant, ctx: PolicyCtx): Promise<boolean> {
  if (g.driveId !== ctx.driveId) return false;
  const { sig, ...rest } = g;
  if (!(await verify(fromHex(g.issuer.key), grantBody(rest), fromHex(sig)))) return false;
  if (g.issuer.type === "attestation") return ctx.trust.attestationKeys.includes(g.issuer.key);
  const issuer = await resolvePerson(g.issuer.key, ctx.certs, ctx.revocations, ctx.trust, BigInt(g.issuedAt));
  return issuer?.userId === ctx.ownerUserId;
}

export async function mayWrite(e: EntryMeta, ctx: PolicyCtx): Promise<Verdict> {
  const [head, ...rest] = e.path;
  if (head === "_id") return { ok: true, person: null };

  const now = await resolvePerson(e.subspaceHex, ctx.certs, ctx.revocations, ctx.trust, e.timestamp);
  if (!now) {
    const ever = await resolvePerson(e.subspaceHex, ctx.certs, [], ctx.trust);
    return { ok: false, reason: ever ? "revoked" : "unknown-device" };
  }
  if (head === "_acl") return now.userId === ctx.ownerUserId ? { ok: true, person: now } : { ok: false, reason: "not-a-member" };
  if (head !== "doc") return { ok: false, reason: "outside-grant" };
  if (now.userId === ctx.ownerUserId) return { ok: true, person: now };

  const docPath = rest.slice(0, rest.indexOf("~u") < 0 ? rest.length : rest.indexOf("~u"));
  let member = false;
  for (const g of ctx.grants.filter((g) => g.userId === now.userId && WRITE.includes(g.role))) {
    if (g.expiresAt && e.timestamp >= BigInt(g.expiresAt)) continue;
    if (!(await grantValid(g, ctx))) continue;
    member = true;
    if (isPrefix(g.pathPrefix, docPath)) return { ok: true, person: now };
  }
  return { ok: false, reason: member ? "outside-grant" : "not-a-member" };
}
