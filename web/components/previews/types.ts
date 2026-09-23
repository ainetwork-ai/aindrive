// Contract every inline preview renderer implements. See README.md here.

/** A file to preview, independent of where its bytes live. */
export type PreviewSource = {
  /** Display name (basename) — also what the renderer is chosen from. */
  name: string;
  /** Same-origin URL for the raw bytes: fs/stream for drive files, a blob: URL
      for an archive member. Range-capable only for fs/stream. */
  url: string;
  /** Byte size (for size guards before a client-side parse). */
  size: number;
  /** Fetch the whole file once (memoized per source). Renderers that parse in
      the browser (docx, sheet, psd, …) use this rather than fetching `url`. */
  bytes: () => Promise<ArrayBuffer>;
  /** Server conversion URL (fs/preview) for this drive file. Absent for
      archive members — those never round-trip through the server. */
  convertUrl?: (target: "pdf" | "mp4") => string;
};

export type PreviewProps = { src: PreviewSource };
