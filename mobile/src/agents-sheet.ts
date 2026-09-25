// Drive agents, as on the web: chat with an agent that answers over a folder
// (web/components/folder-chat.tsx), create/remove agents
// (create-agent-modal.tsx), and MCP access tokens (mcp-modal.tsx). These are
// server-side agents with a cloud LLM — distinct from the phone's own offline
// agent (the 🤖 sheet), which answers about files on this phone.
import { I, icon, fileGlyph } from "./icons";
import { esc, msgOf, on, val, when, type Ctx, type Sheet } from "./kit";
import type { Agent, McpToken } from "./web";

const PROVIDERS = [
  { id: "flock", label: "Flock", defaultModel: "qwen3-30b-a3b-instruct-2507" },
  { id: "openai", label: "OpenAI", defaultModel: "gpt-4o-mini" },
];

interface Msg { who: "me" | "agent"; text: string; sources?: { path: string }[]; error?: boolean }

export class ChatSheet implements Sheet {
  kind = "page" as const;
  private agents: Agent[] = [];
  private current: string | null = null;
  private msgs = new Map<string, Msg[]>();
  private loading = true;
  private asking = false;
  private creating = false;
  private error: string | null = null;
  private draft = "";

  constructor(private ctx: Ctx, private driveId: string, private driveName: string, private folder: string, private isOwner: boolean, private onOpenPath: (path: string) => void) { void this.load(); }

  private async load() {
    this.loading = true; this.ctx.rerender();
    try {
      this.agents = await this.ctx.web.agents(this.driveId);
      // An agent for this folder first, like the web's folder chat.
      this.agents.sort((a, b) => Number((b.folder ?? "") === this.folder) - Number((a.folder ?? "") === this.folder));
      if (!this.current || !this.agents.some((a) => a.id === this.current)) this.current = this.agents[0]?.id ?? null;
      this.error = null;
    } catch (e) { this.error = msgOf(e); }
    this.loading = false; this.ctx.rerender();
  }

  render(): string {
    const a = this.agents.find((x) => x.id === this.current);
    const thread = (this.current && this.msgs.get(this.current)) || [];
    const body = this.loading ? `<div class="searching"><span class="spinner"></span> Loading…</div>`
      : this.creating ? this.createForm()
      : this.error ? `<div class="empty"><h3>Couldn’t load agents</h3><p>${esc(this.error)}</p></div>`
      : !this.agents.length ? `<div class="empty"><div class="art">${I.agent}</div><h3>No agents in this drive</h3><p>An agent answers questions about a folder, for you and for people you share with.</p>
          ${this.isOwner ? `<button class="btn" id="ch-new" style="max-width:260px">${I.plus} Create agent</button>` : ""}</div>`
      : `
        <div class="inline" style="margin-bottom:12px">
          <select id="ch-agent" style="flex:1">${this.agents.map((x) => `<option value="${esc(x.id)}" ${x.id === this.current ? "selected" : ""}>${esc(x.name)}${x.folder ? ` · /${esc(x.folder)}` : ""}</option>`).join("")}</select>
          ${this.isOwner ? `<button class="iconbtn" id="ch-new" aria-label="New agent">${I.plus}</button><button class="iconbtn" id="ch-del" aria-label="Delete agent">${icon("trash", 18)}</button>` : ""}
        </div>
        ${a?.description ? `<p class="hint" style="margin:0 0 10px">${esc(a.description)}</p>` : ""}
        ${thread.map((m) => m.who === "me"
          ? `<div class="turn"><div class="bubble">${esc(m.text)}</div></div>`
          : `<div class="turn"><p class="answer" ${m.error ? `style="color:var(--err)"` : ""}>${esc(m.text)}</p>
              ${m.sources?.length ? `<ul class="hits">${m.sources.map((s) => `<li data-open="${esc(s.path)}"><span class="kind ${fileGlyph(s.path, false).cls}">${fileGlyph(s.path, false).svg}</span><div style="min-width:0"><div class="name">${esc(s.path.split("/").pop())}</div><div class="meta">${esc(s.path)}</div></div></li>`).join("")}</ul>` : ""}</div>`).join("")}
        ${this.asking ? `<div class="searching"><span class="spinner"></span> Thinking…</div>` : ""}
        ${!thread.length && !this.asking ? `<p class="hint">Ask ${esc(a?.name ?? "the agent")} about the files in ${esc(a?.folder ? "/" + a.folder : this.driveName)}.</p>` : ""}`;
    return `
      <div class="sheet">
        <div class="bar">
          <button class="iconbtn ghost" id="ch-close" aria-label="Back">${I.back}</button>
          <div class="crumbs"><div class="sub">Chat · ${esc(this.driveName)}</div><div class="title">${esc(this.creating ? "New agent" : a?.name ?? "Agents")}</div></div>
        </div>
        <div class="body" id="ch-body">${body}</div>
        ${!this.creating && this.agents.length ? `<div class="bar" style="border-top:1px solid var(--line);border-bottom:0">
          <div class="field">${I.chat}<input id="ch-input" type="text" enterkeyhint="send" placeholder="Ask about these files" value="${esc(this.draft)}" autocomplete="off" /></div>
          <button class="iconbtn primary" id="ch-send" aria-label="Send" ${this.asking ? "disabled" : ""}>${icon("up", 20)}</button></div>` : ""}
      </div>`;
  }

