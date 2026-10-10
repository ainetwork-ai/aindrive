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
//   check   --id <ref> [--rpc <url>] [--lookback-blocks <n>] [--from-block <n>] [--clock-skew-seconds <n>]
//                                            read-only: authorizationState(payer, nonce), the
//                                            transactions that used it, whether each paid this sale,
//                                            its block time next to the row's recorded time and first
//                                            settle outcome, and red flags (see below)
//   credit  --id <ref> --tx <hash> --operator <name> --note "<why>" [--rpc <url>] [--clock-skew-seconds <n>]
//           [--skip-chain-check] [--force]
//                                            receipt + membership (upgrade-only) + 'credited', in one
//                                            transaction. First re-checks on chain that <hash> used this
//                                            authorization and paid the sale's payee the recorded amount,
//                                            and refuses on a red flag unless --force (logged in the note).
//
// Red flags — an EIP-3009 envelope is public in calldata once mined, so a row can
// be recorded by someone who copied another buyer's mined authorization (and a
// lagging facilitator verify accepted it). A transaction that paid the sale is
// NOT proof that this row's account paid when:
//   tx_mined_before_row_recorded  the block time is earlier than the row's created_at
//                                 minus --clock-skew-seconds (default 30);
//   first_settle_nonce_already_used  this row's first settle answer was nonce_already_used;
//   tx_referenced_elsewhere       a payment receipt or another settlement row already
//                                 references the transaction.
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
  node scripts/x402-settlements.mjs check   --id <ref> [--rpc <url>] [--lookback-blocks <n>] [--from-block <n>] [--clock-skew-seconds <n>]
  node scripts/x402-settlements.mjs credit  --id <ref> --tx <txHash> --operator <name> --note "<reason>" [--rpc <url>] [--clock-skew-seconds <n>] [--skip-chain-check] [--force]
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

/** --clock-skew-seconds: how far the server clock may run ahead of block time. */
function skewSeconds() {
  const v = opts["clock-skew-seconds"] ?? "30";
  if (!/^\d+$/.test(v)) fail(`--clock-skew-seconds must be a non-negative integer, got ${v}`);
  return Number(v);
}

/**
 * The row's first settle outcome: the first event after 'recorded' (the
 * server's settle answer, or a later resolution if none was logged).
 * @param {string} id
 */
function firstSettle(id) {
  const e = S.settlementEvents(id).find((x) => x.action !== "recorded");
  return e ? { action: e.action, actor: e.actor, detail: e.detail, at: iso(e.at) } : null;
}

/**
 * Who else in the DB references `txHash`: payment receipts (any), and other
 * settlement rows (credited with it, or naming it in last_error / their log).
 * @param {{ id: string }} row @param {string} txHash
 */
function otherReferences(row, txHash) {
  const tx = txHash.toLowerCase();
  const receipts = db.prepare("SELECT account_id, share_id, drive_id, path, settled_at FROM payment_receipts WHERE lower(tx_hash) = ?").all(tx);
  const rows = db.prepare(
    `SELECT id FROM x402_account_settlements WHERE id != ? AND (lower(tx_hash) = ? OR instr(lower(coalesce(last_error, '')), ?) > 0)
     UNION SELECT settlement_id AS id FROM x402_account_settlement_events WHERE settlement_id != ? AND instr(lower(coalesce(detail, '')), ?) > 0`,
  ).all(row.id, tx, tx, row.id, tx).map((r) => r.id);
  return { receipts, settlement_rows: rows };
}

/**
 * Reasons NOT to credit `row` with `txHash` on the operator's say-so.
 * `minedAtSec` is the tx's block time (null: not known — chain check skipped).
 * @param {any} row @param {string} txHash @param {bigint | null} minedAtSec @param {number} skewS
 */
