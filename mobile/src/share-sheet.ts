// Share drawer for one file or folder — the phone's version of
// web/components/share-dialog.tsx: People (grants at this path), Link sharing
// (free viewer/editor links), and Sell (a priced viewer link, optionally on
// the storefront). "Create in context, audit in settings": the full roster
// and ledger live on the Manage sheet.
import { I, icon } from "./icons";
import { esc, msgOf, on, val, when, ROLE_HELP, type Ctx, type Sheet } from "./kit";
import type { Member, Invite, Share, Role, AppSpaces } from "./web";

export class ShareSheet implements Sheet {
  kind = "drawer" as const;
  private members: Member[] = [];
  private pending: Invite[] = [];
  private shares: Share[] = [];
  private apps: AppSpaces[] = [];
  private tokens: string[] = ["USDC"];
  private loading = true;
  private error: string | null = null;
  private busy = false;
  private myRole: Role = "viewer";

  /** `onNeedPayout`: selling needs a payout wallet first — open the payout wallet screen for this folder. */
  constructor(private ctx: Ctx, private driveId: string, private path: string, private name: string,
              private onNeedPayout?: (path: string) => void, private focusSell = false) {
    this.apps = ShareSheet.appCache.get(`${driveId}|${path}`) ?? []; void this.load(); }

  /** The sale just created: shown at the top of the Sell card, highlighted in the list. */
  private justSold: { id?: string; url: string; price: number; currency: string; listed: boolean } | null = null;

  /** Last spaces per drive+path, so "Our family" is on top the moment the sheet opens again. */
  private static appCache = new Map<string, AppSpaces[]>();

  private async loadApps() {
    const key = `${this.driveId}|${this.path}`;
    try {
      this.apps = await this.ctx.web.appSpaces(this.driveId, this.path);
      ShareSheet.appCache.set(key, this.apps);
    } catch { /* keep what we showed */ }
    this.ctx.rerender();
  }

  private async load() {
    // Only the first load shows "Loading…": a reload after an action keeps the sheet (and its scroll) in place.
    const first = !this.members.length && !this.shares.length && this.loading;
    if (first) this.ctx.rerender();
    try {
      void this.loadApps();   // separately: an app's round-trip must not hold up the sheet
      const [m, s, st] = await Promise.all([
        this.ctx.web.members(this.driveId),
        this.ctx.web.shares(this.driveId),
        this.ctx.web.settings(this.driveId).catch(() => ({ allowed_tokens: null })),
      ]);
      this.members = m.members; this.pending = m.pending; this.myRole = m.myRole; this.shares = s;
      this.tokens = tokenSymbols(st.allowed_tokens);
      this.error = null;
    } catch (e) { this.error = msgOf(e); }
    this.loading = false; this.ctx.rerender();
  }

  private here<T extends { path: string }>(rows: T[]): T[] {
    // Paths compare canonically (NFC, no leading/trailing slash), like the server stores them.
    const norm = (p: string) => p.normalize("NFC").replace(/^\/+|\/+$/g, "");
    const me = norm(this.path);
    return rows.filter((r) => norm(r.path) === me);
  }

