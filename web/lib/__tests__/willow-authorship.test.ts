// web/lib/__tests__/willow-authorship.test.ts
import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import { authorAt } from "@/components/editors/authorship";

describe("authorAt", () => {
  it("names the device that typed each character", () => {
    const a = new Y.Doc(); a.clientID = 1; a.getText("content").insert(0, "mom ");
    const b = new Y.Doc(); b.clientID = 2; Y.applyUpdate(b, Y.encodeStateAsUpdate(a)); b.getText("content").insert(4, "kid");
    const authors = new Map([[1, "aa"], [2, "bb"]]);
    expect(authorAt(b, 0, authors)).toBe("aa");
    expect(authorAt(b, 5, authors)).toBe("bb");
    expect(authorAt(b, 99, authors)).toBeNull();
  });
});
