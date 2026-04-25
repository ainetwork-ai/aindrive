import Link from "next/link";
import { getUser } from "@/lib/session";
import { listUserDrives } from "@/lib/drives";
import { isOnline } from "@/lib/rpc";
import { HardDrive, Terminal } from "lucide-react";

export default async function Home() {
  const user = await getUser();
  if (!user) {
    return (
      <main className="min-h-screen flex items-center justify-center px-6">
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
          <pre className="mt-10 rounded-xl bg-white border border-drive-border p-4 text-sm overflow-x-auto">
{`# install once
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
    <main className="min-h-screen max-w-5xl mx-auto px-6 py-10">
      <header className="flex items-center justify-between mb-8">
        <h1 className="text-2xl font-semibold">My drives</h1>
        <form action="/api/auth/logout" method="POST">
          <button className="text-sm text-drive-muted hover:text-drive-text">Sign out ({user.email})</button>
        </form>
      </header>

      {drives.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-drive-border p-10 text-center bg-white">
          <Terminal className="mx-auto w-10 h-10 text-drive-muted" />
          <p className="mt-3 font-medium">No drives yet</p>
          <p className="text-drive-muted text-sm mt-1">
            Run <code className="px-1.5 py-0.5 bg-drive-hover rounded">aindrive</code> in any folder.
          </p>
        </div>
      ) : (
        <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {drives.map((d) => (
            <li key={d.id}>
              <Link
                href={`/d/${d.id}`}
                className="group flex items-start gap-3 rounded-2xl bg-white border border-drive-border p-4 hover:shadow-drive transition"
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
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
