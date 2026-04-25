"use client";
import { useState } from "react";
import { toast } from "sonner";
import { X, Bot, Sparkles, BookOpen, Cpu, Shield, Loader2, Copy } from "lucide-react";

/**
 * Create Agent modal — owner-only UI for registering a RAG agent
 * over a folder of their drive. The form mirrors the three ports
 * (knowledge, llm, access) so the design lays bare what each axis
 * controls.
 *
 * On success, shows the agent's well-known card URL with a copy
 * button, since that's the publish artifact (other agents can fetch
 * it for A2A discovery).
 */

type CreatedAgent = {
  id: string;
  driveId: string;
  folder: string;
  name: string;
  description: string;
};

/** Subset of Agent the parent passes when opening in edit mode. */
export type EditableAgent = {
  id: string;
  folder: string;
  name: string;
  description: string;
  persona: string;
  llm: { provider: string; model: string };
  access: { policies: string[] };
};

const PERSONA_PLACEHOLDER =
  "e.g. You are the friendly product guide for Acme. Greet visitors warmly, explain product features in plain language, and surface release dates when asked.";

type Props = {
  driveId: string;
  defaultFolder: string;
  onClose: () => void;
  onCreated?: (agent: CreatedAgent) => void;
  /** When provided, the modal opens in edit mode and PATCHes instead of POSTing. */
  existing?: EditableAgent;
};

const PROVIDERS = [
  { id: "flock", label: "Flock", defaultModel: "qwen3-30b-a3b-instruct-2507" },
  { id: "openai", label: "OpenAI", defaultModel: "gpt-4o-mini" },
] as const;

