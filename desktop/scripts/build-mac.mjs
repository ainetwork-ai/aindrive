// Builds the macOS app and its .dmg from Linux (or macOS):
//
//   node scripts/build-mac.mjs            # arm64 + x64
//   node scripts/build-mac.mjs arm64      # one arch
//
// 1. bundles the CLI agent into cli/ (prepare-cli.mjs) and the mobile shell into
//    shell/ (prepare-shell.mjs)
// 2. per arch: puts that arch's prebuilt better-sqlite3 (Electron ABI) and
//    node-llama-cpp binary (@node-llama-cpp/mac-<arch>, N-API so no ABI pin) in
//    node_modules, packages aindrive.app with electron-builder (`dir` target,
//    the other arch's llama binary left out). The LLM itself (a 2 GB GGUF) is
//    never bundled: the app downloads it on request (src/agent/llm.js)
// 3. signs the app ad-hoc with rcodesign — Apple Silicon refuses to run
//    unsigned code, and packaging changed Electron's bundle. Not notarized:
//    see README ("Opening it the first time").
// 4. wraps it in dist/aindrive-<version>-mac-<arch>.dmg (Docker toolchain in
//    scripts/dmg/: xorrisofs + libdmg-hfsplus), with an /Applications link.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const desktop = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(desktop, "package.json"), "utf8"));
const electronVersion = JSON.parse(readFileSync(join(desktop, "node_modules/electron/package.json"), "utf8")).version;
const sqliteVersion = JSON.parse(readFileSync(join(desktop, "node_modules/better-sqlite3/package.json"), "utf8")).version;
const llamaVersion = JSON.parse(readFileSync(join(desktop, "node_modules/node-llama-cpp/package.json"), "utf8")).version;
const cache = join(desktop, ".cache");
const archs = process.argv.slice(2).length ? process.argv.slice(2) : ["arm64", "x64"];
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: "inherit", cwd: desktop, ...opts });
mkdirSync(cache, { recursive: true });

// Everything downloaded into the shipped app is pinned here. Bumping Electron or
// better-sqlite3 means adding the new ABI / hashes (the build refuses otherwise).
/** Electron major → NODE_MODULE_VERSION (nodejs/node doc/abi_version_registry.json) */
const ELECTRON_ABI = { 42: 146 };
/** sha256 of each prebuilt better-sqlite3 tarball, by file name */
const SQLITE_SHA256 = {
  "better-sqlite3-v12.11.1-electron-v146-darwin-arm64.tar.gz": "5b3b7a2850fb510de1f7c5cfda39dbb165d948f0c820827988c9ed05e93d1ead",
  "better-sqlite3-v12.11.1-electron-v146-darwin-x64.tar.gz": "59b9b7c23bd3cc23cd8e2ac05eae666a2aa1b19d2ce1f9426ab17525dd162ecb",
};
/** node-llama-cpp's prebuilt binary package per arch (npm `dist.integrity`, sha512); the version is node-llama-cpp's. */
const LLAMA_BINS = {
  arm64: { name: "mac-arm64-metal", sha512: { "3.21.1": "6MIDAZV7DXD9R1+jEXWJkFuolni3GATGE6mmuyFYc6ZmtOh9djAy15df0T0AXK3sCmVKL+fQcOAWZezxx4MvQQ==" } },
  x64: { name: "mac-x64", sha512: { "3.21.1": "Q4nyNmbcNiKygBZQZjX+qLk2w3YzoiFpLWsxNURQN7xjyUi2p2rWxjRa7Otg0FrjGf/ri4aQ+X3Uj5Y0zD06eg==" } },
};
const RCODESIGN = { version: "0.29.0", sha256: "dbe85cedd8ee4217b64e9a0e4c2aef92ab8bcaaa41f20bde99781ff02e600002" };

/** Download to a file, refusing it unless its sha256 is the pinned one. */
function fetchVerified(url, file, sha256) {
  run("curl", ["-fsSL", "-o", file, url]);
  const got = createHash("sha256").update(readFileSync(file)).digest("hex");
  if (got !== sha256) {
    rmSync(file, { force: true });
    throw new Error(`checksum mismatch for ${url}: ${got}`);
  }
}

