/**
 * Shared skill handlers — single backing function used by the A2A
 * AgentExecutor (lib/aindrive-agent.ts) and the MCP tool handlers
 * (app/mcp/route.ts).
 *
 *   runSkill(ctx, name, args) →
 *     { kind: "ok",  structured, text }     happy path
 *     { kind: "err", code, message }         validation / auth / internal
 *
 * Auth: ctx.userId is supplied by the caller (route handlers extract
 * the JWT before invoking). resolveAccess + atLeast gate every drive
 * op per-path; the sale tools (ctx.sell only) are drive-creator-only and
 * run the HTTP routes' validation from lib/sales.ts.
 *
 * Descriptors include JSON Schema for tool/skill inputs so MCP can
 * emit them verbatim in tools/list and A2A can use them to validate
 * DataParts in v1.1.
 */

import { maxRoleInDrive } from "@/lib/mcp-tokens";
import { getDrive, listUserDrives, listPayoutWallets, setDriveAllowedTokens, type DriveRow } from "@/lib/drives";
import { resolveAccess, atLeast, type Role } from "@/lib/access";
import { callAgent, AgentError } from "@/lib/rpc";
import { paidAccessDenial, paidLocksForListing } from "@/lib/sale-access.js";
import { normalizePath } from "@/lib/path";
import { getOwnerStorageCaps } from "@/lib/tier";
import { getOwnerUsage, bumpOwnerUsage } from "@/lib/storage-usage.js";
import { isSystemPath } from "@/shared/domain/policy/system-paths";
import { resolveDriveTokens } from "@/lib/payment-tokens";
import {
  ShareCreateBody, ShareEditBody, applyPayoutWallet, createShare, editShare, listReceipts, listShares,
  revokeShare, shareUrl, tokenPolicyFromList, type SaleErr,
} from "@/lib/sales";
import { runPaySkill } from "@/lib/x402-pay-skills";
import {
  MUTATING, isPaySkill, isSaleSkill, isSkillName, type SaleSkillName,
} from "./skill-descriptors";
export * from "./skill-descriptors";


/** search walks one agent RPC per folder; bound the walk, not just the matches. */
const MAX_SEARCH_DIRS = 1000;

// Mirrors fs/write/route.ts (AINDRIVE_MAX_WRITE_BYTES).
const MAX_WRITE_BYTES = parseInt(process.env.AINDRIVE_MAX_WRITE_BYTES ?? String(100 * 1024 * 1024), 10);

function splitPath(p: string): { parent: string; base: string } {
  const i = p.lastIndexOf("/");
  return i < 0 ? { parent: "", base: p } : { parent: p.slice(0, i), base: p.slice(i + 1) };
}

/**
 * `driveId` pins every call to one drive (drive-scoped MCP endpoint /
 * token): `drive_id` defaults to it, any other drive is forbidden, and
 * `list_drives` is unavailable. `scope` is the token's ceiling — "read"
 * forbids write_file regardless of the user's role. Both omitted = the
 * legacy account-wide surface (A2A executor, session-auth /mcp).
 * `sell` (account grant with `drives:sell`) unlocks the sale tools; they
 * are refused everywhere else. `pay` (a session, or an account grant with
 * `wallet:pay`) unlocks the x402 pay tools — no drive, the account's wallet.
 */
export type SkillCtx = { userId: string; driveId?: string; scope?: "read" | "write"; sell?: boolean; pay?: boolean };

export type SkillOk = { kind: "ok"; structured: unknown; text: string };
export type SkillErr = {
  kind: "err";
  code: "invalid_params" | "forbidden" | "internal" | "not_found";
  message: string;
};
export type SkillResult = SkillOk | SkillErr;

function arg(args: Record<string, unknown>, key: string): unknown {
  return args && typeof args === "object" ? args[key] : undefined;
}

