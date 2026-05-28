"use client";
import { useEffect, useState } from "react";
import { Lock, ExternalLink, Loader2, ChevronLeft, Download } from "lucide-react";

type FsEntry = { name: string; path: string; isDir: boolean; size: number; mtimeMs: number };
type ReadBody = { content: string; encoding: "utf8" | "base64"; mime: string };

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
  const [file, setFile] = useState<ReadBody | null>(null);
  const [entries, setEntries] = useState<FsEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setFile(null);
    setEntries(null);

    (async () => {
      const listRes = await fetch(`/api/drives/${driveId}/fs/list?path=${encodeURIComponent(currentPath)}`);
      if (!cancelled && listRes.ok) {
        const body = await listRes.json();
        setEntries(body.entries || []);
        setLoading(false);
        return;
      }
      // 400 = path is a file, not a directory — fall through to fs/read.
      // 401/403 = no access; 404 = missing; anything else likely agent-side.
      const readRes = await fetch(`/api/drives/${driveId}/fs/read?path=${encodeURIComponent(currentPath)}`);
      if (!cancelled && readRes.ok) {
        const body: ReadBody = await readRes.json();
        setFile(body);
        setLoading(false);
        return;
      }
      if (cancelled) return;
      const status = readRes.ok ? listRes.status : readRes.status;
      if (status === 401 || status === 403) {
        setError("Permission denied. Your wallet may not have access to this path.");
      } else if (status === 404) {
        setError("File or folder not found.");
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
  const downloadHref = `/api/drives/${driveId}/fs/download?path=${encodeURIComponent(currentPath)}`;

  return (
    <main className="min-h-screen min-h-[100dvh] bg-drive-bg p-4 sm:p-8">
      <div className="max-w-3xl mx-auto">
        <header className="mb-6 pb-4 border-b border-drive-border">
          <div className="flex items-center gap-2 text-sm text-green-700">
            <Lock className="w-4 h-4" /> Permanent access unlocked
          </div>
          <h1 className="mt-2 text-2xl font-semibold break-all">{currentPath || "/"}</h1>
          <p className="mt-1 text-sm text-drive-muted">in drive: {driveName}</p>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            {!atRoot && canGoUp && (
              <button
                onClick={() => setCurrentPath(parentPath || rootPath)}
                className="inline-flex items-center gap-1 text-xs text-drive-accent hover:underline"
              >
                <ChevronLeft className="w-3 h-3" /> Back
              </button>
            )}
            {file && (
              <a
                href={downloadHref}
                className="inline-flex items-center gap-1 text-xs text-drive-accent hover:underline"
              >
                <Download className="w-3 h-3" /> Download
              </a>
            )}
            {txHash && txHash.startsWith("0x") && !txHash.startsWith("0xdev_bypass") && (
              <a
                href={`https://sepolia.basescan.org/tx/${txHash}`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-xs text-drive-accent hover:underline"
              >
                View payment tx <ExternalLink className="w-3 h-3" />
              </a>
            )}
            {txHash?.startsWith("0xdev_bypass") && (
              <span className="inline-block text-xs px-2 py-0.5 rounded bg-amber-100 text-amber-800">
                DEV BYPASS — no on-chain transaction
              </span>
            )}
          </div>
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
          ) : file ? (
            <FileRender file={file} downloadHref={downloadHref} />
          ) : null}
        </article>
      </div>
    </main>
  );
}

function FileRender({ file, downloadHref }: { file: ReadBody; downloadHref: string }) {
  const dataUrl = file.encoding === "base64" ? `data:${file.mime};base64,${file.content}` : null;

  if (file.mime.startsWith("image/") && dataUrl) {
    return (
      <div className="flex items-center justify-center">
        <img src={dataUrl} alt="" className="max-w-full max-h-[80vh] object-contain" />
      </div>
    );
  }
  if (file.mime === "application/pdf" && dataUrl) {
    return (
      <iframe
        src={dataUrl}
        className="w-full h-[80vh] border border-drive-border rounded"
        title="PDF preview"
      />
    );
  }
  if (file.encoding === "utf8") {
    return (
      <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed">{file.content}</pre>
    );
  }
  // Unknown binary: show MIME + size + download link.
  return (
    <div className="text-sm text-drive-muted space-y-2">
      <div>Binary file ({file.mime}) — preview not available in browser.</div>
      <a href={downloadHref} className="inline-flex items-center gap-1 text-drive-accent hover:underline">
        <Download className="w-3 h-3" /> Download to view locally
      </a>
    </div>
  );
}

function prettyBytes(n: number) {
  if (!n) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}
