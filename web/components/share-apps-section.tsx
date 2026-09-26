"use client";
// "Shared in apps": the drive creator's connected apps (lib/connected-apps.ts)
// — e.g. a family workspace in ainmem — and, per space, a switch that shares
// THIS folder into it or takes it out. Loads itself; renders nothing when no
// app is connected, so the drawer is unchanged for everyone else.
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { AppWindow } from "lucide-react";
import { apiFetch } from "@/lib/api-client";
import { Toggle } from "@/components/ui";
import { DrawerSection } from "./share-dialog-sections";

type Space = { id: string; name: string; group?: string; icon?: string | null; members?: number; shared: boolean };
type AppSpaces = { app: { id: string; name: string; origin: string }; spaces: Space[]; error?: string };

export function AppsSection({ driveId, path }: { driveId: string; path: string }) {
  const [apps, setApps] = useState<AppSpaces[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void apiFetch<{ apps: AppSpaces[] }>(`/api/drives/${driveId}/apps?${new URLSearchParams({ path })}`).then((r) => {
      if (live) setApps(r.ok ? r.data.apps : []);
    });
    return () => { live = false; };
  }, [driveId, path]);

  async function toggle(appId: string, space: Space, shared: boolean) {
    const key = `${appId}/${space.id}`;
    setBusy(key);
    const r = await apiFetch(`/api/drives/${driveId}/apps/${appId}/spaces/${encodeURIComponent(space.id)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path, shared }),
    });
    setBusy(null);
    if (!r.ok) return void toast.error(r.error || "Could not change sharing");
    setApps((cur) => cur?.map((a) => a.app.id !== appId ? a : { ...a, spaces: a.spaces.map((s) => s.id === space.id ? { ...s, shared } : s) }) ?? cur);
    toast.success(shared ? `Shared into ${space.name}` : `No longer shared into ${space.name}`);
  }

  if (!apps?.length) return null;
  return (
    <DrawerSection title="Shared in apps" description="Workspaces in apps you connected. Turn this folder on or off in each.">
      <div className="space-y-3">
        {apps.map(({ app, spaces, error }) => (
          <div key={app.id}>
            <div className="flex items-center gap-1.5 text-caption text-drive-muted">
              <AppWindow className="w-3.5 h-3.5" /> {app.name} <span className="truncate opacity-70">· {app.origin.replace(/^https?:\/\//, "")}</span>
            </div>
            {error ? (
              <p className="mt-1 text-caption text-red-600">{error}</p>
            ) : spaces.length === 0 ? (
              <p className="mt-1 text-caption text-drive-muted">No workspaces there yet.</p>
            ) : (
              <ul className="mt-1">
                {spaces.map((s) => (
                  <li key={s.id} className="flex items-center gap-2 py-1.5">
                    <span className="w-5 text-center">{s.icon || "👥"}</span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-body text-drive-text">{s.name}</div>
                      <div className="truncate text-caption text-drive-muted">
                        {[s.group, s.members ? `${s.members} people` : null].filter(Boolean).join(" · ")}
                      </div>
                    </div>
                    <Toggle
                      on={s.shared}
                      disabled={busy === `${app.id}/${s.id}`}
                      onChange={(v) => void toggle(app.id, s, v)}
                      aria-label={`Share into ${s.name}`}
                    />
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>
    </DrawerSection>
  );
}