export async function runSkill(
  ctx: SkillCtx,
  name: string,
  args: Record<string, unknown>,
): Promise<SkillResult> {
  if (!isSkillName(name)) {
    return { kind: "err", code: "invalid_params", message: `unknown skill: ${name}` };
  }

  if (name === "list_drives") {
    if (ctx.driveId) {
      return { kind: "err", code: "forbidden", message: "list_drives is unavailable on a drive-scoped endpoint" };
    }
    // Owned AND member drives (same set as /api/oauth/drives).
    // No owner_id: other users' internal ids stay private (as /api/oauth/drives).
    const rows = listUserDrives(ctx.userId).map((d) => ({ id: d.id, name: d.name, role: maxRoleInDrive(d.id, ctx.userId) }));
    const text = rows.length === 0
      ? "(no drives)"
      : rows.map((r) => `${r.id} — ${r.name}`).join("\n");
    return { kind: "ok", structured: { drives: rows }, text };
  }

  if (isPaySkill(name)) {
    if (!ctx.pay) return { kind: "err", code: "forbidden", message: "forbidden (token lacks the wallet:pay scope)" };
    return runPaySkill(ctx.userId, name, args);
  }

  if (isSaleSkill(name) && !ctx.sell) {
    return { kind: "err", code: "forbidden", message: "forbidden (token lacks the drives:sell scope)" };
  }

  const driveIdRaw = arg(args, "drive_id") ?? ctx.driveId;
  if (ctx.driveId && driveIdRaw !== ctx.driveId) {
    return { kind: "err", code: "forbidden", message: "token is scoped to a different drive" };
  }
  if (typeof driveIdRaw !== "string" || !driveIdRaw) {
    return { kind: "err", code: "invalid_params", message: "drive_id required" };
  }
  const driveId: string = driveIdRaw;
  const drive = getDrive(driveId);
  if (!drive) return { kind: "err", code: "not_found", message: "drive_not_found" };
  if (isSaleSkill(name)) return runSaleSkill(ctx.userId, name, drive, args);
  const driveSecret: string = drive.drive_secret;

  // Canonicalize ONCE and use the same string for every check and the agent
  // call: access, paywall and system-path checks must all see the path the
  // agent will actually touch ("/paid/a.pdf" and "paid//a.pdf" are "paid/a.pdf").
  // (search walks from `path` too.)
  const rawPath = arg(args, "path");
  let path: string;
  try {
    path = normalizePath(typeof rawPath === "string" ? rawPath : "");
  } catch (e) {
    return { kind: "err", code: "invalid_params", message: `invalid path: ${(e as Error).message}` };
  }
  // `.aindrive/` holds the agent token, drive secret and agent API keys —
  // never reachable through a skill, whatever the caller's role.
  if (isSystemPath(path)) {
    return { kind: "err", code: "forbidden", message: "reserved path" };
  }

  const need: Role = MUTATING.includes(name) ? "editor" : "viewer";
  if (need === "editor" && ctx.scope === "read") {
    return { kind: "err", code: "forbidden", message: "forbidden (token scope is read-only)" };
  }
  const role = await resolveAccess(driveId, path, ctx.userId);
  if (!atLeast(role, need)) {
    return { kind: "err", code: "forbidden", message: `forbidden (need ${need}, have ${role})` };
  }
  // Paid carve-out, mirroring requireDriveRole on the fs/* routes: a bare
  // viewer can't open (read or list into) a priced subtree without an
  // entitlement. editor+ bypass inside paidAccessDenial.
  if (name !== "stat" && paidAccessDenial(driveId, path, role, ctx.userId)) {
    return { kind: "err", code: "forbidden", message: `payment required for ${path || "/"}` };
  }

  // R-VIS-PAID-001, as in fs/list: listed paid children show as locked,
  // unlisted (private, link-only) paid children are hidden entirely.
  type Entry = { name: string; isDir: boolean; size?: number; locked?: boolean };
  const visibleEntries = (dir: string, entries: Entry[]): Entry[] => {
    const locks = paidLocksForListing(driveId, dir, entries.map((e) => e.name), role, ctx.userId);
    return entries
      .filter((e) => !(locks[e.name] && !locks[e.name].listed))
      .map((e) => (locks[e.name] ? { ...e, locked: true } : e));
  };

  try {
    switch (name) {
      case "list_files": {
        const r = await callAgent(driveId, driveSecret, { method: "list", path });
        const entries = visibleEntries(path, (r.entries ?? []) as Entry[]);
        const text = entries.length === 0
          ? `(empty) ${path || "/"}`
          : entries.map((e) => `${e.isDir ? "📁" : "📄"} ${e.name}${e.locked ? " 🔒" : ""}`).join("\n");
        return { kind: "ok", structured: { entries }, text };
      }
      case "read_file": {
        if (!path) return { kind: "err", code: "invalid_params", message: "path required" };
        const encoding = (arg(args, "encoding") === "base64" ? "base64" : "utf8") as "utf8" | "base64";
        const r = await callAgent(driveId, driveSecret, { method: "read", path, encoding });
        const text = typeof r.content === "string"
          ? (encoding === "utf8" ? r.content : `[base64, ${r.content.length} chars]`)
          : "";
        return { kind: "ok", structured: r, text };
      }
      case "write_file": {
        if (!path) return { kind: "err", code: "invalid_params", message: "path required" };
        const content = arg(args, "content");
        if (typeof content !== "string") {
          return { kind: "err", code: "invalid_params", message: "content (string) required" };
        }
        const encoding = (arg(args, "encoding") === "base64" ? "base64" : "utf8") as "utf8" | "base64";
        // Same caps as fs/write: payload size + the owner's tiered file count on create.
        const byteLength = encoding === "base64" ? Math.ceil(content.length * 3 / 4) : Buffer.byteLength(content, "utf8");
        if (byteLength > MAX_WRITE_BYTES) {
          return { kind: "err", code: "invalid_params", message: `payload too large (limit ${MAX_WRITE_BYTES} bytes)` };
        }
        const { parent, base } = splitPath(path);
        let creating = true;
        try {
          const l = await callAgent(driveId, driveSecret, { method: "list", path: parent });
          creating = !((l.entries ?? []) as Entry[]).some((e) => e.name === base && !e.isDir);
        } catch { /* parent missing → create */ }
        // The cap is the drive owner's (their tier, or AINDRIVE_UNLIMITED_OWNERS),
        // not the caller's: PAT / account-token calls carry no wallet cookie.
        const ownerId = drive.owner_id as string;
        if (creating) {
          const { tier, fileLimit: limit } = getOwnerStorageCaps(ownerId);
          if (Number.isFinite(limit) && getOwnerUsage(ownerId).files + 1 > limit) {
            return { kind: "err", code: "forbidden", message: `file_limit_reached (tier ${tier}, limit ${limit})` };
          }
        }
        const r = await callAgent(driveId, driveSecret, { method: "write", path, content, encoding });
        if (creating) bumpOwnerUsage(ownerId, { files: 1 });
        return { kind: "ok", structured: r, text: `wrote ${path}` };
      }
      case "delete_path": {
        // "" is the drive root — the whole shared folder, never a delete target
        if (!path) return { kind: "err", code: "invalid_params", message: "path required (the drive root cannot be deleted)" };
        // As fs/delete: learn file vs folder first so the owner's usage counter
        // moves the right way. Drift on recursive folder deletes is acceptable —
        // limits are upper bounds.
        const { parent, base } = splitPath(path);
        let kind: "file" | "folder" | "unknown" = "unknown";
        try {
          const l = await callAgent(driveId, driveSecret, { method: "list", path: parent });
          const entry = ((l.entries ?? []) as Entry[]).find((e) => e.name === base);
          if (!entry) return { kind: "err", code: "not_found", message: `no entry at ${path}` };
          kind = entry.isDir ? "folder" : "file";
        } catch { /* parent unlistable — let the agent decide */ }
        const r = await callAgent(driveId, driveSecret, { method: "delete", path });
        const ownerId = drive.owner_id as string;
        if (kind === "file") bumpOwnerUsage(ownerId, { files: -1 });
        else if (kind === "folder") bumpOwnerUsage(ownerId, { folders: -1 });
        return { kind: "ok", structured: { ...r, path, kind }, text: `deleted ${path}` };
      }
      case "stat": {
        if (!path) return { kind: "err", code: "invalid_params", message: "path required" };
        const { parent, base } = splitPath(path);
        const r = await callAgent(driveId, driveSecret, { method: "list", path: parent });
        const entry = visibleEntries(parent, (r.entries ?? []) as Entry[]).find((e) => e.name === base);
        if (!entry) return { kind: "err", code: "not_found", message: `no entry at ${path}` };
        return { kind: "ok", structured: entry, text: JSON.stringify(entry) };
      }
      case "search": {
        const qRaw = arg(args, "query");
        if (typeof qRaw !== "string" || !qRaw) {
          return { kind: "err", code: "invalid_params", message: "query required" };
        }
        const q = qRaw.toLowerCase();
        const lim = arg(args, "limit");
        const limit = Math.min(typeof lim === "number" ? lim : 50, 500);
        const matches: Array<{ path: string; isDir: boolean; locked?: boolean }> = [];
        let visited = 0;
        const walk = async (dir: string): Promise<void> => {
          if (matches.length >= limit || visited >= MAX_SEARCH_DIRS) return;
          visited++;
          const r = await callAgent(driveId, driveSecret, { method: "list", path: dir });
          for (const e of visibleEntries(dir, (r.entries ?? []) as Entry[])) {
            if (matches.length >= limit) return;
            const full = dir ? `${dir}/${e.name}` : e.name;
            if (e.name.toLowerCase().includes(q)) matches.push({ path: full, isDir: e.isDir, ...(e.locked ? { locked: true } : {}) });
            // Never descend into a subtree this caller hasn't paid for.
            if (e.isDir && !e.locked) await walk(full);
          }
        };
        await walk(path);
        const text = matches.length === 0
          ? `(no matches for "${qRaw}")`
          : matches.map((m) => `${m.isDir ? "📁" : "📄"} ${m.path}${m.locked ? " 🔒" : ""}`).join("\n");
        return { kind: "ok", structured: { matches, truncated: matches.length >= limit || visited >= MAX_SEARCH_DIRS }, text };
      }
    }
  } catch (e) {
    const err = e as AgentError;
    return { kind: "err", code: "internal", message: err.message || String(e) };
  }

  return { kind: "err", code: "internal", message: "unreachable" };
}