function redFlags(row, txHash, minedAtSec, skewS) {
  /** @type {string[]} */
  const flags = [];
  if (minedAtSec !== null && Number(minedAtSec) * 1000 < row.created_at - skewS * 1000) {
    flags.push(`tx_mined_before_row_recorded: block time ${iso(Number(minedAtSec) * 1000)} is before the row's created_at ${iso(row.created_at)} (allowed skew ${skewS}s) — this account's request came after the transfer was public`);
  }
  const first = firstSettle(row.id);
  if (first && first.action === "settle_uncertain" && /nonce_already_used/i.test(first.detail ?? "")) {
    flags.push("first_settle_nonce_already_used: this row's first settle answer said the nonce was already used — someone else may have settled it first");
  }
  const refs = otherReferences(row, txHash);
  if (refs.receipts.length || refs.settlement_rows.length) {
    flags.push(`tx_referenced_elsewhere: ${refs.receipts.map((r) => `receipt(account=${r.account_id ?? "-"}, share=${r.share_id ?? "-"})`).concat(refs.settlement_rows.map((id) => `settlement ${id}`)).join(", ")}`);
  }
  return flags;
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
  const skewS = skewSeconds();
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
    const minedAt = await C.blockTime(client, u.blockNumber);
    const flags = redFlags(row, u.txHash, minedAt, skewS);
    txs.push({
      ...u, block_time: iso(Number(minedAt) * 1000), row_recorded_at: iso(row.created_at),
      pays_this_sale: paid.ok, ...(paid.ok ? { confirmations: paid.confirmations } : { why_not: paid.reason }),
      existing_receipt: receipt ?? null, red_flags: flags,
    });
  }
  const paying = txs.filter((t) => t.pays_this_sale);
  const validBefore = row.valid_before ? BigInt(row.valid_before) : null;
  const stillValid = validBefore !== null && validBefore > BigInt(Math.floor(Date.now() / 1000));
  let advice;
  if (!used) {
    advice = stillValid
      ? `unused but still valid until ${new Date(Number(validBefore) * 1000).toISOString()}: wait until then, check again, then release`
      : "unused and expired: it can never pay — release";
  } else if (paying.some((t) => t.red_flags.length === 0)) {
    advice = `used, and a transaction paid this sale with no red flag: credit with --tx ${paying.find((t) => t.red_flags.length === 0).txHash}`;
  } else if (paying.length) {
    advice = "investigate — do not credit: a transaction paid this sale, but see red_flags — the envelope may have been copied from "
      + "another buyer's mined transaction. Find who actually signed and sent it; `credit` refuses unless --force with a --note saying why";
  } else if (uses.length === 0) {
    advice = `used, but no AuthorizationUsed log since block ${fromBlock}: widen --lookback-blocks or --from-block`;
  } else {
    advice = "used, but not by a transfer that paid this sale: investigate before doing anything";
  }
  out({
    id: row.id, status: row.status, network: row.network, account_id: row.account_id,
    row_recorded_at: iso(row.created_at), first_settle: firstSettle(row.id), clock_skew_seconds: skewS,
    head, from_block: fromBlock, authorization_used: used, still_valid: stillValid, uses: txs, advice,
  });
} else if (cmd === "credit") {
  const row = rowOrFail(opts.id);
  const operator = operatorOrFail();
  if (typeof opts.tx !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(opts.tx)) fail("--tx must be a 32-byte 0x transaction hash");
  const txHash = opts.tx.toLowerCase();
  const skewS = skewSeconds();
  let note = opts.note.trim();
  let flags;
  if (opts["skip-chain-check"]) {
    // Without the chain the tx's block time is unknown, so a copied envelope cannot be ruled out.
    if (!opts.force) fail("--skip-chain-check cannot tell whether the tx was mined before the row was recorded — add --force (and say why in --note)");
    note = `${note} [chain check skipped]`;
    flags = redFlags(row, txHash, null, skewS);
  } else {
    const C = await chain();
    const client = C.clientForNetwork(row.network, opts.rpc);
    const paid = await C.checkPaymentTx(client, row, txHash);
    if (!paid.ok) fail(`chain check failed: ${paid.reason} (nothing changed)`);
    flags = redFlags(row, txHash, await C.blockTime(client, paid.blockNumber), skewS);
  }
  if (flags.length && row.status !== "credited") {
    if (!opts.force) {
      fail(`investigate — do not credit (nothing changed):\n  - ${flags.join("\n  - ")}\n`
        + "A tx that paid this sale is not proof that this account paid. Credit anyway only with --force and a --note saying why.");
    }
    note = `${note} [forced past: ${flags.map((f) => f.split(":")[0]).join(", ")}]`;
    console.error(`warning: crediting past red flags (logged):\n  - ${flags.join("\n  - ")}`);
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
