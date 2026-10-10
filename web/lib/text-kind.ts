// Which files open as TEXT (the code viewer) when their name says nothing
// useful: extensionless and dot files (`Dockerfile`, `Makefile`, `.gitignore`,
// `LICENSE`, …) have no mime type, so by extension alone they were "binary"
// and showed no preview. Pure — shared by the mime classifier (lib/mime.ts,
// fs/read's transport choice), the viewer (components/viewer.tsx) and the repo
// pages. The last resort is a content sniff: the first 8 KiB without a NUL byte
// is text (looksLikeText); the viewer does that over the stream route with a
// Range request, the repo pages over the bytes they already hold.

/** Names (case-insensitive) that are text regardless of extension → Monaco language. */
const TEXT_NAMES: Record<string, string> = {
  dockerfile: "dockerfile", containerfile: "dockerfile", makefile: "makefile", gnumakefile: "makefile",
  procfile: "yaml", license: "plaintext", licence: "plaintext", copying: "plaintext", readme: "markdown",
  changelog: "markdown", changes: "plaintext", authors: "plaintext", contributors: "plaintext",
  notice: "plaintext", todo: "plaintext", version: "plaintext", cname: "plaintext",
  ".gitignore": "ini", ".gitattributes": "ini", ".gitmodules": "ini", ".dockerignore": "ini",
  ".editorconfig": "ini", ".npmrc": "ini", ".nvmrc": "plaintext", ".python-version": "plaintext",
  ".prettierrc": "json", ".eslintrc": "json", ".babelrc": "json", ".env": "ini",
  "requirements.txt": "plaintext", "pyproject.toml": "toml", "package.json": "json",
};
/** Extension → Monaco language (the viewer's syntax); anything here is text. */
const EXT_LANGUAGE: Record<string, string> = {
  ts: "typescript", tsx: "typescript", js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
  json: "json", md: "markdown", markdown: "markdown", html: "html", htm: "html", css: "css", scss: "scss", less: "less",
  py: "python", pyi: "python", rs: "rust", go: "go", yaml: "yaml", yml: "yaml", toml: "ini", ini: "ini", cfg: "ini", conf: "ini",
  sh: "shell", bash: "shell", zsh: "shell", sql: "sql", xml: "xml", csv: "plaintext", tsv: "plaintext", txt: "plaintext",
  env: "ini", example: "ini", sample: "ini", lock: "plaintext", log: "plaintext", dockerfile: "dockerfile", mk: "makefile",
  java: "java", kt: "kotlin", swift: "swift", c: "c", h: "c", cpp: "cpp", hpp: "cpp", cs: "csharp", rb: "ruby", php: "php",
  lua: "lua", r: "r", dart: "dart", scala: "scala", graphql: "graphql", proto: "protobuf", svg: "xml", vue: "html", svelte: "html",
  gitignore: "ini", gitattributes: "ini", dockerignore: "ini", editorconfig: "ini", nvmrc: "plaintext",
};

const base = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/**
 * The Monaco language for a file that is text by name, or null when the name
 * alone does not say it is text. `Dockerfile.dev` and `.env.example` count:
 * a known text name followed by one more suffix, and `.env*` is always ini.
 */
export function textLanguageByName(path: string): string | null {
  const name = base(path);
  const lower = name.toLowerCase();
  if (!lower) return null;
  if (TEXT_NAMES[lower]) return TEXT_NAMES[lower];
  if (lower.startsWith(".env")) return "ini";
  if (lower.startsWith("dockerfile") || lower.startsWith("containerfile")) return "dockerfile";
  if (lower.startsWith("makefile")) return "makefile";
  const parts = lower.split(".");
  // "Dockerfile.dev", "README.rst", "LICENSE.txt": the stem is a known text name
  if (parts.length > 1 && parts[0] && TEXT_NAMES[parts[0]]) return EXT_LANGUAGE[parts[parts.length - 1]] ?? TEXT_NAMES[parts[0]];
  const ext = parts.length > 1 ? parts[parts.length - 1] : "";
  if (ext && EXT_LANGUAGE[ext]) return EXT_LANGUAGE[ext];
  return null;
}

/** True when the name alone says this is a text file. */
export const isTextByName = (path: string) => textLanguageByName(path) !== null;

/** Whether the name gives no verdict at all (no known extension, no known name) — the sniff decides then. */
export function needsSniff(path: string, mime: string): boolean {
  if (isTextByName(path)) return false;
  if (mime && mime !== "application/octet-stream" && mime !== "folder") return false;
  return true;
}

export const SNIFF_BYTES = 8 * 1024;
/** Text if the first 8 KiB carry no NUL byte (what `git` and `file(1)` do). Empty is text. */
export function looksLikeText(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, SNIFF_BYTES);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return false;
  return true;
}
