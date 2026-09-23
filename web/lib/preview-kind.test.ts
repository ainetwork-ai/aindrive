import { describe, expect, it } from "vitest";
import { extOf, isNativeVideo, monacoLanguageFor, previewKindFor, previewKindForEntry } from "./preview-kind";

// Every type Google Drive lists as previewable
// (https://support.google.com/drive/answer/37603, fetched 2026-09-23).
// If one of these ever maps to "none", aindrive has lost parity.
const GOOGLE_DRIVE_PREVIEWABLE = [
  // Archive
  "zip", "rar", "tar", "gz",
  // Audio: MP3, MPEG, WAV, .ogg, .opus
  "mp3", "mpga", "wav", "ogg", "opus",
  // Image
  "jpeg", "jpg", "png", "gif", "bmp", "tiff", "tif", "svg",
  // Markup / code
  "css", "html", "php", "c", "cpp", "h", "hpp", "js", "java", "py",
  // Text
  "txt",
  // Video: WebM, MPEG4, 3GPP, MOV, AVI, MPEGPS, WMV, FLV, ogg
  "webm", "mp4", "3gp", "mov", "avi", "mpg", "mpeg", "wmv", "flv",
  // Adobe
  "dxf", "ai", "psd", "pdf", "eps", "ps", "ttf",
  // Microsoft
  "xls", "xlsx", "ppt", "pptx", "doc", "docx", "xps",
  // Apple
  "key", "numbers",
];

describe("previewKindFor", () => {
  it.each(GOOGLE_DRIVE_PREVIEWABLE)("covers Google Drive type .%s", (ext) => {
    expect(previewKindFor(`file.${ext}`)).not.toBe("none");
    expect(previewKindFor(`FILE.${ext.toUpperCase()}`)).not.toBe("none");
  });

  it("routes each family to its renderer", () => {
    expect(previewKindFor("a/b/notes.md")).toBe("markdown");
    expect(previewKindFor("main.cpp")).toBe("text");
    expect(previewKindFor("index.ts")).toBe("text");
    expect(previewKindFor("photo.bmp")).toBe("image");
    expect(previewKindFor("scan.TIF")).toBe("tiff");
    expect(previewKindFor("logo.ai")).toBe("pdf");
    expect(previewKindFor("clip.avi")).toBe("video");
    expect(previewKindFor("song.opus")).toBe("audio");
    expect(previewKindFor("report.docx")).toBe("docx");
    expect(previewKindFor("budget.xls")).toBe("sheet");
    expect(previewKindFor("deck.pptx")).toBe("pptx");
    expect(previewKindFor("deck.ppt")).toBe("converted");
    expect(previewKindFor("backup.tar.gz")).toBe("archive");
    expect(previewKindFor("Font.TTF")).toBe("font");
    expect(previewKindFor("plan.dxf")).toBe("dxf");
    expect(previewKindFor("figure.eps")).toBe("converted");
    expect(previewKindFor("Dockerfile")).toBe("text");
    expect(previewKindFor("program.exe")).toBe("none");
    expect(previewKindFor("noext")).toBe("none");
  });
});

describe("extOf", () => {
  it("handles dotfiles, paths and case", () => {
    expect(extOf(".env")).toBe("");
    expect(extOf("dir.v2/file")).toBe("");
    expect(extOf("x/Y.JPEG")).toBe("jpeg");
  });
});

describe("isNativeVideo", () => {
  it("tries browser playback only for common containers", () => {
    expect(isNativeVideo("a.mp4")).toBe(true);
    expect(isNativeVideo("a.webm")).toBe(true);
    expect(isNativeVideo("a.avi")).toBe(false);
    expect(isNativeVideo("a.wmv")).toBe(false);
  });
});

describe("monacoLanguageFor", () => {
  it("maps the Google Drive code types", () => {
    expect(monacoLanguageFor("x.php")).toBe("php");
    expect(monacoLanguageFor("x.hpp")).toBe("cpp");
    expect(monacoLanguageFor("x.java")).toBe("java");
    expect(monacoLanguageFor("Dockerfile")).toBe("dockerfile");
    expect(monacoLanguageFor("x.unknown")).toBe("plaintext");
  });
});

describe("previewKindForEntry", () => {
  it("falls back to text for agent-tagged text/* the table doesn't list", () => {
    expect(previewKindForEntry("events.jsonl", "text/plain")).toBe("text");
    expect(previewKindForEntry("post.mdx", "text/markdown")).toBe("text");
    expect(previewKindForEntry("yarn.lock", "text/plain")).toBe("text");
  });
  it("keeps the name-based kind otherwise", () => {
    expect(previewKindForEntry("a.docx", "application/octet-stream")).toBe("docx");
    expect(previewKindForEntry("a.png", "text/plain")).toBe("image"); // name wins
    expect(previewKindForEntry("blob.bin", "application/octet-stream")).toBe("none");
    expect(previewKindForEntry("blob.bin", undefined)).toBe("none");
  });
});
