// Mirrors mobile/android/app/src/main/java/ai/ainetwork/aindrive/clip/SceneLabels.java
/**
 * Zero-shot "does this photo show X?": the photo is classified against X plus a
 * fixed vocabulary of everyday scenes (SCENE_VOCAB, content-words.js) instead of
 * comparing its raw cosine to a cut-off — raw CLIP cosines shift per concept, a
 * softmax over ~90 rivals doesn't. Labels whose text is (nearly) the query are
 * merged into it, so a synonym doesn't steal its photos.
 */
/** Labels at/above this text similarity to the query are the query (synonyms/articles). */
const SAME = 0.95;
/** …or the single closest label, when at least this similar and this far ahead of the runner-up. */
const ALIAS = 0.88, ALIAS_GAP = 0.03;
/** CLIP's logit scale. */
const SCALE = 100;
/** Match when the query wins with at least MIN_WIN, or is at least MIN_ANY likely even if another label wins. */
const MIN_WIN = 0.2, MIN_ANY = 0.3;

export const prompt = (label) => `a photo of ${label}`;

/** @param {ArrayLike<number>} a @param {ArrayLike<number>} b */
export function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/** @param {ArrayLike<number>} v @returns {Float32Array} */
export function normalize(v) {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  const inv = 1 / Math.max(Math.sqrt(n), 1e-9);
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] * inv;
  return out;
}

/**
 * Probability that each photo shows the query (softmax over query + competing labels),
 * or -1 when it doesn't count as a match. `labels[i]` are the label text vectors.
 * @param {Float32Array} query @param {Float32Array[]} labels @param {(Float32Array|null)[]} photos
 */
export function match(query, labels, photos) {
  const sim = labels.map((l) => dot(l, query));
  let first = -1, second = -1, same = false;
  sim.forEach((s, i) => {
    same ||= s >= SAME;
    if (first < 0 || s > sim[first]) { second = first; first = i; }
    else if (second < 0 || s > sim[second]) second = i;
  });
  // "receipts" vs the label "a receipt": a plural or other form of one label is that label when it stands clearly apart.
  const alias = !same && first >= 0 && sim[first] >= ALIAS && (second < 0 || sim[first] - sim[second] >= ALIAS_GAP) ? first : -1;
  const rivals = labels.filter((_, i) => sim[i] < SAME && i !== alias);
  // Search with the label's own wording: "a photo of receipts" sits further from receipt photos than "a photo of a receipt".
  const q = alias >= 0 ? labels[alias] : query;
  return photos.map((v) => {
    if (!v) return -1;
    const sq = dot(v, q);
    const s = rivals.map((r) => dot(v, r));
    const best = s.length ? Math.max(...s) : -Infinity;
    const top = Math.max(sq, best);
    const qe = Math.exp(SCALE * (sq - top));
    let sum = qe;
    for (const x of s) sum += Math.exp(SCALE * (x - top));
    const p = qe / sum;
    const wins = sq >= best;
    return (wins && p >= MIN_WIN) || p >= MIN_ANY ? p : -1;
  });
}
