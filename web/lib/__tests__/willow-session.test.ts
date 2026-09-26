// web/lib/__tests__/willow-session.test.ts
import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import { generateDeviceKey } from "@/shared/willow/keys";
import { newStore } from "@/shared/willow/schemes";
import { appendUpdate, loadDoc } from "@/shared/willow/doc";
import { SyncSession, fullRange, type Channel } from "@/shared/willow/session";
import type { Frame } from "@/shared/willow/wire";

function pipe(): [Channel, Channel] {
  const make = () => ({ frame: [] as ((f: Frame) => void)[], close: [] as (() => void)[] });
  const a = make(), b = make();
  const chan = (me: typeof a, other: typeof a): Channel => ({
    // JSON round trip: the real socket carries text
    send: (f) => queueMicrotask(() => other.frame.forEach((cb) => cb(JSON.parse(JSON.stringify(f))))),
    onFrame: (cb) => me.frame.push(cb),
    onClose: (cb) => me.close.push(cb),
  });
  return [chan(a, b), chan(b, a)];
}

const text = (s: string, client: number) => { const d = new Y.Doc(); d.clientID = client; d.getText("content").insert(0, s); return Y.encodeStateAsUpdate(d); };
const settle = () => new Promise((r) => setTimeout(r, 50));
// Reconciliation of many signed entries takes a few event-loop turns: wait until both stores agree.
async function converged(a: ReturnType<typeof newStore>, b: ReturnType<typeof newStore>) {
  for (let i = 0; i < 100; i++) {
    const [x, y] = await Promise.all([a.summarise(fullRange()), b.summarise(fullRange())]);
    if (x.size === y.size && JSON.stringify([...(x.fingerprint as Uint8Array)]) === JSON.stringify([...(y.fingerprint as Uint8Array)])) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("stores did not converge in 5 s");
}

describe("SyncSession", () => {
  it("two stores with divergent offline edits converge on connect", async () => {
    const mom = await generateDeviceKey(), kid = await generateDeviceKey();
    const s1 = newStore("d"), s2 = newStore("d");
    for (let i = 1; i <= 40; i++) await appendUpdate(s1, mom, ["a.md"], text(`m${i} `, 1000 + i), i);
    for (let i = 1; i <= 40; i++) await appendUpdate(s2, kid, ["a.md"], text(`k${i} `, 2000 + i), i);
    const [c1, c2] = pipe();
    const a = new SyncSession({ store: s1, channel: c1, ranges: [fullRange()] });
    const b = new SyncSession({ store: s2, channel: c2, ranges: [fullRange()] });
    await Promise.all([a.start(), b.start()]);
    await converged(s1, s2);
    const t1 = (await loadDoc(s1, ["a.md"])).getText("content").toString();
    const t2 = (await loadDoc(s2, ["a.md"])).getText("content").toString();
    expect(t1).toBe(t2);
    expect(t1).toContain("m40 ");
    expect(t1).toContain("k40 ");
  });

  it("pushes an entry written after the connect (live)", async () => {
    const mom = await generateDeviceKey();
    const s1 = newStore("d"), s2 = newStore("d");
    const [c1, c2] = pipe();
    await Promise.all([new SyncSession({ store: s1, channel: c1, ranges: [fullRange()] }).start(), new SyncSession({ store: s2, channel: c2, ranges: [fullRange()] }).start()]);
    await appendUpdate(s1, mom, ["a.md"], text("live", 7), 1);
    await settle();
    expect((await loadDoc(s2, ["a.md"])).getText("content").toString()).toBe("live");
  });

  it("an entry the receiver refuses is not stored, and the sender hears why", async () => {
    const mom = await generateDeviceKey();
    const s1 = newStore("d"), s2 = newStore("d");
    const [c1, c2] = pipe();
    const refused: string[] = [];
    const a = new SyncSession({ store: s1, channel: c1, ranges: [fullRange()], onRefused: (f) => refused.push(f.reason) });
    const b = new SyncSession({ store: s2, channel: c2, ranges: [fullRange()], accept: async () => "not-a-member" });
    await Promise.all([a.start(), b.start()]);
    await appendUpdate(s1, mom, ["a.md"], text("x", 7), 1);
    await settle();
    expect((await loadDoc(s2, ["a.md"])).getText("content").toString()).toBe("");
    expect(refused).toContain("not-a-member");
  });

  it("does not echo an entry back to the peer it came from", async () => {
    const mom = await generateDeviceKey();
    const s1 = newStore("d"), s2 = newStore("d");
    const [c1, c2] = pipe();
    let lives = 0;
    const orig = c2.send;
    c2.send = (f) => { if (f.t === "live") lives++; orig(f); };
    await Promise.all([new SyncSession({ store: s1, channel: c1, ranges: [fullRange()] }).start(), new SyncSession({ store: s2, channel: c2, ranges: [fullRange()] }).start()]);
    await appendUpdate(s1, mom, ["a.md"], text("once", 7), 1);
    await settle();
    expect(lives).toBe(0);
  });
});
