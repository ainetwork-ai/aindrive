// Findings from the whole-branch review of the Willow foundation, each pinned.
import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import { generateDeviceKey } from "@/shared/willow/keys";
import { toHex, pathOf } from "@/shared/willow/bytes";
import { newStore } from "@/shared/willow/schemes";
import { issueAttestedCert, issueDeviceCert, revoke, revokeAttested, resolvePerson, certsFrom, type Trust, type Cert } from "@/shared/willow/cert";
import { signGrant, mayWrite, type PolicyCtx } from "@/shared/willow/policy";
import { appendUpdate, loadDoc, authorsByClient, clientClaimConflict } from "@/shared/willow/doc";

const T0 = 1_000_000n;
async function base() {
  const aindrive = await generateDeviceKey();
  const trust: Trust = { attestationKeys: [toHex(aindrive.publicKey)], verifyWallet: async () => null };
  const laptop = await generateDeviceKey();
  const phone = await generateDeviceKey();
  const cL = await issueAttestedCert(aindrive, laptop.publicKey, "u-mom", "laptop", T0);
  const cP = await issueAttestedCert(aindrive, phone.publicKey, "u-mom", "phone", T0);
  return { aindrive, trust, laptop, phone, certs: [cL, cP] };
}
const docEntry = (dev: { publicKey: Uint8Array }, t: bigint) => ({ subspaceHex: toHex(dev.publicKey), path: ["doc", "a.md", "~u", "1"], timestamp: t });

describe("review C1: a stolen device cannot revoke its owner's other devices", () => {
  it("a revocation of the laptop signed by the phone is ignored", async () => {
    const w = await base();
    const byPhone = await revoke(w.phone, w.laptop.publicKey, "u-mom", 0n);
    expect(await resolvePerson(toHex(w.laptop.publicKey), w.certs, [byPhone], w.trust, T0 + 50n)).not.toBeNull();
  });
  it("aindrive's attestation key can revoke a device, and a device can retire itself", async () => {
    const w = await base();
    const byAindrive = await revokeAttested(w.aindrive, w.phone.publicKey, "u-mom", T0 + 100n);
    expect(await resolvePerson(toHex(w.phone.publicKey), w.certs, [byAindrive], w.trust, T0 + 150n)).toBeNull();
    const self = await revoke(w.laptop, w.laptop.publicKey, "u-mom", T0 + 100n);
    expect(await resolvePerson(toHex(w.laptop.publicKey), w.certs, [self], w.trust, T0 + 150n)).toBeNull();
  });
});

describe("review I1: backdating does not get past a revocation or an expiry", () => {
  it("a revoked device's new entry stamped before the revocation is refused at ingest", async () => {
    const w = await base();
    const r = await revokeAttested(w.aindrive, w.phone.publicKey, "u-mom", T0 + 100n);
    const ctx: PolicyCtx = { driveId: "d", ownerUserId: "u-mom", grants: [], certs: w.certs, revocations: [r], trust: w.trust, now: T0 + 200n };
    expect(await mayWrite(docEntry(w.phone, T0 + 99n), ctx)).toEqual({ ok: false, reason: "revoked" });
  });
  it("an expired grant cannot be used with a backdated entry", async () => {
    const w = await base();
    const kid = await generateDeviceKey();
    const cK = await issueAttestedCert(w.aindrive, kid.publicKey, "u-kid", "kid", T0);
    const g = await signGrant(w.laptop, "device", { driveId: "d", userId: "u-kid", role: "editor", pathPrefix: [], issuedAt: T0.toString(), expiresAt: (T0 + 20n).toString() });
    const ctx: PolicyCtx = { driveId: "d", ownerUserId: "u-mom", grants: [g], certs: [...w.certs, cK], revocations: [], trust: w.trust, now: T0 + 30n };
    expect((await mayWrite(docEntry(kid, T0 + 10n), ctx)).ok).toBe(false);
  });
});

describe("review I2: retiring a device keeps the devices it paired earlier", () => {
  it("a phone paired at t=2 by a laptop that retires at t=100 still resolves at t=200", async () => {
    const w = await base();
    const tablet = await generateDeviceKey();
    const cT = await issueDeviceCert(w.laptop, tablet.publicKey, "u-mom", "tablet", T0 + 2n);
    const retire = await revoke(w.laptop, w.laptop.publicKey, "u-mom", T0 + 100n);
    expect(await resolvePerson(toHex(tablet.publicKey), [...w.certs, cT], [retire], w.trust, T0 + 200n)).toEqual({ userId: "u-mom", strength: "attested" });
  });
  it("a device cert issued by a currently revoked device is refused at ingest", async () => {
    const w = await base();
    const r = await revokeAttested(w.aindrive, w.phone.publicKey, "u-mom", T0 + 100n);
    const evil = await generateDeviceKey();
    const cE = await issueDeviceCert(w.phone, evil.publicKey, "u-mom", "evil", T0 + 50n); // backdated
    const ctx: PolicyCtx = { driveId: "d", ownerUserId: "u-mom", grants: [], certs: w.certs, revocations: [r], trust: w.trust, now: T0 + 200n };
    expect((await mayWrite({ subspaceHex: toHex(evil.publicKey), path: ["_id", "cert"], timestamp: T0 + 50n, cert: cE }, ctx)).ok).toBe(false);
  });
});

