import { redirect } from "next/navigation";
import Link from "next/link";
import { getUser } from "@/lib/session";
import { DevicesList } from "./devices-list";

export default async function DevicesPage() {
  const user = await getUser();
  if (!user) redirect("/login?next=/account/devices");
  return (
    <main className="mx-auto max-w-2xl px-6 py-10">
      <Link href="/" className="text-sm text-drive-muted hover:underline">← My drives</Link>
      <h1 className="mt-4 text-2xl font-semibold">Devices</h1>
      <p className="mt-1 text-sm text-drive-muted">
        The browsers, computers and phones that sign edits in your name. Remove one you lost or no longer use:
        its new edits are refused everywhere; what it wrote before stays yours. Removing a device does not sign it
        out: sign out there, or change your password, if someone else has it.
      </p>
      <DevicesList userId={user.id} />
    </main>
  );
}
