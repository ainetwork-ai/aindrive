#!/usr/bin/env node
// Support: account paid-share payments whose settle outcome the server does
// not know (docs/X402_PAYMENT_PENDING.md). While a row is 'unresolved' the
// account cannot pay for that sale with a NEW authorization (409
// payment_pending) — the server never resolves it from the chain. An operator
// inspects the row, checks the chain READ-ONLY, then credits or releases it.
// Every credit/release is logged with --operator (x402_account_settlement_events).
//
//   list    [--status unresolved|credited|released|all] [--account <id>] [--drive <id>]
//   show    --id <ref>                       row, its log, the account's receipts/role for the sale
//   check   --id <ref> [--rpc <url>] [--lookback-blocks <n>] [--from-block <n>]
//                                            read-only: authorizationState(payer, nonce), the
//                                            transactions that used it, and whether each paid this sale
//   credit  --id <ref> --tx <hash> --operator <name> --note "<why>" [--rpc <url>] [--skip-chain-check]
//                                            receipt + membership (upgrade-only) + 'credited', in one
//                                            transaction. First re-checks on chain that <hash> used this
//                                            authorization and paid the sale's payee the recorded amount.
//   release --id <ref> --operator <name> --note "<why>" [--rpc <url>] [--force]
//                                            the authorization did NOT pay: the account may pay again.
//                                            Refused while the authorization is used on chain (credit it)
//                                            or still valid (validBefore not passed) unless --force.
//
// Runs against the server's SQLite DB and env — in production:
// `docker compose exec web node scripts/x402-settlements.mjs …`.

const USAGE = `usage:
  node scripts/x402-settlements.mjs list    [--status unresolved|credited|released|all] [--account <accountId>] [--drive <driveId>]
  node scripts/x402-settlements.mjs show    --id <ref>
  node scripts/x402-settlements.mjs check   --id <ref> [--rpc <url>] [--lookback-blocks <n>] [--from-block <n>]
  node scripts/x402-settlements.mjs credit  --id <ref> --tx <txHash> --operator <name> --note "<reason>" [--rpc <url>] [--skip-chain-check]
  node scripts/x402-settlements.mjs release --id <ref> --operator <name> --note "<reason>" [--rpc <url>] [--force]`;

const FLAGS = new Set(["force", "skip-chain-check", "help"]);

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith("--")) throw new Error(`unexpected argument: ${a}`);
    const key = a.slice(2);
    if (FLAGS.has(key)) { opts[key] = true; continue; }
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
if (!cmd || opts.help) { console.log(USAGE); process.exit(cmd ? 0 : 1); }

await import("../lib/load-env.js");
const { db } = await import("../lib/db.js");
const S = await import("../lib/x402-account-settlements.js");

const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());
const view = (r) => ({ ...r, created_at: iso(r.created_at), updated_at: iso(r.updated_at) });
const out = (v) => console.log(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 2));

function rowOrFail(id) {
  if (!id) fail(`--id is required\n${USAGE}`);
  const row = S.getSettlement(id);
  if (!row) fail(`no settlement ${id}`);
  return row;
}
function operatorOrFail() {
  const op = typeof opts.operator === "string" ? opts.operator.trim() : "";
  if (!op) fail("--operator <name> is required (who is doing this; it is logged)");
  if (typeof opts.note !== "string" || !opts.note.trim()) fail("--note \"<reason>\" is required (it is logged)");
  return op;
}
async function chain() {
  return import("../lib/x402-authorization-chain.js");
}

