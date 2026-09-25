"use client";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Plug, Copy, KeyRound, Trash2, CheckCircle2 } from "lucide-react";
import { apiFetch } from "@/lib/api-client";
import { Badge, Button, IconButton, Input, Modal, Select } from "@/components/ui";

/**
 * MCP modal — the drive's remote MCP connection panel (sidebar → MCP).
 * Shows the drive-scoped MCP URL, how to connect via OAuth (URL only) or a
 * personal access token (issued here, shown once), and the caller's active
 * tokens / connected apps with revoke. Backed by
 * /api/drives/[driveId]/mcp-tokens; server side documented in app/mcp/README.md.
 */

type TokenRow = {
  id: string;
  name: string;
  scope: "read" | "write";
  kind: "pat" | "oauth";
  expires_at: number | null;
  refresh_expires_at: number | null;
  last_used_at: number | null;
  created_at: number;
  user_email: string | null;
  mine: boolean;
};

type Info = { mcpUrl: string; canWrite: boolean; isOwner: boolean; tokens: TokenRow[] };

function copy(s: string) {
  navigator.clipboard.writeText(s);
  toast.success("Copied");
}

function fmtDate(ms: number | null): string {
  return ms ? new Date(ms).toLocaleDateString() : "never";
}

function CopyRow({ value, mono = true }: { value: string; mono?: boolean }) {
  return (
    <div className="flex items-start gap-2">
      <code className={`flex-1 min-w-0 rounded-md bg-drive-sidebar px-2.5 py-1.5 text-caption text-drive-text break-all whitespace-pre-wrap ${mono ? "font-mono" : ""}`}>
        {value}
      </code>
      <IconButton size="sm" variant="text" aria-label="Copy" onClick={() => copy(value)}>
        <Copy className="w-4 h-4" />
      </IconButton>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-caption font-semibold text-drive-text uppercase tracking-wide">{title}</h3>
      {children}
    </section>
  );
}

