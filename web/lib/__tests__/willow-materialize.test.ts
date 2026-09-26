// web/lib/__tests__/willow-materialize.test.ts
import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import { kindFor, docToFile, fileToUpdate } from "@/shared/willow/materialize";

describe("materialize", () => {
  it("picks markdown for .md", () => {
    expect(kindFor("a/b.md")).toBe("markdown");
    expect(kindFor("x.ts")).toBe("text");
  });

  it("plain text round trip, and a disk edit is a minimal update that keeps concurrent typing", () => {
    const a = new Y.Doc(); a.getText("content").insert(0, "hello world");
    expect(docToFile(a, "text")).toBe("hello world");
    const b = new Y.Doc(); Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    b.getText("content").insert(11, "!"); // someone typing in a browser
    const u = fileToUpdate(a, "text", "hello brave world")!; // the disk edit
    Y.applyUpdate(b, u); Y.applyUpdate(a, u);
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    expect(a.getText("content").toString()).toBe("hello brave world!");
    expect(fileToUpdate(a, "text", "hello brave world!")).toBeNull();
  });

  it("markdown round trip through the editor's schema", () => {
    const d = new Y.Doc();
    Y.applyUpdate(d, fileToUpdate(d, "markdown", "# Notes\n\nstart **bold**\n")!);
    expect(docToFile(d, "markdown")).toBe("# Notes\n\nstart **bold**");
    expect(fileToUpdate(d, "markdown", "# Notes\n\nstart **bold**\n")).toBeNull(); // same rendering: no update
  });
});
