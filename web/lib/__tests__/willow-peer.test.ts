// web/lib/__tests__/willow-peer.test.ts
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";
process.env.AINDRIVE_DATA_DIR = mkdtempSync(join(tmpdir(), "aindrive-peer-"));
const roles: Record<string, string> = { "u-ed": "editor", "u-view": "viewer" };
let paywalled = false;
vi.mock("@/lib/willow/roles", () => ({ roleOf: (_d: string, u: string | null) => (u ? roles[u] ?? "none" : "none"), blockedByPaywall: () => paywalled }));
const { acceptFor, onWillowSync } = await import("../willow/peer");
const { certify } = await import("../willow/attestation");
const { openDriveStore } = await import("../willow/store-node");
const { generateDeviceKey } = await import("@/shared/willow/keys");
const { toHex, pathOf, utf8 } = await import("@/shared/willow/bytes");
const { newStore } = await import("@/shared/willow/schemes");

async function signedDoc(kp: Awaited<ReturnType<typeof generateDeviceKey>>) {
  const s = newStore("d");
  const d = new Y.Doc(); d.getText("content").insert(0, "x");
  const r = await s.set({ path: pathOf(["doc", "a.md", "~u", "000000000001"]), subspace: kp.publicKey, payload: Y.encodeStateAsUpdate(d) }, kp);
  if (r.kind !== "success") throw new Error("setup");
  return { entry: r.entry, token: r.authToken, payload: Y.encodeStateAsUpdate(d) };
}

async function withCert(store: ReturnType<typeof openDriveStore>, userId: string) {
  const kp = await generateDeviceKey();
  const cert = await certify(userId, toHex(kp.publicKey), "t");
  const r = await store.set({ path: pathOf(["_id", "cert"]), subspace: kp.publicKey, payload: utf8(JSON.stringify(cert)) }, kp);
  if (r.kind !== "success") throw new Error("cert setup");
  return kp;
}

describe("server peer ingest check", () => {
  it("accepts an editor's doc entry", async () => {
    const store = openDriveStore("d", process.env.AINDRIVE_DATA_DIR!);
    const kp = await withCert(store, "u-ed");
    expect(await acceptFor("d", store)(await signedDoc(kp))).toBeNull();
  });
  it("refuses a viewer's doc entry", async () => {
    const store = openDriveStore("d", process.env.AINDRIVE_DATA_DIR!);
    const kp = await withCert(store, "u-view");
    expect(await acceptFor("d", store)(await signedDoc(kp))).toBe("not-a-member");
  });
  it("refuses a doc entry from a device with no certificate", async () => {
    const store = openDriveStore("d", process.env.AINDRIVE_DATA_DIR!);
    expect(await acceptFor("d", store)(await signedDoc(await generateDeviceKey()))).toBe("unknown-device");
  });
  it("refuses a cert entry naming another device key", async () => {
    const store = openDriveStore("d", process.env.AINDRIVE_DATA_DIR!);
    const kp = await generateDeviceKey();
    const other = await generateDeviceKey();
    const cert = await certify("u-ed", toHex(other.publicKey), "t");
    const s = newStore("d");
    const r = await s.set({ path: pathOf(["_id", "cert"]), subspace: kp.publicKey, payload: utf8(JSON.stringify(cert)) }, kp);
    if (r.kind !== "success") throw new Error("setup");
    expect(await acceptFor("d", store)({ entry: r.entry, token: r.authToken, payload: utf8(JSON.stringify(cert)) })).toBe("bad-cert");
  });

  it("closes the socket with 4402 when a priced path is closed to the user", async () => {
    paywalled = true;
    let code = 0;
    const ws = { close: (c: number) => { code = c; }, on: () => {}, readyState: 1, OPEN: 1, send: () => {} };
    await onWillowSync(ws as never, {} as never, { drive: "d" }, "u-view");
    expect(code).toBe(4402);
    paywalled = false;
  });
});
