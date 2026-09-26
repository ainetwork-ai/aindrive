// electron-builder afterPack: turn off the Electron fuses this app never needs.
// Agents run as utilityProcess (main.js), so nothing depends on running the app
// binary as plain Node — and leaving that on would let any local program run
// its own code under the folder access the user granted aindrive.
// Signing happens after this (build-mac.mjs), so the flipped binary is what is signed.
const { join } = require("node:path");
const { flipFuses, FuseVersion, FuseV1Options } = require("@electron/fuses");

exports.default = async function afterPack(ctx) {
  if (ctx.electronPlatformName !== "darwin") return;
  const app = join(ctx.appOutDir, `${ctx.packager.appInfo.productFilename}.app`);
  await flipFuses(app, {
    version: FuseVersion.V1,
    resetAdHocDarwinSignature: false,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
  });
};