export function CreateAgentModal({ driveId, defaultFolder, onClose, onCreated, existing }: Props) {
  const isEdit = !!existing;
  const [name, setName] = useState(existing?.name ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  const [persona, setPersona] = useState(existing?.persona ?? "");
  const [folder, setFolder] = useState(existing?.folder ?? defaultFolder ?? "");
  const [provider, setProvider] = useState<(typeof PROVIDERS)[number]["id"]>(
    (existing?.llm.provider as (typeof PROVIDERS)[number]["id"]) ?? "flock",
  );
  const [model, setModel] = useState<string>(existing?.llm.model ?? PROVIDERS[0].defaultModel);
  const [temperature, setTemperature] = useState(0.2);
  const [apiKey, setApiKey] = useState("");
  const [policiesAllowCap, setPoliciesAllowCap] = useState(
    existing ? existing.access.policies.includes("cap-holder") : true,
  );
  const [submitting, setSubmitting] = useState(false);
  const [created, setCreated] = useState<{
    agent: CreatedAgent;
    askUrl: string;
    cardUrl: string;
  } | null>(null);

  const onProviderChange = (id: (typeof PROVIDERS)[number]["id"]) => {
    setProvider(id);
    const p = PROVIDERS.find((p) => p.id === id);
    if (p) setModel(p.defaultModel);
  };

  async function submit() {
    if (!name.trim()) return toast.error("Name required");
    setSubmitting(true);
    try {
      const policies = policiesAllowCap ? ["owner", "cap-holder"] : ["owner"];
      const url = isEdit
        ? `/api/drives/${driveId}/agents/${existing!.id}`
        : `/api/drives/${driveId}/agents`;
      const r = await fetch(url, {
        method: isEdit ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          folder,
          name: name.trim(),
          description: description.trim(),
          persona: persona.trim(),
          knowledge: { strategy: "dump-all-text" },
          llm: {
            provider,
            model,
            temperature,
            ...(apiKey ? { apiKey } : {}),
          },
          access: { policies },
        }),
      });
      const data = await r.json();
      if (!r.ok) {
        toast.error(`Failed: ${data.error || r.status}`);
        return;
      }
      const a = data.agent as CreatedAgent;
      onCreated?.(a);
      if (isEdit) {
        toast.success("Agent updated");
        onClose();
      } else {
        setCreated({
          agent: a,
          askUrl: `${window.location.origin}/api/drives/${a.driveId}/agents/${a.id}/ask`,
          cardUrl: `${window.location.origin}/api/drives/${a.driveId}/agents/${a.id}/.well-known/agent-card.json`,
        });
        toast.success("Agent created");
      }
    } catch (e) {
      toast.error(`Failed: ${(e as Error).message}`);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/30 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-white rounded-lg shadow-xl w-full max-w-xl max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b">
          <div className="flex items-center gap-2">
            <Bot className="w-5 h-5 text-blue-600" />
            <h2 className="text-lg font-semibold">{isEdit ? "Edit Agent" : "Create Agent"}</h2>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-gray-100 rounded">
            <X className="w-5 h-5" />
          </button>
        </div>

        {created ? (
          <CreatedView
            askUrl={created.askUrl}
            cardUrl={created.cardUrl}
            onClose={onClose}
          />
        ) : (
          <div className="p-4 space-y-4 text-sm">
            {/* basic */}
            <div className="space-y-2">
              <label className="block">
                <span className="text-gray-700">Name</span>
                <input
                  className="mt-1 w-full border rounded px-2 py-1.5"
                  placeholder="OKR Bot"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={80}
                />
              </label>
              <label className="block">
                <span className="text-gray-700">Description</span>
                <input
                  className="mt-1 w-full border rounded px-2 py-1.5"
                  placeholder="Q&A over Q1 OKR docs"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  maxLength={500}
                />
              </label>
              <label className="block">
                <span className="text-gray-700">Folder</span>
                <input
                  className="mt-1 w-full border rounded px-2 py-1.5 font-mono"
                  placeholder="docs (empty = whole drive)"
                  value={folder}
                  onChange={(e) => setFolder(e.target.value)}
                />
              </label>
            </div>

            {/* persona */}
            <Section icon={<Sparkles className="w-4 h-4 text-violet-600" />} title="Persona">
              <textarea
                className="w-full border rounded px-2 py-1.5 text-sm resize-y"
                rows={4}
                placeholder={PERSONA_PLACEHOLDER}
                value={persona}
                onChange={(e) => setPersona(e.target.value)}
                maxLength={1500}
              />
              <p className="text-xs text-gray-500 mt-1">
                How the agent introduces itself and replies. Leave empty for a friendly default.
              </p>
            </Section>

            {/* context */}
            <Section icon={<BookOpen className="w-4 h-4 text-emerald-600" />} title="Context">
              <select className="border rounded px-2 py-1.5 w-full" disabled>
                <option>Folder documents</option>
              </select>
              <p className="text-xs text-gray-500 mt-1">
                The agent draws on the documents in this folder when answering. Best for small to mid-size knowledge bases.
              </p>
            </Section>

            {/* model */}
            <Section icon={<Cpu className="w-4 h-4 text-amber-600" />} title="Model">
              <div className="grid grid-cols-2 gap-2">
                <label className="block">
                  <span className="text-gray-700">Provider</span>
                  <select
                    className="mt-1 border rounded px-2 py-1.5 w-full"
                    value={provider}
                    onChange={(e) => onProviderChange(e.target.value as (typeof PROVIDERS)[number]["id"])}
                  >
                    {PROVIDERS.map((p) => (
                      <option key={p.id} value={p.id}>{p.label}</option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className="text-gray-700">Model</span>
                  <input
                    className="mt-1 border rounded px-2 py-1.5 w-full font-mono text-xs"
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                  />
                </label>
              </div>
              <label className="block">
                <span className="text-gray-700">Temperature: {temperature.toFixed(2)}</span>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  className="mt-1 w-full"
                  value={temperature}
                  onChange={(e) => setTemperature(Number(e.target.value))}
                />
              </label>
              <label className="block">
                <span className="text-gray-700">API key</span>
                <input
                  type="password"
                  className="mt-1 border rounded px-2 py-1.5 w-full font-mono text-xs"
                  placeholder={isEdit ? "leave empty to keep current key" : "leave empty to use platform default"}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                />
                <p className="text-xs text-gray-500 mt-1">
                  Stored privately within this drive. Not shared with visitors.
                </p>
              </label>
            </Section>

            {/* access */}
            <Section icon={<Shield className="w-4 h-4 text-sky-600" />} title="Audience">
              <label className="flex items-center gap-2">
                <input type="checkbox" checked disabled />
                <span>You (always)</span>
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={policiesAllowCap}
                  onChange={(e) => setPoliciesAllowCap(e.target.checked)}
                />
                <span>Anyone you share this drive with</span>
              </label>
            </Section>

            <div className="flex justify-end gap-2 pt-2 border-t">
              <button
                onClick={onClose}
                className="px-3 py-1.5 rounded border hover:bg-gray-50"
                disabled={submitting}
              >
                Cancel
              </button>
              <button
                onClick={submit}
                disabled={submitting || !name.trim()}
                className="px-3 py-1.5 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 inline-flex items-center gap-1.5"
              >
                {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
                {isEdit ? "Save" : "Create"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Section({
  icon, title, children,
}: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div className="border rounded p-3 space-y-2">
      <div className="flex items-center gap-2 font-medium text-gray-700">
        {icon}
        <span>{title}</span>
      </div>
      {children}
    </div>
  );
}

function CreatedView({ askUrl, cardUrl, onClose }: { askUrl: string; cardUrl: string; onClose: () => void }) {
  const copy = (s: string) => {
    navigator.clipboard.writeText(s);
    toast.success("Copied");
  };
  return (
    <div className="p-4 space-y-3 text-sm">
      <p className="text-green-700 font-medium">✓ Agent created</p>
      <div>
        <span className="text-gray-700">Ask endpoint</span>
        <UrlRow url={askUrl} onCopy={() => copy(askUrl)} />
      </div>
      <div>
        <span className="text-gray-700">A2A agent card (public)</span>
        <UrlRow url={cardUrl} onCopy={() => copy(cardUrl)} />
      </div>
      <p className="text-xs text-gray-500">
        Anyone whose identity passes the access policy you set can POST to the ask endpoint.
        The agent card is published per the A2A v1 spec for external discovery.
      </p>
      <div className="flex justify-end pt-2 border-t">
        <button onClick={onClose} className="px-3 py-1.5 rounded bg-blue-600 text-white hover:bg-blue-700">
          Done
        </button>
      </div>
    </div>
  );
}

function UrlRow({ url, onCopy }: { url: string; onCopy: () => void }) {
  return (
    <div className="mt-1 flex items-center gap-2">
      <code className="flex-1 px-2 py-1.5 bg-gray-100 rounded text-xs font-mono truncate">{url}</code>
      <button onClick={onCopy} className="p-1.5 hover:bg-gray-100 rounded" title="Copy">
        <Copy className="w-4 h-4" />
      </button>
    </div>
  );
}
