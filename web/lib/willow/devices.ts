// The devices that write in a person's name (plan 4): listed from the certificates
// in the server's per-drive stores, and removed with a revocation signed by aindrive's
// attestation key, written into every drive store where the device is known. Sync
// carries it to every peer; resolvePerson refuses the device's entries from then on.
import { db } from "@/lib/db.js";
import { certsIn } from "@/shared/willow/doc";
import { resolvePerson, revokeAttested } from "@/shared/willow/cert";
import { fromHex, pathOf, utf8 } from "@/shared/willow/bytes";
import { nowMicros } from "@/shared/willow/schemes";
import { openDriveStore } from "./store-node";
import { storeDir } from "./peer";
import { attestationKey, trust } from "./attestation";
import { isRevoked, recordRevocation } from "./revocations";
export { isRevoked } from "./revocations";

export type Device = { deviceKey: string; label: string; issuedAt: string; strength: "wallet" | "attested" | "unverified"; revoked: boolean; drives: string[] };

function drivesOf(userId: string): string[] {
  const own = db.prepare("SELECT id FROM drives WHERE owner_id = ?").all(userId) as { id: string }[];
  const member = db.prepare("SELECT DISTINCT drive_id AS id FROM drive_members WHERE user_id = ?").all(userId) as { id: string }[];
  return [...new Set([...own, ...member].map((r) => r.id))];
}

export async function listDevices(userId: string): Promise<Device[]> {
  const byKey = new Map<string, Device>();
  for (const driveId of drivesOf(userId)) {
    const store = openDriveStore(driveId, storeDir());
    const certs = await certsIn(store);
    for (const c of certs.filter((c) => c.userId === userId)) {
      let d = byKey.get(c.deviceKey);
      if (!d) {
        const ever = await resolvePerson(c.deviceKey, certs, [], trust());
        d = { deviceKey: c.deviceKey, label: c.label, issuedAt: c.issuedAt, strength: ever?.strength ?? "unverified", revoked: isRevoked(userId, c.deviceKey), drives: [] };
        byKey.set(c.deviceKey, d);
      }
      d.drives.push(driveId);
    }
  }
  return [...byKey.values()];
}

export async function revokeDevice(userId: string, deviceKeyHex: string): Promise<{ drives: string[]; failed: string[] }> {
  const device = (await listDevices(userId)).find((d) => d.deviceKey === deviceKeyHex);
  if (!device) throw new Error("not your device");
  const att = attestationKey();
  const at = nowMicros();
  if (!recordRevocation(userId, deviceKeyHex, at)) throw new Error("already removed"); // review M2: never re-stamp a revocation later
  const r = await revokeAttested(att, fromHex(deviceKeyHex), userId, at);
  const failed: string[] = [];
  for (const driveId of device.drives) {
    // written in the attestation key's own subspace; peers verify the revocation's signature.
    // One drive failing does not stop the others (review M3); the central record covers it anyway.
    try {
      const res = await openDriveStore(driveId, storeDir()).set({ path: pathOf(["_id", "revoke", deviceKeyHex]), subspace: att.publicKey, payload: utf8(JSON.stringify(r)) }, att);
      if (res.kind !== "success") failed.push(driveId);
    } catch { failed.push(driveId); }
  }
  return { drives: device.drives, failed };
}