if (cmd === "list") {
  const status = opts.status ?? "unresolved";
  if (!["unresolved", "credited", "released", "all"].includes(status)) fail(`bad --status ${status}`);
  const rows = db.prepare(
    `SELECT id, status, account_id, share_id, drive_id, path, role, amount_usdc, currency, network, payer, nonce, tx_hash, last_error, created_at
     FROM x402_account_settlements
     WHERE (? = 'all' OR status = ?) AND (? IS NULL OR account_id = ?) AND (? IS NULL OR drive_id = ?)
     ORDER BY created_at`,
  ).all(status, status, opts.account ?? null, opts.account ?? null, opts.drive ?? null, opts.drive ?? null);
  out(rows.map((r) => ({ ...r, created_at: iso(r.created_at) })));
} else if (cmd === "show") {
  const row = rowOrFail(opts.id);
  const receipts = db.prepare(
    `SELECT tx_hash, account_id, share_id, wallet, amount_usdc, currency, settled_at FROM payment_receipts
     WHERE drive_id = ? AND path = ? AND (account_id = ? OR lower(wallet) = ?) ORDER BY settled_at`,
  ).all(row.drive_id, row.path, row.account_id, row.payer);
  const member = db.prepare("SELECT role FROM drive_members WHERE drive_id = ? AND user_id = ? AND path = ?").get(row.drive_id, row.account_id, row.path);
  const share = db.prepare("SELECT token, price_usdc, currency, role FROM shares WHERE id = ?").get(row.share_id);
  out({
    settlement: view(row),
    events: S.settlementEvents(row.id).map((e) => ({ ...e, at: iso(e.at) })),
    share: share ?? "(link no longer exists — the sale above is the snapshot taken at payment)",
    account_member_role_at_path: member?.role ?? null,
    receipts_for_this_sale_by_account_or_payer: receipts,
  });
} else if (cmd === "check") {
  const row = rowOrFail(opts.id);
  const C = await chain();
  const client = C.clientForNetwork(row.network, opts.rpc);
  const used = await C.authorizationUsed(client, row);
  const head = await client.getBlockNumber();
  const lookback = BigInt(opts["lookback-blocks"] ?? "200000");
  const fromBlock = opts["from-block"] !== undefined ? BigInt(opts["from-block"]) : (head > lookback ? head - lookback : 0n);
  const uses = used ? await C.findAuthorizationUses(client, row, { fromBlock, toBlock: head }) : [];
  const txs = [];
  for (const u of uses) {
    const paid = await C.checkPaymentTx(client, row, u.txHash);
    const receipt = db.prepare("SELECT account_id, share_id FROM payment_receipts WHERE lower(tx_hash) = lower(?)").get(u.txHash);
    txs.push({ ...u, pays_this_sale: paid.ok, ...(paid.ok ? { confirmations: paid.confirmations } : { why_not: paid.reason }), existing_receipt: receipt ?? null });
  }
  const validBefore = row.valid_before ? BigInt(row.valid_before) : null;
  const stillValid = validBefore !== null && validBefore > BigInt(Math.floor(Date.now() / 1000));
  let advice;
  if (!used) {
    advice = stillValid
      ? `unused but still valid until ${new Date(Number(validBefore) * 1000).toISOString()}: wait until then, check again, then release`
      : "unused and expired: it can never pay — release";
  } else if (txs.some((t) => t.pays_this_sale)) {
    advice = "used, and a transaction paid this sale: credit with that --tx (if no other purchase holds its receipt)";
  } else if (uses.length === 0) {
    advice = `used, but no AuthorizationUsed log since block ${fromBlock}: widen --lookback-blocks or --from-block`;
  } else {
    advice = "used, but not by a transfer that paid this sale: investigate before doing anything";
  }
  out({ id: row.id, status: row.status, network: row.network, head, from_block: fromBlock, authorization_used: used, still_valid: stillValid, uses: txs, advice });
} else if (cmd === "credit") {
  const row = rowOrFail(opts.id);
  const operator = operatorOrFail();
  if (typeof opts.tx !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(opts.tx)) fail("--tx must be a 32-byte 0x transaction hash");
  const txHash = opts.tx.toLowerCase();
  let note = opts.note.trim();
  if (opts["skip-chain-check"]) {
    note = `${note} [chain check skipped]`;
  } else {
    const C = await chain();
    const paid = await C.checkPaymentTx(C.clientForNetwork(row.network, opts.rpc), row, txHash);
    if (!paid.ok) fail(`chain check failed: ${paid.reason} (nothing changed)`);
  }
  const r = S.creditSettlement({ id: row.id, txHash, wallet: row.payer, actor: `support:${operator}`, note });
  if (!r.ok) fail(`${r.reason} (nothing changed)`);
  console.log(r.already ? `${row.id} was already credited with ${txHash}` : `credited ${row.id} tx=${txHash} by ${operator}`);
} else if (cmd === "release") {
  const row = rowOrFail(opts.id);
  const operator = operatorOrFail();
  if (row.status !== "unresolved") fail(`row is ${row.status}, not unresolved`);
  let note = opts.note.trim();
  if (opts.force) {
    note = `${note} [forced]`;
  } else {
    const C = await chain();
    const used = await C.authorizationUsed(C.clientForNetwork(row.network, opts.rpc), row);
    if (used) fail("the authorization IS used on chain — releasing would let the buyer pay twice; run `check` and `credit` (or --force)");
    const validBefore = row.valid_before ? BigInt(row.valid_before) : null;
    if (validBefore === null || validBefore > BigInt(Math.floor(Date.now() / 1000))) {
      fail(`the authorization is unused but still valid${validBefore ? ` until ${new Date(Number(validBefore) * 1000).toISOString()}` : ""} — it could still be settled; wait, check again, then release (or --force)`);
    }
  }
  if (!S.releaseSettlement({ id: row.id, actor: `support:${operator}`, reason: note })) fail("row is no longer unresolved (nothing changed)");
  console.log(`released ${row.id} by ${operator}`);
} else {
  fail(`unknown command ${cmd}\n${USAGE}`);
}

// lib/db.js starts periodic maintenance timers; this is a one-shot command.
process.exit(0);
