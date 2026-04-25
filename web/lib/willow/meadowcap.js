import { Meadowcap } from "@earthstar/meadowcap";
import {
  namespaceKeypairScheme,
  userScheme,
  payloadScheme,
  pathScheme,
  isCommunal,
  generateEd25519Keypair,
} from "./schemes.js";

let mc;
export function meadowcap() {
  if (!mc) {
    mc = new Meadowcap({
      namespaceKeypairScheme,
      userScheme,
      payloadScheme,
      pathScheme,
      isCommunal,
    });
  }
  return mc;
}

export { generateEd25519Keypair };

/**
 * Encode a Path (array of Uint8Array components) from a forward-slash string.
 * "docs/q1/notes.md" → [Uint8Array("docs"), Uint8Array("q1"), Uint8Array("notes.md")]
 * Empty string → []
 */
export function pathFromString(str) {
  if (!str) return [];
  return str.split("/").filter(Boolean).map((s) => new TextEncoder().encode(s));
}

export function pathToString(path) {
  if (!path || path.length === 0) return "";
  return path.map((c) => new TextDecoder().decode(c)).join("/");
}