/** Electron's NODE_MODULE_VERSION, which picks the prebuilt binary. */
function electronAbi() {
  const major = Number(electronVersion.split(".")[0]);
  const abi = ELECTRON_ABI[major];
  if (!abi) throw new Error(`Electron ${major}: add its ABI to ELECTRON_ABI (and the matching better-sqlite3 hashes)`);
  return abi;
}

function sqliteFor(arch, abi) {
  const name = `better-sqlite3-v${sqliteVersion}-electron-v${abi}-darwin-${arch}.tar.gz`;
  const sha = SQLITE_SHA256[name];
  if (!sha) throw new Error(`${name}: add its sha256 to SQLITE_SHA256`);
  const dir = join(cache, name.replace(/\.tar\.gz$/, ""));
  if (!existsSync(join(dir, "build/Release/better_sqlite3.node"))) {
    mkdirSync(dir, { recursive: true });
    const tgz = join(cache, name);
    fetchVerified(`https://github.com/WiseLibs/better-sqlite3/releases/download/v${sqliteVersion}/${name}`, tgz, sha);
    run("tar", ["-xzf", tgz, "-C", dir]);
  }
  return join(dir, "build/Release/better_sqlite3.node");
}

/**
 * `node_modules/@node-llama-cpp/<pkg>` for this arch — npm only installs the host's, so the other one is
 * fetched from the registry against its pinned integrity hash. Returns the package to leave out of the app.
 */
function llamaFor(arch) {
  const want = LLAMA_BINS[arch], other = LLAMA_BINS[arch === "x64" ? "arm64" : "x64"];
  const dir = join(desktop, "node_modules/@node-llama-cpp", want.name);
  const installed = existsSync(join(dir, "package.json")) && JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version === llamaVersion;
  if (!installed) {
    const sha512 = want.sha512[llamaVersion];
    if (!sha512) throw new Error(`@node-llama-cpp/${want.name}@${llamaVersion}: add its sha512 to LLAMA_BINS`);
    const tgz = join(cache, `${want.name}-${llamaVersion}.tgz`);
    run("curl", ["-fsSL", "-o", tgz, `https://registry.npmjs.org/@node-llama-cpp/${want.name}/-/${want.name}-${llamaVersion}.tgz`]);
    const got = createHash("sha512").update(readFileSync(tgz)).digest("base64");
    if (got !== sha512) { rmSync(tgz, { force: true }); throw new Error(`integrity mismatch for @node-llama-cpp/${want.name}: ${got}`); }
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    run("tar", ["-xzf", tgz, "-C", dir, "--strip-components=1"]);
  }
  return other.name;
}

/** electron-builder's config for one arch: package.json's `build`, minus the other arch's llama binary. */
function builderConfig(arch, omitLlama) {
  const file = join(cache, `electron-builder-${arch}.json`);
  writeFileSync(file, JSON.stringify({ ...pkg.build, files: [...pkg.build.files, `!node_modules/@node-llama-cpp/${omitLlama}/**`] }, null, 2));
  return file;
}

function rcodesign() {
  const bin = join(cache, "rcodesign");
  if (process.platform === "darwin") return "codesign";
  if (!existsSync(bin)) {
    const v = RCODESIGN.version;
    const name = `apple-codesign-${v}-x86_64-unknown-linux-musl`;
    const tgz = join(cache, `${name}.tar.gz`);
    fetchVerified(`https://github.com/indygreg/apple-platform-rs/releases/download/apple-codesign/${v}/${name}.tar.gz`, tgz, RCODESIGN.sha256);
    run("tar", ["-xzf", tgz, "-C", cache]);
    run("mv", [join(cache, name, "rcodesign"), bin]);
    rmSync(join(cache, name), { recursive: true, force: true });
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
run(process.execPath, ["scripts/prepare-shell.mjs"]);
const abi = electronAbi();
const sqliteTarget = join(desktop, "node_modules/better-sqlite3/build/Release/better_sqlite3.node");
for (const arch of archs) {
  mkdirSync(dirname(sqliteTarget), { recursive: true });
  copyFileSync(sqliteFor(arch, abi), sqliteTarget);
  const omitLlama = llamaFor(arch);
  run("npx", ["electron-builder", "--mac", "dir", `--${arch}`, "--publish", "never", "--config", builderConfig(arch, omitLlama)]);
  const app = join(desktop, "dist", arch === "x64" ? "mac" : `mac-${arch}`, "aindrive.app");
  sign(app);
  console.log(`✓ ${dmg(app, arch)}`);
}
