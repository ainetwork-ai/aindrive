import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 90000,
  use: {
    baseURL: "http://localhost:3737",
    headless: true,
  },
  workers: 1,
});
