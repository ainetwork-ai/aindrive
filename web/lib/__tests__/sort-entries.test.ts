import { describe, it, expect } from "vitest";
import { sortEntries } from "../sort-entries";
import type { DriveEntry } from "../protocol";

const e = (name: string, isDir = false, size = 0, mtimeMs = 0): DriveEntry =>
  ({ name, path: name, isDir, size, mtimeMs, ext: "", mime: "" });

describe("sortEntries", () => {
  it("folders always come first regardless of direction", () => {
    const out = sortEntries([e("z.txt"), e("a", true), e("b.txt")], "name", "desc");
    expect(out.map((x) => x.name)).toEqual(["a", "z.txt", "b.txt"]);
  });

  it("natural numeric name order (file2 < file10), case-insensitive", () => {
    const out = sortEntries([e("file10"), e("File2"), e("file1")], "name", "asc");
    expect(out.map((x) => x.name)).toEqual(["file1", "File2", "file10"]);
  });

  it("mtime desc puts newest first", () => {
    const out = sortEntries([e("old", false, 0, 1), e("new", false, 0, 9)], "mtime", "desc");
    expect(out[0].name).toBe("new");
  });

  it("size for directories falls back to name (server size is meaningless)", () => {
    const out = sortEntries([e("zz", true, 999), e("aa", true, 1)], "size", "asc");
    expect(out.map((x) => x.name)).toEqual(["aa", "zz"]);
  });

  it("does not mutate the input array", () => {
    const input = [e("b.txt"), e("a.txt")];
    sortEntries(input, "name", "asc");
    expect(input[0].name).toBe("b.txt");
  });
});
