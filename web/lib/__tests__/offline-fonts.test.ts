import { createRequire } from "node:module";
import { readFile, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import ts from "typescript";
import postcss from "postcss";
import { runInNewContext } from "node:vm";

const options: Record<string, unknown>[] = [];
const source = readFileSync("app/layout.tsx", "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
runInNewContext(compiled, {
  exports: {},
  require: (name: string) => {
    if (name === "next/font/local") return {
      default: (value: Record<string, unknown>) => {
        options.push(value);
        return { variable: value.variable };
      },
    };
    if (["react/jsx-runtime", "sonner", "./globals.css"].includes(name)) return {};
    throw new Error(`Unexpected root-layout dependency: ${name}`);
  },
});

// Exercise Next's real font parser/loader against the exact root-layout options.
// This catches missing/corrupt assets and loss of weight/style/fallback support.
const require = createRequire(import.meta.url);
const loader = require("next/dist/compiled/@next/font/dist/local/loader").default;
const fontPlugin = require("next/dist/build/webpack/loaders/next-font-loader/postcss-next-font").default;

async function load(variable: string) {
  const config = options.find((value) => value.variable === variable);
  expect(config).toBeDefined();
  const emitted: Buffer[] = [];
  const result = await loader({
    functionName: "",
    variableName: variable.slice(2),
    data: [config],
    resolve: async (file: string) => resolve("app", file),
    loaderContext: { fs: { readFile } },
    emitFontFile: (bytes: Buffer, ext: string) => {
      emitted.push(bytes);
      return `/_next/static/media/font-${emitted.length}.${ext}`;
    },
  });
  expect(result.css).not.toMatch(/https?:/);
  expect(result.css).toContain("font-display: swap");
  expect(result.adjustFontFallback.sizeAdjust).toMatch(/^\d+(\.\d+)?%$/);
  const generated = await postcss([fontPlugin({ ...result, exports: [] })])
    .process(result.css, { from: undefined });
  expect(generated.css).toContain(`${variable}:`);
  expect(generated.css).toContain(`local("${result.adjustFontFallback.fallbackFont}")`);
  expect(generated.css).toContain("size-adjust:");
  expect(generated.css).not.toMatch(/https?:/);
  return { ...result, emitted };
}

describe("offline root-layout fonts", () => {
  it("does not restore build-time Google Fonts downloads", () => {
    expect(readFileSync("app/layout.tsx", "utf8")).not.toContain("next/font/google");
  });

  it("ships a variable sans face with a measured Arial and system fallback", async () => {
    const result = await load("--font-sans");
    expect(result.emitted).toHaveLength(1);
    expect(result.css).toContain("font-weight: 100 900");
    expect(result.css).toContain("font-style: normal");
    expect(result.adjustFontFallback.fallbackFont).toBe("Arial");
    expect(result.fallbackFonts).toEqual(["Arial", "ui-sans-serif", "system-ui", "sans-serif"]);
  });

  it("ships real regular/italic display faces and keeps fallback serif", async () => {
    const result = await load("--font-display");
    expect(result.emitted).toHaveLength(2);
    expect(result.emitted[0].equals(result.emitted[1])).toBe(false);
    expect(result.css.match(/font-weight: 400/g)).toHaveLength(2);
    expect(result.css).toContain("font-style: normal");
    expect(result.css).toContain("font-style: italic");
    expect(result.adjustFontFallback.fallbackFont).toBe("Times New Roman");
    expect(result.fallbackFonts).toEqual(["Georgia", "Times New Roman", "serif"]);
  });
});
