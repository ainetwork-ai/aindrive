"use client";
// Presentational pieces for CreateAgentModal. Form state, submit, provider
// change, and the created/edit view-switch stay in the shell
// (create-agent-modal.tsx); these are pure render functions that receive data
// and handlers as props. Extracting markup only — behavior is unchanged.
import { toast } from "sonner";
import { Sparkles, BookOpen, Cpu, Shield, Copy, CheckCircle2 } from "lucide-react";
import { Input, Select, Button, IconButton, SectionCard } from "@/components/ui";

const PERSONA_PLACEHOLDER =
  "e.g. You are the friendly product guide for Acme. Greet visitors warmly, explain product features in plain language, and surface release dates when asked.";

// Shared multiline-control chrome (no Textarea primitive yet — matches Input's
// token chrome so the form reads consistently).
const TEXTAREA_CLASS =
  "w-full rounded-md border border-drive-border bg-drive-panel px-3 py-2 text-body text-drive-text " +
  "placeholder:text-drive-muted resize-y transition-colors duration-150 outline-none " +
  "focus-visible:ring-2 focus-visible:ring-drive-accent/40 focus-visible:border-drive-accent";

export const PROVIDERS = [
  { id: "flock", label: "Flock", defaultModel: "qwen3-30b-a3b-instruct-2507" },
  { id: "openai", label: "OpenAI", defaultModel: "gpt-4o-mini" },
] as const;

export type ProviderId = (typeof PROVIDERS)[number]["id"];

export function AgentForm({
  isEdit, name, setName, description, setDescription, folder, setFolder,
  persona, setPersona, provider, onProviderChange, model, setModel,
  temperature, setTemperature, apiKey, setApiKey, policiesAllowCap,
  setPoliciesAllowCap, submit, submitting, onClose,
}: {
  isEdit: boolean;
  name: string;
  setName: (v: string) => void;
  description: string;
  setDescription: (v: string) => void;
  folder: string;
  setFolder: (v: string) => void;
  persona: string;
  setPersona: (v: string) => void;
  provider: ProviderId;
  onProviderChange: (id: ProviderId) => void;
  model: string;
  setModel: (v: string) => void;
  temperature: number;
  setTemperature: (v: number) => void;
  apiKey: string;
  setApiKey: (v: string) => void;
  policiesAllowCap: boolean;
  setPoliciesAllowCap: (v: boolean) => void;
  submit: () => void;
  submitting: boolean;
  onClose: () => void;
}) {
  return (
    <div className="space-y-3">
      {/* Identity */}
      <div className="space-y-3 rounded-xl border border-drive-border bg-drive-panel p-4">
        <Input label="Name" placeholder="OKR Bot" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
        <Input label="Description" placeholder="Q&A over Q1 OKR docs" value={description} maxLength={500} onChange={(e) => setDescription(e.target.value)} />
        <Input label="Folder" className="font-mono" placeholder="docs (empty = whole drive)" value={folder} onChange={(e) => setFolder(e.target.value)} />
      </div>

      {/* Persona */}
      <SectionCard icon={<Sparkles className="w-4 h-4" />} title="Persona" description="How the agent introduces itself and replies">
        <textarea
          className={TEXTAREA_CLASS}
          rows={4}
          placeholder={PERSONA_PLACEHOLDER}
          value={persona}
          maxLength={1500}
          onChange={(e) => setPersona(e.target.value)}
        />
        <p className="mt-1.5 text-caption text-drive-muted">Leave empty for a friendly default.</p>
      </SectionCard>

      {/* Context */}
      <SectionCard icon={<BookOpen className="w-4 h-4" />} title="Context" description="What the agent draws on to answer">
        <Select value="folder" disabled aria-label="Knowledge source">
          <option value="folder">Folder documents</option>
        </Select>
        <p className="mt-1.5 text-caption text-drive-muted">
          The agent draws on the documents in this folder. Best for small to mid-size knowledge bases.
        </p>
      </SectionCard>

      {/* Model */}
      <SectionCard icon={<Cpu className="w-4 h-4" />} title="Model" description="Provider, model, and sampling">
        <div className="grid grid-cols-2 gap-2">
          <Select label="Provider" value={provider} onChange={(e) => onProviderChange(e.target.value as ProviderId)}>
            {PROVIDERS.map((p) => (
              <option key={p.id} value={p.id}>{p.label}</option>
            ))}
          </Select>
          <Input label="Model" className="font-mono text-caption" value={model} onChange={(e) => setModel(e.target.value)} />
        </div>
        <label className="mt-3 block">
          <span className="text-caption font-medium text-drive-text">Temperature: {temperature.toFixed(2)}</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            className="mt-1.5 w-full accent-drive-accent"
            value={temperature}
            onChange={(e) => setTemperature(Number(e.target.value))}
          />
        </label>
        <Input
          label="API key"
          type="password"
          className="mt-3 font-mono text-caption"
          placeholder={isEdit ? "leave empty to keep current key" : "leave empty to use platform default"}
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          helper="Stored privately within this drive. Not shared with visitors."
        />
      </SectionCard>

      {/* Audience */}
      <SectionCard icon={<Shield className="w-4 h-4" />} title="Audience" description="Who can ask this agent">
        <div className="space-y-2">
          <label className="flex items-center gap-2.5 text-body text-drive-text">
            <input type="checkbox" checked disabled className="accent-drive-accent" />
            You <span className="text-drive-muted">(always)</span>
          </label>
          <label className="flex items-center gap-2.5 text-body text-drive-text cursor-pointer">
            <input
              type="checkbox"
              checked={policiesAllowCap}
              onChange={(e) => setPoliciesAllowCap(e.target.checked)}
              className="accent-drive-accent"
            />
            Anyone you share this drive with
          </label>
        </div>
      </SectionCard>

      <div className="flex justify-end gap-2 pt-1">
        <Button variant="text" onClick={onClose} disabled={submitting}>Cancel</Button>
        <Button variant="filled" onClick={submit} disabled={submitting || !name.trim()} loading={submitting}>
          {isEdit ? "Save" : "Create"}
        </Button>
      </div>
    </div>
  );
}

