import { resolve } from "node:path";
import { stop } from "../daemon.js";

export async function cmdStop(args) {
  const dir = resolve(args.positional[1] || ".");
  const res = stop(dir);
  if (res.running) {
    console.log(`\n  ✓ stopped the aindrive agent (pid ${res.pid}) for ${dir}\n`);
  } else {
    console.log(`\n  no running aindrive agent for ${dir}\n`);
  }
}