export function McpModal({ driveId, onClose }: { driveId: string; onClose: () => void }) {
  const [info, setInfo] = useState<Info | null>(null);
  const [name, setName] = useState("");
  const [scope, setScope] = useState<"read" | "write">("read");
  const [ttl, setTtl] = useState<"30" | "90" | "never">("90");
  const [issuing, setIssuing] = useState(false);
  const [issued, setIssued] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await apiFetch<Info>(`/api/drives/${driveId}/mcp-tokens`);
    if (r.ok) setInfo(r.data);
    else toast.error(r.error);
  }, [driveId]);

  useEffect(() => { load(); }, [load]);

  async function issue(e: React.FormEvent) {
    e.preventDefault();
    setIssuing(true);
    const r = await apiFetch<{ token: string }>(`/api/drives/${driveId}/mcp-tokens`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: name.trim() || "MCP token", scope, ttlDays: ttl === "never" ? null : Number(ttl) }),
    });
    setIssuing(false);
    if (!r.ok) { toast.error(r.error); return; }
    setIssued(r.data.token);
    setName("");
    load();
  }

  async function revoke(t: TokenRow) {
    if (!confirm(`${t.kind === "oauth" ? "Disconnect" : "Revoke"} "${t.name}"? Apps using it stop working immediately.`)) return;
    const r = await apiFetch(`/api/drives/${driveId}/mcp-tokens/${t.id}`, { method: "DELETE" });
    if (!r.ok) { toast.error(r.error); return; }
    toast.success(t.kind === "oauth" ? "Disconnected" : "Revoked");
    load();
  }

  const url = info?.mcpUrl ?? "";
  const shownToken = issued ?? "<YOUR_TOKEN>";

  return (
    <Modal
      open
      onClose={onClose}
      size="md"
      title={<span className="flex items-center gap-2"><Plug className="w-5 h-5 text-drive-accent" /> MCP</span>}
    >
      {!info ? (
        <p className="text-body text-drive-muted">Loading…</p>
      ) : (
        <div className="space-y-6">
          <Section title="Server URL">
            <CopyRow value={url} />
            <p className="text-caption text-drive-muted">
              Remote MCP (Streamable HTTP) for this drive only. Tools: list_files, read_file, stat, search
              {info.canWrite ? ", write_file, delete_path (write tokens)" : ""}. An app never gets more than your own access here.
              Hosts with MCP Apps (Claude, ChatGPT, VS Code…) show results as an interactive file browser.
            </p>
            <p className="text-caption">
              <a href="/docs" target="_blank" rel="noreferrer" className="text-drive-accent underline">
                Integration guide: MCP, A2A, AG-UI and A2UI →
              </a>
            </p>
          </Section>

          <Section title="Option A · OAuth (URL only)">
            <p className="text-body text-drive-text">
              In <strong>claude.ai</strong> (Settings → Connectors → Add custom connector), <strong>ChatGPT</strong> connectors,
              or any OAuth-capable MCP client, paste the server URL above. You&apos;ll be asked to sign in to aindrive and approve
              access. No token to copy.
            </p>
          </Section>

          <Section title="Option B · Access token">
            {issued ? (
              <div className="space-y-2 rounded-lg border border-emerald-200 bg-emerald-50/60 p-3">
                <div className="flex items-center gap-2 text-body font-medium text-emerald-700">
                  <CheckCircle2 className="w-4 h-4" /> Token created. Copy it now; it won&apos;t be shown again.
                </div>
                <CopyRow value={issued} />
                <Button size="sm" variant="text" onClick={() => setIssued(null)}>Create another</Button>
              </div>
            ) : (
              <form onSubmit={issue} className="grid grid-cols-1 sm:grid-cols-[1fr_auto_auto_auto] gap-2 items-end">
                <Input label="Name" placeholder="e.g. Cursor on laptop" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
                <Select label="Permission" value={scope} onChange={(e) => setScope(e.target.value as "read" | "write")}>
                  <option value="read">Read only</option>
                  {info.canWrite && <option value="write">Read &amp; write</option>}
                </Select>
                <Select label="Expires" value={ttl} onChange={(e) => setTtl(e.target.value as "30" | "90" | "never")}>
                  <option value="30">30 days</option>
                  <option value="90">90 days</option>
                  <option value="never">Never</option>
                </Select>
                <Button type="submit" loading={issuing} icon={<KeyRound className="w-4 h-4" />}>Generate</Button>
              </form>
            )}
            <div className="space-y-1.5 pt-1">
              <span className="text-caption font-medium text-drive-text">Claude Code</span>
              <CopyRow value={`claude mcp add --transport http aindrive ${url} --header "Authorization: Bearer ${shownToken}"`} />
              <span className="text-caption font-medium text-drive-text">Cursor / other clients (mcp.json)</span>
              <CopyRow
                value={JSON.stringify({ mcpServers: { aindrive: { url, headers: { Authorization: `Bearer ${shownToken}` } } } }, null, 2)}
              />
            </div>
          </Section>

          <Section title={info.isOwner ? "Active tokens & connected apps (all members)" : "Your tokens & connected apps"}>
            {info.tokens.length === 0 ? (
              <p className="text-caption text-drive-muted">None yet.</p>
            ) : (
              <ul className="divide-y divide-drive-border rounded-lg border border-drive-border">
                {info.tokens.map((t) => (
                  <li key={t.id} className="flex items-center gap-3 px-3 py-2">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="truncate text-body text-drive-text">{t.name}</span>
                        <Badge tone="neutral">{t.kind === "oauth" ? "OAuth app" : "Token"}</Badge>
                        <Badge tone={t.scope === "write" ? "warning" : "neutral"}>{t.scope === "write" ? "read & write" : "read"}</Badge>
                      </div>
                      <div className="text-caption text-drive-muted truncate">
                        {!t.mine && t.user_email ? `${t.user_email} · ` : ""}
                        last used {fmtDate(t.last_used_at)}
                        {t.kind === "pat" ? ` · expires ${fmtDate(t.expires_at)}` : ""}
                      </div>
                    </div>
                    <IconButton size="sm" variant="text" aria-label={t.kind === "oauth" ? "Disconnect" : "Revoke"} onClick={() => revoke(t)}>
                      <Trash2 className="w-4 h-4" />
                    </IconButton>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>
      )}
    </Modal>
  );
}
