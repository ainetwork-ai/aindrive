// @ts-check
// Deliberately .mjs, not .ts: Next loads a `next.config.ts` by transpiling it to
// CommonJS and evaluating it under the virtual filename `next.config.compiled.js`.
// In this `"type": "module"` package Node resolves that name as ESM, so the
// transpiled `exports` reference throws (`exports is not defined in ES module
// scope`) and every build fails. `.js`/`.mjs` configs skip that path and are
// imported as real ESM. Types are preserved by the JSDoc annotation below, and
// tsconfig `include` lists this file so `npm run typecheck` still covers it.
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import("next").NextConfig} */
const config = {
  output: "standalone",
  outputFileTracingRoot: __dirname,
  reactStrictMode: true,
  experimental: {
    serverActions: { bodySizeLimit: "100mb" },
  },
};

export default config;
