// Self-host the runtime assets the file-preview renderers load by URL (workers,
// wasm, CMaps) — the app CSP (middleware.ts: script-src/worker-src 'self')
// blocks CDNs, and bundlers can't inline workers/wasm for these libraries.
//
// Runs on predev/prebuild next to copy-monaco. Output under public/preview-assets
// is a gitignored build artifact, re-copied when a source package version changes.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const nm = (p) => resolve(webRoot, "node_modules", p);
const outRoot = resolve(webRoot, "public/preview-assets");

// [package, [source-in-package, dest-under-outRoot]...]
const ASSETS = [
  ["pdfjs-dist", [
    ["build/pdf.worker.min.mjs", "pdfjs/pdf.worker.min.mjs"],
    ["cmaps", "pdfjs/cmaps"],            // CJK text in PDFs needs these
    ["standard_fonts", "pdfjs/standard_fonts"],
    ["wasm", "pdfjs/wasm"],              // JPX/JBIG2 image decoders
  ]],
  ["libarchive.js", [
    ["dist/worker-bundle.js", "libarchive/worker-bundle.js"],
    ["dist/libarchive.wasm", "libarchive/libarchive.wasm"],
  ]],
];

const versionOf = (pkg) => JSON.parse(readFileSync(nm(`${pkg}/package.json`), "utf8")).version;
const stamp = ASSETS.map(([pkg]) => `${pkg}@${versionOf(pkg)}`).join(" ");
const stampFile = resolve(outRoot, ".version");
if (existsSync(stampFile) && readFileSync(stampFile, "utf8") === stamp) {
  console.log(`[copy-preview-assets] up to date (${stamp})`);
  process.exit(0);
}

rmSync(outRoot, { recursive: true, force: true });
for (const [pkg, files] of ASSETS) {
  for (const [from, to] of files) {
    const src = nm(`${pkg}/${from}`);
    if (!existsSync(src)) {
      console.error(`[copy-preview-assets] missing ${src} — run \`npm install\` first.`);
      process.exit(1);
    }
    const dest = resolve(outRoot, to);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(src, dest, { recursive: true });
  }
}
writeFileSync(stampFile, stamp);
console.log(`[copy-preview-assets] copied ${stamp} → public/preview-assets`);
