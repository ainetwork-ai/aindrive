// vitest config for e2e scenario suite — runs scenarios/*.test.mjs against a
// live server+agent booted by globalSetup. Kept separate from vitest.config.ts
// so `npm test` (lib units) never starts a server.
import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "."),
    },
  },
  test: {
    globalSetup: ["./scenarios/global-setup.mjs"],
    include: ["scenarios/*.test.mjs"],
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
