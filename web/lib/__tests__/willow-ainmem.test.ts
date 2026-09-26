// web/lib/__tests__/willow-ainmem.test.ts
// ainmem's signed transactions in a drive's store (ainmem docs/willow-ainmem-plan.md Task 3):
// ["ainmem", teamspace, page, tx] entries, accepted from a teamspace member whose ainmem
// server hands them in on behalf of someone who may write to the drive.
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.AINDRIVE_DATA_DIR = mkdtempSync(join(tmpdir(), "aindrive-ainmem-"));
const roles: Record<string, string> = { "u-owner": "owner", "u-ed": "editor", "u-view": "viewer" };
vi.mock("@/lib/willow/roles", () => ({
  roleOf: (_d: string, u: string | null) => (u ? roles[u] ?? "none" : "none"),
  isMember: (_d: string, u: string | null) => !!u && !!roles[u],
  paywalled: () => false,
}));
const { acceptFor, allowFor } = await import("../willow/peer");
const { ingestEntries, ainmemAuthors } = await import("../willow/ainmem");
const { certify, attestationKey } = await import("../willow/attestation");
const { openDriveStore } = await import("../willow/store-node");
const { storeDir } = await import("../willow/peer");
const { generateDeviceKey } = await import("@/shared/willow/keys");
const { toHex, pathOf, utf8, fromHex } = await import("@/shared/willow/bytes");
const { revokeAttested } = await import("@/shared/willow/cert");
const { newStore } = await import("@/shared/willow/schemes");
const { encodeEntry } = await import("@/shared/willow/wire");

type KP = Awaited<ReturnType<typeof generateDeviceKey>>;

/** A device of `userId` and the wire JSON of its `_id/cert` entry, signed outside the drive store. */
async function device(userId: string) {
  const kp = await generateDeviceKey();
  const cert = await certify(userId, toHex(kp.publicKey), "ainmem browser");
  const s = newStore("dA");
  const payload = utf8(JSON.stringify(cert));
  const r = await s.set({ path: pathOf(["_id", "cert"]), subspace: kp.publicKey, payload }, kp);
  if (r.kind !== "success") throw new Error("cert setup");
  return { kp, certWire: encodeEntry({ entry: r.entry, token: r.authToken, payload }) };
}

async function txEntry(kp: KP, parts: string[], body: unknown = { id: parts[3], ops: [] }) {
  const s = newStore("dA");
  const payload = utf8(JSON.stringify(body));
  const r = await s.set({ path: pathOf(parts), subspace: kp.publicKey, payload }, kp);
  if (r.kind !== "success") throw new Error("tx setup");
  return { wire: encodeEntry({ entry: r.entry, token: r.authToken, payload }), w: { entry: r.entry, token: r.authToken, payload } };
}

const TX = (tx: string) => ["ainmem", "ts-1", "page-1", tx];

describe("ainmem entries in a drive's store", () => {
  it("accepts a stranger's entry only when an editor of the drive vouches for it", async () => {
    const store = openDriveStore("dA", storeDir());
    const { kp, certWire } = await device("u-stranger");
    expect(await ingestEntries("dA", "u-ed", [certWire])).toEqual([null]);
    const { w } = await txEntry(kp, TX("t1"));
    expect(await acceptFor("dA", store)(w)).toBe("not-a-member");
    expect(await acceptFor("dA", store, { vouchedBy: "u-view" })(w)).toBe("not-a-member");
    expect(await acceptFor("dA", store, { vouchedBy: "u-ed" })(w)).toBeNull();
  });

  it("ingests a vouched batch (cert first) and reports each entry", async () => {
    const { kp, certWire } = await device("u-mom");
    const a = await txEntry(kp, TX("t2"));
    const bad = await txEntry(kp, ["ainmem", "ts-1", "page-1", "t3", "extra"]);
    const doc = await txEntry(kp, ["doc", "a.md", "~u", "000000000001"]);
    expect(await ingestEntries("dA", "u-ed", [certWire, a.wire, bad.wire, doc.wire])).toEqual([null, null, "outside-grant", "outside-grant"]);
  });

  it("refuses a device with no certificate and a revoked device", async () => {
    const lone = await generateDeviceKey();
    expect(await ingestEntries("dA", "u-ed", [(await txEntry(lone, TX("t4"))).wire])).toEqual(["unknown-device"]);

    const store = openDriveStore("dA", storeDir());
    const { kp, certWire } = await device("u-gone");
    await ingestEntries("dA", "u-ed", [certWire]);
    const att = attestationKey();
    const r = await revokeAttested(att, kp.publicKey, "u-gone", BigInt(Date.now()) * 1000n - 1000n);
    await store.set({ path: pathOf(["_id", "revoke", toHex(kp.publicKey)]), subspace: att.publicKey, payload: utf8(JSON.stringify(r)) }, att);
    expect(await ingestEntries("dA", "u-ed", [(await txEntry(kp, TX("t5"))).wire])).toEqual(["revoked"]);
  });

  it("refuses a caller who cannot write to the drive, and a malformed entry", async () => {
    const { certWire } = await device("u-x");
    expect(await ingestEntries("dA", "u-view", [certWire])).toEqual(["not-a-member"]);
    expect(await ingestEntries("dA", "u-ed", [{ nope: 1 }])).toEqual(["malformed"]);
  });

  it("sends ainmem entries to viewers of the drive, not to strangers", () => {
    const e = { path: pathOf(TX("t6")) };
    expect(allowFor("dA", "u-view")(e)).toBe(true);
    expect(allowFor("dA", "u-none")(e)).toBe(false);
  });

  it("names the signer of each transaction of a page", async () => {
    const { db } = await import("@/lib/db.js");
    db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?,?,?,?)").run("u-dad", "dad@example.com", "name-of-u-dad", "x");
    const { kp, certWire } = await device("u-dad");
    const t = await txEntry(kp, ["ainmem", "ts-9", "page-9", "tx-dad"]);
    await ingestEntries("dA", "u-ed", [certWire, t.wire]);
    const authors = await ainmemAuthors("dA", "ts-9", "page-9");
    expect(authors).toEqual([expect.objectContaining({ tx: "tx-dad", userId: "u-dad", name: "name-of-u-dad", strength: "attested", device: toHex(kp.publicKey) })]);
    expect(fromHex(authors[0].device)).toEqual(kp.publicKey);
  });
});