  private createForm(): string {
    return `
      <div class="scard"><div class="scard-h">${I.agent} Agent</div>
        <label for="ca-name">Name</label><input type="text" id="ca-name" placeholder="e.g. Contracts helper" />
        <label for="ca-folder">Folder it answers over</label><input type="text" id="ca-folder" value="${esc(this.folder)}" placeholder="blank = whole drive" />
        <label for="ca-desc">Description</label><input type="text" id="ca-desc" placeholder="What it's for" />
        <label for="ca-persona">Persona</label><textarea id="ca-persona" placeholder="How it should answer (optional)"></textarea></div>
      <div class="scard"><div class="scard-h">${I.sparkle} Model</div>
        <label for="ca-provider">Provider</label><select id="ca-provider">${PROVIDERS.map((p) => `<option value="${p.id}">${p.label}</option>`).join("")}</select>
        <label for="ca-model">Model</label><input type="text" id="ca-model" class="mono" value="${PROVIDERS[0].defaultModel}" />
        <label for="ca-key">API key (optional)</label><input type="text" id="ca-key" placeholder="Uses the server's key when blank" autocomplete="off" /></div>
      <div class="inline"><button class="btn secondary" id="ca-cancel" style="flex:1">Cancel</button><button class="btn" id="ca-save" style="flex:1">Create agent</button></div>`;
  }

  bind(root: HTMLElement) {
    on(root, "#ch-close", "click", () => this.ctx.close());
    on(root, "#ch-new", "click", () => { this.creating = true; this.ctx.rerender(); });
    on(root, "#ca-cancel", "click", () => { this.creating = false; this.ctx.rerender(); });
    on(root, "#ca-provider", "change", (el) => { const p = PROVIDERS.find((x) => x.id === (el as HTMLSelectElement).value); (root.querySelector("#ca-model") as HTMLInputElement).value = p?.defaultModel ?? ""; });
    on(root, "#ca-save", "click", () => void (async () => {
      const name = val(root, "ca-name");
      if (!name) { this.ctx.notify("Give the agent a name", true); return; }
      try {
        const r = await this.ctx.web.createAgent(this.driveId, {
          name, folder: val(root, "ca-folder").replace(/^\/+|\/+$/g, ""), description: val(root, "ca-desc"), persona: val(root, "ca-persona"),
          llm: { provider: val(root, "ca-provider"), model: val(root, "ca-model"), ...(val(root, "ca-key") ? { apiKey: val(root, "ca-key") } : {}) },
        });
        this.creating = false; this.current = r.agent.id;
        this.ctx.notify(`Created ${name}`); this.ctx.forget("ca-name", "ca-desc", "ca-persona", "ca-key");
        await this.load();
      } catch (e) { this.ctx.notify(msgOf(e), true); }
    })());
    on(root, "#ch-agent", "change", (el) => { this.current = (el as HTMLSelectElement).value; this.ctx.rerender(); });
    on(root, "#ch-del", "click", () => void (async () => {
      const a = this.agents.find((x) => x.id === this.current);
      if (!a || !(await this.ctx.confirm(`Delete ${a.name}?`, "Its ask URL stops working for everyone.", "Delete", true))) return;
      try { await this.ctx.web.deleteAgent(this.driveId, a.id); this.current = null; await this.load(); } catch (e) { this.ctx.notify(msgOf(e), true); }
    })());
    const input = root.querySelector("#ch-input") as HTMLInputElement | null;
    input?.addEventListener("input", () => { this.draft = input.value; });
    // Android keyboards report Enter as key "Enter" or only keyCode 13 (the IME's send action).
    input?.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.keyCode === 13) { e.preventDefault(); void this.send(root); } });
    on(root, "#ch-send", "click", () => void this.send(root));
    on(root, "[data-open]", "click", (el) => this.onOpenPath(el.dataset.open!));
    const body = root.querySelector("#ch-body") as HTMLElement | null;
    if (body) body.scrollTop = body.scrollHeight;
  }

  private async send(root?: HTMLElement) {
    // The field is the truth: re-renders can leave this.draft behind what is on screen.
    const q = ((root?.querySelector("#ch-input") as HTMLInputElement | null)?.value ?? this.draft).trim();
    if (!q || !this.current || this.asking) return;
    const id = this.current;
    const thread = this.msgs.get(id) ?? [];
    thread.push({ who: "me", text: q });
    this.msgs.set(id, thread);
    const field = root?.querySelector("#ch-input") as HTMLInputElement | null;
    if (field) field.value = "";   // render() keeps a focused field's value; clear it first
    this.draft = ""; this.ctx.forget("ch-input"); this.asking = true; this.ctx.rerender();
    try {
      const r = await this.ctx.web.askAgent(this.driveId, id, q);
      thread.push({ who: "agent", text: r.answer, sources: r.sources });
    } catch (e) { thread.push({ who: "agent", text: msgOf(e), error: true }); }
    this.asking = false; this.ctx.rerender();
  }
}

