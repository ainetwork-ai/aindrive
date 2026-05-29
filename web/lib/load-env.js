// Loads .env / .env.local into process.env BEFORE any other module runs.
//
// Why a dedicated module imported first: ES `import` statements are hoisted
// and evaluated before any top-level statement in the importing file. So
// putting a loadEnvConfig() call at the top of server.js would still run
// AFTER server.js's sibling imports (./lib/db.js, ./lib/dochub.js, the
// migrations) — which open the DB and read AINDRIVE_* at import time. By
// doing the load in this module's own top-level and importing it on the very
// first line of server.js, the env is populated before those siblings load.
//
// @next/env is what Next itself uses; its later call during app.prepare() is
// a cache hit, and it never overrides already-set process.env vars, so shell
// exports still win over .env.local.
// @next/env is CommonJS, so import the default export and destructure —
// `import { loadEnvConfig }` fails at runtime under raw `node server.js`.
import nextEnv from "@next/env";

const dev = process.env.NODE_ENV !== "production";
nextEnv.loadEnvConfig(process.cwd(), dev);
