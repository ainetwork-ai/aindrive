// Which renderer the file Viewer uses for a file, decided by extension alone.
//
// Pure + dependency-free so both the client Viewer and server routes can
// import it. The agent's own `entry.mime` is NOT consulted: published CLI
// versions ship a ~25-entry mime table, so anything outside it (bmp, tiff,
// docx, …) arrives as application/octet-stream and would never preview.
//
// Coverage target: every type Google Drive previews
// (https://support.google.com/drive/answer/37603) — pinned by
// preview-kind.test.ts. See docs/superpowers/specs/2026-09-23-file-preview-coverage-design.md.

export type PreviewKind =
  | "markdown"  // rich-text (TipTap + Yjs) editor
  | "text"      // Monaco (collaborative code/text editor)
  | "image"     // browser-native <img>
  | "tiff"      // decoded client-side (utif) → canvas
  | "psd"       // composite decoded client-side (ag-psd)
  | "pdf"       // pdf.js; also Illustrator .ai (PDF-compatible container)
  | "video"     // <video>; falls back to a server transcode when the codec won't play
  | "audio"     // <audio>
  | "docx"      // docx-preview
  | "sheet"     // SheetJS
  | "pptx"      // pptx-preview
  | "archive"   // libarchive.js listing + single-entry extract
  | "font"      // FontFace specimen
  | "dxf"       // dxf-viewer (WebGL)
  | "converted" // server converter → PDF (legacy Office, iWork, PostScript, XPS)
  | "none";     // no inline preview; download only

const TABLE: Record<Exclude<PreviewKind, "none">, string[]> = {
  markdown: ["md", "markdown"],
  text: [
    "txt", "log", "text", "json", "jsonc", "json5", "ndjson",
    "js", "mjs", "cjs", "jsx", "ts", "mts", "cts", "tsx",
    "html", "htm", "xhtml", "css", "scss", "sass", "less",
    "py", "pyi", "rs", "go", "java", "kt", "kts", "scala", "groovy", "gradle",
    "c", "h", "cpp", "cc", "cxx", "hpp", "hh", "hxx", "m", "mm", "cs", "swift", "dart",
    "php", "rb", "pl", "pm", "lua", "r", "jl", "ex", "exs", "erl", "hs", "clj", "elm",
    "sh", "bash", "zsh", "fish", "ps1", "bat", "cmd",
    "sql", "graphql", "gql", "proto", "vue", "svelte", "astro",
    "yml", "yaml", "toml", "ini", "cfg", "conf", "properties", "env",
    "xml", "xsd", "xsl", "plist", "csv", "tsv", "tex", "bib", "rst", "adoc", "org",
    "diff", "patch", "srt", "vtt", "dockerfile", "makefile", "cmake",
  ],
  image: ["jpg", "jpeg", "jpe", "jfif", "png", "apng", "gif", "webp", "bmp", "dib", "svg", "ico", "avif"],
  tiff: ["tif", "tiff"],
  psd: ["psd"],
  pdf: ["pdf", "ai"],
  video: [
    // native in browsers:
    "mp4", "m4v", "webm", "mov", "ogv", "mkv",
    // transcoded server-side (see NATIVE_VIDEO):
    "avi", "wmv", "asf", "flv", "f4v", "3gp", "3g2", "mpg", "mpeg", "mpe", "m1v", "m2v", "vob", "m2ts", // not ts/mts: TypeScript owns those
  ],
  audio: ["mp3", "mpga", "mp2", "m2a", "wav", "ogg", "oga", "opus", "m4a", "aac", "flac", "weba"],
  docx: ["docx", "docm", "dotx", "dotm"],
  sheet: ["xlsx", "xlsm", "xltx", "xltm", "xlsb", "xls", "ods"],
  pptx: ["pptx", "pptm", "ppsx", "ppsm", "potx"],
  archive: ["zip", "rar", "7z", "tar", "gz", "tgz", "bz2", "tbz", "tbz2", "xz", "txz"],
  font: ["ttf", "otf", "woff", "woff2"],
  dxf: ["dxf"],
  converted: [
    "doc", "dot", "rtf", "odt", "ott", "wpd",
    "ppt", "pps", "pot", "odp",
    "key", "numbers", "pages",
    "eps", "ps",
    "xps", "oxps",
  ],
};

