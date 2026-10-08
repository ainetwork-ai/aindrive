import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";

// Run against the production output: `npm run build` must succeed first.
export default defineConfig({
  testDir: "./e2e",
  testMatch: "offline-fonts.spec.ts",
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:3738",
    browserName: "chromium",
    headless: true,
    serviceWorkers: "block",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node node_modules/next/dist/bin/next start --hostname 127.0.0.1 --port 3738",
    url: "http://127.0.0.1:3738",
    reuseExistingServer: false,
    env: { AINDRIVE_DATA_DIR: resolve(".aindrive/offline-fonts") },
  },
});
