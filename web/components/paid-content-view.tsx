"use client";
import { useEffect, useState } from "react";
import { Lock, ExternalLink, Loader2, ChevronLeft } from "lucide-react";

type FsEntry = { name: string; path: string; isDir: boolean; size: number; mtimeMs: number };

export function PaidContentView({
  driveId, driveName, path, txHash,
}: {
  driveId: string;
  driveName: string;
  path: string;
  txHash?: string;
}) {
  const rootPath = path;
  const [currentPath, setCurrentPath] = useState(path);
  const [content, setContent] = useState<string | null>(null);
  const [entries, setEntries] = useState<FsEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setContent(null);
    setEntries(null);

    (async () => {
      const listRes = await fetch(`/api/drives/${driveId}/fs/list?path=${encodeURIComponent(currentPath)}`);
      if (!cancelled && listRes.ok) {
        const body = await listRes.json();
        setEntries(body.entries || []);
        setLoading(false);
        return;
      }
      const readRes = await fetch(`/api/drives/${driveId}/fs/read?path=${encodeURIComponent(currentPath)}`);
      if (!cancelled && readRes.ok) {
        const body = await readRes.json();
        setContent(body.content ?? "");
        setLoading(false);
        return;
      }
      if (cancelled) return;
      const status = listRes.status;
      if (status === 401 || status === 403) {
        setError("Permission denied. Your wallet may not have access to this path.");
      } else {
        setError("Content unavailable. The seller's agent may be offline.");
      }
      setLoading(false);
    })();

    return () => { cancelled = true; };
  }, [driveId, currentPath]);

  const atRoot = currentPath === rootPath;
  const parentPath = currentPath.includes("/") ? currentPath.slice(0, currentPath.lastIndexOf("/")) : "";
  const canGoUp = !atRoot && (parentPath === rootPath || parentPath.startsWith(rootPath + "/") || rootPath === "");

  return (
    <main className="min-h-screen min-h-[100dvh] bg-drive-bg p-4 sm:p-8">
      <div className="max-w-3xl mx-auto">
        <header className="mb-6 pb-4 border-b border-drive-border">
          <div className="flex items-center gap-2 text-sm text-green-700">
            <Lock className="w-4 h-4" /> Permanent access unlocked
          </div>
          <h1 className="mt-2 text-2xl font-semibold break-all">{currentPath || "/"}</h1>
          <p className="mt-1 text-sm text-drive-muted">in drive: {driveName}</p>
          {!atRoot && canGoUp && (
            <button
              onClick={() => setCurrentPath(parentPath || rootPath)}
              className="mt-2 inline-flex items-center gap-1 text-xs text-drive-accent hover:underline"
            >
              <ChevronLeft className="w-3 h-3" /> Back
            </button>
          )}
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
                <li key={e.path}>
                  <button
                    onClick={() => setCurrentPath(e.path)}
                    className="w-full py-2 flex items-center gap-3 text-left hover:bg-drive-bg/60 rounded px-2 -mx-2"
                  >
                    <span>{e.isDir ? "📁" : "📄"}</span>
                    <span className="flex-1 truncate">{e.name}</span>
                    <span className="text-xs text-drive-muted">{e.isDir ? "—" : prettyBytes(e.size)}</span>
                  </button>
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
