// Canonical path constants for the scenario suite.
// All scenario files import from ./paths.mjs instead of hardcoding /mnt/newdata/...
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// <repo_root>/web/scenarios/ → two levels up = repo root
const _scenariosDir = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT =
  process.env.AINDRIVE_REPO_ROOT || resolve(_scenariosDir, "../..");

// Default sample fixture is the committed in-repo directory.
// Override with AINDRIVE_SAMPLE_DIR for a tmp copy (Phase 2 harness).
export const SAMPLE =
  process.env.AINDRIVE_SAMPLE_DIR ||
  resolve(REPO_ROOT, "web/scenarios/fixtures/sample");

export const CLI_SRC   = resolve(REPO_ROOT, "cli/src");
export const DIAGNOSE  = resolve(REPO_ROOT, "tools/diagnose.mjs");
export const SCENARIOS_DOC = resolve(REPO_ROOT, "docs/TEST_SCENARIOS.md");
