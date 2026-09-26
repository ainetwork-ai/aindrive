// web/lib/__tests__/willow-peer.test.ts
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";
process.env.AINDRIVE_DATA_DIR = mkdtempSync(join(tmpdir(), "aindrive-peer-"));
const roles: Record<string, string> = { "u-ed": "editor", "u-view": "viewer" };
let paywalled = false;
// u-sub is a member only of notes/; paid/ is priced
const roleAt = (u: string | null, path: string) => (u === "u-sub" ? (path === "notes" || path.startsWith("notes/") ? "editor" : "none") : u ? roles[u] ?? "none" : "none");
vi.mock("@/lib/willow/roles", () => ({
  roleOf: (_d: string, u: string | null, path: string) => roleAt(u, path),
  isMember: (_d: string, u: string | null) => !!u && (u === "u-sub" || !!roles[u]),
  paywalled: (_d: string, _u: string | null, path: string) => paywalled || path.startsWith("paid/"),
}));
const { acceptFor, allowFor, onWillowSync } = await import("../willow/peer");
const { certify } = await import("../willow/attestation");
const { openDriveStore } = await import("../willow/store-node");
const { generateDeviceKey } = await import("@/shared/willow/keys");
const { toHex, pathOf, utf8 } = await import("@/shared/willow/bytes");
const { revoke } = await import("@/shared/willow/cert");
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

  it("lets a path-scoped member connect (no 4401) and closes a non-member", async () => {
    const codes: number[] = [];
    const ws = () => ({ close: (c: number) => codes.push(c), on: () => {}, readyState: 1, OPEN: 1, send: () => {} });
    await onWillowSync(ws() as never, {} as never, { drive: "d" }, "u-sub");
    await onWillowSync(ws() as never, {} as never, { drive: "d" }, "u-stranger");
    expect(codes).toEqual([4401]);
  });

  it("allowFor sends a member only docs under their paths, never paid ones, always certificates", async () => {
    const e = (parts: string[]) => ({ path: pathOf(parts) }) as never;
    const allowSub = allowFor("d", "u-sub");
    expect(allowSub(e(["doc", "notes", "a.md", "~u", "1"]))).toBe(true);
    expect(allowSub(e(["doc", "other.md", "~u", "1"]))).toBe(false);
    expect(allowSub(e(["_id", "cert"]))).toBe(true);
    const allowEd = allowFor("d", "u-ed");
    expect(allowEd(e(["doc", "paid", "x.md", "~u", "1"]))).toBe(false);
    expect(allowEd(e(["doc", "free.md", "~u", "1"]))).toBe(true);
  });

  it("accepts a device's own revocation and refuses one for another device", async () => {
    const store = openDriveStore("d", process.env.AINDRIVE_DATA_DIR!);
    const kp = await withCert(store, "u-ed");
    const other = await generateDeviceKey();
    const s = newStore("d");
    const put = async (target: Uint8Array) => {
      const r = await revoke(kp, target, "u-ed", 5n);
      const payload = utf8(JSON.stringify(r));
      const x = await s.set({ path: pathOf(["_id", "revoke", toHex(target)]), subspace: kp.publicKey, payload }, kp);
      if (x.kind !== "success") throw new Error("setup");
      return acceptFor("d", store)({ entry: x.entry, token: x.authToken, payload });
    };
    expect(await put(kp.publicKey)).toBeNull();
    expect(await put(other.publicKey)).not.toBeNull();
  });
});
