import Link from "next/link";
import { getUser } from "@/lib/session";
import { listUserDrives } from "@/lib/drives";
import { isOnline } from "@/lib/rpc";
import { Globe, HardDrive, Share2 } from "lucide-react";
import { LeaveDriveButton } from "@/components/leave-drive-button";
import { AddEmailForm } from "@/components/add-email-form";
import { isWalletOnlyEmail, walletDisplayLabel } from "@/shared/wallet-display";
import { GetMacApp } from "@/components/get-mac-app";
import { env } from "@/lib/env";
import { desktopAppServes } from "@/shared/desktop";

export default async function Home() {
  const user = await getUser();
  if (!user) {
    // The web is where you use aindrive — from any browser, nothing to install.
    // Installing is only for putting a folder IN (the Mac app or the terminal
    // agent on the device that holds it), so it comes second.
    return (
      <main className="min-h-screen min-h-[100dvh] flex items-center justify-center px-6 py-12">
        <div className="max-w-xl w-full">
          <h1 className="text-4xl font-semibold tracking-tight">aindrive</h1>
          <p className="mt-3 text-lg text-drive-text">Your files, in any browser.</p>
          <p className="mt-2 text-drive-muted">
            Open the folders on your computer and phone from anywhere — see them, share them with people, or sell a
            file. Nothing to install to use it: sign in here.
          </p>
          <div className="mt-8 flex gap-3">
            <Link className="rounded-full bg-drive-accent text-white px-5 py-2.5 hover:bg-drive-accentHover" href="/signup">Create account</Link>
            <Link className="rounded-full border border-drive-border px-5 py-2.5 hover:bg-drive-hover" href="/login">Sign in</Link>
          </div>
          <ul className="mt-6 grid gap-2 text-sm text-drive-muted sm:grid-cols-3">
            <li className="flex items-center gap-2"><Globe className="h-4 w-4 shrink-0 text-drive-accent" /> Open from any browser</li>
            <li className="flex items-center gap-2"><Share2 className="h-4 w-4 shrink-0 text-drive-accent" /> Share or sell a file</li>
            <li className="flex items-center gap-2"><HardDrive className="h-4 w-4 shrink-0 text-drive-accent" /> Files stay on your devices</li>
          </ul>

          <section className="mt-12 border-t border-drive-border pt-6">
            <h2 className="text-sm font-medium text-drive-text">Adding a folder is the one thing you install for</h2>
            <p className="mt-1 text-sm text-drive-muted">
              A folder shows up here once the small aindrive agent runs on the device that holds it. Everything else is
              in the browser.
            </p>
            {desktopAppServes(env.publicUrl) && (
              <p className="mt-3 text-sm text-drive-muted">
                On a Mac: <a href="/download/mac" className="text-drive-accent hover:underline">download the aindrive app</a> — share a folder in two clicks, no terminal.
              </p>
            )}
            <details className="mt-3 text-sm">
              <summary className="cursor-pointer text-drive-muted hover:text-drive-text">Or from a terminal</summary>
              <pre className="mt-2 rounded-xl bg-white border border-drive-border p-4 text-sm overflow-x-auto">
{`npm i -g aindrive     # install once
cd ~/Documents
aindrive              # this folder is now in aindrive`}
              </pre>
            </details>
          </section>
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
          {drives.length > 0 && <GetMacApp server={env.publicUrl} available={desktopAppServes(env.publicUrl)} compact />}
          <Link href="/account/devices" className="text-sm text-drive-muted hover:text-drive-accent hover:underline">
            Devices
          </Link>
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
