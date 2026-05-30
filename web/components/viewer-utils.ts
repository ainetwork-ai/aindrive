// Pure helpers for the file Viewer — crypto/base64/format utilities separated
// from the effect-heavy Viewer component. No React, no side effects.
import type { DriveEntry } from "@/lib/protocol";

export const TEXT_EXT = new Set([
  "txt", "md", "json", "js", "mjs", "ts", "tsx", "jsx", "html", "css",
  "py", "rs", "go", "yml", "yaml", "toml", "sh", "sql", "xml", "csv",
]);

/** Deterministic HSL color from a string (peer identity → avatar color). */
export function colorForId(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return `hsl(${Math.abs(h) % 360}, 70%, 50%)`;
}

/** SHA-1 of a string as a 22-char base64url digest (Yjs persistence key). */
export async function sha1Base64(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(s));
  const bytes = new Uint8Array(buf);
  let bin = ""; for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "").slice(0, 22);
}

/** Uint8Array → base64 (chunked to avoid call-stack limits on large arrays). */
export function bytesToBase64(arr: Uint8Array): string {
  let s = ""; const chunk = 0x8000;
  for (let i = 0; i < arr.length; i += chunk) s += String.fromCharCode(...arr.subarray(i, i + chunk));
  return btoa(s);
}

/** base64 → Uint8Array. */
export function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64); const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Monaco language id for a drive entry's extension. */
export function languageFor(e: DriveEntry): string {
  const map: Record<string, string> = {
    ts: "typescript", tsx: "typescript", js: "javascript", mjs: "javascript", jsx: "javascript",
    json: "json", md: "markdown", html: "html", css: "css",
    py: "python", rs: "rust", go: "go", yaml: "yaml", yml: "yaml",
    sh: "shell", sql: "sql", xml: "xml",
  };
  return map[e.ext] || "plaintext";
}