export class McpSheet implements Sheet {
  kind = "drawer" as const;
  private url = "";
  private tokens: McpToken[] = [];
  private canWrite = false;
  private fresh: string | null = null;
  private loading = true;
  private error: string | null = null;

  constructor(private ctx: Ctx, private driveId: string, private driveName: string) { void this.load(); }

  private async load() {
    this.loading = true; this.ctx.rerender();
    try { const r = await this.ctx.web.mcp(this.driveId); this.url = r.mcpUrl; this.tokens = r.tokens; this.canWrite = r.canWrite; this.error = null; }
    catch (e) { this.error = msgOf(e); }
    this.loading = false; this.ctx.rerender();
  }

  render(): string {
    const body = this.loading ? `<div class="searching"><span class="spinner"></span> Loading…</div>`
      : this.error ? `<p class="hint" style="color:var(--err)">${esc(this.error)}</p>` : `
      <div class="scard"><div class="scard-h">${I.plug} Server URL</div>
        <div class="scard-s">Add this to Claude, Cursor or any MCP client, with a token below.</div>
        <div class="row2"><input type="text" class="mono" readonly value="${esc(this.url)}" /><button class="iconbtn" id="mcp-copyurl" aria-label="Copy URL">${icon("copy", 18)}</button></div></div>
      ${this.fresh ? `<div class="scard" style="border-color:var(--accent)"><div class="scard-h">${I.check} New token — copy it now</div>
        <div class="scard-s">It is shown only once.</div>
        <div class="row2"><input type="text" class="mono" readonly value="${esc(this.fresh)}" /><button class="iconbtn primary" id="mcp-copytok" aria-label="Copy token">${icon("copy", 18)}</button></div></div>` : ""}
      <div class="scard"><div class="scard-h">${I.lock} Access tokens</div>
        <label for="mcp-name">Name</label><input type="text" id="mcp-name" placeholder="e.g. Claude on laptop" />
        <div class="inline" style="margin-top:8px">
          <select id="mcp-scope" style="flex:1"><option value="read">Read only</option>${this.canWrite ? `<option value="write">Read & write</option>` : ""}</select>
          <select id="mcp-ttl" style="flex:1"><option value="90">90 days</option><option value="30">30 days</option><option value="">No expiry</option></select>
        </div>
        <button class="btn" id="mcp-create">${I.plus} Create token</button>
        <ul class="list">${this.tokens.map((t) => `<li data-tid="${esc(t.id)}"><div class="grow"><div class="t">${esc(t.name)} <span class="badge">${esc(t.scope)}</span></div><div class="s">${t.expires_at ? `expires ${esc(when(t.expires_at))}` : "no expiry"}${t.last_used_at ? ` · used ${esc(when(t.last_used_at))}` : ""}</div></div>
          <button class="iconbtn ghost" data-revoke aria-label="Revoke">${icon("trash", 18)}</button></li>`).join("")}</ul></div>`;
    return `<div class="drawer"><div class="grab"></div>
      <div class="head"><h3>MCP · ${esc(this.driveName)}</h3><button class="iconbtn ghost" id="mcp-close" aria-label="Close">${I.close}</button></div>${body}</div>`;
  }

  bind(root: HTMLElement) {
    on(root, "#mcp-close", "click", () => this.ctx.close());
    on(root, "#mcp-copyurl", "click", () => void this.ctx.copy(this.url, "MCP URL"));
    on(root, "#mcp-copytok", "click", () => void this.ctx.copy(this.fresh ?? "", "Token"));
    on(root, "#mcp-create", "click", () => void (async () => {
      const name = val(root, "mcp-name");
      if (!name) { this.ctx.notify("Name the token", true); return; }
      const ttl = val(root, "mcp-ttl");
      try {
        const r = await this.ctx.web.createMcpToken(this.driveId, name, val(root, "mcp-scope") as "read" | "write", ttl ? (Number(ttl) as 30 | 90) : null);
        this.fresh = r.token; this.ctx.forget("mcp-name");
        await this.load();
      } catch (e) { this.ctx.notify(msgOf(e), true); }
    })());
    on(root, "[data-tid] [data-revoke]", "click", (el) => void (async () => {
      if (!(await this.ctx.confirm("Revoke this token?", "Clients using it lose access immediately.", "Revoke", true))) return;
      try { await this.ctx.web.revokeMcpToken(this.driveId, el.closest<HTMLElement>("[data-tid]")!.dataset.tid!); await this.load(); }
      catch (e) { this.ctx.notify(msgOf(e), true); }
    })());
  }
}
