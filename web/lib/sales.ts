/**
 * Selling operations shared by the HTTP routes (app/api/drives/[driveId]/
 * {shares,payout}, PATCH /api/drives/[driveId]) and the remote-MCP sale tools
 * (shared/agent-skills.ts, account grant `drives:sell`): share-link
 * create/edit/revoke, payout wallets, the token policy and the receipt ledger.
 *
 * Callers authenticate first and pass the user id. Failures come back as
 * `{ ok: false, status, error }` with the status and message the HTTP route
 * answers, so both surfaces reject the same input the same way.
 */
import { nanoid } from "nanoid";
import { z } from "zod";
import { isAddress } from "viem";
import { db } from "./db";
import { payoutWalletFor, setPayoutWallet, type DriveRow } from "./drives";
import { resolveRole, atLeast } from "./access";
import {
  parseTokenPolicy, pickShareCurrency, policyChainViolation, resolveDriveTokens, type PaymentToken,
} from "./payment-tokens";
import { decideShareEdit } from "./share-edit";
import { env } from "./env";
import { zPath } from "./zod-helpers";
import { AgentError, callAgent } from "./rpc";

export type SaleErr = { ok: false; status: number; error: string };

export function shareUrl(token: string): string {
  return `${env.publicUrl.replace(/\/$/, "")}/s/${token}`;
}

// ── Share links ──────────────────────────────────────────────────────────

export const ShareCreateBody = z.object({
  path: zPath.default(""),
  role: z.enum(["viewer", "editor"]),
  expiresAt: z.string().datetime().optional(),
  price_usdc: z.number().positive().optional(),
  currency: z.string().optional(),
  listed: z.boolean().optional(),
});
export type ShareCreateInput = z.infer<typeof ShareCreateBody>;

export type ShareRow = {
  id: string;
  path: string;
  role: string;
  token: string;
  expires_at: string | null;
  created_at: string;
  price_usdc: number | null;
  currency: string | null;
  listed: number;
};

/** Every share link of a drive, newest first. */
export function listShares(driveId: string): ShareRow[] {
  return db.prepare(`
    SELECT id, path, role, token, expires_at, created_at, price_usdc, currency, listed
    FROM shares WHERE drive_id = ? ORDER BY created_at DESC
  `).all(driveId) as ShareRow[];
}

/**
 * Mint a share link (free, or paid when `price_usdc` is set). Gates: editor at
 * the path; listing and editor links are owner-only; a paid share needs a
 * payout wallet covering the path and a currency in the drive's policy; a
 * non-root path must exist on the agent (so the agent must be online).
 */
