import { defineConfig } from "drizzle-kit";
import { join } from "node:path";
import { homedir } from "node:os";

const dataDir = process.env.AINDRIVE_DATA_DIR || join(homedir(), ".aindrive");

export default defineConfig({
  schema: "./drizzle/schema.ts",
  out: "./drizzle/migrations",
  dialect: "sqlite",
  dbCredentials: {
    url: join(dataDir, "data.sqlite"),
  },
});
