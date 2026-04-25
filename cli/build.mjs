import { build } from "esbuild";
import { chmod, rm, readFile, writeFile } from "node:fs/promises";

await rm("dist", { recursive: true, force: true });

await build({
  entryPoints: ["bin/aindrive.mjs"],
  bundle: true,
  outfile: "dist/aindrive.mjs",
  platform: "node",
  target: "node20",
  format: "esm",
  external: ["better-sqlite3"],
  banner: {
    js: [
      "#!/usr/bin/env node",
      "import { createRequire as __aindriveCreateRequire } from 'node:module';",
      "const require = __aindriveCreateRequire(import.meta.url);",
    ].join("\n"),
  },
  legalComments: "none",
  loader: { ".json": "json" },
  minify: false,
  sourcemap: false,
  logLevel: "info",
});

const out = await readFile("dist/aindrive.mjs", "utf8");
const cleaned = out.replace(/^#!\/usr\/bin\/env node\n(?=#!\/usr\/bin\/env node\n)/, "");
if (cleaned !== out) await writeFile("dist/aindrive.mjs", cleaned);

await chmod("dist/aindrive.mjs", 0o755);
console.log("✓ built dist/aindrive.mjs");
