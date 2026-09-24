"use client";
import { useState } from "react";
import { Plug } from "lucide-react";
import { Button } from "@/components/ui";
import type { AccountScope, AuthorizeParams } from "@/lib/oauth";

type Props = {
  params: AuthorizeParams;
  clientName: string;
  redirectHost: string;
  driveName: string;
  userEmail: string;
  canWrite: boolean;
  requestedScope: "read" | "write";
};

/** POSTs the Approve/Deny decision to /api/oauth/authorize, then follows the redirect. */
function useDecision(params: AuthorizeParams) {
  const [busy, setBusy] = useState<"approve" | "deny" | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function decide(decision: "approve" | "deny", extra: Record<string, string> = {}) {
    setBusy(decision); setErr(null);
    const res = await fetch("/api/oauth/authorize", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...params, decision, ...extra }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body?.redirect) {
      setBusy(null);
      setErr(body?.error || "Something went wrong");
      return;
    }
    window.location.href = body.redirect;
  }

  return { busy, err, decide };
}

/* The name is self-asserted at dynamic registration, so anyone can
   register "Claude". The redirect destination is the real identity. */
function RedirectNotice({ redirectHost }: { redirectHost: string }) {
  return (
    <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-caption text-amber-900">
      Access will be sent to <strong className="font-mono break-all">{redirectHost}</strong>. The app name is
      self-reported and not verified by aindrive. Only continue if you started this connection from that app.
    </div>
  );
}

export function ConsentForm({ params, clientName, redirectHost, driveName, userEmail, canWrite, requestedScope }: Props) {
  const [scope, setScope] = useState<"read" | "write">(canWrite && requestedScope === "write" ? "write" : "read");
  const { busy, err, decide } = useDecision(params);

  return (
    <div>
      <div className="flex items-center gap-2">
        <Plug className="w-5 h-5 text-drive-accent" />
        <h1 className="text-xl font-semibold">Connect {clientName}</h1>
      </div>
      <p className="mt-3 text-sm text-drive-text">
        An app calling itself <strong>{clientName}</strong> wants to access the drive <strong>{driveName}</strong> through MCP.
      </p>
      <RedirectNotice redirectHost={redirectHost} />
      <p className="mt-2 text-caption text-drive-muted">Signed in as {userEmail}.</p>

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
        <Button variant="outline" loading={busy === "deny"} disabled={!!busy} onClick={() => decide("deny", { scope_choice: scope })}>Deny</Button>
        <Button variant="filled" loading={busy === "approve"} disabled={!!busy} onClick={() => decide("approve", { scope_choice: scope })}>Allow</Button>
      </div>
    </div>
  );
}

const ACCOUNT_SCOPE_LINES: Record<AccountScope, string[]> = {
  profile: ["See your profile (email, name, wallet address)"],
  "drives:read": ["List your drives", "Read files in your drives (read-only)"],
  "drives:write": ["Upload and delete files in your drives"],
  "drives:sell": ["List files for sale, set prices and your payout wallet, and read your sales"],
};

/** Consent for an account grant ("Sign in with aindrive"): no drive; lists every requested scope. */
export function AccountConsentForm({ params, clientName, redirectHost, userEmail, scopes }: {
  params: AuthorizeParams;
  clientName: string;
  redirectHost: string;
  userEmail: string;
  scopes: AccountScope[];
}) {
  const { busy, err, decide } = useDecision(params);

  return (
    <div>
      <div className="flex items-center gap-2">
        <Plug className="w-5 h-5 text-drive-accent" />
        <h1 className="text-xl font-semibold">Sign in to {clientName}</h1>
      </div>
      <p className="mt-3 text-sm text-drive-text">
        <strong>{clientName}</strong> wants to:
      </p>
      <ul className="mt-2 list-disc pl-5 space-y-1 text-sm text-drive-text">
        {scopes.flatMap((s) => ACCOUNT_SCOPE_LINES[s]).map((line) => <li key={line}>{line}</li>)}
      </ul>
      <RedirectNotice redirectHost={redirectHost} />
      <p className="mt-2 text-caption text-drive-muted">Signed in as {userEmail}.</p>
      <p className="mt-3 text-caption text-drive-muted">
        {scopes.includes("drives:write")
          ? "The app never gets more than your own access in each drive."
          : "The app can't create, change or delete files, and never gets more than your own access."}
        {scopes.includes("drives:sell") && " Sales can only be managed on drives you created."}
      </p>

      {err && <p className="mt-3 text-sm text-red-600">{err}</p>}
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="outline" loading={busy === "deny"} disabled={!!busy} onClick={() => decide("deny")}>Deny</Button>
        <Button variant="filled" loading={busy === "approve"} disabled={!!busy} onClick={() => decide("approve")}>Approve</Button>
      </div>
    </div>
  );
}
