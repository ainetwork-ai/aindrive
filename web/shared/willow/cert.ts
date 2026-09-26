// web/shared/willow/cert.ts
// Who a device is (spec §4): a certificate binds a device key to a person, issued
// in flows people already do. Issuers: aindrive's attestation key (email/Google),
// another device of the same person (pairing), or the person's wallet (SIWE with a
// device line), the last paired with an attested wallet↔user link. Certificates and
// revocations are stored as Willow entries in the device's own subspace (Plan 2);
// this module only builds and checks them.
import { canonicalJson, fromHex, toHex, utf8 } from "./bytes";
import { sign, verify, type DeviceKeypair } from "./keys";

export type SignedLink = { address: string; userId: string; sig: string };
export type Issuer =
  | { type: "attestation"; key: string }
  | { type: "device"; key: string }
  | { type: "wallet"; address: string; message: string; signature: string; link: SignedLink };
export type Cert = { v: 1; deviceKey: string; userId: string; label: string; issuedAt: string; issuer: Issuer; sig: string };
export type Revocation = { v: 1; deviceKey: string; userId: string; at: string; by: string; sig: string };
export type Trust = { attestationKeys: string[]; verifyWallet(message: string, signature: string): Promise<string | null> };
export type Person = { userId: string; strength: "wallet" | "attested" };

const body = (c: Omit<Cert, "sig">) => canonicalJson({ kind: "aindrive-device-cert", ...c });
const linkBody = (address: string, userId: string) => canonicalJson({ kind: "aindrive-wallet-link", address: address.toLowerCase(), userId });
const revBody = (r: Omit<Revocation, "sig">) => canonicalJson({ kind: "aindrive-device-revocation", ...r });

export const walletCertMessageLine = (deviceKey: Uint8Array) => `aindrive device: ed25519:${toHex(deviceKey)}`;

async function issueSigned(signer: DeviceKeypair, issuer: Issuer, deviceKey: Uint8Array, userId: string, label: string, at: bigint): Promise<Cert> {
  const c = { v: 1 as const, deviceKey: toHex(deviceKey), userId, label, issuedAt: at.toString(), issuer };
  return { ...c, sig: toHex(await sign(signer, body(c))) };
}

export const issueAttestedCert = (attestation: DeviceKeypair, deviceKey: Uint8Array, userId: string, label: string, at: bigint) =>
  issueSigned(attestation, { type: "attestation", key: toHex(attestation.publicKey) }, deviceKey, userId, label, at);

export const issueDeviceCert = (issuer: DeviceKeypair, deviceKey: Uint8Array, userId: string, label: string, at: bigint) =>
  issueSigned(issuer, { type: "device", key: toHex(issuer.publicKey) }, deviceKey, userId, label, at);

export async function signLink(attestation: DeviceKeypair, address: string, userId: string): Promise<SignedLink> {
  return { address: address.toLowerCase(), userId, sig: toHex(await sign(attestation, linkBody(address, userId))) };
}

export function issueWalletCert(p: {
  deviceKey: Uint8Array; userId: string; label: string; at: bigint; address: string; message: string; signature: string; link: SignedLink;
}): Cert {
  return {
    v: 1, deviceKey: toHex(p.deviceKey), userId: p.userId, label: p.label, issuedAt: p.at.toString(),
    issuer: { type: "wallet", address: p.address.toLowerCase(), message: p.message, signature: p.signature, link: p.link }, sig: "",
  };
}

export async function revoke(by: DeviceKeypair, deviceKey: Uint8Array, userId: string, at: bigint): Promise<Revocation> {
  const r = { v: 1 as const, deviceKey: toHex(deviceKey), userId, at: at.toString(), by: toHex(by.publicKey) };
  return { ...r, sig: toHex(await sign(by, revBody(r))) };
}

async function linkOk(link: SignedLink, trust: Trust): Promise<boolean> {
  for (const k of trust.attestationKeys) if (await verify(fromHex(k), linkBody(link.address, link.userId), fromHex(link.sig))) return true;
  return false;
}

/** Revokes `deviceKey` with aindrive's attestation key: the account page's "remove this device". */
export async function revokeAttested(attestation: DeviceKeypair, deviceKey: Uint8Array, userId: string, at: bigint): Promise<Revocation> {
  return revoke(attestation, deviceKey, userId, at);
}

const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;
const DEC = /^[0-9]{1,20}$/;

function certShapeOk(c: Cert): boolean {
  if (!c || c.v !== 1 || typeof c.userId !== "string" || typeof c.label !== "string") return false;
  if (!HEX64.test(c.deviceKey) || !DEC.test(c.issuedAt)) return false;
  const i = c.issuer as Issuer | undefined;
  if (!i) return false;
  if (i.type === "wallet") return typeof i.message === "string" && typeof i.signature === "string" && typeof i.address === "string" && !!i.link && HEX128.test(i.link.sig);
  return (i.type === "attestation" || i.type === "device") && HEX64.test(i.key) && HEX128.test(c.sig);
}

