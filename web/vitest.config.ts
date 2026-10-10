import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
  // Page tests render .tsx server components: Next's tsconfig keeps `jsx: preserve`, so vitest compiles JSX itself.
  esbuild: { jsx: "automatic", jsxImportSource: "react", tsconfigRaw: { compilerOptions: { jsx: "react-jsx" } } },
  oxc: { jsx: { runtime: "automatic", importSource: "react" } },
  test: {
    include: [
      "scenarios/*.test.mjs",
      "lib/**/*.test.ts",
      "lib/**/__tests__/*.test.ts",
    ],
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 60000,
    hookTimeout: 60000,
  },
});
