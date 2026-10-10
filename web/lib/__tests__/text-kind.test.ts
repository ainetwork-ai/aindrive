// lib/text-kind.ts — extensionless / dot files that are text open in the code
// viewer (the owner hit `Dockerfile` with no preview), with the right syntax;
// a name that says nothing is decided by a NUL-byte sniff; and none of them is
// ever offered ▶ Run (only .py/.js/.mjs — lib/git-panel.ts runLanguageFor).
import { describe, it, expect } from "vitest";
import { isTextByName, looksLikeText, needsSniff, textLanguageByName } from "../text-kind";
import { classifyKind } from "../mime";
import { runLanguageFor } from "../git-panel";

describe("textLanguageByName", () => {
  it("knows the usual extensionless and dot files, with their Monaco language", () => {
    expect(textLanguageByName("clef-artwork-search/Dockerfile")).toBe("dockerfile");
    expect(textLanguageByName("Dockerfile.dev")).toBe("dockerfile");
    expect(textLanguageByName("Containerfile")).toBe("dockerfile");
    expect(textLanguageByName("Makefile")).toBe("makefile");
    expect(textLanguageByName("Procfile")).toBe("yaml");
    for (const n of ["LICENSE", "README", "CHANGELOG", "AUTHORS", ".gitignore", ".gitattributes", ".dockerignore", ".editorconfig", ".env.example", ".nvmrc", ".python-version"]) {
      expect(isTextByName(n), n).toBe(true);
    }
    expect(textLanguageByName(".env")).toBe("ini");
    expect(textLanguageByName(".env.local")).toBe("ini");
    expect(textLanguageByName(".gitignore")).toBe("ini");
    expect(textLanguageByName("README.rst")).toBe("markdown");
    expect(textLanguageByName("LICENSE.txt")).toBe("plaintext");
    expect(textLanguageByName("main.py")).toBe("python");
    expect(textLanguageByName("x.tsx")).toBe("typescript");
  });
  it("says nothing about a name it does not know — the sniff decides those", () => {
    expect(textLanguageByName("photo.jpg")).toBeNull();
    expect(textLanguageByName("archive.bin")).toBeNull();
    expect(textLanguageByName("mystery")).toBeNull();
    expect(needsSniff("mystery", "application/octet-stream")).toBe(true);
    expect(needsSniff("photo.jpg", "image/jpeg")).toBe(false);
    expect(needsSniff("Dockerfile", "application/octet-stream")).toBe(false);
  });
});

describe("looksLikeText", () => {
  it("is text without a NUL in the first 8 KiB, binary otherwise", () => {
    expect(looksLikeText(new TextEncoder().encode("FROM python:3.12\nRUN pip install x\n"))).toBe(true);
    expect(looksLikeText(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]))).toBe(false);
    expect(looksLikeText(new Uint8Array(0))).toBe(true);
    const late = new Uint8Array(9000).fill(0x61); late[8500] = 0; // a NUL past the sniff window does not count
    expect(looksLikeText(late)).toBe(true);
  });
});

describe("the classifier and Run agree", () => {
  it("classifyKind serves Dockerfile & co. as text/plain, so fs/read sends utf8", () => {
    expect(classifyKind("repositories/clef/Dockerfile")).toEqual({ kind: "text", mime: "text/plain" });
    expect(classifyKind(".gitignore")).toEqual({ kind: "text", mime: "text/plain" });
    expect(classifyKind("blob.bin").kind).toBe("binary");
    expect(classifyKind("a.py").kind).toBe("text");
  });
  it("Run is only for .py / .js / .mjs — never for text-by-name files", () => {
    for (const n of ["Dockerfile", "Makefile", ".gitignore", "LICENSE", "README.md", "requirements.txt", ".env"]) expect(runLanguageFor(n), n).toBeNull();
    expect(runLanguageFor("art_search.py")).toBe("python");
    expect(runLanguageFor("index.mjs")).toBe("node");
  });
});
