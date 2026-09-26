// web/lib/__tests__/willow-binding.test.ts
import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import { generateDeviceKey } from "@/shared/willow/keys";
import { newStore } from "@/shared/willow/schemes";
import { SyncSession, fullRange, type Channel } from "@/shared/willow/session";
import { bindDoc, clientIdFor } from "@/shared/willow/y-binding";
import type { Frame } from "@/shared/willow/wire";

function pipe(): [Channel, Channel] {
  const a = { f: [] as ((x: Frame) => void)[] }, b = { f: [] as ((x: Frame) => void)[] };
  const c = (me: typeof a, o: typeof a): Channel => ({ send: (x) => queueMicrotask(() => o.f.forEach((cb) => cb(JSON.parse(JSON.stringify(x))))), onFrame: (cb) => me.f.push(cb), onClose: () => {} });
  return [c(a, b), c(b, a)];
}
const settle = () => new Promise((r) => setTimeout(r, 60));
// signed entries take a few event-loop turns to verify and travel: poll, up to 5 s
async function until(ok: () => boolean) {
  for (let i = 0; i < 100 && !ok(); i++) await new Promise((r) => setTimeout(r, 50));
}
let seq = 0;
const nextSeq = async () => ++seq;

describe("Y.Doc bound to a Willow store", () => {
  it("typing in one browser shows up in another through the stores", async () => {
    const k1 = await generateDeviceKey(), k2 = await generateDeviceKey();
    const s1 = newStore("d"), s2 = newStore("d");
    const [c1, c2] = pipe();
    await Promise.all([new SyncSession({ store: s1, channel: c1, ranges: [fullRange()] }).start(), new SyncSession({ store: s2, channel: c2, ranges: [fullRange()] }).start()]);
    const d1 = new Y.Doc(), d2 = new Y.Doc();
    await bindDoc({ store: s1, key: k1, docPath: ["a.md"], doc: d1, nextSeq });
    await bindDoc({ store: s2, key: k2, docPath: ["a.md"], doc: d2, nextSeq });
    d1.getText("content").insert(0, "hello ");
    await until(() => d2.getText("content").toString() === "hello ");
    d2.getText("content").insert(d2.getText("content").length, "world");
    await until(() => d1.getText("content").toString() === "hello world");
    expect(d1.getText("content").toString()).toBe("hello world");
    expect(d2.getText("content").toString()).toBe("hello world");
  });

  it("a reopened doc has everything typed before, with no network", async () => {
    const k = await generateDeviceKey();
    const s = newStore("d");
    const d1 = new Y.Doc();
    const unbind = await bindDoc({ store: s, key: k, docPath: ["a.md"], doc: d1, nextSeq });
    d1.getText("content").insert(0, "offline text");
    await settle();
    unbind();
    const d2 = new Y.Doc();
    await bindDoc({ store: s, key: k, docPath: ["a.md"], doc: d2, nextSeq });
    expect(d2.getText("content").toString()).toBe("offline text");
  });

  it("two tabs of one device get different Yjs client ids", async () => {
    const k = await generateDeviceKey();
    expect(clientIdFor(k, 1)).not.toBe(clientIdFor(k, 2));
  });

  it("rapid typing loses nothing even when nextSeq is slow (appends are serialised)", async () => {
    const k = await generateDeviceKey();
    const s = newStore("d");
    let n = 0;
    const racySeq = async () => { const v = n; await new Promise((r) => setTimeout(r, 2)); n = v + 1; return v + 1; };
    const d1 = new Y.Doc();
    await bindDoc({ store: s, key: k, docPath: ["a.md"], doc: d1, nextSeq: racySeq });
    for (const ch of "abcdefghijklmnopqrst") d1.getText("content").insert(d1.getText("content").length, ch);
    await new Promise((r) => setTimeout(r, 400));
    const d2 = new Y.Doc();
    await bindDoc({ store: s, key: k, docPath: ["a.md"], doc: d2, nextSeq: racySeq });
    expect(d2.getText("content").toString()).toBe("abcdefghijklmnopqrst");
  });

  it("coalesces updates typed while an append is in flight into one entry", async () => {
    const k = await generateDeviceKey();
    const s = newStore("d");
    let n = 0;
    const slowSeq = async () => { await new Promise((r) => setTimeout(r, 20)); return ++n; };
    const d = new Y.Doc();
    await bindDoc({ store: s, key: k, docPath: ["a.md"], doc: d, nextSeq: slowSeq });
    for (const ch of "abcdefghijklmnopqrst") d.getText("content").insert(d.getText("content").length, ch);
    await new Promise((r) => setTimeout(r, 300));
    const { readUpdates } = await import("@/shared/willow/doc");
    const entries = await readUpdates(s, ["a.md"]);
    expect(entries.length).toBeLessThanOrEqual(3);
    const d2 = new Y.Doc();
    for (const u of entries) Y.applyUpdate(d2, u.update);
    expect(d2.getText("content").toString()).toBe("abcdefghijklmnopqrst");
  });
});
