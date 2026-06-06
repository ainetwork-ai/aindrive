// Vitest config for the cli package.
// ESM-only package (type:module), no TypeScript build step.
// fileParallelism:false keeps SQLite tmp files from colliding between test files.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.mjs", "src/__tests__/**/*.test.mjs"],
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 15000,
  },
});
