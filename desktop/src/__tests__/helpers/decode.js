// Test-only image decoding without Electron: macOS `sips` → BMP → RGBA pixels.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function nativeDecode(file) {
  const dir = mkdtempSync(join(tmpdir(), "clip-decode-"));
  try {
    const out = join(dir, "x.bmp");
    execFileSync("/usr/bin/sips", ["-s", "format", "bmp", file, "--out", out], { stdio: "ignore" });
    const b = readFileSync(out);
    const off = b.readUInt32LE(10), w = b.readInt32LE(18), hRaw = b.readInt32LE(22), bpp = b.readUInt16LE(28);
    const h = Math.abs(hRaw), step = bpp / 8, stride = Math.ceil((w * step) / 4) * 4;
    const data = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
      const row = off + (hRaw > 0 ? h - 1 - y : y) * stride;   // bottom-up unless the height is negative
      for (let x = 0; x < w; x++) {
        const s = row + x * step, d = (y * w + x) * 4;
        data[d] = b[s + 2]; data[d + 1] = b[s + 1]; data[d + 2] = b[s]; data[d + 3] = 255;
      }
    }
    return { width: w, height: h, data, order: "rgba" };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
