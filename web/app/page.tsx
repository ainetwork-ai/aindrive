import Link from "next/link";
import { getUser } from "@/lib/session";
import { listUserDrives } from "@/lib/drives";
import { isOnline } from "@/lib/rpc";
import { HardDrive } from "lucide-react";
import { LeaveDriveButton } from "@/components/leave-drive-button";
import { AddEmailForm } from "@/components/add-email-form";
import { isWalletOnlyEmail, walletDisplayLabel } from "@/shared/wallet-display";
import { GetMacApp } from "@/components/get-mac-app";
import { Landing } from "@/components/landing";
import { env } from "@/lib/env";
import { desktopAppServes } from "@/shared/desktop";

export default async function Home() {
  const user = await getUser();
  if (!user) {
    // the web is where you use aindrive; the Mac app, the Android app and the
    // terminal are how a folder gets in — components/landing.tsx
    return <Landing macAvailable={desktopAppServes(env.publicUrl)} />;
  }

  const drives = listUserDrives(user.id);
  return (
    <main className="min-h-screen min-h-[100dvh] max-w-5xl mx-auto px-6 py-10">
      <header className="flex items-center justify-between mb-8">
        <h1 className="text-2xl font-semibold">My drives</h1>
        <div className="flex items-center gap-4">
          {drives.length > 0 && <GetMacApp server={env.publicUrl} available={desktopAppServes(env.publicUrl)} compact />}
          {!isWalletOnlyEmail(user.email) && (
            <Link href="/account/wallet" className="text-sm text-drive-muted hover:text-drive-accent hover:underline">
              Add wallet sign-in
            </Link>
          )}
          <form action="/api/auth/logout" method="POST">
            <button className="text-sm text-drive-muted hover:text-drive-text">Sign out ({walletDisplayLabel(user.email, user.name)})</button>
          </form>
        </div>
      </header>

      {isWalletOnlyEmail(user.email) && (
        <div className="mb-6 rounded-xl border border-drive-border bg-drive-panel px-4 py-3 text-sm">
          <p className="font-medium text-drive-text">This is a wallet account</p>
          <p className="mt-0.5 text-drive-muted">
            You sign in with your wallet. There is no password recovery — lose the wallet
            and you lose access. Add an email to enable a second way in.
          </p>
          <AddEmailForm />
        </div>
      )}

      {drives.length === 0 ? (
        <>
          <div className="mb-6 rounded-2xl border border-dashed border-drive-border px-6 py-8 text-center" data-testid="no-drives">
            <HardDrive className="mx-auto h-7 w-7 text-drive-muted" />
            <p className="mt-2 text-lg font-medium">Your drives show up here</p>
            <p className="mx-auto mt-1 max-w-md text-sm text-drive-muted">
              Open them from any browser, anywhere — nothing to install. A drive appears when you share a folder from
              one of your devices, or when someone shares theirs with you.
            </p>
          </div>
          <GetMacApp server={env.publicUrl} available={desktopAppServes(env.publicUrl)} />
        </>
      ) : (
        <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {drives.map((d) => (
            <li key={d.id} className="relative group">
              <Link
                href={`/d/${d.id}`}
                className="flex items-start gap-3 rounded-2xl bg-white border border-drive-border p-4 hover:shadow-drive transition"
              >
                <HardDrive className="w-6 h-6 text-drive-accent mt-0.5" />
                <div className="min-w-0 flex-1">
                  <div className="font-medium truncate">{d.name}</div>
                  <div className="text-xs text-drive-muted mt-1 flex items-center gap-1.5">
                    <span className={`inline-block w-1.5 h-1.5 rounded-full ${isOnline(d.id) ? "bg-green-500" : "bg-gray-300"}`} />
                    {isOnline(d.id) ? "online" : (d.last_seen_at ? `last seen ${new Date(d.last_seen_at).toLocaleString()}` : "waiting for agent…")}
                  </div>
                </div>
              </Link>
              {/* Members can leave (creator can't — API enforces too) */}
              {d.owner_id !== user.id && <LeaveDriveButton driveId={d.id} driveName={d.name} />}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
