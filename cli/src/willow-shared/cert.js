// GENERATED from web/shared/willow/cert.ts by web/scripts/mirror-willow-to-cli.mjs — do not edit.
import { canonicalJson, fromHex, toHex, utf8 } from "./bytes.js";
import { sign, verify } from "./keys.js";
const body = (c) => canonicalJson({ kind: "aindrive-device-cert", ...c });
const linkBody = (address, userId) => canonicalJson({ kind: "aindrive-wallet-link", address: address.toLowerCase(), userId });
const revBody = (r) => canonicalJson({ kind: "aindrive-device-revocation", ...r });
const walletCertMessageLine = (deviceKey) => `aindrive device: ed25519:${toHex(deviceKey)}`;
async function issueSigned(signer, issuer, deviceKey, userId, label, at) {
  const c = { v: 1, deviceKey: toHex(deviceKey), userId, label, issuedAt: at.toString(), issuer };
  return { ...c, sig: toHex(await sign(signer, body(c))) };
}
const issueAttestedCert = (attestation, deviceKey, userId, label, at) => issueSigned(attestation, { type: "attestation", key: toHex(attestation.publicKey) }, deviceKey, userId, label, at);
const issueDeviceCert = (issuer, deviceKey, userId, label, at) => issueSigned(issuer, { type: "device", key: toHex(issuer.publicKey) }, deviceKey, userId, label, at);
async function signLink(attestation, address, userId) {
  return { address: address.toLowerCase(), userId, sig: toHex(await sign(attestation, linkBody(address, userId))) };
}
function issueWalletCert(p) {
  return {
    v: 1,
    deviceKey: toHex(p.deviceKey),
    userId: p.userId,
    label: p.label,
    issuedAt: p.at.toString(),
    issuer: { type: "wallet", address: p.address.toLowerCase(), message: p.message, signature: p.signature, link: p.link },
    sig: ""
  };
}
async function revoke(by, deviceKey, userId, at) {
  const r = { v: 1, deviceKey: toHex(deviceKey), userId, at: at.toString(), by: toHex(by.publicKey) };
  return { ...r, sig: toHex(await sign(by, revBody(r))) };
}
async function linkOk(link, trust) {
  for (const k of trust.attestationKeys) if (await verify(fromHex(k), linkBody(link.address, link.userId), fromHex(link.sig))) return true;
  return false;
}
async function revokeAttested(attestation, deviceKey, userId, at) {
  return revoke(attestation, deviceKey, userId, at);
}
const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;
const DEC = /^[0-9]{1,20}$/;
function certShapeOk(c) {
  if (!c || c.v !== 1 || typeof c.userId !== "string" || typeof c.label !== "string") return false;
  if (!HEX64.test(c.deviceKey) || !DEC.test(c.issuedAt)) return false;
  const i = c.issuer;
  if (!i) return false;
  if (i.type === "wallet") return typeof i.message === "string" && typeof i.signature === "string" && typeof i.address === "string" && !!i.link && HEX128.test(i.link.sig);
  return (i.type === "attestation" || i.type === "device") && HEX64.test(i.key) && HEX128.test(c.sig);
}
const revShapeOk = (r) => !!r && r.v === 1 && HEX64.test(r.deviceKey) && HEX64.test(r.by) && HEX128.test(r.sig) && DEC.test(r.at) && typeof r.userId === "string";
const verified = /* @__PURE__ */ new Map();
async function verifyMemo(keyHex, bodyBytes, sigHex) {
  const k = `${keyHex}|${sigHex}|${toHex(bodyBytes)}`;
  const hit = verified.get(k);
  if (hit !== void 0) return hit;
  const ok = await verify(fromHex(keyHex), bodyBytes, fromHex(sigHex));
  if (verified.size > 1e4) verified.clear();
  verified.set(k, ok);
  return ok;
}
function certsFrom(entries) {
  const out = [];
  for (const e of entries) {
    try {
      const c = JSON.parse(new TextDecoder().decode(e.payload));
      if (certShapeOk(c) && c.deviceKey === e.subspaceHex) out.push(c);
    } catch {
    }
  }
  return out;
}
async function resolvePerson(deviceKeyHex, certs, revocations, trust, at) {
  const goodCerts = certs.filter((c) => {
    try {
      return certShapeOk(c);
    } catch {
      return false;
    }
  });
  const goodRevs = revocations.filter((r) => {
    try {
      return revShapeOk(r);
    } catch {
      return false;
    }
  });
  const revoked = async (key, userId, t) => {
    for (const r of goodRevs) {
      if (r.deviceKey !== key || r.userId !== userId) continue;
      if (t !== void 0 && t < BigInt(r.at)) continue;
      if (r.by !== key && !trust.attestationKeys.includes(r.by)) continue;
      const { sig, ...rest } = r;
      if (await verifyMemo(r.by, revBody(rest), sig)) return true;
    }
    return false;
  };
  const walk = async (key, depth, t, seen) => {
    if (depth > 8 || seen.has(key)) return null;
    const next = new Set(seen).add(key);
    for (const c of goodCerts) {
      if (c.deviceKey !== key) continue;
      let p = null;
      try {
        p = await certPerson(c, depth, next);
      } catch {
        p = null;
      }
      if (p && !await revoked(key, p.userId, t)) return p;
    }
    return null;
  };
  const certPerson = async (c, depth, seen) => {
    const { sig, ...rest } = c;
    if (c.issuer.type === "attestation") {
      if (!trust.attestationKeys.includes(c.issuer.key)) return null;
      return await verifyMemo(c.issuer.key, body(rest), sig) ? { userId: c.userId, strength: "attested" } : null;
    }
    if (c.issuer.type === "device") {
      if (!await verifyMemo(c.issuer.key, body(rest), sig)) return null;
      const parent = await walk(c.issuer.key, depth + 1, BigInt(c.issuedAt), seen);
      return parent && parent.userId === c.userId ? parent : null;
    }
    const w = c.issuer;
    if (!w.message.split(/\r?\n/).includes(`aindrive device: ed25519:${c.deviceKey}`)) return null;
    if ((await trust.verifyWallet(w.message, w.signature))?.toLowerCase() !== w.address) return null;
    if (w.link.address !== w.address || w.link.userId !== c.userId || !await linkOk(w.link, trust)) return null;
    return { userId: c.userId, strength: "wallet" };
  };
  return walk(deviceKeyHex, 0, at, /* @__PURE__ */ new Set());
}
const certBytes = (c) => utf8(JSON.stringify(c));
export {
  certBytes,
  certsFrom,
  issueAttestedCert,
  issueDeviceCert,
  issueWalletCert,
  resolvePerson,
  revoke,
  revokeAttested,
  signLink,
  walletCertMessageLine
};
