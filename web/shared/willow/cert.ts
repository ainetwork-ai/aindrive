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

/**
 * The person behind `deviceKeyHex` at time `at` (µs; default: ignore revocations
 * after "now" = all of them apply), or null. Chains through device-issued certs
 * (max depth 8), never across people.
 */
export async function resolvePerson(deviceKeyHex: string, certs: Cert[], revocations: Revocation[], trust: Trust, at?: bigint): Promise<Person | null> {
  const seen = new Set<string>();
  const walk = async (key: string, depth: number): Promise<Person | null> => {
    if (depth > 8 || seen.has(key)) return null;
    seen.add(key);
    for (const c of certs.filter((c) => c.deviceKey === key)) {
      const p = await certPerson(c, depth);
      if (p && !(await revokedAt(key, p.userId, at))) return p;
    }
    return null;
  };
  const certPerson = async (c: Cert, depth: number): Promise<Person | null> => {
    const { sig, ...rest } = c;
    if (c.issuer.type === "attestation") {
      if (!trust.attestationKeys.includes(c.issuer.key)) return null;
      return (await verify(fromHex(c.issuer.key), body(rest), fromHex(sig))) ? { userId: c.userId, strength: "attested" } : null;
    }
    if (c.issuer.type === "device") {
      if (!(await verify(fromHex(c.issuer.key), body(rest), fromHex(sig)))) return null;
      const parent = await walk(c.issuer.key, depth + 1);
      return parent && parent.userId === c.userId ? parent : null;
    }
    const w = c.issuer;
    if (!w.message.split("\n").includes(`aindrive device: ed25519:${c.deviceKey}`)) return null;
    if ((await trust.verifyWallet(w.message, w.signature))?.toLowerCase() !== w.address) return null;
    if (w.link.address !== w.address || w.link.userId !== c.userId || !(await linkOk(w.link, trust))) return null;
    return { userId: c.userId, strength: "wallet" };
  };
  const revokedAt = async (key: string, userId: string, t?: bigint): Promise<boolean> => {
    for (const r of revocations.filter((r) => r.deviceKey === key && r.userId === userId)) {
      if (t !== undefined && t < BigInt(r.at)) continue;
      const { sig, ...rest } = r;
      if (!(await verify(fromHex(r.by), revBody(rest), fromHex(sig)))) continue;
      if (r.by === key) return true; // a device may retire itself
      const byPerson = await resolveNoRevoke(r.by);
      if (byPerson?.userId === userId) return true;
    }
    return false;
  };
  // the revoker's own standing is checked without revocations, so two devices cannot lock each other out in a loop
  const resolveNoRevoke = (key: string) => resolvePerson(key, certs, [], trust);
  return walk(deviceKeyHex, 0);
}

export const certBytes = (c: Cert) => utf8(JSON.stringify(c));
