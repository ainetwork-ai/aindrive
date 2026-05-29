"use client";
import { useCallback, useEffect, useState } from "react";
import { Lock, ExternalLink, Loader2, ChevronLeft, Download, KeyRound } from "lucide-react";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { toast } from "sonner";
import { useWalletLogin } from "./use-wallet-login";

type FsEntry = { name: string; path: string; isDir: boolean; size: number; mtimeMs: number };

/**
 * Wire shape of GET /api/drives/:id/fs/read. Discriminated on `encoding`
 * so render code can branch on the variant rather than re-checking the
 * pair (mime, encoding) at every callsite.
 */
type ReadBody =
  | { content: string; encoding: "utf8"; mime: string }
  | { content: string; encoding: "base64"; mime: string };

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
  const [denied, setDenied] = useState(false); // 401/403 → offer wallet re-link
  const [loading, setLoading] = useState(true);

  const load = useCallback(
    async (signal?: { cancelled: boolean }) => {
      const live = () => !signal?.cancelled;
      setLoading(true);
      setError(null);
      setDenied(false);
      setFile(null);
      setEntries(null);

      const listRes = await fetch(`/api/drives/${driveId}/fs/list?path=${encodeURIComponent(currentPath)}`);
      if (live() && listRes.ok) {
        const body = await listRes.json();
        setEntries(body.entries || []);
        setLoading(false);
        return;
      }
      // Access/missing failure on list → don't probe fs/read (same result).
      if (listRes.status === 401 || listRes.status === 403 || listRes.status === 404) {
        if (!live()) return;
        if (listRes.status === 401 || listRes.status === 403) setDenied(true);
        setError(await extractError(listRes, listRes.status === 404 ? "File or folder not found." : "Your wallet may not have access to this path."));
        setLoading(false);
        return;
      }
      // 400 = path is a file, not a directory — fall through to fs/read.
      const readRes = await fetch(`/api/drives/${driveId}/fs/read?path=${encodeURIComponent(currentPath)}`);
      if (live() && readRes.ok) {
        const body: ReadBody = await readRes.json();
        setFile(body);
        setLoading(false);
        return;
      }
      if (!live()) return;
      const status = readRes.status;
      if (status === 401 || status === 403) {
        setDenied(true);
        setError(await extractError(readRes, "Your wallet may not have access to this path."));
      } else if (status === 404) {
        setError(await extractError(readRes, "File or folder not found."));
      } else {
        setError(await extractError(readRes, "Content unavailable. The seller's agent may be offline."));
      }
      setLoading(false);
    },
    [driveId, currentPath],
  );

  useEffect(() => {
    const signal = { cancelled: false };
    load(signal);
    return () => { signal.cancelled = true; };
  }, [load]);

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
          ) : denied ? (
            <WalletRelink message={error} onLoggedIn={() => load()} />
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

/**
 * Shown when fs/* returns 401/403. The visitor likely paid (or was granted
 * access) on another device/browser, so this device just lacks the
 * `aindrive_wallet` cookie. Let them connect the same wallet and re-prove
 * ownership via SIWE — no second payment. On success we re-run load().
 */
function WalletRelink({ message, onLoggedIn }: { message: string | null; onLoggedIn: () => void }) {
  const { login, busy, isConnected } = useWalletLogin();

  async function handle() {
    const ok = await login();
    if (ok) {
      toast.success("Wallet verified. Restoring access…");
      onLoggedIn();
    } else {
      toast.error("Could not verify wallet");
    }
  }

  return (
    <div className="flex flex-col items-center text-center gap-3 py-6">
      <KeyRound className="w-8 h-8 text-drive-accent" />
      <div className="text-sm font-medium">Access needs your wallet</div>
      <p className="text-xs text-drive-muted max-w-sm">
        {message || "Your wallet may not have access to this path."} If you paid or were granted
        access on another device, connect the same wallet to restore it — no second payment.
      </p>
      <ConnectButton showBalance={false} chainStatus="icon" />
      <button
        onClick={handle}
        disabled={!isConnected || busy}
        className="mt-1 rounded-lg bg-drive-accent text-white px-4 py-2 text-sm hover:bg-drive-accentHover disabled:opacity-50"
      >
        {busy ? "Verifying…" : isConnected ? "Verify this wallet" : "Connect wallet first"}
      </button>
    </div>
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
