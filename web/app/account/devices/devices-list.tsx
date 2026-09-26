"use client";
import { useEffect, useState } from "react";
import { toHex } from "@/shared/willow/bytes";
import { deviceKey } from "@/lib/willow/client";

type Device = { deviceKey: string; label: string; issuedAt: string; strength: string; revoked: boolean; drives: string[] };

export function DevicesList({ userId }: { userId: string }) {
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [mine, setMine] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => fetch("/api/willow/devices").then((r) => r.json()).then((j) => setDevices(j.devices ?? [])).catch(() => setError("Could not load devices."));
  useEffect(() => { void load(); void deviceKey(userId).then((k) => setMine(toHex(k.publicKey))).catch(() => {}); }, [userId]);

  const remove = async (d: Device) => {
    const self = d.deviceKey === mine;
    if (!confirm(self ? "Remove THIS browser? Its new edits will be refused everywhere." : `Remove “${d.label}”? Its new edits will be refused everywhere.`)) return;
    const r = await fetch("/api/willow/devices/revoke", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ deviceKey: d.deviceKey }) });
    if (!r.ok) setError((await r.json().catch(() => ({}))).error ?? "Could not remove the device.");
    await load();
  };

  if (error) return <p className="mt-6 text-sm text-red-600">{error}</p>;
  if (!devices) return <p className="mt-6 text-sm text-drive-muted">Loading…</p>;
  if (!devices.length) return <p className="mt-6 text-sm text-drive-muted">No device has signed an edit yet.</p>;
  return (
    <ul className="mt-6 divide-y divide-drive-border rounded-xl border border-drive-border bg-white" data-testid="devices">
      {devices.map((d) => (
        <li key={d.deviceKey} className="flex items-center gap-3 px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="truncate font-medium">{d.label}{d.deviceKey === mine && <span className="ml-2 text-xs text-drive-accent">this browser</span>}</div>
            <div className="text-xs text-drive-muted">
              {d.strength === "wallet" ? "vouched by your wallet" : d.strength === "attested" ? "vouched by aindrive" : "not verified"}
              {" · "}{d.drives.length} drive{d.drives.length === 1 ? "" : "s"}
              {d.revoked && " · removed"}
            </div>
          </div>
          {!d.revoked && <button onClick={() => void remove(d)} className="rounded-full border border-drive-border px-3 py-1 text-sm hover:bg-drive-hover">Remove</button>}
        </li>
      ))}
    </ul>
  );
}