export async function createShare(
  drive: DriveRow,
  userId: string,
  input: ShareCreateInput,
): Promise<{ ok: true; id: string; token: string; url: string } | SaleErr> {
  const driveId = drive.id;
  const role = resolveRole(driveId, userId, input.path);
  if (!atLeast(role, "editor")) return { ok: false, status: 403, error: "forbidden" };

  // [rev2-D] Listing on the drive's showcase is owner-only: a path-scoped
  // editor must not be able to put arbitrary priced items on the drive's
  // storefront. Unlisted share creation stays editor-at-path as before.
  if (input.listed && !atLeast(resolveRole(driveId, userId, ""), "owner")) {
    return { ok: false, status: 403, error: "only the owner can list a share" };
  }

  // Granting EDITOR access via a link is owner-only — a non-owner editor must
  // not be able to laterally escalate strangers to editor. Editors may still
  // mint VIEWER links at paths they cover. (owner is whole-drive only → root.)
  if (input.role === "editor" && !atLeast(resolveRole(driveId, userId, ""), "owner")) {
    return { ok: false, status: 403, error: "only an owner can grant editor access via a link" };
  }

  // Paid share: currency must be one the drive's token policy allows.
  // Defaults to the policy's first token when the caller doesn't pick one.
  let currency: string | null = null;
  if (input.price_usdc) {
    // A paid share needs somewhere for the money to land. The payout wallet is
    // path-scoped: this share's funds go to the nearest ANCESTOR folder's
    // wallet (set in that folder's Share panel; inherits down to the drive
    // root). If no ancestor — not even root — has one, block at creation
    // instead of minting a link that settles to 0x0 and fails at checkout.
    if (!payoutWalletFor(driveId, input.path)) {
      return { ok: false, status: 400, error: "set a payout wallet for this folder (or a parent) before selling" };
    }
    const symbols = resolveDriveTokens(drive.allowed_tokens).map((t) => t.symbol);
    currency = pickShareCurrency(symbols, input.currency);
    if (currency === null) {
      return { ok: false, status: 400, error: "currency not allowed by drive policy" };
    }
  }

  // Non-root path: stat-probe verifies the path EXISTS (typo protection),
  // which needs the agent — we don't hand out tokens for typo'd paths that
  // would 404 after the visitor pays. Root ("") has no path to verify, so it
  // is NOT gated on the agent being online — a fresh, not-yet-paired drive can
  // still set up free invites and storefront sales before/independent of the
  // agent running (the drive just reads "offline" until the agent connects).
  if (input.path !== "") {
    try {
      const stat = await callAgent(driveId, drive.drive_secret, { method: "stat", path: input.path });
      if (!stat?.entry) return { ok: false, status: 400, error: "path not found in drive" };
    } catch (e) {
      const err = e as AgentError;
      return { ok: false, status: err.status ?? 503, error: err.message || "agent unreachable" };
    }
  }

  const id = nanoid(12);
  const token = nanoid(24);
  db.prepare(`
    INSERT INTO shares (id, drive_id, path, role, token, expires_at, created_by, price_usdc, currency, listed)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, driveId, input.path, input.role, token, input.expiresAt ?? null, userId, input.price_usdc ?? null, currency, input.listed ? 1 : 0);
  return { ok: true, id, token, url: shareUrl(token) };
}

export const ShareEditBody = z
  .object({
    price_usdc: z.number().positive().optional(),
    currency: z.string().optional(),
    listed: z.boolean().optional(),
  })
  .refine((b) => b.price_usdc !== undefined || b.currency !== undefined || b.listed !== undefined, {
    message: "no fields to update",
  });
export type ShareEditInput = z.infer<typeof ShareEditBody>;

/**
 * Edit a share's sale terms in place (the /s link and prior grants are kept).
 * Owner edits any share; a non-owner only one they created AND still hold
 * editor at its path for. The rest (listing owner-only, currency policy,
 * payout wallet, no free→paid) is decideShareEdit.
 */
export function editShare(
  drive: DriveRow,
  userId: string,
  shareId: string,
  patch: ShareEditInput,
): { ok: true; id: string; price_usdc: number | null; currency: string | null; listed: number } | SaleErr {
  const driveId = drive.id;
  const share = db
    .prepare("SELECT id, path, created_by, price_usdc, currency, listed FROM shares WHERE id = ? AND drive_id = ?")
    .get(shareId, driveId) as
    | { id: string; path: string; created_by: string | null; price_usdc: number | null; currency: string | null; listed: number }
    | undefined;
  if (!share) return { ok: false, status: 404, error: "not found" };

  // created_by has no FK, so a removed editor whose id still matches the
  // column must NOT retain edit rights — hence the live role re-check.
  const isOwner = atLeast(resolveRole(driveId, userId, ""), "owner");
  if (!isOwner && (share.created_by !== userId || !atLeast(resolveRole(driveId, userId, share.path), "editor"))) {
    return { ok: false, status: 403, error: "forbidden" };
  }

  const decision = decideShareEdit(
    { price_usdc: share.price_usdc, currency: share.currency, listed: share.listed === 1 },
    patch,
    {
      allowedSymbols: resolveDriveTokens(drive.allowed_tokens).map((t) => t.symbol),
      payoutExists: !!payoutWalletFor(driveId, share.path),
      isOwner,
    },
  );
  if (!decision.ok) return { ok: false, status: decision.status, error: decision.error };

  const { price_usdc, currency, listed } = decision.next;
  db.prepare("UPDATE shares SET price_usdc = ?, currency = ?, listed = ? WHERE id = ? AND drive_id = ?")
    .run(price_usdc, currency, listed, shareId, driveId);
  return { ok: true, id: share.id, price_usdc, currency, listed };
}

/**
 * Revoke a share link: the row goes, so /s/<token> 404s; access already
 * granted through it stays. Owner revokes any link; a non-owner only their
 * own, and only while still a member.
 */
export function revokeShare(driveId: string, userId: string, shareId: string): { ok: true } | SaleErr {
  const share = db
    .prepare("SELECT id, created_by FROM shares WHERE id = ? AND drive_id = ?")
    .get(shareId, driveId) as { id: string; created_by: string | null } | undefined;
  if (!share) return { ok: false, status: 404, error: "not found" };
  const myRole = resolveRole(driveId, userId, "");
  const isOwner = atLeast(myRole, "owner");
  if (!isOwner && (!atLeast(myRole, "viewer") || share.created_by !== userId)) {
    return { ok: false, status: 403, error: "forbidden" };
  }
  db.prepare("DELETE FROM shares WHERE id = ? AND drive_id = ?").run(shareId, driveId);
  return { ok: true };
}

// ── Payout wallets + token policy (creator-only; callers check owner_id) ──

export const PayoutWalletBody = z.object({
  path: zPath.default(""),
  wallet: z.string().refine((v) => isAddress(v), "invalid address"),
});

/** Set one folder's payout wallet from raw input; the wallet is stored lowercased. */
export function applyPayoutWallet(driveId: string, raw: unknown): { ok: true } | SaleErr {
  const body = PayoutWalletBody.safeParse(raw);
  if (!body.success) return { ok: false, status: 400, error: body.error.issues[0]?.message ?? "invalid input" };
  setPayoutWallet(driveId, body.data.path, body.data.wallet.toLowerCase());
  return { ok: true };
}

/** Validate a serialized token policy (drives.allowed_tokens) before storing it. */
export function validateTokenPolicy(json: string): { ok: true; policy: PaymentToken[] } | SaleErr {
  const policy = parseTokenPolicy(json);
  if (!policy) return { ok: false, status: 400, error: "invalid token policy" };
  const badChain = policyChainViolation(policy);
  if (badChain) {
    return { ok: false, status: 400, error: `${badChain} tokens cannot be accepted on a mainnet deployment` };
  }
  return { ok: true, policy };
}

const BASE_CHAINS = ["base", "base-sepolia"];

/**
 * A token list from a client (MCP set_token_policy) → the policy JSON to
 * store. Same checks as the drive PATCH, plus every token must be a contract
 * on Base (or Base Sepolia, where the testnet USDC preset lives): a token the
 * 402 can't quote would only surface as a failed checkout.
 */
export function tokenPolicyFromList(tokens: unknown): { ok: true; json: string } | SaleErr {
  if (!Array.isArray(tokens)) return { ok: false, status: 400, error: "invalid token policy" };
  const normalized = tokens.map((t) =>
    t && typeof t === "object" ? { name: null, version: null, ...(t as Record<string, unknown>) } : t,
  );
  const v = validateTokenPolicy(JSON.stringify(normalized));
  if (!v.ok) return v;
  const offBase = v.policy.find((t) => !BASE_CHAINS.includes(t.chain) || !isAddress(t.asset));
  if (offBase) {
    return { ok: false, status: 400, error: `${offBase.symbol}: asset must be a token contract address on Base (chain base or base-sepolia)` };
  }
  return { ok: true, json: JSON.stringify(v.policy) };
}

// ── Receipts ─────────────────────────────────────────────────────────────

export type ReceiptRow = {
  tx_hash: string;
  path: string;
  wallet: string;
  amount_usdc: number | null;
  currency: string | null;
  network: string;
  share_id: string | null;
  account_id: string | null;
  settled_at: string;
};

/**
 * One page of a drive's receipts, newest first, settled strictly before
 * `before` (a previous page's last settled_at). settled_at has one-second
 * resolution, so a full page is extended to take every receipt sharing its
 * last timestamp — the next page (`< before`) then never skips one.
 */
export function listReceipts(driveId: string, opts: { limit: number; before?: string }): ReceiptRow[] {
  const cols = "rowid, tx_hash, path, wallet, amount_usdc, currency, network, share_id, account_id, settled_at";
  const rows = (opts.before === undefined
    ? db.prepare(`SELECT ${cols} FROM payment_receipts WHERE drive_id = ? ORDER BY settled_at DESC, rowid DESC LIMIT ?`)
      .all(driveId, opts.limit)
    : db.prepare(`SELECT ${cols} FROM payment_receipts WHERE drive_id = ? AND settled_at < ? ORDER BY settled_at DESC, rowid DESC LIMIT ?`)
      .all(driveId, opts.before, opts.limit)) as (ReceiptRow & { rowid: number })[];
  const last = rows[rows.length - 1];
  if (last && rows.length === opts.limit) {
    rows.push(...(db
      .prepare(`SELECT ${cols} FROM payment_receipts WHERE drive_id = ? AND settled_at = ? AND rowid < ? ORDER BY rowid DESC`)
      .all(driveId, last.settled_at, last.rowid) as (ReceiptRow & { rowid: number })[]));
  }
  return rows.map(({ rowid: _rowid, ...r }) => r);
}
