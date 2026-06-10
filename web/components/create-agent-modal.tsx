"use client";
import { useState } from "react";
import { toast } from "sonner";
import { Bot } from "lucide-react";
import { apiFetch } from "@/lib/api-client";
import { Modal } from "@/components/ui";
import { AgentForm, CreatedView, PROVIDERS, type ProviderId } from "./create-agent-modal-parts";

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

type Props = {
  driveId: string;
  defaultFolder: string;
  onClose: () => void;
  onCreated?: (agent: CreatedAgent) => void;
  /** When provided, the modal opens in edit mode and PATCHes instead of POSTing. */
  existing?: EditableAgent;
};

export function CreateAgentModal({ driveId, defaultFolder, onClose, onCreated, existing }: Props) {
  const isEdit = !!existing;
  const [name, setName] = useState(existing?.name ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  const [persona, setPersona] = useState(existing?.persona ?? "");
  const [folder, setFolder] = useState(existing?.folder ?? defaultFolder ?? "");
  const [provider, setProvider] = useState<ProviderId>(
    (existing?.llm.provider as ProviderId) ?? "flock",
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

  const onProviderChange = (id: ProviderId) => {
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
      const r = await apiFetch<{ agent: CreatedAgent }>(url, {
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
      if (!r.ok) {
        toast.error(`Failed: ${r.error}`);
        return;
      }
      const a = r.data.agent;
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
    <Modal
      open
      onClose={onClose}
      size="md"
      title={
        <span className="flex items-center gap-2">
          <Bot className="w-5 h-5 text-blue-600" />
          {isEdit ? "Edit Agent" : "Create Agent"}
        </span>
      }
    >
      {created ? (
        <CreatedView
          askUrl={created.askUrl}
          cardUrl={created.cardUrl}
          onClose={onClose}
        />
      ) : (
        <AgentForm
          isEdit={isEdit}
          name={name}
          setName={setName}
          description={description}
          setDescription={setDescription}
          folder={folder}
          setFolder={setFolder}
          persona={persona}
          setPersona={setPersona}
          provider={provider}
          onProviderChange={onProviderChange}
          model={model}
          setModel={setModel}
          temperature={temperature}
          setTemperature={setTemperature}
          apiKey={apiKey}
          setApiKey={setApiKey}
          policiesAllowCap={policiesAllowCap}
          setPoliciesAllowCap={setPoliciesAllowCap}
          submit={submit}
          submitting={submitting}
          onClose={onClose}
        />
      )}
    </Modal>
  );
}