  render(): string {
    const owner = this.myRole === "owner";
    const title = this.path ? this.name : `${this.name} (whole drive)`;
    const people = this.here(this.members);
    const invites = this.here(this.pending);
    const links = this.here(this.shares).filter((s) => !s.price_usdc);
    const sales = this.here(this.shares).filter((s) => !!s.price_usdc);
    // Workspaces in connected apps ("Our family") come first — shown from the last load right away,
    // even while the rest of the sheet is loading (owners only; the list is cached per folder).
    const appsCard = this.apps.length && (owner || this.loading) ? `
      <div class="scard" id="sh-apps-card">
        <div class="scard-h">${I.users} Shared in apps</div>
        <div class="scard-s">Workspaces in apps you connected. Turn this folder on or off in each.</div>
        ${this.apps.map(({ app, spaces, error }) => `
          <p class="note group" style="margin:10px 0 4px">${esc(app.name)} · ${esc(app.origin.replace(/^https?:\/\//, ""))}</p>
          ${error ? `<p class="hint" style="color:var(--err)">${esc(error)}</p>` : !spaces.length ? `<p class="hint">No workspaces there yet.</p>` : `
          <ul class="list">
            ${spaces.map((sp) => `
              <li data-app="${esc(app.id)}" data-space="${esc(sp.id)}">
                <div class="avatar">${esc(sp.icon || "👥")}</div>
                <div class="grow"><div class="t">${esc(sp.name)}</div><div class="s">${esc([sp.group, sp.members ? `${sp.members} people` : ""].filter(Boolean).join(" · "))}</div></div>
                <button class="switch" role="switch" aria-checked="${sp.shared}" aria-label="Share into ${esc(sp.name)}" data-app-toggle ${this.busy ? "disabled" : ""}></button>
              </li>`).join("")}
          </ul>`}`).join("")}
      </div>` : "";
    const body = this.loading ? `<div class="searching"><span class="spinner"></span> Loading…</div>`
      : this.error ? `<p class="hint" style="color:var(--err)">${esc(this.error)}</p>`
      : `

      <div class="scard">
        <div class="scard-h">${I.users} People with access</div>
        <div class="scard-s">Invite by email. They sign in with that address.</div>
        ${owner ? `
        <input type="email" id="sh-email" placeholder="Invite by email" autocomplete="off" />
        <div class="row2" style="margin-top:8px">
          <select id="sh-role"><option value="viewer">Viewer</option><option value="editor">Editor</option></select>
          <button class="btn small" id="sh-invite" ${this.busy ? "disabled" : ""}>Invite</button>
        </div>
        <p class="hint"><b>Viewer:</b> ${ROLE_HELP.viewer} · <b>Editor:</b> ${ROLE_HELP.editor}</p>` : `<p class="hint">Only the owner can invite people.</p>`}
        <ul class="list">
          ${people.map((m) => `
            <li data-mid="${esc(m.id)}"><div class="avatar">${esc((m.name || m.email || "?").slice(0, 1).toUpperCase())}</div>
              <div class="grow"><div class="t">${esc(m.name || m.email)}</div><div class="s">${esc(m.email)}</div></div>
              ${owner && !m.isCreator ? `<select data-role>${(["viewer", "editor", "owner"] as Role[]).map((r) => `<option value="${r}" ${m.role === r ? "selected" : ""}>${cap(r)}</option>`).join("")}</select>
              <button class="iconbtn ghost" data-remove aria-label="Remove">${icon("userMinus", 18)}</button>` : `<span class="badge">${cap(m.role)}</span>`}
            </li>`).join("")}
          ${invites.map((v) => `
            <li data-iid="${esc(v.id)}"><div class="avatar">${icon("mail", 16)}</div>
              <div class="grow"><div class="t">${esc(v.email)}</div><div class="s">Invited · ${cap(v.role)}</div></div>
              ${owner ? `<button class="iconbtn ghost" data-cancel aria-label="Cancel invite">${icon("close", 18)}</button>` : ""}
            </li>`).join("")}
          ${!people.length && !invites.length ? `<li><span class="s">No one has been invited to ${this.path ? "this item" : "this drive"} yet.</span></li>` : ""}
        </ul>
      </div>

      <div class="scard">
        <div class="scard-h">${I.link} Link sharing</div>
        <div class="scard-s">Anyone with the link can open it after signing in.</div>
        <div class="inline">
          <button class="btn small secondary" data-newlink="viewer" ${this.busy ? "disabled" : ""}>${icon("link", 16)} Viewer link</button>
          <button class="btn small secondary" data-newlink="editor" ${this.busy ? "disabled" : ""}>${icon("link", 16)} Editor link</button>
        </div>
        <ul class="list">
          ${links.map((s) => `
            <li data-sid="${esc(s.id)}" data-url="${esc(shareUrl(this.ctx.server, s))}">
              <div class="grow"><div class="t">${cap(s.role)} link</div><div class="s">${esc(when(s.created_at))}</div></div>
              <button class="iconbtn ghost" data-copy aria-label="Copy link">${icon("copy", 18)}</button>
              ${owner ? `<button class="iconbtn ghost" data-revoke aria-label="Revoke">${icon("trash", 18)}</button>` : ""}
            </li>`).join("")}
        </ul>
      </div>


      ${owner ? `
      <div class="scard" id="sh-sell-card">
        <div class="scard-h">${I.dollar} Sell</div>
        <div class="scard-s">A paid viewer link. The buyer pays once in the token you choose, then can open it.</div>
        <div class="row2"><input type="number" id="sh-price" min="0.01" max="9999.99" step="0.01" placeholder="Price, e.g. 5" />
          <select id="sh-cur" style="width:auto">${this.tokens.map((t) => `<option>${esc(t)}</option>`).join("")}</select></div>
        <label class="check"><input type="checkbox" id="sh-listed" checked /> List on the drive's storefront</label>
        ${this.justSold ? `<div class="sold-banner">${icon("check", 18)}<div class="grow"><b>On sale for ${esc(this.justSold.price)} ${esc(this.justSold.currency)}</b><br><span class="hint">Sale link copied — send it to buyers${this.justSold.listed ? " · listed on the storefront" : ""}.</span></div></div>` : ""}
        <button class="btn" id="sh-sell" ${this.busy ? "disabled" : ""}>${this.busy ? `<span class="spinner"></span> Creating…` : `${I.dollar} ${sales.length ? "Create another sale link" : "Create sale link"}`}</button>
        ${sales.length ? `<p class="note group" style="margin:14px 0 4px">On sale (${sales.length})</p>` : ""}
        <ul class="list">
          ${sales.map((s) => `
            <li data-sid="${esc(s.id)}" data-url="${esc(shareUrl(this.ctx.server, s))}" class="${this.justSold && (s.id === this.justSold.id || shareUrl(this.ctx.server, s) === this.justSold.url) ? "selected" : ""}">
              <div class="grow"><div class="t">${esc(s.price_usdc)} ${esc(s.currency || "USDC")}</div><div class="s">${s.listed ? "Listed on storefront" : "Unlisted"} · ${esc(when(s.created_at))}</div></div>
              <button class="iconbtn ghost" data-toggle-list aria-label="${s.listed ? "Unlist" : "List"}">${icon(s.listed ? "lock" : "external", 18)}</button>
              <button class="iconbtn ghost" data-copy aria-label="Copy link">${icon("copy", 18)}</button>
              <button class="iconbtn ghost" data-revoke aria-label="Stop selling">${icon("trash", 18)}</button>
            </li>`).join("")}
        </ul>
      </div>` : ""}`;
    return `
      <div class="drawer" id="share-drawer">
        <div class="grab"></div>
        <div class="head"><h3>Share “${esc(title)}”</h3><button class="iconbtn ghost" id="sh-close" aria-label="Close">${I.close}</button></div>
        <p class="sub">${esc(this.path || "/")}</p>
        ${appsCard}
        ${body}
      </div>`;
  }

  bind(root: HTMLElement) {
    on(root, "#sh-close", "click", () => this.ctx.close());
    // Opened from "Sell…": bring the Sell card into view once it has rendered.
    if (this.focusSell && !this.loading) {
      this.focusSell = false;
      setTimeout(() => { root.querySelector("#sh-sell-card")?.scrollIntoView({ block: "start", behavior: "smooth" }); if (!this.justSold) (root.querySelector("#sh-price") as HTMLInputElement | null)?.focus({ preventScroll: true }); }, 50);
    }
    on(root, "#sh-invite", "click", () => this.act(async () => {
      const email = val(root, "sh-email");
      if (!/.+@.+\..+/.test(email)) throw new Error("Enter an email address");
      await this.ctx.web.invite(this.driveId, email, val(root, "sh-role") as Role, this.path);
      this.ctx.notify(`Invited ${email}`); this.ctx.forget("sh-email");
    }));
    on(root, "[data-mid] select[data-role]", "change", (el) => this.act(async () => {
      const mid = el.closest<HTMLElement>("[data-mid]")!.dataset.mid!;
      await this.ctx.web.setRole(this.driveId, mid, (el as HTMLSelectElement).value as Role);
      this.ctx.notify("Role updated");
    }));
    on(root, "[data-mid] [data-remove]", "click", (el) => this.act(async () => {
      const mid = el.closest<HTMLElement>("[data-mid]")!.dataset.mid!;
      if (!(await this.ctx.confirm("Remove access?", "They lose access to this item right away.", "Remove", true))) return;
      await this.ctx.web.removeMember(this.driveId, mid);
    }));
    on(root, "[data-iid] [data-cancel]", "click", (el) => this.act(async () => {
      await this.ctx.web.cancelInvite(this.driveId, el.closest<HTMLElement>("[data-iid]")!.dataset.iid!);
    }));
    on(root, "[data-newlink]", "click", (el) => this.act(async () => {
      const r = await this.ctx.web.createShare(this.driveId, { path: this.path, role: el.dataset.newlink as "viewer" | "editor" });
      await this.ctx.copy(r.url, "Link");
    }));
    on(root, "[data-sid] [data-copy]", "click", (el) => void this.ctx.copy(el.closest<HTMLElement>("[data-sid]")!.dataset.url!, "Link"));
    on(root, "[data-sid] [data-revoke]", "click", (el) => this.act(async () => {
      if (!(await this.ctx.confirm("Revoke this link?", "People who haven't opened it yet can't use it any more.", "Revoke", true))) return;
      await this.ctx.web.revokeShare(this.driveId, el.closest<HTMLElement>("[data-sid]")!.dataset.sid!);
    }));
    on(root, "[data-sid] [data-toggle-list]", "click", (el) => this.act(async () => {
      const sid = el.closest<HTMLElement>("[data-sid]")!.dataset.sid!;
      const s = this.shares.find((x) => x.id === sid);
      await this.ctx.web.editShare(this.driveId, sid, { listed: !s?.listed });
    }));
    on(root, "[data-space] [data-app-toggle]", "click", (el) => this.act(async () => {
      const li = el.closest<HTMLElement>("[data-space]")!;
      const shared = el.getAttribute("aria-checked") !== "true";
      const name = this.apps.flatMap((a) => a.spaces).find((s) => s.id === li.dataset.space)?.name ?? "the workspace";
      await this.ctx.web.setAppShared(this.driveId, li.dataset.app!, li.dataset.space!, this.path, shared);
      this.ctx.notify(shared ? `Shared into ${name}` : `No longer shared into ${name}`);
    }));
    on(root, "#sh-sell", "click", () => this.act(async () => {
      const price = Number(val(root, "sh-price"));
      if (!(price >= 0.01 && price <= 9999.99)) throw new Error("Price must be between 0.01 and 9999.99");
      const listed = (root.querySelector("#sh-listed") as HTMLInputElement).checked;
      let r;
      try { r = await this.ctx.web.createShare(this.driveId, { path: this.path, role: "viewer", price_usdc: price, currency: val(root, "sh-cur"), listed }); }
      catch (e) {
        // No payout wallet yet (web/lib/share-edit.ts "set a payout wallet … before selling").
        // The account's sign-in wallet is the payout wallet: set it on the drive and sell again.
        if (/payout wallet/i.test(msgOf(e))) {
          const me = await this.ctx.web.me().catch(() => null);
          if (me?.wallet) {
            await this.ctx.web.setPayout(this.driveId, "", me.wallet);
            this.ctx.notify(`Sales go to your sign-in wallet ${me.wallet.slice(0, 6)}…${me.wallet.slice(-4)}`);
            r = await this.ctx.web.createShare(this.driveId, { path: this.path, role: "viewer", price_usdc: price, currency: val(root, "sh-cur"), listed });
          }
        }
        // No sign-in wallet either: take the owner to set a payout wallet.
        if (!r && this.onNeedPayout && /payout wallet/i.test(msgOf(e))) {
          this.ctx.notify("Set a payout wallet first — that's where sale proceeds go.");
          this.onNeedPayout(this.path);
          return;
        }
        if (!r) throw e;
      }
      await this.ctx.copy(r.url, "Sale link"); this.ctx.forget("sh-price");
      const made = r as { url: string; id?: string; share?: { id?: string } };
      this.justSold = { id: made.id ?? made.share?.id, url: made.url, price, currency: val(root, "sh-cur") || "USDC", listed };
      this.focusSell = true;   // after the reload, keep the Sell card (and the new sale) in view
    }));
  }

  private async act(fn: () => Promise<void>) {
    this.busy = true; this.ctx.rerender();
    try { await fn(); await this.load(); } catch (e) { this.ctx.notify(msgOf(e), true); }
    this.busy = false; this.ctx.rerender();
  }
}

export function shareUrl(server: string, s: Share): string { return s.url || `${server}/s/${s.token}`; }
function cap(s: string): string { return s.charAt(0).toUpperCase() + s.slice(1); }

/** The drive's accepted tokens → currency symbols for the Sell picker (USDC when unset). */
export function tokenSymbols(allowed: unknown): string[] {
  const out: string[] = [];
  if (typeof allowed === "string") { try { allowed = JSON.parse(allowed); } catch { allowed = null; } }
  const add = (x: unknown) => {
    if (typeof x === "string") out.push(x);
    else if (x && typeof x === "object") { const o = x as Record<string, unknown>; const s = o.symbol ?? o.currency ?? o.name; if (typeof s === "string") out.push(s); }
  };
  if (Array.isArray(allowed)) allowed.forEach(add);
  else if (allowed && typeof allowed === "object") Object.values(allowed as object).forEach((v) => (Array.isArray(v) ? v.forEach(add) : add(v)));
  return out.length ? [...new Set(out)] : ["USDC"];
}
