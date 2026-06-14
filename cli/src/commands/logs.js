import { resolve } from "node:path";
import { followLogs } from "../daemon.js";

export async function cmdLogs(args) {
  const dir = resolve(args.positional[1] || ".");
  await followLogs(dir); // runs until Ctrl+C
}
