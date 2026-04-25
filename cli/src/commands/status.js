import { readDriveConfig, readGlobalCreds } from "../config.js";
import { resolve } from "node:path";

export async function cmdStatus(args) {
  const creds = await readGlobalCreds();
  console.log("\n  aindrive status");
  console.log("  -----------------");
  if (creds) {
    console.log(`  account : ${creds.email}`);
    console.log(`  server  : ${creds.server}`);
  } else {
    console.log("  account : (not signed in — run `aindrive login`)");
  }
  const dir = resolve(args.positional[1] || ".");
  const drive = await readDriveConfig(dir);
  if (drive) {
    console.log(`  drive   : ${drive.driveId}  (${dir})`);
    console.log(`  url     : ${drive.url || "-"}`);
  } else {
    console.log(`  drive   : (${dir} not linked yet — run \`aindrive\` here)`);
  }
  console.log();
}
