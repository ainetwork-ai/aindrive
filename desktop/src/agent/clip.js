// Mirrors mobile/android/app/src/main/java/ai/ainetwork/aindrive/clip/ClipEmbedder.java
/**
 * MobileCLIP2-S2 on ONNX Runtime (onnxruntime-node): a photo and a sentence
 * become 512-d unit vectors in one space — the same model and preprocessing as
 * the phone, so the same question finds the same photos on both.
 *
 * Preprocessing (preprocessor_config.json): shortest edge → 256 (bilinear),
 * center crop 256×256, RGB in [0, 1], NO mean/std normalisation. Pixels come
 * from the caller (the Mac decodes with the OS, see mac-agent.js), so this file
 * has no image decoder and runs in plain Node for tests.
 *
 * The vision graph is fp32 and the text graph int8 on purpose — the phone found
 * the int8/fp16 vision exports broken; don't "optimise" to them.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ClipTokenizer, CONTEXT } from "./clip-tokenizer.js";
import { normalize, prompt } from "./scene-labels.js";
import { SCENE_VOCAB } from "./content-words.js";

export const DIM = 512, SIZE = 256;

/**
 * Shortest edge → SIZE with bilinear sampling, then the centre SIZE×SIZE, as CHW floats in [0, 1].
 * @param {{ width: number, height: number, data: Uint8Array | Buffer, order?: "rgba" | "bgra" }} img 4 bytes per pixel
 */
export function toPixelValues(img) {
  const { width: w, height: h, data } = img;
  const [ri, gi, bi] = img.order === "bgra" ? [2, 1, 0] : [0, 1, 2];
  const scale = SIZE / Math.min(w, h);
  const sw = Math.max(SIZE, Math.round(w * scale)), sh = Math.max(SIZE, Math.round(h * scale));
  const ox = Math.floor((sw - SIZE) / 2), oy = Math.floor((sh - SIZE) / 2);
  const out = new Float32Array(3 * SIZE * SIZE);
  const plane = SIZE * SIZE;
  for (let y = 0; y < SIZE; y++) {
    const fy = Math.min(h - 1, Math.max(0, ((y + oy + 0.5) * h) / sh - 0.5));
    const y0 = Math.floor(fy), y1 = Math.min(h - 1, y0 + 1), dy = fy - y0;
    for (let x = 0; x < SIZE; x++) {
      const fx = Math.min(w - 1, Math.max(0, ((x + ox + 0.5) * w) / sw - 0.5));
      const x0 = Math.floor(fx), x1 = Math.min(w - 1, x0 + 1), dx = fx - x0;
      const a = (y0 * w + x0) * 4, b = (y0 * w + x1) * 4, c = (y1 * w + x0) * 4, d = (y1 * w + x1) * 4;
      const at = y * SIZE + x;
      for (const [ch, k] of [[0, ri], [1, gi], [2, bi]]) {
        const top = data[a + k] * (1 - dx) + data[b + k] * dx;
        const bottom = data[c + k] * (1 - dx) + data[d + k] * dx;
        out[ch * plane + at] = (top * (1 - dy) + bottom * dy) / 255;
      }
    }
  }
  return out;
}

/**
 * @param {{ files: { vision: string, text: string }, assetsDir: string, manifest?: { model?: string } }} o
 *   files: paths of visual.onnx / text.onnx (their .onnx.data sit next to them); assetsDir holds vocab.txt + merges.txt
 */
export async function createClip({ files, assetsDir, manifest = {} }) {
  // Lazily: a missing or broken native module must not stop the rest of the agent.
  const ort = await import("onnxruntime-node");
  const opts = { intraOpNumThreads: 4, graphOptimizationLevel: "all" };
  const vision = await ort.InferenceSession.create(files.vision, opts);
  const text = await ort.InferenceSession.create(files.text, opts);
  const tokenizer = new ClipTokenizer(readFileSync(join(assetsDir, "vocab.txt"), "utf8"), readFileSync(join(assetsDir, "merges.txt"), "utf8"));
  const textCache = new Map();
  let labels = null;
  // One inference at a time per graph: ORT sessions are not meant to be run concurrently from JS.
  let queue = Promise.resolve();
  const serial = (fn) => { const p = queue.then(fn, fn); queue = p.catch(() => {}); return p; };

  const clip = {
    name: manifest.model ?? "CLIP",
    /** @param {Parameters<typeof toPixelValues>[0]} img */
    embedImage: (img) => serial(async () => {
      const t = new ort.Tensor("float32", toPixelValues(img), [1, 3, SIZE, SIZE]);
      const r = await vision.run({ [vision.inputNames[0]]: t });
      return normalize(/** @type {Float32Array} */ (r[vision.outputNames[0]].data));
    }),
    /** @param {string} sentence */
    embedText: async (sentence) => {
      const hit = textCache.get(sentence);
      if (hit) return hit;
      const v = await serial(async () => {
        const t = new ort.Tensor("int64", tokenizer.encode(sentence), [1, CONTEXT]);
        const r = await text.run({ [text.inputNames[0]]: t });
        return normalize(/** @type {Float32Array} */ (r[text.outputNames[0]].data));
      });
      textCache.set(sentence, v);
      return v;
    },
    /** Text vectors of SCENE_VOCAB (the rivals a query is classified against), computed once. */
    labelVectors: async () => (labels ??= await Promise.all(SCENE_VOCAB.map((l) => clip.embedText(prompt(l))))),
    /** Release both sessions after the inference in flight — quitting with live sessions aborts the process (ORT). */
    close: async () => { await queue; await vision.release?.(); await text.release?.(); },
  };
  return clip;
}

/** A vector for the JSON index (base64 of its float32 bytes) and back. */
export const packVec = (v) => Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString("base64");
export const unpackVec = (s) => { const b = Buffer.from(s, "base64"); return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };
