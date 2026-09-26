// web/scripts/mirror-willow-to-cli.mjs
// cli/ is an independent package (CLAUDE.md): it may not import web/. The Willow
// code must still be the same bytes on both sides, so this compiles each shared
// TypeScript module to plain JS (no bundling: imports stay imports, "./x" → "./x.js")
// into cli/src/willow-shared/. A web test fails when the copy drifts.
import { transform } from "esbuild";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "../..");
const SOURCES = [
  ...["bytes", "keys", "schemes", "cert", "policy", "doc", "wire", "session", "y-binding", "materialize"].map((n) => [`web/shared/willow/${n}.ts`, `${n}.js`]),
  ["web/shared/media/chunks.ts", "chunks.js"],
];

export async function mirror({ write = true } = {}) {
  const out = {};
  for (const [src, name] of SOURCES) {
    const ts = readFileSync(join(repo, src), "utf8");
    const { code } = await transform(ts, { loader: "ts", format: "esm", target: "node20" });
    const js = code
      .replace(/from "\.\/([\w-]+)"/g, 'from "./$1.js"')
      .replace(/from "\.\.\/willow\/([\w-]+)"/g, 'from "./$1.js"');
    const file = `cli/src/willow-shared/${name}`;
    out[file] = `// GENERATED from ${src} by web/scripts/mirror-willow-to-cli.mjs — do not edit.\n${js}`;
  }
  if (write) {
    mkdirSync(join(repo, "cli/src/willow-shared"), { recursive: true });
    for (const [file, text] of Object.entries(out)) writeFileSync(join(repo, file), text);
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) await mirror();
