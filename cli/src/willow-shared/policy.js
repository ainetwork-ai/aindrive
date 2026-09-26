// GENERATED from web/shared/willow/policy.ts by web/scripts/mirror-willow-to-cli.mjs — do not edit.
import { canonicalJson, fromHex, toHex } from "./bytes.js";
import { sign, verify } from "./keys.js";
import { resolvePerson } from "./cert.js";
const grantBody = (g) => canonicalJson({ kind: "aindrive-grant", ...g });
const WRITE = ["editor", "owner"];
async function signGrant(signer, issuerType, g) {
  const full = { v: 1, ...g, issuer: { type: issuerType, key: toHex(signer.publicKey) } };
  return { ...full, sig: toHex(await sign(signer, grantBody(full))) };
}
const isPrefix = (prefix, path) => prefix.length <= path.length && prefix.every((c, i) => path[i] === c);
const ID_MAX = 4096n;
const HEX64 = /^[0-9a-f]{64}$/;
const later = (a, b) => b !== void 0 && b > a ? b : a;
async function grantValid(g, ctx) {
  try {
    if (g.driveId !== ctx.driveId) return false;
    const { sig, ...rest } = g;
    if (!await verify(fromHex(g.issuer.key), grantBody(rest), fromHex(sig))) return false;
    if (g.issuer.type === "attestation") return ctx.trust.attestationKeys.includes(g.issuer.key);
    const issuer = await resolvePerson(g.issuer.key, ctx.certs, ctx.revocations, ctx.trust, later(BigInt(g.issuedAt), ctx.now));
    return issuer?.userId === ctx.ownerUserId;
  } catch {
    return false;
  }
}
async function mayWrite(e, ctx) {
  const [head, ...rest] = e.path;
  const t = later(e.timestamp, ctx.now);
  if (head === "_id") {
    const cert = rest.length === 1 && rest[0] === "cert";
    const rev = rest.length === 2 && rest[0] === "revoke" && HEX64.test(rest[1]);
    if (!cert && !rev) return { ok: false, reason: "outside-grant" };
    if (e.payloadLength !== void 0 && e.payloadLength > ID_MAX) return { ok: false, reason: "outside-grant" };
    if (cert && e.cert) {
      if (e.cert.deviceKey !== e.subspaceHex) return { ok: false, reason: "unknown-device" };
      if (e.cert.issuer?.type === "device" && !await resolvePerson(e.cert.issuer.key, ctx.certs, ctx.revocations, ctx.trust, t))
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
      if (!await grantValid(g, ctx)) continue;
      member = true;
      if (isPrefix(g.pathPrefix, docPath)) return { ok: true, person: now };
    } catch {
      continue;
    }
  }
  return { ok: false, reason: member ? "outside-grant" : "not-a-member" };
}
export {
  mayWrite,
  signGrant
};
