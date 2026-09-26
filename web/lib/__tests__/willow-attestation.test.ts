// web/lib/__tests__/willow-attestation.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.AINDRIVE_DATA_DIR = mkdtempSync(join(tmpdir(), "aindrive-att-"));
delete process.env.AINDRIVE_ATTESTATION_KEY;
const { attestationKey, certify, trust } = await import("../willow/attestation");
const { generateDeviceKey } = await import("@/shared/willow/keys");
const { resolvePerson } = await import("@/shared/willow/cert");
const { toHex } = await import("@/shared/willow/bytes");

describe("attestation", () => {
  it("creates one key and keeps it", () => {
    expect(toHex(attestationKey().publicKey)).toBe(toHex(attestationKey().publicKey));
  });
  it("certifies a device for a user, and peers trusting the key resolve it", async () => {
    const dev = await generateDeviceKey();
    const cert = await certify("u-1", toHex(dev.publicKey), "Chrome on Mac");
    expect(await resolvePerson(toHex(dev.publicKey), [cert], [], trust())).toEqual({ userId: "u-1", strength: "attested" });
  });
  it("refuses a malformed device key", async () => {
    await expect(certify("u-1", "zz", "x")).rejects.toThrow();
  });
});
