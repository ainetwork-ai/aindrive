// Account, as on the web home footer + /account: who is signed in, add an
// email to a wallet-only account (email → code → password), add wallet
// sign-in (SIWE needs a wallet app, so it opens the web page), sign out.
import { I, icon } from "./icons";
import { esc, msgOf, on, val, type Ctx, type Sheet } from "./kit";
import type { Me } from "./web";

export class AccountSheet implements Sheet {
  kind = "drawer" as const;
  private me: Me | null = null;
  private step: "idle" | "code" = "idle";
  private email = "";
  private busy = false;

  constructor(private ctx: Ctx, private onSignOut: () => void) { void this.load(); }

  private async load() {
    try { this.me = await this.ctx.web.me(); } catch (e) { this.ctx.notify(msgOf(e), true); }
    this.ctx.rerender();
  }

  render(): string {
    const me = this.me;
    const who = me?.email || me?.name || (me?.wallet ? `${me.wallet.slice(0, 6)}…${me.wallet.slice(-4)}` : "…");
    return `<div class="drawer"><div class="grab"></div>
      <div class="head"><h3>Account</h3><button class="iconbtn ghost" id="ac-close" aria-label="Close">${I.close}</button></div>
      <div class="account" style="margin:6px 0 4px"><div class="avatar">${esc(String(who).slice(0, 1).toUpperCase())}</div>
        <div style="min-width:0"><div style="font-weight:600">${esc(me?.name || who)}</div><div class="hint" style="margin:0">${esc(me?.email ?? "No email — signed in with a wallet")}</div></div></div>
      ${me && !me.email ? `<div class="scard"><div class="scard-h">${I.mail} Add an email</div>
        <div class="scard-s">Sign in with email and password too, and get invites sent to you.</div>
        ${this.step === "idle" ? `<div class="row2"><input type="email" id="ac-email" placeholder="you@example.com" /><button class="btn small" id="ac-send" ${this.busy ? "disabled" : ""}>Send code</button></div>`
          : `<p class="hint">Code sent to ${esc(this.email)}.</p><input type="text" id="ac-code" placeholder="6-digit code" inputmode="numeric" />
             <input type="text" id="ac-pass" placeholder="New password (8+ characters)" style="margin-top:8px" autocomplete="new-password" />
             <button class="btn" id="ac-verify" ${this.busy ? "disabled" : ""}>Add email</button>`}</div>` : ""}
      <div class="scard"><div class="scard-h">${I.wallet} Wallet sign-in</div>
        <div class="scard-s">${me?.wallet ? `Linked: <span class="mono">${esc(me.wallet)}</span>` : "Link a wallet so you can sign in with it. Opens aindrive in your browser, where your wallet app can sign."}</div>
        ${me?.wallet ? "" : `<button class="btn secondary" id="ac-wallet">${icon("external", 18)} Add wallet sign-in</button>`}</div>
      <button class="btn danger" id="ac-signout">${I.logout} Sign out</button></div>`;
  }

  bind(root: HTMLElement) {
    on(root, "#ac-close", "click", () => this.ctx.close());
    on(root, "#ac-wallet", "click", () => void this.ctx.openUrl(`${this.ctx.server}/account/wallet`));
    on(root, "#ac-signout", "click", () => this.onSignOut());
    on(root, "#ac-send", "click", () => void (async () => {
      const email = val(root, "ac-email");
      if (!/.+@.+\..+/.test(email)) { this.ctx.notify("Enter an email address", true); return; }
      this.busy = true; this.ctx.rerender();
      try { await this.ctx.web.startAddEmail(email); this.email = email; this.step = "code"; } catch (e) { this.ctx.notify(msgOf(e), true); }
      this.busy = false; this.ctx.rerender();
    })());
    on(root, "#ac-verify", "click", () => void (async () => {
      const code = val(root, "ac-code"), password = val(root, "ac-pass");
      if (password.length < 8) { this.ctx.notify("Password needs 8+ characters", true); return; }
      this.busy = true; this.ctx.rerender();
      try { await this.ctx.web.verifyAddEmail(this.email, code, password); this.step = "idle"; this.ctx.notify("Email added"); await this.load(); }
      catch (e) { this.ctx.notify(msgOf(e), true); }
      this.busy = false; this.ctx.rerender();
    })());
  }
}
