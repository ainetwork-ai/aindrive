"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { apiFetch } from "@/lib/api-client";
import { pathCovers } from "@/shared/domain/policy/path";
import { CreateAgentModal, type EditableAgent } from "./create-agent-modal";
import {
  ChatHeader, AgentPicker, MessageList, ChatInput, CLOUD_ID, CLOUD_AGENT_SUMMARY, isOnDevice,
  type AgentSummary, type Source, type Msg, type DeviceInfo,
} from "./folder-chat-parts";

/**
 * Folder Chat sidebar — picks one agent from the drive (defaults to
 * the first one matching the current folder) and lets the user ask
 * questions. Calls POST /api/drives/[driveId]/agents/[id]/ask.
 *
 * Auth is implicit: cookies (session for owner, aindrive_cap for cap
 * holder) ride along with fetch. The route's identity resolver picks
 * the right one — same agent serves both audiences.
 */

const MAX_MSGS = 100;

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
  // the drive's device: every drive agent runs there
  const [device, setDevice] = useState<DeviceInfo | null>(null);
  // aindrive-cloud keeps its conversation per chat
  const [cloudContext, setCloudContext] = useState<string | undefined>(undefined);

  useEffect(() => {
    let cancel = false;
    const load = () => void apiFetch<{ drives: { id: string; hostname: string | null; online: boolean }[] }>("/api/drives").then((r) => {
      if (cancel || !r.ok) return;
      const d = r.data.drives.find((x) => x.id === driveId);
      setDevice(d ? { hostname: d.hostname, online: d.online } : null);
    });
    load();
    const t = setInterval(load, 30_000);
    return () => { cancel = true; clearInterval(t); };
  }, [driveId]);
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
      const r = await apiFetch<{ agents?: AgentSummary[] }>(`/api/drives/${driveId}/agents`);
      if (cancel) return;
      if (!r.ok) {
        setAgents([]);
        return;
      }
      // aindrive-cloud is the owner's to use: it hands the folder's files out as links
      const list: AgentSummary[] = [...(r.data.agents ?? []), ...(isOwner ? [CLOUD_AGENT_SUMMARY] : [])];
      setAgents(list);
      // Prefer one whose folder is an ancestor of (or equal to) currentFolder.
      const preferred = pickAgentForFolder(list, currentFolder) ?? list[0] ?? null;
      if (preferred) setAgentId(preferred.id);
    })();
    return () => { cancel = true; };
  }, [driveId, currentFolder, reloadTick, isOwner]);

  async function onDelete(target: AgentSummary) {
    if (!confirm(`Delete agent "${target.name}"? This removes the agent JSON from the drive.`)) return;
    const r = await apiFetch(`/api/drives/${driveId}/agents/${target.id}`, { method: "DELETE" });
    if (!r.ok) {
      toast.error(`Delete failed: ${r.error}`);
      return;
    }
    toast.success("Agent deleted");
    if (agentId === target.id) setAgentId(null);
    setReloadTick((t) => t + 1);
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
    if (agentId === CLOUD_ID) {
      const key = `aindrive:cloud-ok:${driveId}`;
      let ok = false;
      try { ok = localStorage.getItem(key) === "1"; } catch { /* private mode: ask every time */ }
      if (!ok) {
        ok = confirm(
          "Ask aindrive-cloud (ainize.ai)?\n\nYour question, this folder's file list, and 15-minute links to its files go to ainize.ai. " +
          "It opens a file only when the answer needs it. Nothing else on the drive is reachable.",
        );
        if (!ok) return;
        try { localStorage.setItem(key, "1"); } catch { /* fine */ }
      }
    }
    append({ role: "user", text: q });
    setInput("");
    setBusy(true);
    try {
      if (agentId === CLOUD_ID) {
        const c = await apiFetch<{ answer: string; contextId: string | null; handed: number }>(`/api/drives/${driveId}/cloud-ask`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ q, path: currentFolder, contextId: cloudContext }),
        });
        if (!c.ok) { append({ role: "error", text: c.error || `HTTP ${c.status}` }); return; }
        setCloudContext(c.data.contextId ?? undefined);
        append({ role: "agent", text: c.data.answer, sources: [], policyName: c.data.handed ? `${c.data.handed} file links, 15 min` : undefined });
        return;
      }
      const r = await apiFetch<{ answer: string; sources?: Source[]; policyName?: string }>(
        `/api/drives/${driveId}/agents/${agentId}/ask`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ q }),
        },
      );
      if (!r.ok) {
        // Rate-limit responses carry retryAfterMs in the error body — surface
        // a countdown instead of the generic error string.
        const b = r.body as { error?: string; retryAfterMs?: number } | null;
        const err =
          b?.error === "rate_limited"
            ? `Rate limited (retry in ${Math.ceil((b.retryAfterMs ?? 0) / 1000)}s)`
            // an on-device agent asked on a computer: the recogniser lives in the phone app
            : selectedAgent && isOnDevice(selectedAgent) && /no_api_key/.test(r.error || "")
              ? `The on-device agent runs in the aindrive phone app, and this drive is on ${device?.hostname || "a computer"}. ` +
                (isOwner ? "Pick aindrive-cloud above to ask about this folder." : "Ask the owner to add an agent with an API key.")
              : r.error || `HTTP ${r.status}`;
        append({ role: "error", text: err });
        return;
      }
      append({ role: "agent", text: r.data.answer, sources: r.data.sources ?? [], policyName: r.data.policyName });
    } finally {
      setBusy(false);
    }
  }

  return (
    <aside className="fixed inset-0 z-30 w-full lg:static lg:inset-auto lg:z-auto lg:w-80 border-l border-drive-border bg-white flex flex-col">
      <ChatHeader onClose={onClose} />

      <AgentPicker
        agents={agents}
        agentId={agentId}
        setAgentId={setAgentId}
        selectedAgent={selectedAgent}
        isOwner={isOwner}
        device={device}
        onEdit={onEdit}
        onDelete={onDelete}
      />

      <MessageList scrollRef={scrollRef} msgs={msgs} selectedAgent={selectedAgent} />

      <ChatInput
        ask={ask}
        input={input}
        setInput={setInput}
        agentId={agentId}
        selectedAgent={selectedAgent}
        busy={busy}
      />

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

function pickAgentForFolder(agents: AgentSummary[], folder: string): AgentSummary | null {
  const candidates = agents.filter((a) => pathCovers(a.folder, folder));
  candidates.sort((a, b) => b.folder.length - a.folder.length);
  return candidates[0] ?? null;
}
