import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.AINDRIVE_DATA_DIR = mkdtempSync(join(tmpdir(), "aindrive-devices-"));
const { db } = await import("../db.js");
const { createDrive } = await import("../drives");
const { listDevices, revokeDevice, isRevoked } = await import("../willow/devices");
const { certify, trust } = await import("../willow/attestation");
const { openDriveStore, closeDriveStores } = await import("../willow/store-node");
const { storeDir } = await import("../willow/peer");
const { generateDeviceKey } = await import("@/shared/willow/keys");
const { pathOf, toHex, utf8 } = await import("@/shared/willow/bytes");
const { certsIn, revocationsIn } = await import("@/shared/willow/doc");
const { resolvePerson } = await import("@/shared/willow/cert");
const { nowMicros } = await import("@/shared/willow/schemes");

db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?,?,?,?)").run("mom", "m@x.com", "Mom", "x");
db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?,?,?,?)").run("kid", "k@x.com", "Kid", "x");
const d1 = await createDrive("mom", "A");
const d2 = await createDrive("mom", "B");

async function deviceIn(driveIds: string[], userId: string, label: string) {
  const kp = await generateDeviceKey();
  const cert = await certify(userId, toHex(kp.publicKey), label);
  for (const d of driveIds) {
    const r = await openDriveStore(d, storeDir()).set({ path: pathOf(["_id", "cert"]), subspace: kp.publicKey, payload: utf8(JSON.stringify(cert)) }, kp);
    if (r.kind !== "success") throw new Error("setup");
  }
  return kp;
}

describe("devices", () => {
  it("lists my devices across drives, once each", async () => {
    await deviceIn([d1.driveId, d2.driveId], "mom", "Mom's laptop");
    await deviceIn([d1.driveId], "mom", "Mom's phone");
    const list = await listDevices("mom");
    expect(list.map((d) => d.label).sort()).toEqual(["Mom's laptop", "Mom's phone"]);
    expect(list.find((d) => d.label === "Mom's laptop")!.drives.sort()).toEqual([d1.driveId, d2.driveId].sort());
    expect(list.every((d) => d.strength === "attested" && !d.revoked)).toBe(true);
  });

  it("revoking a device writes the revocation into every drive it is known in; new entries resolve to nobody", async () => {
    const kp = await deviceIn([d1.driveId, d2.driveId], "mom", "lost phone");
    await revokeDevice("mom", toHex(kp.publicKey));
    for (const d of [d1.driveId, d2.driveId]) {
      const s = openDriveStore(d, storeDir());
      expect(await resolvePerson(toHex(kp.publicKey), await certsIn(s), await revocationsIn(s), trust(), nowMicros() + 1n)).toBeNull();
    }
    expect((await listDevices("mom")).find((d) => d.label === "lost phone")!.revoked).toBe(true);
  });

  it("review I1: a removed device is refused a new certificate and a place in another drive; revoking twice is refused", async () => {
    const kp = await deviceIn([d1.driveId], "mom", "stolen");
    await revokeDevice("mom", toHex(kp.publicKey));
    expect(isRevoked("mom", toHex(kp.publicKey))).toBe(true);
    const { acceptFor } = await import("../willow/peer");
    const cert = await certify("mom", toHex(kp.publicKey), "again");
    const { newStore } = await import("@/shared/willow/schemes");
    const r = await newStore(d2.driveId).set({ path: pathOf(["_id", "cert"]), subspace: kp.publicKey, payload: utf8(JSON.stringify(cert)) }, kp);
    if (r.kind !== "success") throw new Error("setup");
    expect(await acceptFor(d2.driveId, openDriveStore(d2.driveId, storeDir()))({ entry: r.entry, token: r.authToken, payload: utf8(JSON.stringify(cert)) })).toBe("revoked");
    await expect(revokeDevice("mom", toHex(kp.publicKey))).rejects.toThrow(/already/);
  });

  it("refuses to revoke someone else's device", async () => {
    const theirs = await deviceIn([d1.driveId], "kid", "kid's tablet");
    await expect(revokeDevice("mom", toHex(theirs.publicKey))).rejects.toThrow(/not your device/);
    closeDriveStores();
  });
});
