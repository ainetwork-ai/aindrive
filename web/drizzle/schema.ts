import {
  sqliteTable,
  text,
  real,
  blob,
  uniqueIndex,
  index,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

// ---------------------------------------------------------------------------
// users
// ---------------------------------------------------------------------------
export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  password_hash: text("password_hash").notNull(),
  role: text("role").notNull().default("member"),
  created_at: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

// ---------------------------------------------------------------------------
// drives
// ---------------------------------------------------------------------------
export const drives = sqliteTable("drives", {
  id: text("id").primaryKey(),
  owner_id: text("owner_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  agent_token_hash: text("agent_token_hash").notNull(),
  drive_secret: text("drive_secret").notNull(),
  last_seen_at: text("last_seen_at"),
  last_hostname: text("last_hostname"),
  created_at: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
  namespace_pubkey: blob("namespace_pubkey"),
  namespace_secret: blob("namespace_secret"),
  // EVM wallet that receives x402 payments for this drive's paid shares.
  // Null = fall back to the AINDRIVE_PAYOUT_WALLET env (single-tenant default).
  payout_wallet: text("payout_wallet"),
});

// ---------------------------------------------------------------------------
// drive_members
// ---------------------------------------------------------------------------
export const drive_members = sqliteTable(
  "drive_members",
  {
    id: text("id").primaryKey(),
    drive_id: text("drive_id")
      .notNull()
      .references(() => drives.id, { onDelete: "cascade" }),
    user_id: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    path: text("path").notNull().default(""),
    role: text("role").notNull(),
    created_at: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (t) => [
    uniqueIndex("drive_members_drive_user_path_unique").on(
      t.drive_id,
      t.user_id,
      t.path
    ),
    index("idx_drive_members_user").on(t.user_id),
    index("idx_drive_members_drive").on(t.drive_id),
  ]
);

// ---------------------------------------------------------------------------
// shares
// ---------------------------------------------------------------------------
export const shares = sqliteTable(
  "shares",
  {
    id: text("id").primaryKey(),
    drive_id: text("drive_id")
      .notNull()
      .references(() => drives.id, { onDelete: "cascade" }),
    path: text("path").notNull().default(""),
    role: text("role").notNull(),
    token: text("token").notNull().unique(),
    password_hash: text("password_hash"),
    expires_at: text("expires_at"),
    created_by: text("created_by"),
    created_at: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`),
    price_usdc: real("price_usdc"),
    payment_chain: text("payment_chain"),
  },
  (t) => [index("idx_shares_drive").on(t.drive_id)]
);

// ---------------------------------------------------------------------------
// folder_access
// ---------------------------------------------------------------------------
export const folder_access = sqliteTable(
  "folder_access",
  {
    id: text("id").primaryKey(),
    drive_id: text("drive_id")
      .notNull()
      .references(() => drives.id, { onDelete: "cascade" }),
    path: text("path").notNull().default(""),
    wallet_address: text("wallet_address").notNull(),
    added_by: text("added_by").notNull(),
    // Legacy: most-recent payment tx_hash for paid grants. New code writes
    // receipts to payment_receipts (below) instead. Kept for backward-compat
    // lookups on rows that pre-date the Phase 4 backfill.
    payment_tx: text("payment_tx"),
    added_at: text("added_at")
      .notNull()
      .default(sql`(datetime('now'))`),
    role: text("role").notNull().default("viewer"),
  },
  (t) => [
    uniqueIndex("folder_access_drive_path_wallet_unique").on(
      t.drive_id,
      t.path,
      t.wallet_address
    ),
    index("idx_folder_access_lookup").on(t.drive_id, t.path, t.wallet_address),
    index("idx_folder_access_wallet").on(t.wallet_address),
  ]
);

// ---------------------------------------------------------------------------
// payment_receipts — append-only ledger of every settled x402 payment.
// folder_access tells you WHO has access; payment_receipts tells you HOW
// they got there. tx_hash UNIQUE doubles as replay defense.
// ---------------------------------------------------------------------------
export const payment_receipts = sqliteTable(
  "payment_receipts",
  {
    id: text("id").primaryKey(),
    drive_id: text("drive_id")
      .notNull()
      .references(() => drives.id, { onDelete: "cascade" }),
    path: text("path").notNull().default(""),
    wallet: text("wallet").notNull(),
    tx_hash: text("tx_hash").notNull().unique(),
    // Nullable: NULL = "amount unknown" (legacy backfilled receipts from
    // before Phase 4). A real 0-amount is a different signal.
    amount_usdc: real("amount_usdc"),
    network: text("network").notNull(),
    // Nullable because the originating share may be deleted later.
    share_id: text("share_id"),
    settled_at: text("settled_at")
      .notNull()
      .default(sql`(datetime('now'))`),
    // NEW (Phase 4): the account this payment is attributed to. Nullable for
    // legacy/anonymous receipts settled before the payer linked a wallet;
    // POST /api/wallet/link backfills these on link.
    account_id: text("account_id").references(() => users.id),
  },
  (t) => [
    index("idx_payment_receipts_wallet").on(t.wallet),
    index("idx_payment_receipts_drive_wallet").on(t.drive_id, t.wallet),
  ]
);

// ---------------------------------------------------------------------------
// account_wallets — links an EVM wallet to a users row. One wallet maps to at
// most one account (wallet_address UNIQUE); an account may link many wallets.
// This is how a paid x402 payer (identified only by wallet) gets a durable
// drive_members grant: settle resolves the wallet to an account through here.
// ---------------------------------------------------------------------------
export const account_wallets = sqliteTable(
  "account_wallets",
  {
    id: text("id").primaryKey(),
    account_id: text("account_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    wallet_address: text("wallet_address").notNull().unique(),
    linked_at: text("linked_at")
      .notNull()
      .default(sql`(datetime('now'))`),
    verified_via: text("verified_via").notNull().default("siwe"),
  },
  (t) => [index("idx_account_wallets_account").on(t.account_id)]
);
