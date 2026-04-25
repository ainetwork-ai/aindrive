/**
 * Scenario runner — loads test cases from scenarios/cases.mjs and runs them
 * sequentially, printing PASS/FAIL summary and updating docs/TEST_SCENARIOS.md.
 *
 * NOTE: vitest is the new primary test path. Use `npm test` (vitest run) for
 * parallelization, watch mode, snapshots, and JUnit XML output.
 * This file is kept for lightweight CI scripts that don't have vitest installed.
 */
import { cases } from "./cases.mjs";
import { readFileSync, writeFileSync } from "node:fs";

const PATH = "/mnt/newdata/git/aindrive/docs/TEST_SCENARIOS.md";
const FILTER = process.env.SCENARIO || null;

let pass = 0, fail = 0, skipped = 0;
const results = new Map(); // id → 'pass' | 'fail' | 'skip'
const failures = [];

for (const c of cases) {
  if (FILTER && !String(c.id).match(FILTER)) continue;
  process.stdout.write(`#${String(c.id).padStart(3, "0")} ${c.name} … `);
  if (c.skip) { console.log("SKIP"); skipped++; results.set(c.id, "skip"); continue; }
  try {
    await c.run();
    console.log("PASS");
    pass++; results.set(c.id, "pass");
  } catch (e) {
    console.log("FAIL — " + (e?.message || e));
    fail++; results.set(c.id, "fail");
    failures.push({ id: c.id, name: c.name, error: e?.message || String(e) });
  }
}

// Update markdown checkboxes
let md = readFileSync(PATH, "utf8");
for (const [id, r] of results) {
  const symbol = r === "pass" ? "🟢" : r === "fail" ? "🔴" : "⚪";
  md = md.replace(new RegExp(`(^${id}\\. )(⬜|🟢|🔴|⚪)`, "m"), `$1${symbol}`);
}
writeFileSync(PATH, md);

console.log(`\n${pass} pass · ${fail} fail · ${skipped} skip · ${pass + fail + skipped} total`);
if (failures.length) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  #${f.id} ${f.name}: ${f.error}`);
  process.exit(1);
}
