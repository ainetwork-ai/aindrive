// Paid-share purchases by AUTHENTICATED accounts (session or aind_aat Bearer)
// paying with an EIP-3009 authorization: a record per settle attempt whose only
// job is to stop a second charge when a settle answer is lost
// (docs/X402_PAYMENT_PENDING.md; decision: docs/11-entitlements.md §6 option 3).
//
// Nothing here reads the chain, and nothing here credits a purchase from the
// chain. A row becomes 'credited' only when this server's own settle request
// was answered with success (the route), or when an operator credits it with
// scripts/x402-settlements.mjs. A row becomes 'released' only when the
// facilitator refused the first settle request before broadcasting (the
// route), or when an operator releases it. Everything else stays
// 'unresolved' — and while it does, the same account cannot pay for the same
// sale with a NEW authorization (409 payment_pending).
//
// Shared by the route (TypeScript, via x402-account-settlements.d.ts) and the
// support CLI (plain node), so both credit with the same guards.

import { createHash } from "node:crypto";
import { nanoid } from "nanoid";
import { db } from "./db.js";
import { bestMatchingRole, mergeRoleUpgradeOnly } from "./access-core.js";

/** @param {unknown} v @param {number} bytes */
const hex = (v, bytes) => typeof v === "string" && new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`).test(v);

/**
 * An unsigned integer as its canonical decimal string, read the way the
 * facilitator reads it (`BigInt(...)`: decimal or 0x-hex strings, JSON
 * integers), or null. The EIP-712 signature does not depend on how a number is
 * written, so neither may the envelope hash: "0x7a120", 500000 and "500000"
 * are one authorization.
 * @param {unknown} v
 */
function uint(v) {
  if (typeof v !== "string" && !(typeof v === "number" && Number.isSafeInteger(v))) return null;
  if (typeof v === "string" && !/^\s*(0[xX][0-9a-fA-F]+|\d+)\s*$/.test(v)) return null;
  try {
    const n = BigInt(v);
    return n >= 0n && n < 2n ** 256n ? n.toString(10) : null;
  } catch {
    return null;
  }
}

/**
 * The inner payload carries both an EIP-3009 `authorization` and a Permit2
 * `permit2Authorization`. The exact-EVM facilitator picks its path from the
 * payload's shape, so such a payload could be recorded under one authorization
 * and settled under the other: refused outright (400).
 * @param {unknown} payload
 */
export function isAmbiguousPayload(payload) {
  const p = /** @type {{ payload?: unknown }} */ (payload)?.payload;
  return !!p && typeof p === "object" && "authorization" in p && "permit2Authorization" in p;
}

/**
 * The EIP-3009 authorization of a v2 exact-EVM payload, or null when it is not
 * a well-formed one (the route then refuses an account's payment: fail closed).
 * @param {unknown} payload
 */
export function eip3009Authorization(payload) {
  if (isAmbiguousPayload(payload)) return null;
  const p = /** @type {{ payload?: { signature?: unknown; authorization?: Record<string, unknown> } }} */ (payload)?.payload;
  const a = p?.authorization;
  if (!a || typeof a !== "object" || typeof p?.signature !== "string" || !/^0x[0-9a-fA-F]+$/.test(p.signature)) return null;
  if (!hex(a.from, 20) || !hex(a.to, 20) || !hex(a.nonce, 32)) return null;
  const value = uint(a.value), validAfter = uint(a.validAfter), validBefore = uint(a.validBefore);
  if (value === null || validAfter === null || validBefore === null) return null;
  const from = /** @type {string} */ (a.from).toLowerCase();
  const to = /** @type {string} */ (a.to).toLowerCase();
  const nonce = /** @type {string} */ (a.nonce).toLowerCase();
  const canonical = [from, to, value, validAfter, validBefore, nonce, p.signature.toLowerCase()].join("|");
  return { from, to, value, validAfter, validBefore, nonce, envelopeHash: createHash("sha256").update(canonical).digest("hex") };
}

/**
 * @param {string} settlementId
 * @param {string} action
 * @param {string} actor
 * @param {string | null} detail
 * @param {number} at
 */
function logEvent(settlementId, action, actor, detail, at) {
  db.prepare(
    "INSERT INTO x402_account_settlement_events (id, settlement_id, action, actor, detail, at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(nanoid(16), settlementId, action, actor, detail == null ? null : String(detail).slice(0, 500), at);
}

/** @param {{ network: string; asset: string; payer: string; nonce: string }} k */
export function findSettlement(k) {
  return db.prepare(
    "SELECT * FROM x402_account_settlements WHERE network = ? AND asset = ? AND payer = ? AND nonce = ?",
  ).get(k.network, k.asset.toLowerCase(), k.payer.toLowerCase(), k.nonce.toLowerCase());
}

/** @param {string} id */
export function getSettlement(id) {
  return db.prepare("SELECT * FROM x402_account_settlements WHERE id = ?").get(id);
}

/** @param {string} id */
export function settlementEvents(id) {
  return db.prepare("SELECT action, actor, detail, at FROM x402_account_settlement_events WHERE settlement_id = ? ORDER BY at, rowid").all(id);
}

/**
 * The row is for this sale: the same link, or the same drive, path and role
 * stored on the row (another link selling the same thing, or the link re-made
 * after a revoke).
 * @param {{ share_id: string; drive_id: string; path: string; role: string }} row
 * @param {{ shareId: string; driveId: string; path: string; role: string }} sale
 */
export function isSameSale(row, sale) {
  return row.share_id === sale.shareId
    || (row.drive_id === sale.driveId && row.path === sale.path && row.role === sale.role);
}

/**
 * The account's unresolved attempt for this sale (oldest first), if any.
 * @param {string} accountId
 * @param {{ shareId: string; driveId: string; path: string; role: string }} sale
 */
export function openSettlementFor(accountId, sale) {
  return db.prepare(
    `SELECT * FROM x402_account_settlements
     WHERE account_id = ? AND status = 'unresolved'
       AND (share_id = ? OR (drive_id = ? AND path = ? AND role = ?))
     ORDER BY created_at, rowid LIMIT 1`,
  ).get(accountId, sale.shareId, sale.driveId, sale.path, sale.role);
}

/**
 * Atomic (one IMMEDIATE transaction): check and insert the row for a verified
 * authorization, right before settle. `holdsNow` re-reads the account's
 * entitlement inside the transaction, so a request that raced a credited one
 * is not charged.
 *
 * @param {{
 *   accountId: string;
 *   sale: { shareId: string; driveId: string; path: string; role: string; amountUsdc: number; currency: string; chain: string; payTo: string; amountAtomic: string };
 *   network: string; asset: string; payer: string; nonce: string; envelopeHash: string; validBefore: string;
 * }} input
 * @param {() => boolean} holdsNow
 * @param {number} [nowMs]
 */
export function recordBeforeSettle(input, holdsNow, nowMs = Date.now()) {
  return db.transaction(() => {
    const existing = findSettlement(input);
    if (existing) {
      const same = existing.account_id === input.accountId && isSameSale(existing, input.sale)
        && existing.envelope_hash === input.envelopeHash;
      // The same account's same envelope, recorded by a parallel request: that
      // request settles it; this one must not wait on or duplicate it.
      if (same && existing.status === "unresolved") return { kind: "pending", row: existing };
      return { kind: "conflict" };
    }
    const open = openSettlementFor(input.accountId, input.sale);
    if (open) return { kind: "pending", row: open };
    if (holdsNow()) return { kind: "held" };
    const s = input.sale;
    const row = {
      id: nanoid(16), account_id: input.accountId, share_id: s.shareId,
      drive_id: s.driveId, path: s.path, role: s.role,
      amount_usdc: s.amountUsdc, currency: s.currency, chain: s.chain,
      pay_to: s.payTo.toLowerCase(), amount_atomic: s.amountAtomic,
      network: input.network, asset: input.asset.toLowerCase(), payer: input.payer.toLowerCase(), nonce: input.nonce.toLowerCase(),
      envelope_hash: input.envelopeHash, valid_before: input.validBefore,
      status: "unresolved", tx_hash: null, last_error: null, resolved_by: null, resolution_note: null,
      created_at: nowMs, updated_at: nowMs,
    };
    db.prepare(
      `INSERT INTO x402_account_settlements (id, account_id, share_id, drive_id, path, role, amount_usdc, currency, chain,
         pay_to, amount_atomic, network, asset, payer, nonce, envelope_hash, valid_before, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unresolved', ?, ?)`,
    ).run(row.id, row.account_id, row.share_id, row.drive_id, row.path, row.role, row.amount_usdc, row.currency, row.chain,
      row.pay_to, row.amount_atomic, row.network, row.asset, row.payer, row.nonce, row.envelope_hash, row.valid_before, nowMs, nowMs);
    logEvent(row.id, "recorded", "server", null, nowMs);
    return { kind: "recorded", row };
  }).immediate();
}

