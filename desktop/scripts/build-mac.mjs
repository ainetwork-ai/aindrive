// Builds the macOS app and its .dmg from Linux (or macOS):
//
//   node scripts/build-mac.mjs            # arm64 + x64
//   node scripts/build-mac.mjs arm64      # one arch
//
// 1. bundles the CLI agent into cli/ (prepare-cli.mjs)
// 2. per arch: puts that arch's prebuilt better-sqlite3 (Electron ABI) in
//    node_modules, packages aindrive.app with electron-builder (`dir` target)
// 3. signs the app ad-hoc with rcodesign — Apple Silicon refuses to run
//    unsigned code, and packaging changed Electron's bundle. Not notarized:
//    see README ("Opening it the first time").
// 4. wraps it in dist/aindrive-<version>-mac-<arch>.dmg (Docker toolchain in
//    scripts/dmg/: xorrisofs + libdmg-hfsplus), with an /Applications link.
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const desktop = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(desktop, "package.json"), "utf8"));
const electronVersion = JSON.parse(readFileSync(join(desktop, "node_modules/electron/package.json"), "utf8")).version;
const sqliteVersion = JSON.parse(readFileSync(join(desktop, "node_modules/better-sqlite3/package.json"), "utf8")).version;
const cache = join(desktop, ".cache");
const archs = process.argv.slice(2).length ? process.argv.slice(2) : ["arm64", "x64"];
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: "inherit", cwd: desktop, ...opts });
mkdirSync(cache, { recursive: true });

/** Electron's NODE_MODULE_VERSION, which picks the prebuilt binary. */
function electronAbi() {
  const major = Number(electronVersion.split(".")[0]);
  const reg = JSON.parse(execFileSync("curl", ["-fsSL", "https://raw.githubusercontent.com/nodejs/node/main/doc/abi_version_registry.json"]).toString());
  const hit = reg.NODE_MODULE_VERSION.find((x) => x.runtime === "electron" && x.versions.split(/[ ,]+/).map(Number).includes(major));
  if (!hit) throw new Error(`no ABI known for Electron ${major}`);
  return hit.modules;
}

function sqliteFor(arch, abi) {
  const name = `better-sqlite3-v${sqliteVersion}-electron-v${abi}-darwin-${arch}.tar.gz`;
  const dir = join(cache, name.replace(/\.tar\.gz$/, ""));
  if (!existsSync(join(dir, "build/Release/better_sqlite3.node"))) {
    mkdirSync(dir, { recursive: true });
    run("sh", ["-c", `curl -fsSL "https://github.com/WiseLibs/better-sqlite3/releases/download/v${sqliteVersion}/${name}" | tar -xz -C "${dir}"`]);
  }
  return join(dir, "build/Release/better_sqlite3.node");
}

function rcodesign() {
  const bin = join(cache, "rcodesign");
  if (process.platform === "darwin") return "codesign";
  if (!existsSync(bin)) {
    const v = "0.29.0";
    const tgz = `apple-codesign-${v}-x86_64-unknown-linux-musl`;
    run("sh", ["-c", `curl -fsSL "https://github.com/indygreg/apple-platform-rs/releases/download/apple-codesign/${v}/${tgz}.tar.gz" | tar -xz -C "${cache}" && mv "${cache}/${tgz}/rcodesign" "${bin}" && rm -rf "${cache}/${tgz}"`]);
    chmodSync(bin, 0o755);
  }
  return bin;
}

function sign(app) {
  const tool = rcodesign();
  if (tool === "codesign") run("codesign", ["--force", "--deep", "--sign", "-", app]);
  else run(tool, ["sign", app]); // no identity given → ad-hoc, nested code included
}

function dmg(app, arch) {
  const out = join(desktop, "dist", `aindrive-${pkg.version}-mac-${arch}.dmg`);
  if (process.platform === "darwin") {
    run("hdiutil", ["create", "-volname", "aindrive", "-srcfolder", app, "-ov", "-format", "UDZO", out]);
    return out;
  }
  run("docker", ["build", "-q", "-t", "aindrive-dmg-tools", join(desktop, "scripts/dmg")]);
  const stage = join(desktop, "dist", `.stage-${arch}`);
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  run("cp", ["-a", app, stage]);
  symlinkSync("/Applications", join(stage, "Applications"));
  const uid = `${process.getuid()}:${process.getgid()}`;
  run("docker", [
    "run", "--rm", "-u", uid, "-v", `${join(desktop, "dist")}:/work`, "aindrive-dmg-tools", "sh", "-c",
    `xorrisofs -D -V aindrive -no-pad -r -dir-mode 0755 -o /work/.raw-${arch}.dmg /work/.stage-${arch} -- -volume_date all_file_dates =1 ` +
      `&& dmg /work/.raw-${arch}.dmg "/work/aindrive-${pkg.version}-mac-${arch}.dmg" && rm /work/.raw-${arch}.dmg`,
  ]);
  rmSync(stage, { recursive: true, force: true });
  return out;
}

run(process.execPath, ["scripts/prepare-cli.mjs"]);
const abi = electronAbi();
const sqliteTarget = join(desktop, "node_modules/better-sqlite3/build/Release/better_sqlite3.node");
for (const arch of archs) {
  mkdirSync(dirname(sqliteTarget), { recursive: true });
  copyFileSync(sqliteFor(arch, abi), sqliteTarget);
  run("npx", ["electron-builder", "--mac", "dir", `--${arch}`, "--publish", "never"]);
  const app = join(desktop, "dist", arch === "x64" ? "mac" : `mac-${arch}`, "aindrive.app");
  sign(app);
  console.log(`✓ ${dmg(app, arch)}`);
}
