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
      // If listing already failed for an access/missing reason, don't bother
      // probing fs/read — it'll fail the same way and waste a roundtrip.
      if (listRes.status === 401 || listRes.status === 403 || listRes.status === 404) {
        if (cancelled) return;
        setError(await extractError(listRes, listRes.status === 404 ? "File or folder not found." : "Permission denied. Your wallet may not have access to this path."));
        setLoading(false);
        return;
      }
      // 400 = path is a file, not a directory — fall through to fs/read.
      const readRes = await fetch(`/api/drives/${driveId}/fs/read?path=${encodeURIComponent(currentPath)}`);
      if (!cancelled && readRes.ok) {
        const body: ReadBody = await readRes.json();
        setFile(body);
        setLoading(false);
        return;
      }
      if (cancelled) return;
      const status = readRes.status;
      if (status === 401 || status === 403) {
        setError(await extractError(readRes, "Permission denied. Your wallet may not have access to this path."));
      } else if (status === 404) {
        setError(await extractError(readRes, "File or folder not found."));
      } else {
        setError(await extractError(readRes, "Content unavailable. The seller's agent may be offline."));
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
  // For PDFs we cannot use a data: URL — the CSP middleware ships
  // `frame-src 'self' blob:` (no data:), so the iframe gets blocked. Convert
  // base64 to a blob URL, which the CSP allows. Images go through data: just
  // fine because img-src allows data:.
  const pdf = usePdfBlobUrl(file);
  const imageDataUrl =
    file.mime.startsWith("image/") && file.encoding === "base64"
      ? `data:${file.mime};base64,${file.content}`
      : null;

  if (imageDataUrl) {
    return (
      <div className="flex items-center justify-center">
        <img src={imageDataUrl} alt="" className="max-w-full max-h-[80vh] object-contain" />
      </div>
    );
  }
  if (file.mime === "application/pdf") {
    if (pdf.err) {
      return (
        <div className="text-sm text-drive-muted space-y-2">
          <div className="text-red-600">{pdf.err}</div>
          <a href={downloadHref} className="inline-flex items-center gap-1 text-drive-accent hover:underline">
            <Download className="w-3 h-3" /> Download
          </a>
        </div>
      );
    }
    if (pdf.url) {
      return (
        <iframe
          src={pdf.url}
          className="w-full h-[80vh] border border-drive-border rounded"
          title="PDF preview"
        />
      );
    }
    // PDF but blob URL not ready yet — usePdfBlobUrl effect is still running.
    return <div className="text-drive-muted text-sm">Preparing PDF preview…</div>;
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

function usePdfBlobUrl(file: ReadBody): { url: string | null; err: string | null } {
  const [state, setState] = useState<{ url: string | null; err: string | null }>({ url: null, err: null });
  useEffect(() => {
    if (file.mime !== "application/pdf" || file.encoding !== "base64") {
      setState({ url: null, err: null });
      return;
    }
    try {
      const bin = atob(file.content);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const blob = new Blob([bytes], { type: "application/pdf" });
      const objUrl = URL.createObjectURL(blob);
      setState({ url: objUrl, err: null });
      return () => { URL.revokeObjectURL(objUrl); };
    } catch (e) {
      console.error("usePdfBlobUrl: failed to decode base64 PDF", e);
      setState({ url: null, err: "PDF preview failed to load. Try downloading instead." });
    }
  }, [file.mime, file.encoding, file.content]);
  return state;
}

/**
 * Pull `{ error: "..." }` from a non-OK Response body, fall back to the
 * caller-supplied default. Console-logs the raw response for dev debugging
 * regardless. Prevents the "Content unavailable" generic message from
 * hiding more useful backend codes like "file too large" or "invalid path".
 */
async function extractError(res: Response, fallback: string): Promise<string> {
  try {
    const body = await res.json().catch(() => null) as { error?: string } | null;
    if (body && typeof body.error === "string" && body.error.length > 0) {
      console.error(`PaidContentView: ${res.status} ${body.error}`);
      return body.error;
    }
  } catch (e) {
    console.error("PaidContentView: failed to parse error body", e);
  }
  console.error(`PaidContentView: ${res.status} (no error body)`);
  return fallback;
}

function prettyBytes(n: number) {
  if (!n) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}
