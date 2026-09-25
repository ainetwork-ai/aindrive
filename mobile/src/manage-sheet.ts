// Drive-wide ledger — the phone's web/components/drive-manage.tsx: Members
// (roster + pending invites), Links (every link, filterable, revocable), Sales
// (storefront listings + earnings), Payments (payout wallets, accepted
// tokens, delete drive). Items are created in context (Share drawer); this is
// where they are audited.
import { I, icon, type IconName } from "./icons";
import { esc, msgOf, on, val, when, shortAddr, ROLE_HELP, type Ctx, type Sheet } from "./kit";
import { shareUrl } from "./share-sheet";
import type { Member, Invite, Share, Receipt, PayoutWallet, Role } from "./web";

type Tab = "members" | "links" | "sales" | "payments";
interface Token { symbol: string; chain: string; asset: string; name: string | null; version: string | null; decimals: number; transferMethod: string }

export class ManageSheet implements Sheet {
  kind = "page" as const;
  tab: Tab = "members";
  private members: Member[] = [];
  private pending: Invite[] = [];
  private shares: Share[] = [];
  private receipts: Receipt[] = [];
  private wallets: PayoutWallet[] = [];
  private tokens: Token[] | null = null;
  private linkFilter: "all" | "free" | "paid" | "listed" = "all";
  private memberQuery = "";
  private loading = true;
  private error: string | null = null;
  private busy = false;

  constructor(private ctx: Ctx, private driveId: string, private name: string, private onDeleted: () => void) { void this.load(); }

  private async load() {
    this.loading = true; this.ctx.rerender();
    try {
      const [m, s, r, st] = await Promise.all([
        this.ctx.web.members(this.driveId),
        this.ctx.web.shares(this.driveId),
        this.ctx.web.receipts(this.driveId).catch(() => [] as Receipt[]),
        this.ctx.web.settings(this.driveId),
      ]);
      this.members = m.members; this.pending = m.pending; this.shares = s; this.receipts = r;
      this.wallets = st.payout_wallets ?? (st.payout_wallet ? [{ path: "", wallet: st.payout_wallet }] : []);
      this.tokens = parseTokens(st.allowed_tokens);
      this.error = null;
    } catch (e) { this.error = msgOf(e); }
    this.loading = false; this.ctx.rerender();
  }

  render(): string {
    const tabs: [Tab, string, IconName][] = [["members", "Members", "users"], ["links", "Links", "link"], ["sales", "Sales", "sales"], ["payments", "Payments", "wallet"]];
    const body = this.loading ? `<div class="searching"><span class="spinner"></span> Loading…</div>`
      : this.error ? `<div class="empty"><h3>Couldn’t load</h3><p>${esc(this.error)}</p></div>`
      : this.tab === "members" ? this.membersTab() : this.tab === "links" ? this.linksTab() : this.tab === "sales" ? this.salesTab() : this.paymentsTab();
    return `
      <div class="sheet">
        <div class="bar">
          <button class="iconbtn ghost" id="mg-close" aria-label="Back">${I.back}</button>
          <div class="crumbs"><div class="sub">Manage</div><div class="title">${esc(this.name)}</div></div>
        </div>
        <div class="tabs" role="tablist">${tabs.map(([t, label, ic]) => `<button role="tab" data-tab="${t}" aria-selected="${this.tab === t}">${icon(ic, 18)} ${label}</button>`).join("")}</div>
        <div class="body">${body}</div>
      </div>`;
  }

