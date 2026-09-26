import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ClipTokenizer } from "../agent/clip-tokenizer.js";
import { match, normalize } from "../agent/scene-labels.js";
import { SIZE, toPixelValues, packVec, unpackVec } from "../agent/clip.js";

const MOBILE = join(import.meta.dirname, "../../../mobile/android/app/src");
const ASSETS = join(MOBILE, "main/assets/clip");

test("the tokenizer gives the phone's reference ids (clip-tokenizer-vectors.tsv)", () => {
  const t = new ClipTokenizer(readFileSync(join(ASSETS, "vocab.txt"), "utf8"), readFileSync(join(ASSETS, "merges.txt"), "utf8"));
  const rows = readFileSync(join(MOBILE, "test/resources/clip-tokenizer-vectors.tsv"), "utf8").split("\n").filter(Boolean);
  assert.equal(rows.length, 10);
  for (const line of rows) {
    const [text, ids] = line.split("\t");
    const want = ids.split(" ").map(Number);
    const got = [...t.encode(text)].map(Number);
    assert.deepEqual(got.slice(0, want.length), want, text);
    assert.ok(got.slice(want.length).every((x) => x === 0), `${text}: padded with 0`);
  }
  assert.equal(t.encode("x").length, 77);
});

// SceneLabelsTest.java, case for case
const unit = (...v) => normalize(v);
test("a photo matches when the query is its likeliest scene", () => {
  const food = unit(1, 0, 0), sign = unit(0, 1, 0), street = unit(0, 0, 1);
  const p = match(food, [food, sign, street], [unit(0.19, 0.05, 0.02), unit(0.05, 0.28, 0.02), null]);
  assert.ok(p[0] > 0.5);
  assert.equal(p[1], -1);
  assert.equal(p[2], -1);
});
test("a synonym label does not steal the photo", () => {
  const food = unit(1, 0, 0), meal = unit(1, 0.01, 0), sign = unit(0, 1, 0);
  assert.ok(match(food, [meal, sign], [unit(0.2, 0.02, 0)])[0] > 0.9);
});
test("no concept in the library means no match", () => {
  const dog = unit(1, 0, 0), cat = unit(0.8, 0.6, 0), car = unit(0, 0, 1);
  assert.equal(match(dog, [cat, car], [unit(0.7, 0.7, 0.1)])[0], -1);
});

test("preprocessing: shortest edge to 256, centre crop, RGB in [0,1], BGRA understood", () => {
  // 512×256: left half red, right half blue — the centre crop is the middle 256 px: red then blue, split in the middle.
  const w = 512, h = 256, data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = (y * w + x) * 4; data[i] = x < 256 ? 255 : 0; data[i + 2] = x < 256 ? 0 : 255; data[i + 3] = 255; }
  const px = toPixelValues({ width: w, height: h, data });
  const R = (x, y) => px[y * SIZE + x], B = (x, y) => px[2 * SIZE * SIZE + y * SIZE + x];
  assert.equal(px.length, 3 * SIZE * SIZE);
  assert.equal(R(10, 100), 1); assert.equal(B(10, 100), 0);
  assert.equal(R(245, 100), 0); assert.equal(B(245, 100), 1);
  const bgra = Uint8Array.from(data); for (let i = 0; i < bgra.length; i += 4) [bgra[i], bgra[i + 2]] = [bgra[i + 2], bgra[i]];
  assert.deepEqual(toPixelValues({ width: w, height: h, data: bgra, order: "bgra" }), px);
});

test("vectors survive the JSON index", () => {
  const v = normalize([0.1, -0.2, 0.3]);
  assert.deepEqual(unpackVec(packVec(v)), v);
});

// The real model, when this Mac has it (downloaded by the app, or AINDRIVE_CLIP_DIR). The fixture is the
// phone's EXIF test image — a plain blue frame — so "the sky" is what it shows, and nothing else counts.
const MODEL = process.env.AINDRIVE_CLIP_DIR ?? join(homedir(), "Library/Caches/aindrive-dev-models/mobileclip2-s2");
test("MobileCLIP2-S2 on this Mac: a plain blue frame is the sky, not food or a dog", { skip: !existsSync(join(MODEL, "visual.onnx.data")) && "model not downloaded" }, async () => {
  const { createClip } = await import("../agent/clip.js");
  const { nativeDecode } = await import("./helpers/decode.js");
  const { SCENE_VOCAB } = await import("../agent/content-words.js");
  const { dot } = await import("../agent/scene-labels.js");
  const clip = await createClip({ files: { vision: join(MODEL, "visual.onnx"), text: join(MODEL, "text.onnx") }, assetsDir: ASSETS });
  try {
    const v = await clip.embedImage(await nativeDecode(join(MOBILE, "test/resources/paris_eiffel.jpg")));
    assert.equal(v.length, 512);
    const labels = await clip.labelVectors();
    const best = SCENE_VOCAB.map((l, i) => [l, dot(v, labels[i])]).sort((a, b) => b[1] - a[1])[0][0];
    assert.equal(best, "the sky");
    assert.ok(match(await clip.embedText("a photo of the sky"), labels, [v])[0] >= 0);
    for (const no of ["food", "a dog", "a receipt"]) assert.equal(match(await clip.embedText(`a photo of ${no}`), labels, [v])[0], -1, no);
  } finally { await clip.close(); }
});
