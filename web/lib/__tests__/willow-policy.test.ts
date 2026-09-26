// web/lib/__tests__/willow-policy.test.ts
import { describe, it, expect } from "vitest";
import { generateDeviceKey } from "@/shared/willow/keys";
import { toHex } from "@/shared/willow/bytes";
import { issueAttestedCert, revoke, type Trust } from "@/shared/willow/cert";
import { signGrant, mayWrite, type PolicyCtx } from "@/shared/willow/policy";

const T0 = 1_000_000n;

async function world() {
  const aindrive = await generateDeviceKey();
  const trust: Trust = { attestationKeys: [toHex(aindrive.publicKey)], verifyWallet: async () => null };
  const momDev = await generateDeviceKey();
  const kidDev = await generateDeviceKey();
  const strangerDev = await generateDeviceKey();
  const certs = [
    await issueAttestedCert(aindrive, momDev.publicKey, "u-mom", "mom", T0),
    await issueAttestedCert(aindrive, kidDev.publicKey, "u-kid", "kid", T0),
    await issueAttestedCert(aindrive, strangerDev.publicKey, "u-x", "x", T0),
  ];
  const grant = await signGrant(momDev, "device", { driveId: "d", userId: "u-kid", role: "editor", pathPrefix: ["notes"], issuedAt: T0.toString() });
  const ctx: PolicyCtx = { driveId: "d", ownerUserId: "u-mom", grants: [grant], certs, revocations: [], trust };
  return { aindrive, momDev, kidDev, strangerDev, ctx };
}

const doc = (dev: { publicKey: Uint8Array }, path: string[], t = T0 + 10n) => ({ subspaceHex: toHex(dev.publicKey), path: ["doc", ...path, "~u", "1"], timestamp: t });

describe("mayWrite", () => {
  it("the owner writes anywhere", async () => {
    const w = await world();
    expect((await mayWrite(doc(w.momDev, ["a.md"]), w.ctx)).ok).toBe(true);
  });

  it("an editor writes inside the grant", async () => {
    const w = await world();
    expect(await mayWrite(doc(w.kidDev, ["notes", "a.md"]), w.ctx)).toEqual({ ok: true, person: { userId: "u-kid", strength: "attested" } });
  });

  it("a grant for notes/ does not cover notes-old/", async () => {
    const w = await world();
    expect(await mayWrite(doc(w.kidDev, ["notes-old", "a.md"]), w.ctx)).toEqual({ ok: false, reason: "outside-grant" });
  });

  it("a stranger is not a member", async () => {
    const w = await world();
    expect(await mayWrite(doc(w.strangerDev, ["notes", "a.md"]), w.ctx)).toEqual({ ok: false, reason: "not-a-member" });
  });

  it("an unknown device is refused", async () => {
    const w = await world();
    const ghost = await generateDeviceKey();
    expect(await mayWrite(doc(ghost, ["a.md"]), w.ctx)).toEqual({ ok: false, reason: "unknown-device" });
  });

  it("a revoked device: earlier edits accepted, later ones refused", async () => {
    const w = await world();
    const r = await revoke(w.kidDev, w.kidDev.publicKey, "u-kid", T0 + 100n);
    const ctx = { ...w.ctx, revocations: [r] };
    expect((await mayWrite(doc(w.kidDev, ["notes", "a.md"], T0 + 50n), ctx)).ok).toBe(true);
    expect(await mayWrite(doc(w.kidDev, ["notes", "a.md"], T0 + 150n), ctx)).toEqual({ ok: false, reason: "revoked" });
  });

  it("an expired grant stops counting", async () => {
    const w = await world();
    const g = await signGrant(w.momDev, "device", { driveId: "d", userId: "u-kid", role: "editor", pathPrefix: [], issuedAt: T0.toString(), expiresAt: (T0 + 20n).toString() });
    expect(await mayWrite(doc(w.kidDev, ["b.md"], T0 + 30n), { ...w.ctx, grants: [g] })).toEqual({ ok: false, reason: "not-a-member" });
  });

  it("a grant signed by a non-owner device is ignored", async () => {
    const w = await world();
    const g = await signGrant(w.kidDev, "device", { driveId: "d", userId: "u-x", role: "editor", pathPrefix: [], issuedAt: T0.toString() });
    expect(await mayWrite(doc(w.strangerDev, ["a.md"]), { ...w.ctx, grants: [g] })).toEqual({ ok: false, reason: "not-a-member" });
  });

  it("a viewer grant does not allow writing", async () => {
    const w = await world();
    const g = await signGrant(w.momDev, "device", { driveId: "d", userId: "u-x", role: "viewer", pathPrefix: [], issuedAt: T0.toString() });
    expect(await mayWrite(doc(w.strangerDev, ["a.md"]), { ...w.ctx, grants: [g] })).toEqual({ ok: false, reason: "not-a-member" });
  });

  it("only the owner's devices write _acl entries; _id entries are always accepted", async () => {
    const w = await world();
    const acl = (dev: { publicKey: Uint8Array }) => ({ subspaceHex: toHex(dev.publicKey), path: ["_acl", "u-kid"], timestamp: T0 + 1n });
    expect((await mayWrite(acl(w.momDev), w.ctx)).ok).toBe(true);
    expect((await mayWrite(acl(w.kidDev), w.ctx)).ok).toBe(false);
    const ghost = await generateDeviceKey();
    expect((await mayWrite({ subspaceHex: toHex(ghost.publicKey), path: ["_id", "cert"], timestamp: T0 }, w.ctx)).ok).toBe(true);
  });
});
