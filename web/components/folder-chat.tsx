"use client";
import { useEffect, useRef, useState } from "react";
import { AinuiFolderChat } from "ain-ui/react";
import { readChatStream, type FolderChatAgent } from "ain-ui";
import "ain-ui/styles.css";
import { CreateAgentModal, type EditableAgent } from "./create-agent-modal";
import { mentionFolders, parseMentions, type MentionDrive } from "@/lib/mention";
import type { AgentSummary } from "./folder-chat-parts";

type Props = { driveId: string; currentFolder: string; onClose?: () => void; isOwner?: boolean };
export function FolderChat(props: Props) {
  return <FolderChatScope key={`${props.driveId}:${props.currentFolder}`} {...props} />;
}
function FolderChatScope({ driveId, currentFolder, onClose, isOwner }: Props) {
  const [agents, setAgents] = useState<FolderChatAgent[]>([]);
  const [drives, setDrives] = useState<MentionDrive[]>([]);
  const contexts = useRef(new Map<string, string>());
  const [error, setError] = useState("");
  const [localAgents, setLocalAgents] = useState<AgentSummary[]>([]);
  const [editing, setEditing] = useState<EditableAgent | null>(null);
  const [reload, setReload] = useState(0);
  const approved = useRef(new Set<string>());
  useEffect(() => {
    const controller = new AbortController();
    if (isOwner) void fetch("/api/drives", { signal: controller.signal }).then(r => r.json()).then(r => { if (!controller.signal.aborted) setDrives(r.drives || []); }).catch(() => {});
    void Promise.all([
      fetch(`/api/drives/${driveId}/agents`, { signal: controller.signal }).then(r => r.ok ? r.json() : { agents: [] }),
      isOwner ? fetch(`/api/drives/${driveId}/folder-chat`, { signal: controller.signal }).then(r => r.ok ? r.json() : { agents: [] }) : Promise.resolve({ agents: [] }),
    ]).then(([local, remote]) => {
      if (controller.signal.aborted) return;
      // A broader ancestor's agent would read outside the selected folder.
      const scoped = (local.agents as AgentSummary[]).filter(a => a.folder.replace(/^\/+|\/+$/g, "") === currentFolder.replace(/^\/+|\/+$/g, ""));
      setLocalAgents(scoped);
      setAgents([...scoped.map(a => ({ id: `local:${a.id}`, label: a.name })), ...remote.agents]);
    }).catch(e => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [driveId, currentFolder, isOwner, reload]);
  return <aside className="fixed inset-0 z-30 w-full overflow-auto border-l border-drive-border bg-white p-4 lg:static lg:z-auto lg:w-96">
    {onClose && <button onClick={onClose}>Close chat</button>}
    {error && <p role="alert">{error}</p>}
    {isOwner && localAgents.length > 0 && <details><summary>Manage folder agents</summary>{localAgents.map(a => <div key={a.id}>
      {a.name} <button onClick={() => setEditing(a)}>Edit</button> <button onClick={async () => {
        if (!window.confirm(`Delete agent "${a.name}"?`)) return;
        const r = await fetch(`/api/drives/${driveId}/agents/${a.id}`, { method: "DELETE" });
        if (!r.ok) setError("Could not delete agent"); else setReload(n => n + 1);
      }}>Delete</button></div>)}</details>}
    {editing && <CreateAgentModal driveId={driveId} defaultFolder={editing.folder} existing={editing} onClose={() => { setEditing(null); setReload(n => n + 1); }} />}
    {!agents.length && <p>No agent is available for this folder.</p>}
    {isOwner && drives.length > 0 && <details><summary>Folder mentions</summary><p>Start a message with an agent or folder handle to choose its context.</p>{mentionFolders(drives).map(f => <div key={f.drive.id}><code>@{f.handle}</code></div>)}</details>}
    <AinuiFolderChat driveId={driveId} path={currentFolder} agents={agents} onSend={async turn => {
      const said = parseMentions(turn.q, agents.map(a => ({ ...a, name: a.label })), mentionFolders(drives));
      const agentId = said?.agent?.id ?? (said?.folders.length ? "cloud" : turn.agentId);
      const selected = agents.find(a => a.id === agentId);
      if (!selected) throw new Error("Agent unavailable");
      const local = agentId.startsWith("local:");
      if (local && said?.folders.length) throw new Error("Select a remote agent to read mentioned folders");
      const folders = said?.folders.length ? said.folders.map(f => ({ driveId: f.drive.id, path: "" })) : undefined;
      const scope = JSON.stringify({ agentId, folders: folders ?? [{ driveId, path: currentFolder }] });
      if (!local && !approved.current.has(scope)) {
        if (!window.confirm(`Send ${folders ? "the mentioned folders" : "this folder"} file lists and temporary file links to ${selected.label}?`)) throw new Error("Remote agent access was not approved");
        approved.current.add(scope);
      }
      const endpoint = local ? `/api/drives/${driveId}/agents/${encodeURIComponent(agentId.slice(6))}/ask` : `/api/drives/${driveId}/folder-chat`;
      const response = await fetch(endpoint, { method: "POST", signal: turn.signal, headers: { "content-type": "application/json", accept: "text/event-stream" }, body: JSON.stringify({ q: said?.text ?? turn.q, path: currentFolder, agentId, folders, contextId: contexts.current.get(scope) }) });
      const result = await readChatStream(response, turn.onUpdate, turn.signal);
      if (result.contextId) contexts.current.set(scope, result.contextId);
      return result;
    }} />
  </aside>;
}
