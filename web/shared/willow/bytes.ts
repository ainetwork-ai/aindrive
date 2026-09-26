// web/shared/willow/bytes.ts
// Byte helpers shared by every Willow unit. No Node or DOM imports: this runs in
// the server, the browser and the phone shell.

export function toHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

export function fromHex(s: string): Uint8Array {
  if (s.length % 2 !== 0 || /[^0-9a-f]/i.test(s)) throw new Error("bad hex");
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

/** JSON with sorted keys and bigints as decimal strings: the bytes a signature covers. */
export function canonicalJson(v: unknown): Uint8Array {
  const norm = (x: unknown): unknown => {
    if (typeof x === "bigint") return x.toString();
    if (x instanceof Uint8Array) return toHex(x);
    if (Array.isArray(x)) return x.map(norm);
    if (x && typeof x === "object") {
      const o = x as Record<string, unknown>;
      return Object.fromEntries(Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => [k, norm(o[k])]));
    }
    return x;
  };
  return utf8(JSON.stringify(norm(v)));
}

export const pathOf = (parts: string[]): Uint8Array[] => parts.map(utf8);
export const partsOf = (path: Uint8Array[]): string[] => path.map((c) => new TextDecoder().decode(c));
