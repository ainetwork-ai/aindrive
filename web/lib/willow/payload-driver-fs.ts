// web/lib/willow/payload-driver-fs.ts
// Payloads as files named by their SHA-256 digest (hex). Content-addressed, so a
// write is idempotent and a crash leaves at worst an orphan temp file.
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sha256 } from "@noble/hashes/sha2.js";
import { ValidationError, type Payload, type PayloadDriver } from "@earthstar/willow";
import { toHex, equalBytes } from "@/shared/willow/bytes";

type B = Uint8Array;
async function all(p: B | AsyncIterable<B>): Promise<B> {
  if (p instanceof Uint8Array) return p;
  const parts: B[] = []; for await (const c of p) parts.push(c);
  const out = new Uint8Array(parts.reduce((n, c) => n + c.length, 0)); let o = 0;
  for (const c of parts) { out.set(c, o); o += c.length; }
  return out;
}
const payloadOf = (bytes: B): Payload => ({
  bytes: async (offset = 0) => bytes.subarray(offset),
  stream: async (offset = 0) => (async function* () { yield bytes.subarray(offset); })(),
  length: async () => BigInt(bytes.length),
});

export class PayloadDriverFs implements PayloadDriver<B> {
  constructor(private readonly dir: string) { mkdirSync(dir, { recursive: true }); }
  private file(d: B) { return join(this.dir, toHex(d)); }
  private write(d: B, bytes: B) { const f = this.file(d); const tmp = `${f}.tmp-${process.pid}`; writeFileSync(tmp, bytes); renameSync(tmp, f); }
  async get(d: B) { const f = this.file(d); return existsSync(f) ? payloadOf(new Uint8Array(readFileSync(f))) : undefined; }
  async set(p: B | AsyncIterable<B>) { const bytes = await all(p); const d = sha256(bytes); this.write(d, bytes); return { digest: d, length: BigInt(bytes.length), payload: payloadOf(bytes) }; }
  async receive(o: { payload: B | AsyncIterable<B>; offset: number; expectedLength: bigint; expectedDigest: B }) {
    const prev = o.offset > 0 && existsSync(this.file(o.expectedDigest) + ".part") ? new Uint8Array(readFileSync(this.file(o.expectedDigest) + ".part")).subarray(0, o.offset) : new Uint8Array(0);
    const bytes = new Uint8Array([...prev, ...(await all(o.payload))]);
    const d = sha256(bytes);
    return {
      digest: d, length: BigInt(bytes.length),
      commit: async (complete: boolean) => {
        if (complete && equalBytes(d, o.expectedDigest)) { this.write(d, bytes); try { unlinkSync(this.file(o.expectedDigest) + ".part"); } catch {} }
        else writeFileSync(this.file(o.expectedDigest) + ".part", bytes);
      },
      reject: async () => { try { unlinkSync(this.file(o.expectedDigest) + ".part"); } catch {} },
    };
  }
  async length(d: B) { const f = this.file(d); return existsSync(f) ? BigInt(statSync(f).size) : 0n; }
  async erase(d: B): Promise<true | ValidationError> { try { unlinkSync(this.file(d)); return true; } catch { return new ValidationError("no payload with that digest"); } }
}
