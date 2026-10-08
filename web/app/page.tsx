import Link from "next/link";
import { redirect } from "next/navigation";
import { getUser } from "@/lib/session";
import { staleSessionCheck } from "@/lib/sso/stale-session";
import { listUserDrives } from "@/lib/drives";
import { listOrgDrivesForUser } from "@/lib/orgs.js";
import { orgSectionState } from "@/lib/org-policy.js";
import { isOnline } from "@/lib/rpc";
import { Building2, Globe, HardDrive, PauseCircle, Share2 } from "lucide-react";
import { LeaveDriveButton } from "@/components/leave-drive-button";
import { AddEmailForm } from "@/components/add-email-form";
import { isWalletOnlyEmail, walletDisplayLabel } from "@/shared/wallet-display";
import { GetMacApp } from "@/components/get-mac-app";
import { env } from "@/lib/env";
import { desktopAppServes } from "@/shared/desktop";

export default async function Home() {
  const user = await getUser();
  if (!user) {
    // A dead session cookie: the automatic AIN sign-in the middleware skipped.
    const check = await staleSessionCheck("/");
    if (check) redirect(check);
    // The web is where you use aindrive — from any browser, nothing to install.
    // Installing is only for putting a folder IN (the Mac app or the terminal
    // agent on the device that holds it), so it comes second.
    return (
      <main className="min-h-screen min-h-[100dvh] flex items-center justify-center px-6 py-12">
        <div className="min-w-0 max-w-xl w-full">
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
              <pre className="mt-2 rounded-xl bg-white border border-drive-border p-4 text-sm whitespace-pre-wrap break-words">
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

  // Organization drives first (docs/PERMISSIONS.md "Organizations"): each
  // organization the person is an active member of, with the drives shared
  // with it — or, by orgSectionState, "paused" (its creator is not an active
  // member now) or an empty state saying who sets one up (one line when the
  // person's own drives follow). Every drive is listed once: a personal drive
  // shared with an organization shows in its section.
  const orgs = listOrgDrivesForUser(user.id);
  const inOrgSection = new Set(orgs.flatMap((o) => o.drives.map((d) => d.id)));
  const drives = listUserDrives(user.id).filter((d) => !inOrgSection.has(d.id));
  const hasAnyDrive = drives.length > 0 || inOrgSection.size > 0;
  const sectionState = (o: (typeof orgs)[number]) =>
    orgSectionState({ drives: o.drives.length, pausedDrives: o.pausedDrives, hasPersonalDrives: drives.length > 0 });
  return (
    <main className="min-h-screen min-h-[100dvh] max-w-5xl mx-auto px-4 sm:px-6 py-10">
      <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 mb-8">
        <h1 className="text-2xl font-semibold">My drives</h1>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          {hasAnyDrive && <GetMacApp server={env.publicUrl} available={desktopAppServes(env.publicUrl)} compact />}
          {!isWalletOnlyEmail(user.email) && (
            <Link href="/account/wallet" className="text-sm text-drive-muted hover:text-drive-accent hover:underline">
              Add wallet sign-in
            </Link>
          )}
          <form action="/api/auth/logout" method="POST">
            <button className="text-sm text-drive-muted hover:text-drive-text">Sign out ({walletDisplayLabel(user.email, user.name)})</button>
          </form>
          <form action="/api/auth/logout?everywhere=1" method="POST">
            <button className="text-sm text-drive-muted hover:text-drive-text" title="Also signs out the CLI, Mac app and phones that use this account">Sign out on all devices</button>
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

      {orgs.map((o) => (
        <section key={`${o.issuer} ${o.orgId}`} className="mb-8" data-testid="org-section" aria-labelledby={`org-${o.orgId}`}>
          <div className="mb-3 flex items-center gap-2">
            <Building2 className="h-5 w-5 shrink-0 text-drive-accent" />
            <h2 id={`org-${o.orgId}`} className="text-lg font-semibold truncate">{o.name}</h2>
            <span className="shrink-0 rounded-full bg-drive-sidebar px-2 py-0.5 text-xs text-drive-muted">Organization</span>
          </div>
          {sectionState(o) === "paused" ? (
            <div className="flex items-start gap-3 rounded-2xl border border-drive-border bg-drive-panel px-5 py-4 text-sm" data-testid="org-paused">
              <PauseCircle className="mt-0.5 h-5 w-5 shrink-0 text-drive-muted" />
              <div className="min-w-0">
                <p className="font-medium text-drive-text">{o.name}’s shared drive is paused</p>
                <p className="mt-1 text-drive-muted">
                  It comes back as soon as the person who shares it is an active {o.name} member again. Ask your {o.name}{" "}
                  admin if it stays paused.
                </p>
              </div>
            </div>
          ) : sectionState(o) === "empty-compact" ? (
            <p className="text-sm text-drive-muted" data-testid="org-empty">
              No {o.name} drive yet — an admin shares one with {o.name}, and it appears here.
            </p>
          ) : sectionState(o) === "empty" ? (
            <div className="rounded-2xl border border-dashed border-drive-border px-5 py-6 text-sm" data-testid="org-empty">
              <p className="font-medium text-drive-text">No {o.name} drive yet</p>
              <p className="mt-1 text-drive-muted">
                Your organization’s shared folders appear here once an admin shares a drive with it. Ask your {o.name} admin
                to set it up.
              </p>
            </div>
          ) : (
            <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {o.drives.map((d) => (
                <li key={d.id}>
                  <DriveCard
                    id={d.id}
                    name={d.name}
                    lastSeenAt={d.last_seen_at}
                    badge={d.owner_id === user.id ? "Owner" : d.org_role === "editor" ? "Editor" : "Viewer"}
                  />
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}

      {orgs.length > 0 && drives.length > 0 && <h2 className="mb-3 text-lg font-semibold">Personal</h2>}
      {drives.length === 0 ? (
        inOrgSection.size > 0 ? null : (
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
        )
      ) : (
        <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {drives.map((d) => (
            <li key={d.id} className="relative group">
              <DriveCard id={d.id} name={d.name} lastSeenAt={d.last_seen_at} />
              {/* Members can leave (creator can't — API enforces too) */}
              {d.owner_id !== user.id && <LeaveDriveButton driveId={d.id} driveName={d.name} />}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

function DriveCard({ id, name, lastSeenAt, badge }: { id: string; name: string; lastSeenAt: string | null; badge?: string }) {
  const online = isOnline(id);
  return (
    <Link
      href={`/d/${id}`}
      className="flex items-start gap-3 rounded-2xl bg-white border border-drive-border p-4 hover:shadow-drive transition"
    >
      <HardDrive className="w-6 h-6 shrink-0 text-drive-accent mt-0.5" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-medium truncate">{name}</span>
          {badge && <span className="shrink-0 rounded-full bg-drive-sidebar px-2 py-0.5 text-xs text-drive-muted">{badge}</span>}
        </div>
        <div className="text-xs text-drive-muted mt-1 flex items-center gap-1.5">
          <span className={`inline-block w-1.5 h-1.5 rounded-full ${online ? "bg-green-500" : "bg-gray-300"}`} />
          {online ? "online" : (lastSeenAt ? `last seen ${new Date(lastSeenAt).toLocaleString()}` : "waiting for agent…")}
        </div>
      </div>
    </Link>
  );
}