// Containers browsers usually decode in <video>. Everything else in the video
// row goes straight to the server transcode instead of a doomed native try.
const NATIVE_VIDEO = new Set(["mp4", "m4v", "webm", "mov", "ogv", "mkv"]);

const BY_EXT = new Map<string, PreviewKind>();
for (const [kind, exts] of Object.entries(TABLE) as Array<[PreviewKind, string[]]>) {
  for (const e of exts) {
    // An extension in two rows would silently route to whichever came last.
    if (BY_EXT.has(e)) throw new Error(`preview-kind: .${e} listed under both ${BY_EXT.get(e)} and ${kind}`);
    BY_EXT.set(e, kind);
  }
}

// Extension-less files that are conventionally text.
const TEXT_BASENAMES = new Set([
  "dockerfile", "makefile", "readme", "license", "licence", "changelog",
  "authors", "contributors", "notice", "gemfile", "procfile", "vagrantfile",
  ".gitignore", ".gitattributes", ".dockerignore", ".npmrc", ".editorconfig", ".env",
]);

/** Lowercased extension without the dot ("" when none). ".env" → "". */
export function extOf(name: string): string {
  const base = name.slice(name.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

export function previewKindFor(name: string): PreviewKind {
  const ext = extOf(name);
  const kind = BY_EXT.get(ext);
  if (kind) return kind;
  const base = name.slice(name.lastIndexOf("/") + 1).toLowerCase();
  if (TEXT_BASENAMES.has(base)) return "text";
  return "none";
}

/** Video the browser should try natively before asking for a transcode. */
export function isNativeVideo(name: string): boolean {
  return NATIVE_VIDEO.has(extOf(name));
}

/** Monaco language id for a text-kind file. */
export function monacoLanguageFor(name: string): string {
  const ext = extOf(name);
  const base = name.slice(name.lastIndexOf("/") + 1).toLowerCase();
  if (base === "dockerfile" || ext === "dockerfile") return "dockerfile";
  const map: Record<string, string> = {
    ts: "typescript", mts: "typescript", cts: "typescript", tsx: "typescript",
    js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
    json: "json", jsonc: "json", json5: "json",
    html: "html", htm: "html", xhtml: "html", vue: "html", svelte: "html", astro: "html",
    css: "css", scss: "scss", sass: "scss", less: "less",
    py: "python", pyi: "python", rs: "rust", go: "go", java: "java",
    kt: "kotlin", kts: "kotlin", scala: "scala", groovy: "java", gradle: "java",
    c: "c", h: "c", cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp", hxx: "cpp",
    m: "objective-c", mm: "objective-c", cs: "csharp", swift: "swift", dart: "dart",
    php: "php", rb: "ruby", pl: "perl", pm: "perl", lua: "lua", r: "r", jl: "julia",
    ex: "elixir", exs: "elixir", clj: "clojure",
    sh: "shell", bash: "shell", zsh: "shell", fish: "shell", ps1: "powershell", bat: "bat", cmd: "bat",
    sql: "sql", graphql: "graphql", gql: "graphql", proto: "proto",
    yml: "yaml", yaml: "yaml", toml: "ini", ini: "ini", cfg: "ini", conf: "ini", properties: "ini",
    xml: "xml", xsd: "xml", xsl: "xml", plist: "xml",
    tex: "latex", bib: "latex", rst: "restructuredtext", diff: "plaintext", patch: "plaintext",
  };
  return map[ext] || "plaintext";
}
