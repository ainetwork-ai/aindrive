import { test, describe } from "vitest";
import { cases } from "./cases.mjs";

describe("aindrive scenarios", () => {
  for (const c of cases) {
    const fn = c.skip
      ? test.skip
      : test;
    fn(`#${String(c.id).padStart(3, "0")} ${c.name}`, async () => {
      await c.run();
    }, 60_000);
  }
});
