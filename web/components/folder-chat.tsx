"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { Bot, Send, Loader2, MessageSquare, X, Pencil, Trash2, ChevronDown, ChevronRight } from "lucide-react";
import { toast } from "sonner";
import { pathCovers } from "@/shared/domain/policy/path";
import { CreateAgentModal, type EditableAgent } from "./create-agent-modal";

/**
 * Folder Chat sidebar — picks one agent from the drive (defaults to
 * the first one matching the current folder) and lets the user ask
 * questions. Calls POST /api/drives/[driveId]/agents/[id]/ask.
 *
 * Auth is implicit: cookies (session for owner, aindrive_cap for cap
 * holder) ride along with fetch. The route's identity resolver picks
 * the right one — same agent serves both audiences.
 */

type AgentSummary = {
  id: string;
  name: string;
  description: string;
  persona: string;
  folder: string;
  llm: { provider: string; model: string };
  access: { policies: string[] };
};

type Source = {
  path: string;
  snippet: string;
  lineStart?: number;
  lineEnd?: number;
};

const MAX_MSGS = 100;

type Msg =
  | { role: "user"; text: string }
  | { role: "agent"; text: string; sources: Source[]; policyName?: string }
  | { role: "error"; text: string };

type Props = {
  driveId: string;
  /** Currently-open folder path; agents whose folder is an ancestor are preferred. */
  currentFolder: string;
  onClose?: () => void;
  /** Hint: caller knows whether the user is the owner (drives the empty-state copy). */
  isOwner?: boolean;
};

export function FolderChat({ driveId, currentFolder, onClose, isOwner }: Props) {
  const [agents, setAgents] = useState<AgentSummary[] | null>(null);
  const [agentId, setAgentId] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<EditableAgent | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Load agent list. For owners we fetch the private list endpoint;
  // cap-holders can't list (it's owner-only) — they need the agent id
  // shared with them by another channel. v1 demo: caller is always
  // either owner OR comes in via a cap link that already knows the id.
  // For simplicity we try the list and fall back to "ask owner for an
  // agent id" if it's 401/403.
  useEffect(() => {
    let cancel = false;
    (async () => {
      try {
        const r = await fetch(`/api/drives/${driveId}/agents`);
        if (!r.ok) {
          if (!cancel) setAgents([]);
          return;
        }
        const data = await r.json();
        if (cancel) return;
        const list: AgentSummary[] = data.agents ?? [];
        setAgents(list);
        // Prefer one whose folder is an ancestor of (or equal to) currentFolder.
        const preferred = pickAgentForFolder(list, currentFolder) ?? list[0] ?? null;
        if (preferred) setAgentId(preferred.id);
      } catch {
        if (!cancel) setAgents([]);
      }
    })();
    return () => { cancel = true; };
  }, [driveId, currentFolder, reloadTick]);

  async function onDelete(target: AgentSummary) {
    if (!confirm(`Delete agent "${target.name}"? This removes the agent JSON from the drive.`)) return;
    try {
      const r = await fetch(`/api/drives/${driveId}/agents/${target.id}`, { method: "DELETE" });
      if (!r.ok && r.status !== 204) {
        const data = await r.json().catch(() => ({}));
        toast.error(`Delete failed: ${data.error || r.status}`);
        return;
      }
      toast.success("Agent deleted");
      if (agentId === target.id) setAgentId(null);
      setReloadTick((t) => t + 1);
    } catch (e) {
      toast.error(`Delete failed: ${(e as Error).message}`);
    }
  }

  function onEdit(target: AgentSummary) {
    setEditing({
      id: target.id,
      folder: target.folder,
      name: target.name,
      description: target.description,
      persona: target.persona,
      llm: target.llm,
      access: target.access,
    });
  }

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [msgs.length]);

  const selectedAgent = useMemo(
    () => agents?.find((a) => a.id === agentId) ?? null,
    [agents, agentId],
  );

  async function ask() {
    const q = input.trim();
    if (!q || !agentId || busy) return;
    const append = (msg: Msg) => setMsgs((m) => [...m, msg].slice(-MAX_MSGS));
    append({ role: "user", text: q });
    setInput("");
    setBusy(true);
    try {
      const r = await fetch(`/api/drives/${driveId}/agents/${agentId}/ask`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ q }),
      });
      const data = await r.json();
      if (!r.ok) {
        const err =
          data.error === "rate_limited"
            ? `Rate limited (retry in ${Math.ceil((data.retryAfterMs ?? 0) / 1000)}s)`
            : data.error || `HTTP ${r.status}`;
        append({ role: "error", text: err });
        return;
      }
      append({ role: "agent", text: data.answer, sources: data.sources ?? [], policyName: data.policyName });
    } catch (e) {
      append({ role: "error", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <aside className="hidden lg:flex flex-col w-80 border-l border-drive-border bg-white">
      <div className="flex items-center justify-between px-3 py-2 border-b">
        <div className="flex items-center gap-2 text-sm font-medium">
          <MessageSquare className="w-4 h-4 text-blue-600" />
          <span>Folder Chat</span>
        </div>
        {onClose && (
          <button onClick={onClose} className="p-1 hover:bg-gray-100 rounded">
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      <div className="px-3 py-2 border-b text-xs">
        {agents === null ? (
          <span className="text-gray-500">Loading agents…</span>
        ) : agents.length === 0 ? (
          <EmptyState isOwner={isOwner} />
        ) : (
          <label className="block">
            <span className="text-gray-600">Agent</span>
            <select
              className="mt-1 w-full border rounded px-2 py-1 text-xs"
              value={agentId ?? ""}
              onChange={(e) => setAgentId(e.target.value)}
            >
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} — {a.folder || "/"}
                </option>
              ))}
            </select>
            {selectedAgent && (
              <div className="mt-1 flex items-center justify-between gap-2">
                <p className="text-[11px] text-gray-500 font-mono truncate">
                  {selectedAgent.llm.provider} · {selectedAgent.llm.model}
                </p>
                {isOwner && (
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      onClick={() => onEdit(selectedAgent)}
                      title="Edit agent"
                      className="p-1 hover:bg-gray-100 rounded text-gray-600"
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => onDelete(selectedAgent)}
                      title="Delete agent"
                      className="p-1 hover:bg-red-50 rounded text-red-600"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                )}
              </div>
            )}
          </label>
        )}
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto p-3 space-y-3 text-sm">
        {msgs.length === 0 ? (
          <p className="text-gray-400 text-xs text-center mt-6">
            {selectedAgent
              ? `Ask ${selectedAgent.name} anything about this drive.`
              : "Pick an agent to start chatting."}
          </p>
        ) : (
          msgs.map((m, i) => <MessageBubble key={i} msg={m} />)
        )}
      </div>

      <form
        onSubmit={(e) => { e.preventDefault(); ask(); }}
        className="border-t p-2 flex items-end gap-2"
      >
        <textarea
          className="flex-1 border rounded px-2 py-1.5 text-sm resize-none"
          rows={2}
          placeholder={
            agentId && selectedAgent
              ? `Message ${selectedAgent.name}…`
              : "No agent selected"
          }
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              ask();
            }
          }}
          disabled={!agentId || busy}
        />
        <button
          type="submit"
          disabled={!agentId || !input.trim() || busy}
          className="px-2 py-1.5 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
        </button>
      </form>
      {editing && (
        <CreateAgentModal
          driveId={driveId}
          defaultFolder={editing.folder}
          existing={editing}
          onClose={() => { setEditing(null); setReloadTick((t) => t + 1); }}
        />
      )}
    </aside>
  );
}

