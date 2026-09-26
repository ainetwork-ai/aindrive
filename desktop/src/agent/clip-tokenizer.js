// Mirrors mobile/android/app/src/main/java/ai/ainetwork/aindrive/clip/ClipTokenizer.java
/**
 * CLIP's byte-level BPE tokenizer (open_clip's SimpleTokenizer), so the text
 * encoder sees exactly the ids it was trained with. Pinned against the phone's
 * reference vectors (mobile/android/app/src/test/resources/clip-tokenizer-vectors.tsv).
 *
 * Inputs: vocab.txt (one token per line, line number = id) and merges.txt
 * (one "a b" pair per line, in priority order) — the phone's assets/clip files.
 */
export const CONTEXT = 77;
export const BOS = 49406, EOS = 49407, PAD = 0;

const PAT = /<\|startoftext\|>|<\|endoftext\|>|'s|'t|'re|'ve|'m|'ll|'d|[\p{L}]+|[\p{N}]|[^\s\p{L}\p{N}]+/giu;

export class ClipTokenizer {
  /** @param {string} vocab @param {string} merges */
  constructor(vocab, merges) {
    /** @type {Map<string, number>} */
    this.encoder = new Map();
    const lines = vocab.split("\n");
    if (lines[lines.length - 1] === "") lines.pop();   // the trailing newline is not a token (Java's readLine)
    lines.forEach((line, i) => this.encoder.set(line.replace(/\r$/, ""), i));
    /** @type {Map<string, number>} */
    this.ranks = new Map();
    let rank = 0;
    for (const raw of merges.split("\n")) {
      const line = raw.replace(/\r$/, "");
      if (!line || line.startsWith("#version")) continue;
      this.ranks.set(line, rank++);
    }
    // GPT-2 bytes_to_unicode: printable bytes map to themselves, the rest to U+0100+.
    const bs = [];
    for (let b = 0x21; b <= 0x7e; b++) bs.push(b);
    for (let b = 0xa1; b <= 0xac; b++) bs.push(b);
    for (let b = 0xae; b <= 0xff; b++) bs.push(b);
    const have = new Set(bs);
    this.byteEncoder = new Array(256);
    let n = 0;
    for (let b = 0; b < 256; b++) this.byteEncoder[b] = String.fromCodePoint(have.has(b) ? b : 256 + n++);
    /** @type {Map<string, string>} */
    this.cache = new Map();
  }

  /** BOS + tokens + EOS, padded with PAD to CONTEXT (truncated to keep EOS last). */
  encode(text) {
    let ids = [BOS];
    const clean = String(text).normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();
    const utf8 = new TextEncoder();
    for (const m of clean.matchAll(PAT)) {
      let s = "";
      for (const b of utf8.encode(m[0])) s += this.byteEncoder[b];
      for (const piece of this.bpe(s).split(" ")) {
        const id = this.encoder.get(piece);
        if (id !== undefined) ids.push(id);
      }
    }
    if (ids.length > CONTEXT - 1) ids = ids.slice(0, CONTEXT - 1);
    ids.push(EOS);
    const out = new BigInt64Array(CONTEXT);   // PAD = 0
    ids.forEach((id, i) => { out[i] = BigInt(id); });
    return out;
  }

  bpe(token) {
    const hit = this.cache.get(token);
    if (hit !== undefined) return hit;
    const cps = [...token];
    let word = cps.map((c, i) => (i === cps.length - 1 ? c + "</w>" : c));
    while (word.length > 1) {
      let best = null, bestRank = Infinity;
      for (let i = 0; i < word.length - 1; i++) {
        const r = this.ranks.get(word[i] + " " + word[i + 1]);
        if (r !== undefined && r < bestRank) { bestRank = r; best = [word[i], word[i + 1]]; }
      }
      if (!best) break;
      const merged = [];
      for (let i = 0; i < word.length;) {
        if (i < word.length - 1 && word[i] === best[0] && word[i + 1] === best[1]) { merged.push(best[0] + best[1]); i += 2; }
        else { merged.push(word[i]); i++; }
      }
      word = merged;
    }
    const out = word.join(" ");
    this.cache.set(token, out);
    return out;
  }
}
