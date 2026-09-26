// Plan 3 review C1/I1/I2: a disk edit is merged three-way (base → file, applied to
// the current document), so edits made since the base survive.
import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import { baseOf, threeWayUpdate, fileToUpdate, docToFile, isLossy } from "@/shared/willow/materialize";

const fresh = () => new Y.Doc({ gc: false });
const clone = (d: Y.Doc) => { const c = fresh(); Y.applyUpdate(c, Y.encodeStateAsUpdate(d)); return c; };

describe("three-way disk merge", () => {
  it("text: a browser insert the agent already has survives a disk edit elsewhere", () => {
    const d = fresh(); d.getText("content").insert(0, "hello world");
    const base = baseOf(d, "text"); // what the file had when last written
    d.getText("content").insert(11, "X"); // remote edit, already in the doc, not yet on disk
    const u = threeWayUpdate(d, "text", base, "hi world")!; // the user saved the old file with an edit
    Y.applyUpdate(d, u);
    expect(docToFile(d, "text")).toBe("hi worldX");
  });

  it("text: a file equal to the base is no disk edit", () => {
    const d = fresh(); d.getText("content").insert(0, "abc");
    const base = baseOf(d, "text");
    d.getText("content").insert(3, "d");
    expect(threeWayUpdate(d, "text", base, "abc")).toBeNull();
  });

  it("text: a remote delete outside the edited span stays deleted", () => {
    const d = fresh(); d.getText("content").insert(0, "one two three");
    const base = baseOf(d, "text");
    d.getText("content").delete(0, 4); // "two three"
    Y.applyUpdate(d, threeWayUpdate(d, "text", base, "one two THREE")!);
    expect(docToFile(d, "text")).toBe("two THREE");
  });

  it("markdown: someone typing in paragraph 1 keeps it when the disk edits paragraph 3", () => {
    const d = fresh();
    Y.applyUpdate(d, fileToUpdate(d, "markdown", "first para\n\nsecond para\n\nthird para")!);
    const base = baseOf(d, "markdown");
    const browser = clone(d);
    const p1 = browser.getXmlFragment("prosemirror").get(0) as Y.XmlElement;
    (p1.get(0) as Y.XmlText).insert(5, " EDITED");
    Y.applyUpdate(d, Y.encodeStateAsUpdate(browser));
    Y.applyUpdate(d, threeWayUpdate(d, "markdown", base, "first para\n\nsecond para\n\nthird para CHANGED")!);
    const md = docToFile(d, "markdown");
    expect(md).toContain("first EDITED para");
    expect(md).toContain("third para CHANGED");
    expect(md).toContain("second para");
  });

  it("markdown: the editor cannot model a table, so the file is lossy", () => {
    expect(isLossy("markdown", "| a | b |\n|---|---|\n| 1 | 2 |\n")).toBe(true);
    expect(isLossy("markdown", "---\ntitle: x\n---\n\n# T\n")).toBe(true);
    expect(isLossy("markdown", "# T\n\n* a\n* b\n\nsome **bold** text")).toBe(false);
    expect(isLossy("text", "anything | at | all")).toBe(false);
  });
});
