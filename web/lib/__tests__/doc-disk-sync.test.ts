import { describe, it, expect } from "vitest";
import {
  createDiskSync, decideOnOpen, hashText, markLoaded, noteUpdate, shouldReloadFromDisk, shouldWriteBack,
} from "../doc-disk-sync";

describe("doc-disk-sync (incident: stale Yjs doc overwrote a git push)", () => {
  it("hashText tells texts apart and is stable", () => {
    expect(hashText("a")).toBe(hashText("a"));
    expect(hashText("a")).not.toBe(hashText("b"));
    expect(hashText("")).not.toBe(hashText(" "));
  });

  it("open: empty doc seeds from disk; doc == disk keeps; disk changed externally replaces", () => {
    const disk = "v2";
    expect(decideOnOpen({ docEmpty: true, docEqualsDisk: false, diskHash: hashText(disk), lastKnownDiskHash: null })).toBe("seed-from-disk");
    expect(decideOnOpen({ docEmpty: false, docEqualsDisk: true, diskHash: hashText(disk), lastKnownDiskHash: null })).toBe("keep-doc");
    // The browser last saw v1 on disk; the CRDT still holds v1; disk is now v2 → disk wins.
    expect(decideOnOpen({ docEmpty: false, docEqualsDisk: false, diskHash: hashText(disk), lastKnownDiskHash: hashText("v1") })).toBe("replace-from-disk");
    // First open on this browser with a differing stored CRDT: the file is the truth.
    expect(decideOnOpen({ docEmpty: false, docEqualsDisk: false, diskHash: hashText(disk), lastKnownDiskHash: null })).toBe("replace-from-disk");
    // Disk unchanged since we last wrote it, the CRDT carries unsaved offline edits → keep them.
    expect(decideOnOpen({ docEmpty: false, docEqualsDisk: false, diskHash: hashText(disk), lastKnownDiskHash: hashText(disk) })).toBe("keep-doc");
  });

  it("scenario: open doc → file changes on disk (fs-changed) → doc reloads → no write-back", () => {
    let s = createDiskSync();
    s = markLoaded(s, "v1");              // seeded from disk
    s = noteUpdate(s, "idb-restore");     // IndexedDB restore is not an edit
    s = noteUpdate(s, "remote");          // neither is the server sync
    expect(shouldWriteBack(s, "v1")).toBe(false);
    // git push rewrote the file
    expect(shouldReloadFromDisk(s, "v2", false)).toBe(true);
    const before = s.generation;
    s = markLoaded(s, "v2", { replaced: true });
    expect(s.generation).toBe(before + 1);
    // the reload's own transact is programmatic: still nothing to write
    s = noteUpdate(s, "programmatic");
    expect(shouldWriteBack(s, "v2")).toBe(false);
    expect(shouldWriteBack(s, "v1")).toBe(false); // and the stale text can never go back
  });

  it("our own write echoing back through fs.watch is not a reload", () => {
    let s = createDiskSync();
    s = markLoaded(s, "v1");
    s = noteUpdate(s, "local");
    expect(shouldWriteBack(s, "v1 edited")).toBe(true);
    s = markLoaded(s, "v1 edited");       // write succeeded
    expect(shouldReloadFromDisk(s, "v1 edited", true)).toBe(false);
    expect(shouldReloadFromDisk(s, "v1 edited", false)).toBe(false); // same hash, not dirty (e.g. canon differs)
  });

  it("a local edit makes the doc dirty; writing the unchanged text is still refused", () => {
    let s = createDiskSync();
    s = markLoaded(s, "x");
    s = noteUpdate(s, "local");
    expect(s.dirty).toBe(true);
    expect(shouldWriteBack(s, "x")).toBe(false); // typed then undid
    expect(shouldWriteBack(s, "xy")).toBe(true);
  });
});