  private membersTab(): string {
    const q = this.memberQuery.toLowerCase();
    const rows = this.members.filter((m) => !q || `${m.email} ${m.name} ${m.path}`.toLowerCase().includes(q));
    return `
      <div class="scard">
        <div class="scard-h">${I.users} Members</div>
        <div class="scard-s">Who has access, and where.</div>
        <input type="email" id="mg-email" placeholder="Invite by email" />
        <input type="text" id="mg-path" placeholder="folder (blank = all)" style="margin-top:8px" />
        <div class="row2" style="margin-top:8px"><select id="mg-role"><option value="viewer">Viewer</option><option value="editor">Editor</option><option value="owner">Owner</option></select>
          <button class="btn small" id="mg-invite" ${this.busy ? "disabled" : ""}>Invite</button></div>
        <p class="hint"><b>Viewer:</b> ${ROLE_HELP.viewer} · <b>Editor:</b> ${ROLE_HELP.editor} · <b>Owner:</b> ${ROLE_HELP.owner}</p>
      </div>
      <input type="search" id="mg-q" placeholder="Search members" value="${esc(this.memberQuery)}" />
      <div class="section"><h2>${rows.length} grant${rows.length === 1 ? "" : "s"}</h2></div>
      ${rows.length ? `<ul class="list card" style="padding:0 14px">${rows.map((m) => `
        <li data-mid="${esc(m.id)}"><div class="avatar">${esc((m.name || m.email || "?").slice(0, 1).toUpperCase())}</div>
          <div class="grow"><div class="t">${esc(m.name || m.email)}${m.isCreator ? ` <span class="badge accent">Creator</span>` : ""}</div><div class="s">${esc(m.email)} · ${esc(m.path || "whole drive")}</div></div>
          ${m.isCreator ? `<span class="badge">Owner</span>` : `<select data-role>${(["viewer", "editor", "owner"] as Role[]).map((r) => `<option value="${r}" ${m.role === r ? "selected" : ""}>${cap(r)}</option>`).join("")}</select>
          <button class="iconbtn ghost" data-remove aria-label="Remove">${icon("userMinus", 18)}</button>`}
        </li>`).join("")}</ul>` : `<div class="empty"><div class="art">${I.users}</div><h3>No members yet</h3><p>Invite someone above to get started.</p></div>`}
      ${this.pending.length ? `<div class="section"><h2>Pending invites</h2></div>
        <ul class="list card" style="padding:0 14px">${this.pending.map((v) => `
          <li data-iid="${esc(v.id)}"><div class="avatar">${icon("mail", 16)}</div>
            <div class="grow"><div class="t">${esc(v.email)}</div><div class="s">${cap(v.role)} · ${esc(v.path || "whole drive")}${v.expires_at ? ` · expires ${esc(when(v.expires_at))}` : ""}</div></div>
            <button class="iconbtn ghost" data-cancel aria-label="Cancel invite">${icon("close", 18)}</button></li>`).join("")}</ul>` : ""}`;
  }

  private linksTab(): string {
    const f = this.linkFilter;
    const rows = this.shares.filter((s) => f === "all" || (f === "free" ? !s.price_usdc : f === "paid" ? !!s.price_usdc : !!s.listed));
    return `
      <div class="seg" style="margin-bottom:12px">${(["all", "free", "paid", "listed"] as const).map((x) => `<button data-filter="${x}" aria-pressed="${f === x}" style="width:auto;padding:0 12px">${cap(x)}</button>`).join("")}</div>
      ${rows.length ? `<ul class="list card" style="padding:0 14px">${rows.map((s) => `
        <li data-sid="${esc(s.id)}" data-url="${esc(shareUrl(this.ctx.server, s))}">
          <div class="grow"><div class="t">${esc(s.path || "/ (whole drive)")}</div>
            <div class="s">${s.price_usdc ? `${esc(s.price_usdc)} ${esc(s.currency || "USDC")}${s.listed ? " · listed" : ""}` : `${cap(s.role)} · free`} · ${esc(when(s.created_at))}</div></div>
          <button class="iconbtn ghost" data-copy aria-label="Copy">${icon("copy", 18)}</button>
          <button class="iconbtn ghost" data-revoke aria-label="Revoke">${icon("trash", 18)}</button></li>`).join("")}</ul>`
        : `<div class="empty"><div class="art">${I.link}</div><h3>No links</h3><p>Share a file or folder to create one.</p></div>`}`;
  }

  private salesTab(): string {
    const listed = this.shares.filter((s) => s.price_usdc && s.listed);
    const byCur = new Map<string, number>();
    for (const r of this.receipts) byCur.set(r.currency || "USDC", (byCur.get(r.currency || "USDC") ?? 0) + Number(r.amount_usdc || 0));
    return `
      <div class="scard"><div class="scard-h">${I.sales} Earnings</div>
        <div class="scard-s">${this.receipts.length} sale${this.receipts.length === 1 ? "" : "s"}</div>
        <div style="font-size:24px;font-weight:600">${byCur.size ? [...byCur].map(([c, v]) => `${v.toFixed(2)} ${esc(c)}`).join(" · ") : "0.00 USDC"}</div></div>
      <div class="section"><h2>Storefront</h2></div>
      ${listed.length ? `<ul class="list card" style="padding:0 14px">${listed.map((s) => `<li data-sid="${esc(s.id)}" data-url="${esc(shareUrl(this.ctx.server, s))}"><div class="grow"><div class="t">${esc(s.path || "/")}</div><div class="s">${esc(s.price_usdc)} ${esc(s.currency || "USDC")}</div></div><button class="iconbtn ghost" data-copy aria-label="Copy">${icon("copy", 18)}</button></li>`).join("")}</ul>`
        : `<p class="hint">Nothing listed. Use Share → Sell on a file or folder.</p>`}
      <div class="section"><h2>Receipts</h2></div>
      ${this.receipts.length ? `<ul class="list card" style="padding:0 14px">${this.receipts.map((r) => `<li><div class="grow"><div class="t">${esc(r.amount_usdc)} ${esc(r.currency || "USDC")} · ${esc(r.path || "/")}</div><div class="s">${esc(shortAddr(r.wallet))} · ${esc(when(r.settled_at))}${r.network ? ` · ${esc(r.network)}` : ""}</div></div></li>`).join("")}</ul>`
        : `<p class="hint">No sales yet.</p>`}`;
  }

