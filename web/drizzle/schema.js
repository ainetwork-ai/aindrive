// Runtime JS version of schema.ts — used by db.js at server startup.
// For type-checking and drizzle-kit, see schema.ts.
import {
  sqliteTable,
  text,
  real,
  integer,
  blob,
  uniqueIndex,
  index,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

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

export const drives = sqliteTable("drives", {
  id: text("id").primaryKey(),
  owner_id: text("owner_id").notNull(),
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
  payout_wallet: text("payout_wallet"),
  allowed_tokens: text("allowed_tokens"),
});

export const drive_members = sqliteTable(
  "drive_members",
  {
    id: text("id").primaryKey(),
    drive_id: text("drive_id").notNull(),
    user_id: text("user_id").notNull(),
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

export const shares = sqliteTable(
  "shares",
  {
    id: text("id").primaryKey(),
    drive_id: text("drive_id").notNull(),
    path: text("path").notNull().default(""),
    role: text("role").notNull(),
    token: text("token").notNull().unique(),
    expires_at: text("expires_at"),
    created_by: text("created_by"),
    created_at: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`),
    price_usdc: real("price_usdc"),
    currency: text("currency"),
    listed: integer("listed").notNull().default(0),
  },
  (t) => [index("idx_shares_drive").on(t.drive_id)]
);

export const payment_receipts = sqliteTable(
  "payment_receipts",
  {
    id: text("id").primaryKey(),
    drive_id: text("drive_id").notNull(),
    path: text("path").notNull().default(""),
    wallet: text("wallet").notNull(),
    tx_hash: text("tx_hash").notNull().unique(),
    amount_usdc: real("amount_usdc"),
    network: text("network").notNull(),
    share_id: text("share_id"),
    settled_at: text("settled_at")
      .notNull()
      .default(sql`(datetime('now'))`),
    // NEW (Phase 4): the account this payment is attributed to. Nullable for
    // legacy/anonymous receipts settled before the payer linked a wallet.
    account_id: text("account_id"),
  },
  (t) => [
    index("idx_payment_receipts_wallet").on(t.wallet),
    index("idx_payment_receipts_drive_wallet").on(t.drive_id, t.wallet),
  ]
);

export const account_wallets = sqliteTable(
  "account_wallets",
  {
    id: text("id").primaryKey(),
    account_id: text("account_id").notNull(),
    wallet_address: text("wallet_address").notNull().unique(),
    linked_at: text("linked_at")
      .notNull()
      .default(sql`(datetime('now'))`),
    verified_via: text("verified_via").notNull().default("siwe"),
  },
  (t) => [index("idx_account_wallets_account").on(t.account_id)]
);
