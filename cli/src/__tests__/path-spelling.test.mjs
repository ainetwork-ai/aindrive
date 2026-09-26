// matchSpelling: the server names paths in NFC; a byte-exact filesystem (Linux
// ext4, where a macOS-made NFD name keeps its bytes) must still find the file.
// A fake byte-exact fs is injected — this machine's APFS is normalization-
// insensitive, so a real-disk test would pass with or without the fallback.
import { describe, it, expect } from "vitest";
import path from "node:path";
import { matchSpelling } from "../rpc.js";

const ROOT = "/drive";
const NFC = (s) => s.normalize("NFC");
const NFD = (s) => s.normalize("NFD");

function byteExactFs(relPaths) {
  const abs = new Set([ROOT, ...relPaths.map((r) => path.join(ROOT, r))]);
  return {
    existsSync: (p) => abs.has(p),
    readdirSync: (dir) => {
      if (!abs.has(dir)) { const e = new Error("ENOENT"); e.code = "ENOENT"; throw e; }
      return [...abs].filter((p) => path.dirname(p) === dir && p !== dir).map((p) => path.basename(p));
    },
  };
}

describe("matchSpelling", () => {
  it("finds an NFD-named file on disk from its NFC name", () => {
    const fsx = byteExactFs([NFD("가족"), NFD("가족/제주 앨범.jpg")]);
    const got = matchSpelling(ROOT, path.join(ROOT, NFC("가족/제주 앨범.jpg")), fsx);
    expect(got).toBe(path.join(ROOT, NFD("가족/제주 앨범.jpg")));
  });

  it("a new file under an NFD folder lands in that folder, in the requested spelling", () => {
    const fsx = byteExactFs([NFD("가족")]);
    const got = matchSpelling(ROOT, path.join(ROOT, NFC("가족/새 메모.md")), fsx);
    expect(got).toBe(path.join(ROOT, NFD("가족"), NFC("새 메모.md")));
  });

  it("an exact match wins when both spellings exist", () => {
    const fsx = byteExactFs([NFC("앨범"), NFD("앨범")]);
    expect(matchSpelling(ROOT, path.join(ROOT, NFC("앨범")), fsx)).toBe(path.join(ROOT, NFC("앨범")));
  });

  it("an ASCII-only path never lists a folder — it has no other Unicode spelling", () => {
    const fsx = byteExactFs(["big"]);
    let listed = 0;
    const counting = { ...fsx, readdirSync: (d) => { listed++; return fsx.readdirSync(d); } };
    expect(matchSpelling(ROOT, path.join(ROOT, "big/missing.txt"), counting)).toBe(path.join(ROOT, "big/missing.txt"));
    expect(listed).toBe(0);
  });

  it("a path with nothing on disk comes back unchanged", () => {
    const fsx = byteExactFs([]);
    expect(matchSpelling(ROOT, path.join(ROOT, "a/b.txt"), fsx)).toBe(path.join(ROOT, "a/b.txt"));
  });
});
