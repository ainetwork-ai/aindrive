"use client";
// Manage → Members: share the whole drive with an AIN SSO organization, change
// its role, or stop (docs/PERMISSIONS.md "Organizations"). The API decides who
// may (creator; org admin or operator-allowlisted); this card only mirrors it.
// Hidden when there is nothing to show (no organization shares, and the viewer
// belongs to no organization).
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Building2, TrashIcon } from "lucide-react";
import { apiFetch } from "@/lib/api-client";
import { Badge, Button, IconButton, SectionCard } from "@/components/ui";

type OrgRole = "viewer" | "editor";
type OrgShare = {
  issuer: string; orgId: string; slug: string | null; name: string; role: OrgRole;
  activeMembers: number; ownerActive: boolean; inForce: boolean;
};
type Refusal = "not_creator" | "not_member" | "not_admin";
type Candidate = { orgId: string; slug: string | null; name: string; canShare: boolean; reason: string | null; reasonCode: Refusal | null };
type OrgsResponse = { enabled: boolean; canManage: boolean; shares: OrgShare[]; candidates: Candidate[] };

const ROLE_HELP: Record<OrgRole, string> = {
  viewer: "everyone can read & download",
  editor: "everyone can also upload, edit & delete",
};

/** Why this creator can't share with `c`, and what to do instead (lib/org-policy.js codes). */
function refusalText(c: Candidate): string {
  if (c.reasonCode === "not_admin") {
    return `Only a ${c.name} admin can share drives with ${c.name}. Ask your aindrive operator to add this drive to ${c.name}.`;
  }
  const r = c.reason ?? "You can’t share this drive with the organization.";
  return r[0].toUpperCase() + r.slice(1) + (/[.!?]$/.test(r) ? "" : ".");
}

export function DriveOrgAccess({ driveId, busy, setBusy }: { driveId: string; busy: boolean; setBusy: (b: boolean) => void }) {
  const [data, setData] = useState<OrgsResponse | null>(null);
  const [roles, setRoles] = useState<Record<string, OrgRole>>({});

  const load = useCallback(async () => {
    const res = await apiFetch<OrgsResponse>(`/api/drives/${driveId}/orgs`);
    if (res.ok) setData(res.data);
  }, [driveId]);
  useEffect(() => { load(); }, [load]);

  if (!data) return null;
  const sharedIds = new Set(data.shares.map((s) => s.orgId));
  const candidates = data.candidates.filter((c) => !sharedIds.has(c.orgId));
  if (data.shares.length === 0 && candidates.length === 0) return null;

  async function share(orgId: string, role: OrgRole) {
    setBusy(true);
    const res = await apiFetch(`/api/drives/${driveId}/orgs`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ orgId, role }),
    });
    setBusy(false);
    if (!res.ok) { toast.error(res.error || "Failed to share with the organization"); return; }
    toast.success(res.status === 201 ? "Shared with the organization" : "Organization role updated");
    load();
  }
  async function unshare(s: OrgShare) {
    if (!confirm(`Stop sharing this drive with ${s.name}?\n\nIts members lose access now (people you invited yourself keep theirs).`)) return;
    setBusy(true);
    const res = await apiFetch(`/api/drives/${driveId}/orgs/${encodeURIComponent(s.orgId)}`, { method: "DELETE" });
    setBusy(false);
    if (!res.ok) { toast.error(res.error || "Failed to stop sharing"); return; }
    toast.success(`No longer shared with ${s.name}`);
    load();
  }

  return (
    <SectionCard
      icon={<Building2 className="w-4 h-4" />}
      title="Organizations"
      description="Share the whole drive with everyone in your organization. People get access while they are active members, and lose it the moment AIN SSO suspends or offboards them."
    >
      {data.shares.length > 0 && (
        <ul className="space-y-2" data-testid="org-shares">
          {data.shares.map((s) => (
            <li key={`${s.issuer} ${s.orgId}`} className="flex flex-wrap items-center gap-2 rounded-lg bg-drive-sidebar px-3 py-2 text-body">
              <Building2 className="w-4 h-4 shrink-0 text-drive-accent" />
              <span className="min-w-0 truncate font-medium text-drive-text">{s.name}</span>
              <span className="text-caption text-drive-muted">{s.activeMembers} active member{s.activeMembers === 1 ? "" : "s"}</span>
              {!s.inForce && (
                <Badge tone="warning" className="shrink-0">
                  {s.ownerActive ? "paused — AIN SSO is off" : "paused — the creator is not an active member"}
                </Badge>
              )}
              <span className="ml-auto flex items-center gap-1">
                {data.canManage ? (
                  <>
                    <select
                      value={s.role}
                      disabled={busy}
                      onChange={(e) => share(s.orgId, e.target.value as OrgRole)}
                      className="bg-transparent text-drive-text font-medium focus:outline-none"
                      aria-label={`Role for ${s.name}`}
                    >
                      <option value="viewer">viewer</option>
                      <option value="editor">editor</option>
                    </select>
                    <IconButton size="sm" variant="text" aria-label={`Stop sharing with ${s.name}`} disabled={busy} onClick={() => unshare(s)}>
                      <TrashIcon className="w-3.5 h-3.5" />
                    </IconButton>
                  </>
                ) : (
                  <Badge tone="neutral">{s.role}</Badge>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}

      {candidates.length > 0 && (
        <ul className={data.shares.length > 0 ? "mt-3 space-y-2 border-t border-drive-border pt-3" : "space-y-2"}>
          {candidates.map((c) => {
            const role = roles[c.orgId] ?? "viewer";
            return (
              <li key={c.orgId} className="flex flex-wrap items-center gap-2 text-body">
                <span className="min-w-0 truncate font-medium text-drive-text">{c.name}</span>
                {c.canShare ? (
                  <span className="ml-auto flex items-center gap-2">
                    <select
                      value={role}
                      disabled={busy}
                      onChange={(e) => setRoles((r) => ({ ...r, [c.orgId]: e.target.value as OrgRole }))}
                      className="rounded-md border border-drive-border bg-white px-2 py-1 text-caption"
                      aria-label={`Role to give ${c.name}`}
                    >
                      <option value="viewer">Viewer</option>
                      <option value="editor">Editor</option>
                    </select>
                    <Button size="sm" variant="filled" disabled={busy} onClick={() => share(c.orgId, role)}>Share with {c.name}</Button>
                  </span>
                ) : (
                  <span className="basis-full text-caption text-drive-muted" data-testid="org-share-refusal">{refusalText(c)}</span>
                )}
                {c.canShare && <span className="basis-full text-caption text-drive-muted">{role[0].toUpperCase() + role.slice(1)}: {ROLE_HELP[role]}</span>}
              </li>
            );
          })}
        </ul>
      )}

      {!data.canManage && (
        <p className="mt-3 text-caption text-drive-muted">Only the drive’s creator can change organization sharing.</p>
      )}
    </SectionCard>
  );
}
