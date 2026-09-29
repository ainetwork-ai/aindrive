#!/usr/bin/env node
// Operator: bind a drive to an AIN SSO organization (docs/DEPLOY.md
// "Organization drives"; model in docs/PERMISSIONS.md "Organizations").
// Runs against the server's SQLite DB (AINDRIVE_DATA_DIR) with the server's
// env — in production: `docker compose exec web node scripts/org-drive.mjs …`.
// Takes effect at once (access is read per request); audited in sso_audit
// with actor `operator`.
//
//   orgs                                          organizations AIN SSO pushed, with their drives
//   list    --drive <id>                          organizations a drive is shared with
//   share   --drive <id> --org <slug|id> [--role viewer|editor] [--issuer <url>] [--force]
//   unshare --drive <id> --org <slug|id> [--issuer <url>]

const USAGE = `usage:
  node scripts/org-drive.mjs orgs
  node scripts/org-drive.mjs list    --drive <driveId>
  node scripts/org-drive.mjs share   --drive <driveId> --org <slug|orgId> [--role viewer|editor] [--issuer <url>] [--force]
  node scripts/org-drive.mjs unshare --drive <driveId> --org <slug|orgId> [--issuer <url>]`;

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith("--")) throw new Error(`unexpected argument: ${a}`);
    const key = a.slice(2);
    if (key === "force" || key === "help") { opts[key] = true; continue; }
    const val = rest[i + 1];
    if (val === undefined || val.startsWith("--")) throw new Error(`--${key} needs a value`);
    opts[key] = val;
    i++;
  }
  return { cmd, opts };
}

function fail(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

let parsed;
try { parsed = parseArgs(process.argv.slice(2)); } catch (e) { fail(`${e.message}\n${USAGE}`); }
const { cmd, opts } = parsed;
if (!cmd || opts.help || !["orgs", "list", "share", "unshare"].includes(cmd)) {
  console.log(USAGE);
  process.exit(cmd && !opts.help ? 1 : 0);
}

// Same env as the server (.env / .env.local outside the container), then the DB.
await import("../lib/load-env.js");
const { db } = await import("../lib/db.js");
const orgs = await import("../lib/orgs.js");

function driveOrFail(id) {
  if (!id) fail(`--drive is required\n${USAGE}`);
  const d = db.prepare("SELECT d.id, d.name, d.owner_id, u.email AS owner_email FROM drives d LEFT JOIN users u ON u.id = d.owner_id WHERE d.id = ?").get(id);
  if (!d) fail(`no drive with id ${id}`);
  return d;
}

function orgOrFail(query, issuer) {
  if (!query) fail(`--org is required\n${USAGE}`);
  const wanted = issuer || orgs.orgAccessIssuer();
  let found = orgs.findOrgs(query);
  if (wanted) found = found.filter((o) => o.issuer === wanted);
  if (found.length === 0) {
    fail(`no organization "${query}"${wanted ? ` for issuer ${wanted}` : ""} in sso_memberships — AIN SSO must have provisioned at least one of its members to aindrive first`);
  }
  if (found.length > 1) {
    fail(`"${query}" matches several organizations; pass --issuer:\n${found.map((o) => `  ${o.issuer}  ${o.orgId}  ${o.slug ?? ""}  ${o.name}`).join("\n")}`);
  }
  return found[0];
}

function printShares(driveId) {
  const shares = orgs.listDriveOrgShares(driveId);
  if (shares.length === 0) { console.log("  (not shared with any organization)"); return; }
  for (const s of shares) {
    const state = s.inForce ? "in force" : s.ownerActive ? "paused: AIN SSO is not configured for this issuer" : "paused: the drive's owner is not an active member";
    console.log(`  ${s.name} (${s.slug ?? "-"}, ${s.orgId})  role=${s.role}  active members=${s.activeMembers}  ${state}`);
  }
}

if (cmd === "orgs") {
  const all = orgs.listKnownOrgs();
  if (all.length === 0) console.log("No organizations yet (AIN SSO has provisioned nobody to aindrive).");
  for (const o of all) {
    console.log(`${o.name} (${o.slug ?? "-"}, ${o.orgId})  issuer=${o.issuer}  members=${o.members} (active ${o.activeMembers})`);
    if (o.drives.length === 0) console.log("  no drives");
    for (const d of o.drives) console.log(`  drive ${d.driveId}  ${d.name ?? "(deleted)"}  role=${d.role}`);
  }
} else if (cmd === "list") {
  const d = driveOrFail(opts.drive);
  console.log(`${d.name} (${d.id}), owner ${d.owner_email ?? d.owner_id}`);
  printShares(d.id);
} else if (cmd === "share") {
  const role = opts.role ?? "viewer";
  if (role !== "viewer" && role !== "editor") fail("--role must be viewer or editor");
  const d = driveOrFail(opts.drive);
  const o = orgOrFail(opts.org, opts.issuer);
  const owner = orgs.membershipFor(d.owner_id, o.issuer, o.orgId);
  if (!owner?.active) {
    const msg = `the drive's owner (${d.owner_email ?? d.owner_id}) is not an active member of ${o.name}; an organization share gives access only while its drive's owner is one`;
    if (!opts.force) fail(`${msg}. Serve the folder from an active member's account, or pass --force to record the share anyway.`);
    console.warn(`warning: ${msg} — recorded anyway (--force).`);
  }
  if (orgs.orgAccessIssuer() !== o.issuer) {
    console.warn(`warning: this server's AINDRIVE_SSO_ISSUER/AINDRIVE_SSO_CLIENT_ID are not set for ${o.issuer}; the share stays paused until they are.`);
  }
  const { previousRole } = orgs.shareDriveWithOrg({ driveId: d.id, issuer: o.issuer, orgId: o.orgId, role, actor: "operator", via: "operator" });
  console.log(previousRole === null
    ? `Shared ${d.name} (${d.id}) with ${o.name} as ${role}.`
    : previousRole === role ? `${d.name} (${d.id}) was already shared with ${o.name} as ${role}.`
    : `Changed ${o.name}'s role on ${d.name} (${d.id}) from ${previousRole} to ${role}.`);
  printShares(d.id);
} else if (cmd === "unshare") {
  const d = driveOrFail(opts.drive);
  const o = orgOrFail(opts.org, opts.issuer);
  const removed = orgs.unshareDriveFromOrg({ driveId: d.id, orgId: o.orgId, issuer: o.issuer, actor: "operator" });
  console.log(removed ? `${d.name} (${d.id}) is no longer shared with ${o.name}.` : `${d.name} (${d.id}) was not shared with ${o.name}.`);
}

// lib/db.js starts periodic maintenance timers; this is a one-shot command.
process.exit(0);
