// Builds the mobile shell (../mobile — the same UI as the phone app) into
// desktop/shell/, with the Mac's Capacitor bridge (src/shell/mac-bridge.js)
// loaded first and a strict CSP. The window serves it as app://shell/.
import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const desktop = join(dirname(fileURLToPath(import.meta.url)), "..");
const mobile = join(desktop, "..", "mobile");
const out = join(desktop, "shell");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

if (!existsSync(join(mobile, "node_modules"))) execFileSync(npm, ["ci", "--ignore-scripts"], { cwd: mobile, stdio: "inherit" });
execFileSync(npm, ["run", "build"], { cwd: mobile, stdio: "inherit" });
rmSync(out, { recursive: true, force: true });
cpSync(join(mobile, "dist"), out, { recursive: true });
copyFileSync(join(desktop, "src", "shell", "mac-bridge.js"), join(out, "mac-bridge.js"));

// Network goes through the bridge (native fetch), so the page itself only
// loads its own files; images may come from the server or data/blob URLs.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' app: data: blob: https: http:",
  "media-src 'self' app: data: blob: https: http:",
  "font-src 'self' data:",
  "connect-src 'self' app: data: blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-src 'none'",
].join("; ");
const index = join(out, "index.html");
let html = readFileSync(index, "utf8");
if (!html.includes("<head>")) throw new Error("mobile/dist/index.html has no <head>");
html = html.replace(
  "<head>",
  `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />\n    <script src="./mac-bridge.js"></script>`,
);
writeFileSync(index, html);
console.log("✓ desktop/shell (mobile shell + mac bridge)");
