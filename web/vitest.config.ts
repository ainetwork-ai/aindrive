import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
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
