// Runtime JS version of schema.ts — used by db.js at server startup.
// For type-checking and drizzle-kit, see schema.ts.
import {
  sqliteTable,
  text,
  real,
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

export const folder_access = sqliteTable(
  "folder_access",
  {
    id: text("id").primaryKey(),
    drive_id: text("drive_id").notNull(),
    path: text("path").notNull().default(""),
    wallet_address: text("wallet_address").notNull(),
    added_by: text("added_by").notNull(),
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
