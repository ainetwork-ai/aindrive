"use client";
import { useState } from "react";
import { Plug } from "lucide-react";
import { Button } from "@/components/ui";
import type { AuthorizeParams } from "@/lib/oauth";

type Props = {
  params: AuthorizeParams;
  clientName: string;
  redirectHost: string;
  driveName: string;
  userEmail: string;
  canWrite: boolean;
  requestedScope: "read" | "write";
};

export function ConsentForm({ params, clientName, redirectHost, driveName, userEmail, canWrite, requestedScope }: Props) {
  const [scope, setScope] = useState<"read" | "write">(canWrite && requestedScope === "write" ? "write" : "read");
  const [busy, setBusy] = useState<"approve" | "deny" | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function decide(decision: "approve" | "deny") {
    setBusy(decision); setErr(null);
    const res = await fetch("/api/oauth/authorize", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...params, decision, scope_choice: scope }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body?.redirect) {
      setBusy(null);
      setErr(body?.error || "Something went wrong");
      return;
    }
    window.location.href = body.redirect;
  }

  return (
    <div>
      <div className="flex items-center gap-2">
        <Plug className="w-5 h-5 text-drive-accent" />
        <h1 className="text-xl font-semibold">Connect {clientName}</h1>
      </div>
      <p className="mt-3 text-sm text-drive-text">
        <strong>{clientName}</strong> wants to access the drive <strong>{driveName}</strong> through MCP.
      </p>
      <p className="mt-1 text-caption text-drive-muted">
        Signed in as {userEmail}. You&apos;ll be sent back to {redirectHost}.
      </p>

      <fieldset className="mt-5 space-y-2">
        <legend className="text-caption font-medium text-drive-text mb-1">Permission</legend>
        <label className="flex items-start gap-2 text-sm">
          <input type="radio" name="scope" checked={scope === "read"} onChange={() => setScope("read")} className="mt-1" />
          <span>Read only — list, search and read files</span>
        </label>
        <label className={`flex items-start gap-2 text-sm ${canWrite ? "" : "opacity-50"}`}>
          <input type="radio" name="scope" disabled={!canWrite} checked={scope === "write"} onChange={() => setScope("write")} className="mt-1" />
          <span>Read &amp; write — also create and overwrite files{canWrite ? "" : " (requires editor access)"}</span>
        </label>
      </fieldset>
      <p className="mt-3 text-caption text-drive-muted">
        The app never gets more than your own access in this drive. You can disconnect it anytime from the drive&apos;s MCP panel.
      </p>

      {err && <p className="mt-3 text-sm text-red-600">{err}</p>}
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="outline" loading={busy === "deny"} disabled={!!busy} onClick={() => decide("deny")}>Deny</Button>
        <Button variant="filled" loading={busy === "approve"} disabled={!!busy} onClick={() => decide("approve")}>Allow</Button>
      </div>
    </div>
  );
}
