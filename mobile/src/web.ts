/**
 * The web app's drive features, called from the phone with the account's
 * session — the same endpoints web/components use (share-dialog, drive-manage,
 * create-agent-modal, folder-chat, mcp-modal). Contracts: web/app/api/README.md.
 * Nothing here talks to the phone's own agent; these are server-side records
 * (members, links, sales, agents, tokens) plus fs/* for drives on OTHER devices.
 */
import { request } from "./api";

export type Role = "viewer" | "editor" | "owner";
export interface Member { id: string; path: string; role: Role; email: string; name: string; isCreator?: boolean }
export interface Invite { id: string; email: string; role: Role; path: string; created_at?: string; expires_at?: string }
export interface Share { id: string; path: string; role: "viewer" | "editor"; token: string; url?: string; expires_at?: string | null; created_at?: string; price_usdc?: number | null; currency?: string | null; listed?: number | boolean | null }
export interface Receipt { id: string; path: string; wallet: string; tx_hash: string; amount_usdc: number; currency?: string; network?: string; share_id?: string; settled_at: string }
export interface PayoutWallet { path: string; wallet: string }
export interface DriveSettings { payout_wallet?: string | null; payout_wallets?: PayoutWallet[]; allowed_tokens?: unknown }
export interface Agent { id: string; name: string; description?: string; folder?: string; persona?: string; llm?: { provider: string; model: string } }
export interface McpToken { id: string; name: string; scope: "read" | "write"; created_at?: string; expires_at?: string | null; last_used_at?: string | null; mine?: boolean }
export interface Me { id: string; email?: string | null; name?: string | null; wallet?: string | null }
/** A connected app's workspace a folder can be shared into (web/lib/connected-apps.ts). */
export interface AppSpace { id: string; name: string; group?: string; icon?: string | null; members?: number; shared: boolean }
export interface AppSpaces { app: { id: string; name: string; origin: string }; spaces: AppSpace[]; error?: string }
export interface DriveInfo { id: string; name: string; hostname: string | null; online: boolean; lastSeenAt?: string | null; owned?: boolean }

export class Web {
  constructor(private server: string, private cookie: string) {}
  private d(driveId: string, rest = "") { return `/api/drives/${encodeURIComponent(driveId)}${rest}`; }
  private call<T>(method: string, path: string, body?: unknown, headers?: Record<string, string>) {
    return request<T>(this.server, method, path, body, this.cookie, headers);
  }

  me() { return this.call<{ user: Me }>("GET", "/api/auth/me").then((r) => r.user); }
  drives() { return this.call<{ drives: DriveInfo[] }>("GET", "/api/drives").then((r) => r.drives); }
  leave(driveId: string) { return this.call<{ ok: boolean }>("POST", this.d(driveId, "/leave"), {}); }
  deleteDrive(driveId: string) { return this.call<unknown>("DELETE", this.d(driveId)); }
  settings(driveId: string) { return this.call<DriveSettings>("GET", this.d(driveId)); }
  setAllowedTokens(driveId: string, allowed_tokens: unknown) { return this.call<unknown>("PATCH", this.d(driveId), { allowed_tokens }); }

  // members
  members(driveId: string) { return this.call<{ members: Member[]; pending: Invite[]; myRole: Role }>("GET", this.d(driveId, "/members")); }
  invite(driveId: string, email: string, role: Role, path: string) { return this.call<unknown>("POST", this.d(driveId, "/members"), { email, role, path }); }
  setRole(driveId: string, memberId: string, role: Role) { return this.call<unknown>("PATCH", this.d(driveId, `/members/${encodeURIComponent(memberId)}`), { role }); }
  removeMember(driveId: string, memberId: string) { return this.call<unknown>("DELETE", this.d(driveId, `/members/${encodeURIComponent(memberId)}`)); }
  cancelInvite(driveId: string, inviteId: string) { return this.call<unknown>("DELETE", this.d(driveId, `/members/invites/${encodeURIComponent(inviteId)}`)); }

  // links & sales
  shares(driveId: string) { return this.call<{ shares: Share[] }>("GET", this.d(driveId, "/shares")).then((r) => r.shares); }
  createShare(driveId: string, body: { path: string; role: "viewer" | "editor"; price_usdc?: number; currency?: string; listed?: boolean }) {
    return this.call<{ id: string; token: string; url: string }>("POST", this.d(driveId, "/shares"), body);
  }
  editShare(driveId: string, shareId: string, body: { price_usdc?: number; currency?: string; listed?: boolean }) { return this.call<unknown>("PATCH", this.d(driveId, `/shares/${encodeURIComponent(shareId)}`), body); }
  revokeShare(driveId: string, shareId: string) { return this.call<unknown>("DELETE", this.d(driveId, `/shares/${encodeURIComponent(shareId)}`)); }
  /** Listed sales in a drive shared with you — the web's "For sale" section (buying happens on the web). */
  showcase(driveId: string) { return this.call<{ items: { shareId: string; leafName: string; role: string; price: number; currency: string | null }[] }>("GET", this.d(driveId, "/showcase")).then((r) => r.items); }
  receipts(driveId: string) { return this.call<{ receipts: Receipt[] }>("GET", this.d(driveId, "/receipts")).then((r) => r.receipts); }
  setPayout(driveId: string, path: string, wallet: string) { return this.call<unknown>("PUT", this.d(driveId, "/payout"), { path, wallet }); }
  clearPayout(driveId: string, path: string) { return this.call<unknown>("DELETE", this.d(driveId, "/payout"), { path }); }

