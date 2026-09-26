// web/lib/__tests__/willow-mirror.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mirror } from "../../scripts/mirror-willow-to-cli.mjs";

describe("cli's generated copy of web/shared/willow", () => {
  it("matches what the generator produces now (run: node web/scripts/mirror-willow-to-cli.mjs)", async () => {
    const out = await mirror({ write: false });
    for (const [file, text] of Object.entries(out)) expect(readFileSync(join(__dirname, "../../..", file), "utf8"), file).toBe(text);
  });
});
