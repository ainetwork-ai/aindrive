// Mirrors web/lib/willow/payload-driver-fs.ts (cli and web are independent packages).
// Payloads as files named by their SHA-256 digest (hex); content-addressed, so a
// write is idempotent and a crash leaves at worst an orphan temp file.
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sha256 } from "@noble/hashes/sha2.js";
import { ValidationError } from "@earthstar/willow";
import { toHex, equalBytes } from "./willow-shared/bytes.js";

async function all(p) {
  if (p instanceof Uint8Array) return p;
  const parts = []; for await (const c of p) parts.push(c);
  const out = new Uint8Array(parts.reduce((n, c) => n + c.length, 0)); let o = 0;
  for (const c of parts) { out.set(c, o); o += c.length; }
  return out;
}
const payloadOf = (bytes) => ({
  bytes: async (offset = 0) => bytes.subarray(offset),
  stream: async (offset = 0) => (async function* () { yield bytes.subarray(offset); })(),
  length: async () => BigInt(bytes.length),
});

export class PayloadDriverFs {
  constructor(dir) { this.dir = dir; mkdirSync(dir, { recursive: true }); }
  file(d) { return join(this.dir, toHex(d)); }
  write(d, bytes) { const f = this.file(d); const tmp = `${f}.tmp-${process.pid}`; writeFileSync(tmp, bytes); renameSync(tmp, f); }
  async get(d) { const f = this.file(d); return existsSync(f) ? payloadOf(new Uint8Array(readFileSync(f))) : undefined; }
  async set(p) { const bytes = await all(p); const d = sha256(bytes); this.write(d, bytes); return { digest: d, length: BigInt(bytes.length), payload: payloadOf(bytes) }; }
  async receive(o) {
    const part = this.file(o.expectedDigest) + ".part";
    const prev = o.offset > 0 && existsSync(part) ? new Uint8Array(readFileSync(part)).subarray(0, o.offset) : new Uint8Array(0);
    const bytes = new Uint8Array([...prev, ...(await all(o.payload))]);
    const d = sha256(bytes);
    return {
      digest: d, length: BigInt(bytes.length),
      commit: async (complete) => {
        if (complete && equalBytes(d, o.expectedDigest)) { this.write(d, bytes); try { unlinkSync(part); } catch {} }
        else writeFileSync(part, bytes);
      },
      reject: async () => { try { unlinkSync(part); } catch {} },
    };
  }
  async length(d) { const f = this.file(d); return existsSync(f) ? BigInt(statSync(f).size) : 0n; }
  async erase(d) { try { unlinkSync(this.file(d)); return true; } catch { return new ValidationError("no payload with that digest"); } }
}
