"use client";
// Presentational pieces for FolderChat. State, the ask() action (incl.
// rate_limited handling), effects, and the CreateAgentModal render stay in the
// shell (folder-chat.tsx); these are pure render functions that receive data
// and handlers as props. Extracting markup only — behavior is unchanged.
import { useMemo, useState } from "react";
import { Bot, Send, MessageSquare, Pencil, Trash2, ChevronDown, ChevronRight, X } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Select, IconButton } from "@/components/ui";

export type AgentSummary = {
  id: string;
  name: string;
  description: string;
  persona: string;
  folder: string;
  llm: { provider: string; model: string };
  access: { policies: string[] };
};

export type Source = {
  path: string;
  snippet: string;
  lineStart?: number;
  lineEnd?: number;
};

export type Msg =
  | { role: "user"; text: string }
  | { role: "agent"; text: string; sources: Source[]; policyName?: string }
  | { role: "error"; text: string };

export function ChatHeader({ onClose }: { onClose?: () => void }) {
  return (
    <div className="flex items-center justify-between px-3 py-2.5 border-b border-drive-border">
      <div className="flex items-center gap-2 text-subtitle text-drive-text">
        <MessageSquare className="w-4 h-4 text-drive-accent" />
        <span>Folder Chat</span>
      </div>
      {onClose && (
        <IconButton size="sm" variant="text" aria-label="Close chat" onClick={onClose}>
          <X className="w-4 h-4" />
        </IconButton>
      )}
    </div>
  );
}

