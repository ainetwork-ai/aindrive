// web/lib/__tests__/willow-cert.test.ts
import { describe, it, expect } from "vitest";
import { generateDeviceKey } from "@/shared/willow/keys";
import { toHex } from "@/shared/willow/bytes";
import {
  issueAttestedCert, issueDeviceCert, issueWalletCert, walletCertMessageLine, signLink, revoke, resolvePerson, type Trust,
} from "@/shared/willow/cert";

const T0 = 1_000_000n;

async function setup() {
  const aindrive = await generateDeviceKey();
  const trust: Trust = { attestationKeys: [toHex(aindrive.publicKey)], verifyWallet: async () => null };
  return { aindrive, trust };
}

describe("device certificates", () => {
  it("an attested device resolves to its person, marked attested", async () => {
    const { aindrive, trust } = await setup();
    const laptop = await generateDeviceKey();
    const cert = await issueAttestedCert(aindrive, laptop.publicKey, "u-mom", "Mom's laptop", T0);
    expect(await resolvePerson(toHex(laptop.publicKey), [cert], [], trust)).toEqual({ userId: "u-mom", strength: "attested" });
  });

  it("a paired device chains to the approving device's person", async () => {
    const { aindrive, trust } = await setup();
    const laptop = await generateDeviceKey();
    const phone = await generateDeviceKey();
    const c1 = await issueAttestedCert(aindrive, laptop.publicKey, "u-mom", "laptop", T0);
    const c2 = await issueDeviceCert(laptop, phone.publicKey, "u-mom", "phone", T0 + 1n);
    expect(await resolvePerson(toHex(phone.publicKey), [c1, c2], [], trust)).toEqual({ userId: "u-mom", strength: "attested" });
  });

  it("a device cannot vouch a device into someone else's account", async () => {
    const { aindrive, trust } = await setup();
    const eveLaptop = await generateDeviceKey();
    const evil = await generateDeviceKey();
    const c1 = await issueAttestedCert(aindrive, eveLaptop.publicKey, "u-eve", "eve", T0);
    const c2 = await issueDeviceCert(eveLaptop, evil.publicKey, "u-mom", "fake", T0 + 1n);
    expect(await resolvePerson(toHex(evil.publicKey), [c1, c2], [], trust)).toBeNull();
  });

  it("an unknown attestation key is not trusted", async () => {
    const { trust } = await setup();
    const rogue = await generateDeviceKey();
    const d = await generateDeviceKey();
    const c = await issueAttestedCert(rogue, d.publicKey, "u-mom", "x", T0);
    expect(await resolvePerson(toHex(d.publicKey), [c], [], trust)).toBeNull();
  });

  it("a wallet-signed cert is 'wallet' strength when the wallet and the link check out", async () => {
    const { aindrive } = await setup();
    const d = await generateDeviceKey();
    const message = `aindrive.ainetwork.ai wants you to sign in\n${walletCertMessageLine(d.publicKey)}`;
    const link = await signLink(aindrive, "0xabc", "u-mom");
    const trust: Trust = { attestationKeys: [toHex(aindrive.publicKey)], verifyWallet: async (m, s) => (m === message && s === "0xsig" ? "0xabc" : null) };
    const cert = issueWalletCert({ deviceKey: d.publicKey, userId: "u-mom", label: "browser", at: T0, address: "0xabc", message, signature: "0xsig", link });
    expect(await resolvePerson(toHex(d.publicKey), [cert], [], trust)).toEqual({ userId: "u-mom", strength: "wallet" });
    const other = issueWalletCert({ deviceKey: (await generateDeviceKey()).publicKey, userId: "u-mom", label: "b", at: T0, address: "0xabc", message, signature: "0xsig", link });
    expect(await resolvePerson(other.deviceKey, [other], [], trust)).toBeNull(); // the signed message names a different key
  });

  it("a revoked device stops resolving from the revocation time on, not before", async () => {
    const { aindrive, trust } = await setup();
    const laptop = await generateDeviceKey();
    const phone = await generateDeviceKey();
    const c1 = await issueAttestedCert(aindrive, laptop.publicKey, "u-mom", "laptop", T0);
    const c2 = await issueAttestedCert(aindrive, phone.publicKey, "u-mom", "phone", T0);
    const r = await revoke(laptop, phone.publicKey, "u-mom", T0 + 100n);
    expect(await resolvePerson(toHex(phone.publicKey), [c1, c2], [r], trust, T0 + 50n)).not.toBeNull();
    expect(await resolvePerson(toHex(phone.publicKey), [c1, c2], [r], trust, T0 + 100n)).toBeNull();
  });

  it("a revocation by another person's device is ignored", async () => {
    const { aindrive, trust } = await setup();
    const phone = await generateDeviceKey();
    const eve = await generateDeviceKey();
    const c = await issueAttestedCert(aindrive, phone.publicKey, "u-mom", "phone", T0);
    const ce = await issueAttestedCert(aindrive, eve.publicKey, "u-eve", "eve", T0);
    const r = await revoke(eve, phone.publicKey, "u-mom", T0 + 1n);
    expect(await resolvePerson(toHex(phone.publicKey), [c, ce], [r], trust, T0 + 2n)).not.toBeNull();
  });
});
