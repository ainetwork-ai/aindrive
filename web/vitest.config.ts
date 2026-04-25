import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["scenarios/*.test.mjs"],
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 60000,
    hookTimeout: 60000,
  },
});
