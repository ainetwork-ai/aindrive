// GENERATED from web/shared/willow/bytes.ts by web/scripts/mirror-willow-to-cli.mjs — do not edit.
function toHex(b) {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}
function fromHex(s) {
  if (s.length % 2 !== 0 || /[^0-9a-f]/i.test(s)) throw new Error("bad hex");
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}
function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}
function equalBytes(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
const utf8 = (s) => new TextEncoder().encode(s);
function canonicalJson(v) {
  const norm = (x) => {
    if (typeof x === "bigint") return x.toString();
    if (x instanceof Uint8Array) return toHex(x);
    if (Array.isArray(x)) return x.map(norm);
    if (x && typeof x === "object") {
      const o = x;
      return Object.fromEntries(Object.keys(o).sort().filter((k) => o[k] !== void 0).map((k) => [k, norm(o[k])]));
    }
    return x;
  };
  return utf8(JSON.stringify(norm(v)));
}
const pathOf = (parts) => parts.map(utf8);
const partsOf = (path) => path.map((c) => new TextDecoder().decode(c));
export {
  canonicalJson,
  concat,
  equalBytes,
  fromHex,
  partsOf,
  pathOf,
  toHex,
  utf8
};
