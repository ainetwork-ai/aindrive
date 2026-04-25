/**
 * paid_lifts — DB layer for quota/feature lifts purchased with AIN.
 *
 * Self-creates the table + indexes on first import.
 * All queries use the shared better-sqlite3 handle from @/lib/db.
 */

import { db } from "./db.js";
import { nanoid } from "nanoid";

// ─── Schema bootstrap ─────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS paid_lifts (
    id         TEXT    PRIMARY KEY,
    wallet     TEXT    NOT NULL,
    scope      TEXT    NOT NULL,
    expires_at INTEGER NOT NULL,
    payment_tx TEXT    UNIQUE NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
  );
  CREATE INDEX IF NOT EXISTS idx_paid_lifts_lookup
    ON paid_lifts(wallet, scope, expires_at);
  CREATE INDEX IF NOT EXISTS idx_paid_lifts_tx
    ON paid_lifts(payment_tx);
`);

// ─── API ─────────────────────────────────────────────────────────────────────

/**
 * Returns true if `wallet` has a non-expired lift for `scope`.
 * @param {string} wallet  — lowercase 0x address
 * @param {string} scope
 * @returns {boolean}
 */
export function hasActiveLift(wallet, scope) {
  return getActiveLiftExpiry(wallet, scope) != null;
}

/**
 * Returns the expiry timestamp (ms) of the latest active lift, or null if none.
 * @param {string} wallet  — lowercase 0x address
 * @param {string} scope
 * @returns {number | null}
 */
export function getActiveLiftExpiry(wallet, scope) {
  const now = Date.now();
  const row = db
    .prepare(
      `SELECT expires_at FROM paid_lifts
       WHERE wallet = ? AND scope = ? AND expires_at > ?
       ORDER BY expires_at DESC LIMIT 1`
    )
    .get(wallet.toLowerCase(), scope, now);
  return row ? row.expires_at : null;
}

/**
 * Records a new lift.
 * @param {{ wallet: string, scope: string, ttlMs: number, paymentTx: string }} opts
 * @returns {{ id: string }}
 */
export function addLift({ wallet, scope, ttlMs, paymentTx }) {
  const id = nanoid();
  const expiresAt = Date.now() + ttlMs;
  db.prepare(
    `INSERT INTO paid_lifts (id, wallet, scope, expires_at, payment_tx)
     VALUES (?, ?, ?, ?, ?)`
  ).run(id, wallet.toLowerCase(), scope, expiresAt, paymentTx);
  return { id };
}

/**
 * Returns true if `txHash` has already been recorded (anti-replay).
 * @param {string} txHash  — 0x… transaction hash
 * @returns {boolean}
 */
export function txHashUsed(txHash) {
  const row = db
    .prepare(`SELECT id FROM paid_lifts WHERE payment_tx = ? LIMIT 1`)
    .get(txHash);
  return row != null;
}