describe("review I3: malformed certificates, revocations and grants are skipped, not fatal", () => {
  it("a junk cert naming the victim does not break resolving the victim", async () => {
    const w = await base();
    const junk = { v: 1, deviceKey: toHex(w.laptop.publicKey), userId: "u-mom", label: "x", issuedAt: "zz", issuer: { type: "device", key: "q" }, sig: "q" } as unknown as Cert;
    const junkRev = { v: 1, deviceKey: toHex(w.laptop.publicKey), userId: "u-mom", at: "nope", by: "q", sig: "q" } as never;
    expect(await resolvePerson(toHex(w.laptop.publicKey), [junk, ...w.certs], [junkRev], w.trust)).not.toBeNull();
    const badGrant = { v: 1, driveId: "d", userId: "u-x", role: "editor", pathPrefix: [], issuedAt: "x", expiresAt: "y", issuer: { type: "device", key: "q" }, sig: "q" } as never;
    const ctx: PolicyCtx = { driveId: "d", ownerUserId: "u-mom", grants: [badGrant], certs: w.certs, revocations: [], trust: w.trust };
    expect((await mayWrite(docEntry(w.laptop, T0 + 1n), ctx)).ok).toBe(true);
  });
});

describe("review I4: _id accepts only certificates and revocations, small, in the right subspace", () => {
  it("refuses other _id paths and oversized payloads", async () => {
    const w = await base();
    const ctx: PolicyCtx = { driveId: "d", ownerUserId: "u-mom", grants: [], certs: w.certs, revocations: [], trust: w.trust };
    const x = await generateDeviceKey();
    expect((await mayWrite({ subspaceHex: toHex(x.publicKey), path: ["_id", "junk"], timestamp: T0 }, ctx)).ok).toBe(false);
    expect((await mayWrite({ subspaceHex: toHex(x.publicKey), path: ["_id", "cert"], timestamp: T0, payloadLength: 100_000n }, ctx)).ok).toBe(false);
  });
  it("certsFrom keeps a cert only from the subspace of the device it certifies", async () => {
    const w = await base();
    const other = await generateDeviceKey();
    const enc = (c: Cert) => new TextEncoder().encode(JSON.stringify(c));
    const got = certsFrom([
      { subspaceHex: toHex(w.laptop.publicKey), payload: enc(w.certs[0]) },
      { subspaceHex: toHex(other.publicKey), payload: enc(w.certs[1]) }, // phone's cert sitting in someone else's subspace
      { subspaceHex: toHex(other.publicKey), payload: new TextEncoder().encode("not json") },
    ]);
    expect(got.map((c) => c.label)).toEqual(["laptop"]);
  });
});

function typed(clientId: number, text: string) { const d = new Y.Doc(); d.clientID = clientId; d.getText("content").insert(0, text); return Y.encodeStateAsUpdate(d); }

describe("review I5: a Yjs client id belongs to the first device that used it", () => {
  it("an update reusing another device's client id is flagged, and authorship stays with the first", async () => {
    const alice = await generateDeviceKey(), eve = await generateDeviceKey();
    const s = newStore("d");
    await appendUpdate(s, alice, ["a.md"], typed(7, "alice"), 1, T0);
    const forged = typed(7, "eve");
    expect(await clientClaimConflict(s, ["a.md"], toHex(eve.publicKey), forged)).toBe(true);
    expect(await clientClaimConflict(s, ["a.md"], toHex(alice.publicKey), typed(7, "more"))).toBe(false);
    await appendUpdate(s, eve, ["a.md"], forged, 1, T0 + 5n);
    expect((await authorsByClient(s, ["a.md"])).get(7)).toBe(toHex(alice.publicKey));
  });
});

describe("review I6: one corrupt update does not make the document unloadable", () => {
  it("skips a garbage update", async () => {
    const a = await generateDeviceKey(), b = await generateDeviceKey();
    const s = newStore("d");
    await appendUpdate(s, a, ["a.md"], typed(1, "good"), 1);
    await appendUpdate(s, b, ["a.md"], new Uint8Array([255, 1, 2, 3, 4, 5]), 1);
    expect((await loadDoc(s, ["a.md"])).getText("content").toString()).toBe("good");
    expect((await authorsByClient(s, ["a.md"])).get(1)).toBe(toHex(a.publicKey));
  });
});