export function CreatedView({ askUrl, cardUrl, onClose }: { askUrl: string; cardUrl: string; onClose: () => void }) {
  const copy = (s: string) => {
    navigator.clipboard.writeText(s);
    toast.success("Copied");
  };
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-subtitle font-medium text-emerald-600">
        <CheckCircle2 className="w-5 h-5" /> Agent created
      </div>
      <div className="space-y-1.5">
        <span className="text-caption font-medium text-drive-text">Ask endpoint</span>
        <UrlRow url={askUrl} onCopy={() => copy(askUrl)} />
      </div>
      <div className="space-y-1.5">
        <span className="text-caption font-medium text-drive-text">A2A agent card (public)</span>
        <UrlRow url={cardUrl} onCopy={() => copy(cardUrl)} />
      </div>
      <p className="text-caption text-drive-muted">
        Anyone whose identity passes the access policy you set can POST to the ask endpoint.
        The agent card is published per the A2A v1 spec for external discovery.
      </p>
      <div className="flex justify-end pt-1">
        <Button variant="filled" onClick={onClose}>Done</Button>
      </div>
    </div>
  );
}

function UrlRow({ url, onCopy }: { url: string; onCopy: () => void }) {
  return (
    <div className="flex items-center gap-2">
      <code className="flex-1 rounded-md bg-drive-sidebar px-2.5 py-1.5 text-caption font-mono text-drive-text truncate">{url}</code>
      <IconButton size="sm" variant="text" aria-label="Copy" onClick={onCopy}>
        <Copy className="w-4 h-4" />
      </IconButton>
    </div>
  );
}