  // connected apps (e.g. ainmem): share this folder into their workspaces
  appSpaces(driveId: string, path: string) { return this.call<{ apps: AppSpaces[] }>("GET", this.d(driveId, `/apps?${new URLSearchParams({ path })}`)).then((r) => r.apps); }
  setAppShared(driveId: string, appId: string, spaceId: string, path: string, shared: boolean) {
    return this.call<unknown>("PUT", this.d(driveId, `/apps/${encodeURIComponent(appId)}/spaces/${encodeURIComponent(spaceId)}`), { path, shared });
  }

  tokenLookup(chain: string, address: string) {
    return this.call<{ ok: boolean; token: { symbol: string; decimals: number; name: string | null; version: string | null; chain: string; asset: string }; eip3009: boolean }>("POST", "/api/token-lookup", { chain, address });
  }

  // agents
  agents(driveId: string) { return this.call<{ agents: Agent[] }>("GET", this.d(driveId, "/agents")).then((r) => r.agents); }
  createAgent(driveId: string, body: { folder: string; name: string; description: string; persona: string; llm: { provider: string; model: string; apiKey?: string } }) {
    return this.call<{ agent: Agent; askUrl?: string; cardUrl?: string }>("POST", this.d(driveId, "/agents"), body);
  }
  deleteAgent(driveId: string, agentId: string) { return this.call<unknown>("DELETE", this.d(driveId, `/agents/${encodeURIComponent(agentId)}`)); }
  askAgent(driveId: string, agentId: string, q: string) {
    return this.call<{ answer: string; sources?: { path: string; snippet?: string }[]; policyName?: string }>("POST", this.d(driveId, `/agents/${encodeURIComponent(agentId)}/ask`), { q });
  }

  // MCP (token routes check Origin, like a browser form post)
  mcp(driveId: string) { return this.call<{ mcpUrl: string; canWrite: boolean; isOwner: boolean; tokens: McpToken[] }>("GET", this.d(driveId, "/mcp-tokens")); }
  createMcpToken(driveId: string, name: string, scope: "read" | "write", ttlDays: 30 | 90 | null) {
    return this.call<{ token: string; id?: string }>("POST", this.d(driveId, "/mcp-tokens"), { name, scope, ttlDays }, { origin: this.server });
  }
  revokeMcpToken(driveId: string, tokenId: string) { return this.call<unknown>("DELETE", this.d(driveId, `/mcp-tokens/${encodeURIComponent(tokenId)}`), undefined, { origin: this.server }); }

  // files on drives served elsewhere (another phone / laptop)
  mkdir(driveId: string, path: string) { return this.call<unknown>("POST", this.d(driveId, "/fs/mkdir"), { path }); }
  rename(driveId: string, from: string, to: string) { return this.call<unknown>("POST", this.d(driveId, "/fs/rename"), { from, to }); }
  remove(driveId: string, path: string) { return this.call<unknown>("POST", this.d(driveId, "/fs/delete"), { path }); }
  writeText(driveId: string, path: string, content: string) { return this.call<unknown>("POST", this.d(driveId, "/fs/write"), { path, content, encoding: "utf8" }); }
  downloadUrl(driveId: string, path: string) { return this.call<{ url: string }>("GET", this.d(driveId, `/fs/download-token?path=${encodeURIComponent(path)}`)).then((r) => r.url); }

  // account
  startAddEmail(email: string) { return this.call<unknown>("POST", "/api/account/email/start", { email }); }
  verifyAddEmail(email: string, code: string, password: string) { return this.call<unknown>("POST", "/api/account/email/verify", { email, code, password }); }

  // ---- file handoff links (web/app/api/handoffs, web/lib/handoff.ts)
  handoffs(body: { driveId: string; audience: string; ttlSeconds: number; files: { deviceKey: string; name: string; mime: string; size: number }[] }) {
    return this.call<{ links: { id: string; url: string; name: string; deviceKey: string; expiresAt: string }[] }>("POST", "/api/handoffs", body);
  }
  listHandoffs() { return this.call<{ handoffs: unknown[] }>("GET", "/api/handoffs"); }
  revokeHandoff(id: string) { return this.call<{ revoked: number }>("DELETE", `/api/handoffs/${encodeURIComponent(id)}`); }
}