  private paymentsTab(): string {
    const toks = this.tokens;
    return `
      <div class="scard"><div class="scard-h">${I.wallet} Payout wallets</div>
        <div class="scard-s">Where sale proceeds go. A folder's wallet overrides the drive's.</div>
        ${this.wallets.length ? `<ul class="list">${this.wallets.map((w) => `<li data-wpath="${esc(w.path)}"><div class="grow"><div class="t mono">${esc(w.wallet)}</div><div class="s">${esc(w.path || "whole drive")}</div></div><button class="iconbtn ghost" data-unpay aria-label="Remove">${icon("trash", 18)}</button></li>`).join("")}</ul>` : `<p class="hint">No payout wallet — sales can't settle until you add one.</p>`}
        <input type="text" id="mg-wallet" placeholder="0x… wallet address" style="margin-top:8px" />
        <input type="text" id="mg-wpath" placeholder="folder (blank = whole drive)" style="margin-top:8px" />
        <button class="btn" id="mg-setpay" ${this.busy ? "disabled" : ""}>${I.plus} Set payout wallet</button></div>
      <div class="scard"><div class="scard-h">${I.dollar} Accepted tokens</div>
        <div class="scard-s">The currencies you can price a sale in. Each sale is paid in one token.</div>
        ${toks === null ? `<p class="hint">Default: USDC.</p>` : ""}
        <ul class="list">${(toks ?? []).map((t, i) => `<li data-ti="${i}"><div class="grow"><div class="t">${esc(t.symbol)}</div><div class="s mono">${esc(t.chain)} · ${esc(shortAddr(t.asset))}</div></div>${(toks ?? []).length > 1 ? `<button class="iconbtn ghost" data-untok aria-label="Remove">${icon("trash", 18)}</button>` : ""}</li>`).join("")}</ul>
        <div class="row2" style="margin-top:8px"><select id="mg-chain"><option value="base">Base</option><option value="base-sepolia">Base Sepolia</option></select><span></span></div>
        <div class="row2" style="margin-top:8px"><input type="text" id="mg-token" placeholder="Token contract 0x…" /><button class="btn small" id="mg-addtok" ${this.busy ? "disabled" : ""}>Add</button></div></div>
      <div class="scard" style="border-color:var(--err-line)"><div class="scard-h" style="color:var(--err)">${icon("trash", 18)} Delete drive</div>
        <div class="scard-s">Removes the drive from aindrive: members lose access and links stop working. Files on the device are not deleted.</div>
        <button class="btn danger" id="mg-delete">Delete “${esc(this.name)}”</button></div>`;
  }

  bind(root: HTMLElement) {
    on(root, "#mg-close", "click", () => this.ctx.close());
    on(root, "[data-tab]", "click", (el) => { this.tab = el.dataset.tab as Tab; this.ctx.rerender(); });
    on(root, "[data-filter]", "click", (el) => { this.linkFilter = el.dataset.filter as typeof this.linkFilter; this.ctx.rerender(); });
    on(root, "#mg-q", "input", (el) => { this.memberQuery = (el as HTMLInputElement).value; });
    on(root, "#mg-q", "change", () => this.ctx.rerender());
    on(root, "#mg-invite", "click", () => this.act(async () => {
      const email = val(root, "mg-email");
      if (!/.+@.+\..+/.test(email)) throw new Error("Enter an email address");
      await this.ctx.web.invite(this.driveId, email, val(root, "mg-role") as Role, val(root, "mg-path").replace(/^\/+|\/+$/g, ""));
      this.ctx.notify(`Invited ${email}`); this.ctx.forget("mg-email", "mg-path");
    }));
    on(root, "[data-mid] select[data-role]", "change", (el) => this.act(() => this.ctx.web.setRole(this.driveId, el.closest<HTMLElement>("[data-mid]")!.dataset.mid!, (el as HTMLSelectElement).value as Role).then(() => {})));
    on(root, "[data-mid] [data-remove]", "click", (el) => this.act(async () => {
      if (!(await this.ctx.confirm("Remove this member?", "They lose access right away.", "Remove", true))) return;
      await this.ctx.web.removeMember(this.driveId, el.closest<HTMLElement>("[data-mid]")!.dataset.mid!);
    }));
    on(root, "[data-iid] [data-cancel]", "click", (el) => this.act(() => this.ctx.web.cancelInvite(this.driveId, el.closest<HTMLElement>("[data-iid]")!.dataset.iid!).then(() => {})));
    on(root, "[data-sid] [data-copy]", "click", (el) => void this.ctx.copy(el.closest<HTMLElement>("[data-sid]")!.dataset.url!, "Link"));
    on(root, "[data-sid] [data-revoke]", "click", (el) => this.act(async () => {
      if (!(await this.ctx.confirm("Revoke this link?", "It stops working for anyone who hasn't used it.", "Revoke", true))) return;
      await this.ctx.web.revokeShare(this.driveId, el.closest<HTMLElement>("[data-sid]")!.dataset.sid!);
    }));
    on(root, "#mg-setpay", "click", () => this.act(async () => {
      const wallet = val(root, "mg-wallet");
      if (!/^0x[0-9a-fA-F]{40}$/.test(wallet)) throw new Error("Enter a 0x wallet address (40 hex digits)");
      await this.ctx.web.setPayout(this.driveId, val(root, "mg-wpath").replace(/^\/+|\/+$/g, ""), wallet);
      this.ctx.notify("Payout wallet saved"); this.ctx.forget("mg-wallet", "mg-wpath");
    }));
    on(root, "[data-wpath] [data-unpay]", "click", (el) => this.act(() => this.ctx.web.clearPayout(this.driveId, el.closest<HTMLElement>("[data-wpath]")!.dataset.wpath!).then(() => {})));
    on(root, "#mg-addtok", "click", () => this.act(async () => {
      const address = val(root, "mg-token");
      if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error("Enter a token contract address (0x + 40 hex)");
      const found = await this.ctx.web.tokenLookup(val(root, "mg-chain"), address);
      // Same rule as the web's token picker: an EIP-3009 token settles directly, anything else via Permit2.
      const tok: Token = { ...found.token, transferMethod: found.eip3009 ? "eip3009" : "permit2" };
      const next = [...(this.tokens ?? []), tok].filter((t, i, a) => a.findIndex((x) => x.asset.toLowerCase() === t.asset.toLowerCase() && x.chain === t.chain) === i);
      await this.ctx.web.setAllowedTokens(this.driveId, JSON.stringify(next));
      this.ctx.notify(`${tok.symbol} accepted`); this.ctx.forget("mg-token");
    }));
    on(root, "[data-ti] [data-untok]", "click", (el) => this.act(async () => {
      const i = Number(el.closest<HTMLElement>("[data-ti]")!.dataset.ti);
      const next = (this.tokens ?? []).filter((_, j) => j !== i);
      await this.ctx.web.setAllowedTokens(this.driveId, JSON.stringify(next));
    }));
    on(root, "#mg-delete", "click", () => void (async () => {
      if (!(await this.ctx.confirm(`Delete “${this.name}”?`, "Members lose access and every link stops working. Files on the device stay.", "Delete drive", true))) return;
      try { await this.ctx.web.deleteDrive(this.driveId); this.ctx.notify("Drive deleted"); this.onDeleted(); }
      catch (e) { this.ctx.notify(msgOf(e), true); }
    })());
  }

  private async act(fn: () => Promise<void>) {
    this.busy = true; this.ctx.rerender();
    try { await fn(); await this.load(); } catch (e) { this.ctx.notify(msgOf(e), true); }
    this.busy = false; this.ctx.rerender();
  }
}

function cap(s: string): string { return s.charAt(0).toUpperCase() + s.slice(1); }

function parseTokens(raw: unknown): Token[] | null {
  let v = raw;
  if (typeof v === "string") { try { v = JSON.parse(v); } catch { return null; } }
  return Array.isArray(v) && v.length ? (v as Token[]) : null;
}