function saleErr(e: SaleErr): SkillErr {
  const code = e.status === 400 ? "invalid_params" : e.status === 403 ? "forbidden" : e.status === 404 ? "not_found" : "internal";
  return { kind: "err", code, message: e.error };
}

function invalidInput(issues: { path: (string | number)[]; message: string }[]): SkillErr {
  const first = issues[0];
  const field = first?.path.join(".").replace(/^price_usdc$/, "price");
  return { kind: "err", code: "invalid_params", message: `invalid input${field ? ` (${field})` : ""}: ${first?.message ?? "bad arguments"}` };
}

const optionalString = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/**
 * The sale tools: thin adapters over lib/sales.ts, which holds the same
 * validation the HTTP routes run. Creator-only like the payout / token-policy
 * / receipts routes (docs/PERMISSIONS.md) — checked on every call, so a
 * token stops working here the moment its user no longer created the drive.
 */
async function runSaleSkill(
  userId: string,
  name: SaleSkillName,
  drive: DriveRow,
  args: Record<string, unknown>,
): Promise<SkillResult> {
  if (drive.owner_id !== userId) {
    return { kind: "err", code: "forbidden", message: "forbidden (only the drive's creator can manage its sales)" };
  }
  const driveId = drive.id;
  switch (name) {
    case "list_shares": {
      const shares = listShares(driveId).map((s) => ({
        id: s.id, token: s.token, url: shareUrl(s.token), path: s.path, role: s.role,
        price: s.price_usdc, currency: s.currency, listed: s.listed === 1,
        expiresAt: s.expires_at, createdAt: s.created_at,
      }));
      const text = shares.length === 0
        ? "(no share links)"
        : shares.map((s) => `${s.id} ${s.path || "/"} ${s.price === null ? "free" : `${s.price} ${s.currency}`}${s.listed ? " listed" : ""} ${s.url}`).join("\n");
      return { kind: "ok", structured: { shares }, text };
    }
    case "create_share": {
      // No default path: a forgotten path must not put the whole drive on sale.
      if (typeof arg(args, "path") !== "string") {
        return { kind: "err", code: "invalid_params", message: "path required ('' sells the whole drive)" };
      }
      const body = ShareCreateBody.safeParse({
        path: arg(args, "path"),
        role: arg(args, "role") ?? "viewer",
        expiresAt: arg(args, "expiresAt"),
        price_usdc: arg(args, "price"),
        currency: arg(args, "currency"),
        listed: arg(args, "listed") ?? true,
      });
      if (!body.success) return invalidInput(body.error.issues);
      if (body.data.price_usdc === undefined) return { kind: "err", code: "invalid_params", message: "price required" };
      const r = await createShare(drive, userId, body.data);
      if (!r.ok) return saleErr(r);
      return { kind: "ok", structured: { id: r.id, token: r.token, url: r.url }, text: `on sale: ${r.url}` };
    }
    case "update_share": {
      const shareId = optionalString(arg(args, "shareId"));
      if (!shareId) return { kind: "err", code: "invalid_params", message: "shareId required" };
      const body = ShareEditBody.safeParse({
        price_usdc: arg(args, "price"),
        currency: arg(args, "currency"),
        listed: arg(args, "listed"),
      });
      if (!body.success) return invalidInput(body.error.issues);
      const r = editShare(drive, userId, shareId, body.data);
      if (!r.ok) return saleErr(r);
      return { kind: "ok", structured: { ok: true }, text: `updated ${shareId}` };
    }
    case "delete_share": {
      const shareId = optionalString(arg(args, "shareId"));
      if (!shareId) return { kind: "err", code: "invalid_params", message: "shareId required" };
      const r = revokeShare(driveId, userId, shareId);
      if (!r.ok) return saleErr(r);
      return { kind: "ok", structured: { ok: true }, text: `revoked ${shareId}` };
    }
    case "get_sale_settings": {
      const payoutWallets = listPayoutWallets(driveId);
      const allowedTokens = resolveDriveTokens(drive.allowed_tokens);
      const text = [
        ...payoutWallets.map((w) => `payout ${w.path || "/"} → ${w.wallet}`),
        `tokens: ${allowedTokens.map((t) => `${t.symbol} (${t.chain})`).join(", ")}`,
      ].join("\n");
      return { kind: "ok", structured: { payoutWallets, allowedTokens }, text };
    }
    case "set_payout_wallet": {
      const r = applyPayoutWallet(driveId, { path: arg(args, "path"), wallet: arg(args, "wallet") });
      if (!r.ok) return saleErr(r);
      return { kind: "ok", structured: { ok: true }, text: "payout wallet set" };
    }
    case "set_token_policy": {
      const r = tokenPolicyFromList(arg(args, "tokens"));
      if (!r.ok) return saleErr(r);
      setDriveAllowedTokens(driveId, r.json);
      return { kind: "ok", structured: { ok: true }, text: "token policy set" };
    }
    case "list_receipts": {
      const lim = arg(args, "limit") ?? 50;
      if (typeof lim !== "number" || !Number.isInteger(lim) || lim < 1 || lim > 500) {
        return { kind: "err", code: "invalid_params", message: "limit must be an integer from 1 to 500" };
      }
      const before = arg(args, "before");
      if (before !== undefined && typeof before !== "string") {
        return { kind: "err", code: "invalid_params", message: "before must be a settledAt string" };
      }
      const receipts = listReceipts(driveId, { limit: lim, before }).map((r) => ({
        txHash: r.tx_hash, path: r.path, wallet: r.wallet, amount: r.amount_usdc, currency: r.currency,
        network: r.network, shareId: r.share_id, accountId: r.account_id, settledAt: r.settled_at,
      }));
      const text = receipts.length === 0
        ? "(no receipts)"
        : receipts.map((r) => `${r.settledAt} ${r.amount ?? "?"} ${r.currency ?? ""} ${r.path || "/"} ${r.txHash}`).join("\n");
      return { kind: "ok", structured: { receipts }, text };
    }
  }
}