function MessageBubble({ msg }: { msg: Msg }) {
  if (msg.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="bg-blue-600 text-white rounded-lg px-3 py-1.5 max-w-[85%] whitespace-pre-wrap">
          {msg.text}
        </div>
      </div>
    );
  }
  if (msg.role === "error") {
    return (
      <div className="bg-red-50 text-red-700 rounded-lg px-3 py-1.5 text-xs border border-red-200">
        {msg.text}
      </div>
    );
  }
  return (
    <div className="space-y-1">
      <div className="flex items-start gap-1.5">
        <Bot className="w-4 h-4 text-blue-600 shrink-0 mt-0.5" />
        <div className="bg-gray-100 rounded-lg px-3 py-1.5 max-w-[85%] whitespace-pre-wrap">
          {msg.text}
        </div>
      </div>
      {msg.sources.length > 0 && <SourcesFooter sources={msg.sources} />}
    </div>
  );
}

function SourcesFooter({ sources }: { sources: Source[] }) {
  const [open, setOpen] = useState(false);
  // Dedupe by path so multiple chunks from one file collapse into a single chip.
  const paths = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const s of sources) {
      if (seen.has(s.path)) continue;
      seen.add(s.path);
      out.push(s.path);
    }
    return out;
  }, [sources]);
  if (paths.length === 0) return null;
  return (
    <div className="ml-5 mt-1 text-[11px] text-gray-500">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-0.5 hover:text-gray-700"
      >
        {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        Referenced {paths.length} {paths.length === 1 ? "source" : "sources"}
      </button>
      {open && (
        <div className="mt-1 flex flex-wrap gap-1">
          {paths.map((p) => (
            <span
              key={p}
              className="inline-flex items-center px-1.5 py-0.5 rounded bg-gray-100 text-gray-700 font-mono text-[10px]"
              title={p}
            >
              {p}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function EmptyState({ isOwner }: { isOwner?: boolean }) {
  return (
    <div className="text-gray-500 text-center py-2">
      {isOwner ? (
        <>No agents yet. Right-click a folder → <strong>Create Agent</strong>.</>
      ) : (
        <>No agents available on this drive yet.</>
      )}
    </div>
  );
}

function pickAgentForFolder(agents: AgentSummary[], folder: string): AgentSummary | null {
  const candidates = agents.filter((a) => pathCovers(a.folder, folder));
  candidates.sort((a, b) => b.folder.length - a.folder.length);
  return candidates[0] ?? null;
}
