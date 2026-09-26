import Link from "next/link";
import { getUser } from "@/lib/session";
import { listUserDrives } from "@/lib/drives";
import { isOnline } from "@/lib/rpc";
import { HardDrive } from "lucide-react";
import { LeaveDriveButton } from "@/components/leave-drive-button";
import { AddEmailForm } from "@/components/add-email-form";
import { isWalletOnlyEmail, walletDisplayLabel } from "@/shared/wallet-display";
import { GetMacApp } from "@/components/get-mac-app";
import { env } from "@/lib/env";

export default async function Home() {
  const user = await getUser();
  if (!user) {
    return (
      <main className="min-h-screen min-h-[100dvh] flex items-center justify-center px-6">
        <div className="max-w-xl w-full">
          <h1 className="text-4xl font-semibold tracking-tight">aindrive</h1>
          <p className="mt-3 text-drive-muted">
            Your local folder, served like Google Drive. Files stay on your machine — the web UI talks to a CLI agent
            running in your folder over a local WebSocket.
          </p>
          <div className="mt-8 flex gap-3">
            <Link className="rounded-full bg-drive-accent text-white px-5 py-2.5 hover:bg-drive-accentHover" href="/signup">Create account</Link>
            <Link className="rounded-full border border-drive-border px-5 py-2.5 hover:bg-drive-hover" href="/login">Sign in</Link>
          </div>
          <p className="mt-10 text-sm text-drive-muted">
            On a Mac? <a href="/download/mac" className="text-drive-accent hover:underline">Download the aindrive app</a> — share a folder in two clicks, no terminal.
          </p>
          <pre className="mt-3 rounded-xl bg-white border border-drive-border p-4 text-sm overflow-x-auto">
{`# or, from a terminal: install once
npm i -g aindrive

# in any folder
cd ~/Documents
aindrive`}
          </pre>
        </div>
      </main>
    );
  }

  const drives = listUserDrives(user.id);
  return (
    <main className="min-h-screen min-h-[100dvh] max-w-5xl mx-auto px-6 py-10">
      <header className="flex items-center justify-between mb-8">
        <h1 className="text-2xl font-semibold">My drives</h1>
        <div className="flex items-center gap-4">
          {drives.length > 0 && <GetMacApp server={env.publicUrl} compact />}
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
        <GetMacApp server={env.publicUrl} />
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
