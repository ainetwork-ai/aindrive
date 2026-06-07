// Copy the Monaco editor runtime into public/ so the browser loads it from our
// own origin (/monaco/vs) instead of @monaco-editor/loader's default jsdelivr CDN.
// The app CSP (middleware.ts: script-src 'self') blocks external CDN scripts, so
// self-hosting is required for the file viewer's editor to initialize.
//
// Runs on predev/prebuild (package.json). The copied tree is a build artifact —
// gitignored (public/monaco) and regenerated from the pinned monaco-editor version.
import { cpSync, existsSync, rmSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, "..");
const src = resolve(webRoot, "node_modules/monaco-editor/min/vs");
const dest = resolve(webRoot, "public/monaco/vs");

if (!existsSync(src)) {
  console.error(`[copy-monaco] source missing: ${src}\n  run \`npm install\` first.`);
  process.exit(1);
}

// Skip the 15MB copy when the destination already matches the installed version.
const versionFile = resolve(webRoot, "public/monaco/.version");
const installed = JSON.parse(
  readFileSync(resolve(webRoot, "node_modules/monaco-editor/package.json"), "utf8")
).version;
if (existsSync(dest) && existsSync(versionFile) && readFileSync(versionFile, "utf8") === installed) {
  console.log(`[copy-monaco] up to date (monaco-editor@${installed})`);
  process.exit(0);
}

rmSync(resolve(webRoot, "public/monaco"), { recursive: true, force: true });
cpSync(src, dest, { recursive: true });
import("node:fs").then(({ writeFileSync, mkdirSync }) => {
  mkdirSync(resolve(webRoot, "public/monaco"), { recursive: true });
  writeFileSync(versionFile, installed);
  console.log(`[copy-monaco] copied monaco-editor@${installed} → public/monaco/vs`);
});
