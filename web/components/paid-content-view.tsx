"use client";
import { useEffect, useState } from "react";
import { Lock, ExternalLink, Loader2 } from "lucide-react";

type FsEntry = { name: string; path: string; isDir: boolean; size: number; mtimeMs: number };

export function PaidContentView({
  driveId, driveName, path, txHash,
}: {
  driveId: string;
  driveName: string;
  path: string;
  txHash?: string;
}) {
  const [content, setContent] = useState<string | null>(null);
  const [entries, setEntries] = useState<FsEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const readRes = await fetch(`/api/drives/${driveId}/fs/read?path=${encodeURIComponent(path)}`);
      if (readRes.ok) {
        const body = await readRes.json();
        setContent(body.content ?? "");
        setLoading(false);
        return;
      }
      const listRes = await fetch(`/api/drives/${driveId}/fs/list?path=${encodeURIComponent(path)}`);
      if (listRes.ok) {
        const body = await listRes.json();
        setEntries(body.entries || []);
        setLoading(false);
        return;
      }
      setError("Could not load content. Permission may have lapsed.");
      setLoading(false);
    })();
  }, [driveId, path]);

  return (
    <main className="min-h-screen bg-drive-bg p-8">
      <div className="max-w-3xl mx-auto">
        <header className="mb-6 pb-4 border-b border-drive-border">
          <div className="flex items-center gap-2 text-sm text-green-700">
            <Lock className="w-4 h-4" /> Permanent access unlocked
          </div>
          <h1 className="mt-2 text-2xl font-semibold break-all">{path || "/"}</h1>
          <p className="mt-1 text-sm text-drive-muted">in drive: {driveName}</p>
          {txHash && txHash.startsWith("0x") && !txHash.startsWith("0xdev_bypass") && (
            <a
              href={`https://sepolia.basescan.org/tx/${txHash}`}
              target="_blank"
              rel="noreferrer"
              className="mt-2 inline-flex items-center gap-1 text-xs text-drive-accent hover:underline"
            >
              View payment tx <ExternalLink className="w-3 h-3" />
            </a>
          )}
          {txHash?.startsWith("0xdev_bypass") && (
            <span className="mt-2 inline-block text-xs px-2 py-0.5 rounded bg-amber-100 text-amber-800">
              DEV BYPASS — no on-chain transaction
            </span>
          )}
        </header>

        <article className="bg-white rounded-2xl border border-drive-border p-6 shadow-drive">
          {loading ? (
            <div className="flex items-center gap-2 text-drive-muted">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading…
            </div>
          ) : error ? (
            <div className="text-red-600 text-sm">{error}</div>
          ) : entries ? (
            <ul className="divide-y divide-drive-border">
              {entries.length === 0 && <li className="py-3 text-drive-muted">Empty folder.</li>}
              {entries.map((e) => (
                <li key={e.path} className="py-2 flex items-center gap-3">
                  <span>{e.isDir ? "📁" : "📄"}</span>
                  <span className="flex-1 truncate">{e.name}</span>
                  <span className="text-xs text-drive-muted">{e.isDir ? "—" : prettyBytes(e.size)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed">{content}</pre>
          )}
        </article>
      </div>
    </main>
  );
}

function prettyBytes(n: number) {
  if (!n) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}
