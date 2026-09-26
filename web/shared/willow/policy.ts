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
/** `now` is the receiving peer's clock (µs): revocation and expiry are judged at the
 *  later of `now` and the entry's own timestamp, so a backdated entry gets nothing. */
export type PolicyCtx = { driveId: string; ownerUserId: string; grants: Grant[]; certs: Cert[]; revocations: Revocation[]; trust: Trust; now?: bigint };
/** `cert` is the parsed payload of an `_id/cert` entry; `payloadLength` caps `_id` entries. */
export type EntryMeta = { subspaceHex: string; path: string[]; timestamp: bigint; payloadLength?: bigint; cert?: Cert };
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

const ID_MAX = 4096n;
const HEX64 = /^[0-9a-f]{64}$/;
const later = (a: bigint, b?: bigint) => (b !== undefined && b > a ? b : a);

async function grantValid(g: Grant, ctx: PolicyCtx): Promise<boolean> {
  try {
    if (g.driveId !== ctx.driveId) return false;
    const { sig, ...rest } = g;
    if (!(await verify(fromHex(g.issuer.key), grantBody(rest), fromHex(sig)))) return false;
    if (g.issuer.type === "attestation") return ctx.trust.attestationKeys.includes(g.issuer.key);
    // the owner's device must be valid now, not just when it claims to have signed
    const issuer = await resolvePerson(g.issuer.key, ctx.certs, ctx.revocations, ctx.trust, later(BigInt(g.issuedAt), ctx.now));
    return issuer?.userId === ctx.ownerUserId;
  } catch {
    return false;
  }
}

export async function mayWrite(e: EntryMeta, ctx: PolicyCtx): Promise<Verdict> {
  const [head, ...rest] = e.path;
  const t = later(e.timestamp, ctx.now);

  if (head === "_id") {
    const cert = rest.length === 1 && rest[0] === "cert";
    const rev = rest.length === 2 && rest[0] === "revoke" && HEX64.test(rest[1]);
    if (!cert && !rev) return { ok: false, reason: "outside-grant" };
    if (e.payloadLength !== undefined && e.payloadLength > ID_MAX) return { ok: false, reason: "outside-grant" };
    if (cert && e.cert) {
      if (e.cert.deviceKey !== e.subspaceHex) return { ok: false, reason: "unknown-device" };
      // a device-issued certificate needs an issuer that is valid now (no backdated minting by a revoked device)
      if (e.cert.issuer?.type === "device" && !(await resolvePerson(e.cert.issuer.key, ctx.certs, ctx.revocations, ctx.trust, t)))
        return { ok: false, reason: "revoked" };
      const p = await resolvePerson(e.subspaceHex, [...ctx.certs, e.cert], ctx.revocations, ctx.trust, t);
      if (!p) return { ok: false, reason: "unknown-device" };
    }
    return { ok: true, person: null };
  }

  const now = await resolvePerson(e.subspaceHex, ctx.certs, ctx.revocations, ctx.trust, t);
  if (!now) {
    const ever = await resolvePerson(e.subspaceHex, ctx.certs, [], ctx.trust);
    return { ok: false, reason: ever ? "revoked" : "unknown-device" };
  }
  if (head === "_acl") return now.userId === ctx.ownerUserId ? { ok: true, person: now } : { ok: false, reason: "not-a-member" };
  if (head !== "doc") return { ok: false, reason: "outside-grant" };
  if (now.userId === ctx.ownerUserId) return { ok: true, person: now };

  const u = rest.indexOf("~u");
  const docPath = rest.slice(0, u < 0 ? rest.length : u);
  let member = false;
  for (const g of ctx.grants) {
    try {
      if (g.userId !== now.userId || !WRITE.includes(g.role)) continue;
      if (g.expiresAt && t >= BigInt(g.expiresAt)) continue;
      if (!(await grantValid(g, ctx))) continue;
      member = true;
      if (isPrefix(g.pathPrefix, docPath)) return { ok: true, person: now };
    } catch {
      continue;
    }
  }
  return { ok: false, reason: member ? "outside-grant" : "not-a-member" };
}