export function AgentPicker({
  agents, agentId, setAgentId, selectedAgent, isOwner, onEdit, onDelete,
}: {
  agents: AgentSummary[] | null;
  agentId: string | null;
  setAgentId: (id: string) => void;
  selectedAgent: AgentSummary | null;
  isOwner?: boolean;
  onEdit: (target: AgentSummary) => void;
  onDelete: (target: AgentSummary) => void;
}) {
  return (
    <div className="px-3 py-2.5 border-b border-drive-border">
      {agents === null ? (
        <span className="text-caption text-drive-muted">Loading agents…</span>
      ) : agents.length === 0 ? (
        <EmptyState isOwner={isOwner} />
      ) : (
        <>
          <Select
            label="Agent"
            value={agentId ?? ""}
            onChange={(e) => setAgentId(e.target.value)}
          >
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} — {a.folder || "/"}
              </option>
            ))}
          </Select>
          {selectedAgent && (
            <div className="mt-1.5 flex items-center justify-between gap-2">
              <p className="text-caption text-drive-muted font-mono truncate">
                {selectedAgent.llm.provider} · {selectedAgent.llm.model}
              </p>
              {isOwner && (
                <div className="flex items-center gap-0.5 shrink-0">
                  <IconButton size="sm" variant="text" aria-label="Edit agent" onClick={() => onEdit(selectedAgent)}>
                    <Pencil className="w-3.5 h-3.5" />
                  </IconButton>
                  <IconButton size="sm" variant="danger" aria-label="Delete agent" onClick={() => onDelete(selectedAgent)}>
                    <Trash2 className="w-3.5 h-3.5" />
                  </IconButton>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

export function MessageList({
  scrollRef, msgs, selectedAgent,
}: {
  scrollRef: React.RefObject<HTMLDivElement | null>;
  msgs: Msg[];
  selectedAgent: AgentSummary | null;
}) {
  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto p-3 space-y-3 text-body">
      {msgs.length === 0 ? (
        <p className="text-caption text-drive-muted text-center mt-6">
          {selectedAgent
            ? `Ask ${selectedAgent.name} anything about this drive.`
            : "Pick an agent to start chatting."}
        </p>
      ) : (
        msgs.map((m, i) => <MessageBubble key={i} msg={m} />)
      )}
    </div>
  );
}

export function ChatInput({
  ask, input, setInput, agentId, selectedAgent, busy,
}: {
  ask: () => void;
  input: string;
  setInput: (v: string) => void;
  agentId: string | null;
  selectedAgent: AgentSummary | null;
  busy: boolean;
}) {
  return (
    <form
      onSubmit={(e) => { e.preventDefault(); ask(); }}
      className="border-t border-drive-border p-2 flex items-end gap-2"
    >
      <textarea
        className="flex-1 rounded-md border border-drive-border bg-drive-panel px-3 py-2 text-body text-drive-text
                   placeholder:text-drive-muted resize-none outline-none transition-colors duration-150
                   focus-visible:ring-2 focus-visible:ring-drive-accent/40 focus-visible:border-drive-accent
                   disabled:opacity-50"
        rows={2}
        aria-label={selectedAgent ? `Message ${selectedAgent.name}` : "Message agent"}
        placeholder={agentId && selectedAgent ? `Message ${selectedAgent.name}…` : "No agent selected"}
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
      <IconButton
        type="submit"
        variant="filled"
        aria-label="Send"
        loading={busy}
        disabled={!agentId || !input.trim() || busy}
      >
        <Send className="w-4 h-4" />
      </IconButton>
    </form>
  );
}

function MessageBubble({ msg }: { msg: Msg }) {
  if (msg.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="bg-drive-accent text-white rounded-lg px-3 py-1.5 max-w-[85%] whitespace-pre-wrap">
          {msg.text}
        </div>
      </div>
    );
  }
  if (msg.role === "error") {
    return (
      <div className="bg-red-50 text-red-700 rounded-lg px-3 py-1.5 text-caption border border-red-200">
        {msg.text}
      </div>
    );
  }
  return (
    <div className="space-y-1">
      <div className="flex items-start gap-1.5">
        <Bot className="w-4 h-4 text-drive-accent shrink-0 mt-0.5" />
        <div className="bg-drive-sidebar rounded-lg px-3 py-2 max-w-[85%] agent-prose">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              a: (props) => (
                <a
                  {...props}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-drive-accent underline hover:text-drive-accentHover"
                />
              ),
              code: ({ className, children, ...props }) => {
                const inline = !/language-/.test(className ?? "");
                return inline ? (
                  <code
                    {...props}
                    className="px-1 py-0.5 rounded bg-drive-hover text-drive-text font-mono text-[0.85em]"
                  >
                    {children}
                  </code>
                ) : (
                  <pre className="my-1.5 p-2 rounded bg-gray-900 text-gray-100 overflow-x-auto text-xs">
                    <code className={className} {...props}>{children}</code>
                  </pre>
                );
              },
              ul: (props) => <ul {...props} className="list-disc pl-5 my-1 space-y-0.5" />,
              ol: (props) => <ol {...props} className="list-decimal pl-5 my-1 space-y-0.5" />,
              li: (props) => <li {...props} className="leading-snug" />,
              p: (props) => <p {...props} className="my-1 leading-snug" />,
              h1: (props) => <h1 {...props} className="text-base font-semibold mt-1 mb-0.5" />,
              h2: (props) => <h2 {...props} className="text-sm font-semibold mt-1 mb-0.5" />,
              h3: (props) => <h3 {...props} className="text-sm font-semibold mt-1 mb-0.5" />,
              blockquote: (props) => (
                <blockquote {...props} className="border-l-2 border-drive-border pl-2 my-1 text-drive-muted italic" />
              ),
              table: (props) => (
                <div className="my-1.5 overflow-x-auto">
                  <table {...props} className="border-collapse text-xs" />
                </div>
              ),
              th: (props) => <th {...props} className="border border-drive-border px-1.5 py-0.5 bg-drive-sidebar text-left font-medium" />,
              td: (props) => <td {...props} className="border border-drive-border px-1.5 py-0.5" />,
              hr: () => <hr className="my-2 border-drive-border" />,
              strong: (props) => <strong {...props} className="font-semibold" />,
            }}
          >
            {msg.text}
          </ReactMarkdown>
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
    <div className="ml-5 mt-1 text-caption text-drive-muted">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-0.5 hover:text-drive-text"
      >
        {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        Referenced {paths.length} {paths.length === 1 ? "source" : "sources"}
      </button>
      {open && (
        <div className="mt-1 flex flex-wrap gap-1">
          {paths.map((p) => (
            <span
              key={p}
              className="inline-flex items-center px-1.5 py-0.5 rounded bg-drive-sidebar text-drive-text font-mono text-[10px]"
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
    <div className="text-caption text-drive-muted text-center py-2">
      {isOwner ? (
        <>No agents yet. Right-click a folder → <strong className="text-drive-text">Create Agent</strong>.</>
      ) : (
        <>No agents available on this drive yet.</>
      )}
    </div>
  );
}