/**
 * The account's own role at a path (owner, else its member rows) — the same
 * read as lib/access.ts personalRoleByUser; an organization's live role is not
 * written down as a durable member row.
 * @param {string} driveId @param {string} accountId @param {string} path
 */
function personalRole(driveId, accountId, path) {
  const drive = db.prepare("SELECT owner_id FROM drives WHERE id = ?").get(driveId);
  if (!drive) return "none";
  if (drive.owner_id === accountId) return "owner";
  return bestMatchingRole(db.prepare("SELECT path, role FROM drive_members WHERE drive_id = ? AND user_id = ?").all(driveId, accountId), path);
}

/**
 * Credit a row once, in one transaction: payment receipt, membership
 * (upgrade-only) and status 'credited', from the sale stored on the row. The
 * caller has proof the row's authorization paid: this server's settle answered
 * success with `txHash` (actor "server"), or an operator checked the chain.
 * Refused, with nothing written: a tx already receipted for another account or
 * sale, or already credited to another row.
 *
 * @param {{ id: string; txHash: string; wallet?: string; actor: string; note?: string | null }} c
 * @param {number} [nowMs]
 * @returns {{ ok: true; already: boolean; txHash: string; row: any } | { ok: false; reason: string }}
 */
export function creditSettlement(c, nowMs = Date.now()) {
  return db.transaction(() => {
    const row = getSettlement(c.id);
    if (!row) return { ok: false, reason: "no such settlement" };
    if (row.status === "credited") {
      return row.tx_hash === c.txHash
        ? { ok: true, already: true, txHash: row.tx_hash, row }
        : { ok: false, reason: `already credited with ${row.tx_hash}` };
    }
    const other = db.prepare("SELECT id FROM x402_account_settlements WHERE lower(tx_hash) = lower(?) AND id != ?").get(c.txHash, row.id);
    if (other) return { ok: false, reason: "this transaction already credited another purchase" };
    const receipt = db.prepare("SELECT account_id, share_id FROM payment_receipts WHERE lower(tx_hash) = lower(?)").get(c.txHash);
    if (receipt && (receipt.account_id !== row.account_id || receipt.share_id !== row.share_id)) {
      return { ok: false, reason: "this transaction already paid for another purchase" };
    }
    if (!receipt) {
      db.prepare(
        "INSERT INTO payment_receipts (id, drive_id, path, wallet, tx_hash, amount_usdc, currency, network, share_id, account_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(nanoid(12), row.drive_id, row.path, (c.wallet ?? row.payer).toLowerCase(), c.txHash, row.amount_usdc, row.currency, row.chain, row.share_id, row.account_id);
    }
    const merged = mergeRoleUpgradeOnly(personalRole(row.drive_id, row.account_id, row.path), row.role);
    db.prepare(
      `INSERT INTO drive_members (id, drive_id, user_id, path, role) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(drive_id, user_id, path) DO UPDATE SET role = excluded.role`,
    ).run(nanoid(12), row.drive_id, row.account_id, row.path, merged);
    db.prepare(
      `UPDATE x402_account_settlements SET status = 'credited', tx_hash = ?, resolved_by = ?, resolution_note = ?, updated_at = ?
       WHERE id = ?`,
    ).run(c.txHash, c.actor, c.note ?? null, nowMs, row.id);
    // A released row credited later (its settle answered success after all, or
    // support found the transfer): the log keeps both decisions.
    logEvent(row.id, "credited", c.actor, `${c.txHash}${row.status === "released" ? " (was released)" : ""}${c.note ? ` — ${c.note}` : ""}`, nowMs);
    return { ok: true, already: false, txHash: c.txHash, row: getSettlement(row.id) };
  }).immediate();
}

/**
 * Release an unresolved row: the authorization is known not to have paid, so
 * the account may pay for the sale with a new one. The route calls this only
 * for a settle refused before broadcast; the support CLI after a chain check.
 * @param {{ id: string; actor: string; reason: string }} r
 * @param {number} [nowMs]
 * @returns {boolean} whether an unresolved row was released
 */
export function releaseSettlement(r, nowMs = Date.now()) {
  return db.transaction(() => {
    const res = db.prepare(
      `UPDATE x402_account_settlements SET status = 'released', resolved_by = ?, resolution_note = ?, updated_at = ?
       WHERE id = ? AND status = 'unresolved'`,
    ).run(r.actor, r.reason.slice(0, 500), nowMs, r.id);
    if (res.changes !== 1) return false;
    logEvent(r.id, "released", r.actor, r.reason, nowMs);
    return true;
  }).immediate();
}

/**
 * A settle attempt for an unresolved row ended without a known outcome: the
 * row stays unresolved; the reason is kept for support.
 * @param {string} id @param {string} reason @param {number} [nowMs]
 */
export function noteUncertain(id, reason, nowMs = Date.now()) {
  db.transaction(() => {
    db.prepare("UPDATE x402_account_settlements SET last_error = ?, updated_at = ? WHERE id = ? AND status = 'unresolved'")
      .run(reason.slice(0, 200), nowMs, id);
    logEvent(id, "settle_uncertain", "server", reason, nowMs);
  }).immediate();
}

/**
 * Where a blocked buyer goes for help, with the row as the reference.
 * AINDRIVE_SUPPORT_URL (any URL; `{ref}` is replaced by the reference, else
 * `?ref=` is appended).
 * @param {string} ref
 */
export function supportUrl(ref) {
  const base = process.env.AINDRIVE_SUPPORT_URL || "https://github.com/ainetwork-ai/aindrive/issues/new";
  if (base.includes("{ref}")) return base.replaceAll("{ref}", encodeURIComponent(ref));
  return `${base}${base.includes("?") ? "&" : "?"}ref=${encodeURIComponent(ref)}`;
}
