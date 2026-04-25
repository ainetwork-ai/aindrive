/**
 * Composition root — wires every concrete impl to its port in one place.
 *
 * HTTP routes import `compose.<useCase>` and call the use-case directly.
 * Tests can ignore this file entirely and pass mock deps.
 *
 * Adding a new use-case = add an entry here. Adding a new impl for an
 * existing port = swap one wire. No other file changes.
 */

import { rpcFsBrowser } from "./infra/fs/rpc-fs-browser.js";
import { fsAgentRepo } from "./infra/agent-repo/fs-agent-repo.js";
import { rpcAgentExecutor } from "./infra/agent-executor/rpc-agent-executor.js";
import { accessPolicyFactory } from "./use-cases/agent/policies/factory.js";
import { sessionResolver } from "./adapters/http/middleware/identity/session-resolver.js";
import { capBearerResolver } from "./adapters/http/middleware/identity/cap-bearer-resolver.js";
import { compositeResolver } from "./adapters/http/middleware/identity/composite-resolver.js";

// ─── infra (concrete impls of domain ports) ────────────────────────────────

const fs = rpcFsBrowser;
const agents = fsAgentRepo(fs);

// Order matters: session first, cap-bearer second. An owner who also
// happens to hold a cap is recognized as the owner so ownerPolicy fires
// instead of capHolderPolicy (more specific identity wins).
const identityResolver = compositeResolver([sessionResolver, capBearerResolver]);

// ─── use-case dependency bundles ───────────────────────────────────────────

export const compose = {
  askAgent: {
    agents,
    identityResolver,
    policyFactory: accessPolicyFactory,
    executor: rpcAgentExecutor,
  },
  createAgent: {
    agents,
  },
  // Direct handles for routes that need to do their own thing
  // (e.g. the create route loads the drive's namespace pubkey before
  // calling createAgent — no port abstraction for that yet).
  agents,
  identityResolver,
  fs,
};
