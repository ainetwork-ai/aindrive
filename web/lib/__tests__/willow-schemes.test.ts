// web/lib/__tests__/willow-schemes.test.ts
import { describe, it, expect } from "vitest";
import { generateDeviceKey } from "@/shared/willow/keys";
import { newStore, aindriveSchemes, namespaceOf } from "@/shared/willow/schemes";
import { pathOf, utf8 } from "@/shared/willow/bytes";

describe("aindrive Willow schemes", () => {
  it("a device writes in its own subspace with a real signature", async () => {
    const kp = await generateDeviceKey();
    const store = newStore("drive-1");
    const r = await store.set({ path: pathOf(["doc", "a.md", "~u", "1"]), subspace: kp.publicKey, payload: utf8("hello") }, kp);
    expect(r.kind).toBe("success");
  });

  it("refuses an entry signed by another key (communal rule: the subspace owner signs)", async () => {
    const mom = await generateDeviceKey();
    const eve = await generateDeviceKey();
    const store = newStore("drive-1");
    const r = await store.set({ path: pathOf(["doc", "a.md", "~u", "1"]), subspace: mom.publicKey, payload: utf8("x") }, eve);
    expect(r.kind).toBe("failure");
  });

  it("refuses a token replayed onto a changed entry", async () => {
    const kp = await generateDeviceKey();
    const a = newStore("drive-1");
    const ok = await a.set({ path: pathOf(["doc", "a.md", "~u", "1"]), subspace: kp.publicKey, payload: utf8("x") }, kp);
    if (ok.kind !== "success") throw new Error("setup");
    const b = newStore("drive-1");
    const tampered = { ...ok.entry, timestamp: ok.entry.timestamp + 1n };
    const r = await b.ingestEntry(tampered, ok.authToken);
    expect(r.kind).toBe("failure");
  });

  it("derives one namespace per drive", () => {
    expect(namespaceOf("drive-1")).toEqual(namespaceOf("drive-1"));
    expect(namespaceOf("drive-1")).not.toEqual(namespaceOf("drive-2"));
    expect(aindriveSchemes.namespace.encodedLength(namespaceOf("x"))).toBe(32);
  });
});
