// web/lib/__tests__/willow-doc.test.ts
import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import { generateDeviceKey } from "@/shared/willow/keys";
import { newStore } from "@/shared/willow/schemes";
import { toHex } from "@/shared/willow/bytes";
import { appendUpdate, loadDoc, compactOwn, readUpdates, authorsByClient } from "@/shared/willow/doc";

function typed(clientId: number, text: string, base?: Uint8Array) {
  const d = new Y.Doc();
  d.clientID = clientId;
  if (base) Y.applyUpdate(d, base);
  const before = Y.encodeStateVector(d);
  d.getText("content").insert(d.getText("content").length, text);
  return { doc: d, update: Y.encodeStateAsUpdate(d, before) };
}

describe("documents as Willow entries", () => {
  it("two people edit offline; any merge order gives the same text and per-client authors", async () => {
    const mom = await generateDeviceKey();
    const kid = await generateDeviceKey();
    const a = typed(1, "mom ");
    const b = typed(2, "kid ");
    const s1 = newStore("d");
    const s2 = newStore("d");
    await appendUpdate(s1, mom, ["a.md"], a.update, 1);
    await appendUpdate(s1, kid, ["a.md"], b.update, 1);
    await appendUpdate(s2, kid, ["a.md"], b.update, 1);
    await appendUpdate(s2, mom, ["a.md"], a.update, 1);
    const t1 = (await loadDoc(s1, ["a.md"])).getText("content").toString();
    const t2 = (await loadDoc(s2, ["a.md"])).getText("content").toString();
    expect(t1).toBe(t2);
    expect(t1).toContain("mom ");
    expect(t1).toContain("kid ");
    const authors = await authorsByClient(s1, ["a.md"]);
    expect(authors.get(1)).toBe(toHex(mom.publicKey));
    expect(authors.get(2)).toBe(toHex(kid.publicKey));
  });

  it("compaction keeps the text, prunes only this device's updates, and keeps others' authorship", async () => {
    const mom = await generateDeviceKey();
    const kid = await generateDeviceKey();
    const s = newStore("d");
    const a1 = typed(1, "one ");
    await appendUpdate(s, mom, ["a.md"], a1.update, 1);
    const a2 = typed(1, "two ", a1.update);
    await appendUpdate(s, mom, ["a.md"], a2.update, 2);
    await appendUpdate(s, kid, ["a.md"], typed(2, "kid").update, 1);
    const before = (await loadDoc(s, ["a.md"])).getText("content").toString();
    await compactOwn(s, mom, ["a.md"]);
    const after = await readUpdates(s, ["a.md"]);
    expect(after.filter((u) => u.subspaceHex === toHex(mom.publicKey))).toHaveLength(1);
    expect(after.filter((u) => u.subspaceHex === toHex(kid.publicKey))).toHaveLength(1);
    expect((await loadDoc(s, ["a.md"])).getText("content").toString()).toBe(before);
    expect((await authorsByClient(s, ["a.md"])).get(2)).toBe(toHex(kid.publicKey));
  });

  it("a snapshot of a.md never prunes a.md.bak", async () => {
    const mom = await generateDeviceKey();
    const s = newStore("d");
    await appendUpdate(s, mom, ["a.md.bak"], typed(1, "keep").update, 1);
    await appendUpdate(s, mom, ["a.md"], typed(1, "x").update, 1);
    await compactOwn(s, mom, ["a.md"]);
    expect((await loadDoc(s, ["a.md.bak"])).getText("content").toString()).toBe("keep");
  });
});