const revShapeOk = (r: Revocation) =>
  !!r && r.v === 1 && HEX64.test(r.deviceKey) && HEX64.test(r.by) && HEX128.test(r.sig) && DEC.test(r.at) && typeof r.userId === "string";

// Signature checks repeat for every entry resolved; memoise by (key, body, sig).
const verified = new Map<string, boolean>();
async function verifyMemo(keyHex: string, bodyBytes: Uint8Array, sigHex: string): Promise<boolean> {
  const k = `${keyHex}|${sigHex}|${toHex(bodyBytes)}`;
  const hit = verified.get(k);
  if (hit !== undefined) return hit;
  const ok = await verify(fromHex(keyHex), bodyBytes, fromHex(sigHex));
  if (verified.size > 10_000) verified.clear();
  verified.set(k, ok);
  return ok;
}

/**
 * Certificates found in `_id/cert` entries: parsed, shape-checked, and kept only
 * when the certificate sits in the subspace of the device it certifies (spec §5),
 * so nobody can plant certificates for someone else's key. Malformed ones are skipped.
 */
export function certsFrom(entries: { subspaceHex: string; payload: Uint8Array }[]): Cert[] {
  const out: Cert[] = [];
  for (const e of entries) {
    try {
      const c = JSON.parse(new TextDecoder().decode(e.payload)) as Cert;
      if (certShapeOk(c) && c.deviceKey === e.subspaceHex) out.push(c);
    } catch {}
  }
  return out;
}

/**
 * The person behind `deviceKeyHex` at time `at` (µs), or null. Revocations take
 * effect from their `at`; only the device itself or a trusted attestation key may
 * revoke a device (a stolen device cannot revoke its owner's others). A device
 * certified by another device is checked against its parent as of the moment the
 * parent issued the certificate, so retiring a laptop keeps the phones it paired
 * earlier. Malformed items are skipped, never fatal. Chains at most 8 deep, never
 * across people.
 */
export async function resolvePerson(deviceKeyHex: string, certs: Cert[], revocations: Revocation[], trust: Trust, at?: bigint): Promise<Person | null> {
  const goodCerts = certs.filter((c) => { try { return certShapeOk(c); } catch { return false; } });
  const goodRevs = revocations.filter((r) => { try { return revShapeOk(r); } catch { return false; } });

  const revoked = async (key: string, userId: string, t?: bigint): Promise<boolean> => {
    for (const r of goodRevs) {
      if (r.deviceKey !== key || r.userId !== userId) continue;
      if (t !== undefined && t < BigInt(r.at)) continue;
      if (r.by !== key && !trust.attestationKeys.includes(r.by)) continue;
      const { sig, ...rest } = r;
      if (await verifyMemo(r.by, revBody(rest), sig)) return true;
    }
    return false;
  };

  const walk = async (key: string, depth: number, t: bigint | undefined, seen: Set<string>): Promise<Person | null> => {
    if (depth > 8 || seen.has(key)) return null;
    const next = new Set(seen).add(key);
    for (const c of goodCerts) {
      if (c.deviceKey !== key) continue;
      let p: Person | null = null;
      try { p = await certPerson(c, depth, next); } catch { p = null; }
      if (p && !(await revoked(key, p.userId, t))) return p;
    }
    return null;
  };

  const certPerson = async (c: Cert, depth: number, seen: Set<string>): Promise<Person | null> => {
    const { sig, ...rest } = c;
    if (c.issuer.type === "attestation") {
      if (!trust.attestationKeys.includes(c.issuer.key)) return null;
      return (await verifyMemo(c.issuer.key, body(rest), sig)) ? { userId: c.userId, strength: "attested" } : null;
    }
    if (c.issuer.type === "device") {
      if (!(await verifyMemo(c.issuer.key, body(rest), sig))) return null;
      const parent = await walk(c.issuer.key, depth + 1, BigInt(c.issuedAt), seen);
      return parent && parent.userId === c.userId ? parent : null;
    }
    const w = c.issuer;
    if (!w.message.split(/\r?\n/).includes(`aindrive device: ed25519:${c.deviceKey}`)) return null;
    if ((await trust.verifyWallet(w.message, w.signature))?.toLowerCase() !== w.address) return null;
    if (w.link.address !== w.address || w.link.userId !== c.userId || !(await linkOk(w.link, trust))) return null;
    return { userId: c.userId, strength: "wallet" };
  };

  return walk(deviceKeyHex, 0, at, new Set());
}

export const certBytes = (c: Cert) => utf8(JSON.stringify(c));
