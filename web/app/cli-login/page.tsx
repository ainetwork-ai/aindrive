"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

type State =
  | { kind: "loading" }
  | { kind: "needs-login" }
  | { kind: "ready"; code: string; expiresAt: number }
  | { kind: "error"; message: string };

export default function CliLoginPage() {
  const router = useRouter();
  const [state, setState] = useState<State>({ kind: "loading" });
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetch("/api/auth/cli/issue", { method: "POST" });
      if (cancelled) return;
      if (res.status === 401) {
        setState({ kind: "needs-login" });
        return;
      }
      if (!res.ok) {
        const msg = (await res.json().catch(() => ({}))).error || "could not issue code";
        setState({ kind: "error", message: msg });
        return;
      }
      const { code, expiresInSec } = await res.json();
      setState({ kind: "ready", code, expiresAt: Date.now() + expiresInSec * 1000 });
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (state.kind !== "ready") return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [state.kind]);

  if (state.kind === "needs-login") {
    const next = typeof window !== "undefined" ? window.location.pathname : "/cli-login";
    return (
      <Centered>
        <h1 className="text-xl font-semibold">Sign in to continue</h1>
        <p className="mt-2 text-sm text-drive-muted">
          You need to sign in before you can pair the CLI.
        </p>
        <button
          onClick={() => router.push(`/login?next=${encodeURIComponent(next)}`)}
          className="mt-5 w-full rounded-lg bg-drive-accent text-white py-2 hover:bg-drive-accentHover"
        >
          Sign in
        </button>
        <p className="mt-4 text-sm text-drive-muted text-center">
          New here? <Link className="text-drive-accent hover:underline" href="/signup">Create an account</Link>
        </p>
      </Centered>
    );
  }

  if (state.kind === "loading") {
    return <Centered><p className="text-sm text-drive-muted">Generating code…</p></Centered>;
  }

  if (state.kind === "error") {
    return <Centered><p className="text-sm text-red-600">{state.message}</p></Centered>;
  }

  const remainingMs = Math.max(0, state.expiresAt - now);
  const mins = Math.floor(remainingMs / 60000);
  const secs = Math.floor((remainingMs % 60000) / 1000);

  return (
    <Centered wide>
      <h1 className="text-xl font-semibold">Pair the aindrive CLI</h1>
      <p className="mt-2 text-sm text-drive-muted">
        Paste this code into your terminal to finish <code>aindrive login</code>.
      </p>
      <div className="mt-6 rounded-2xl border border-drive-border bg-drive-surface px-6 py-8 text-center">
        <div className="font-mono text-4xl tracking-widest select-all">{state.code}</div>
        <button
          onClick={async () => {
            await navigator.clipboard.writeText(state.code);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
          className="mt-4 text-sm text-drive-accent hover:underline"
        >
          {copied ? "Copied!" : "Copy to clipboard"}
        </button>
      </div>
      <p className="mt-4 text-xs text-drive-muted text-center">
        {remainingMs > 0
          ? `Expires in ${mins}:${String(secs).padStart(2, "0")}`
          : "Code expired — refresh this page for a new one."}
      </p>
    </Centered>
  );
}

function Centered({ children, wide }: { children: React.ReactNode; wide?: boolean }) {
  return (
    <main className="min-h-screen flex items-center justify-center px-6">
      <div className={`w-full ${wide ? "max-w-md" : "max-w-sm"} bg-white border border-drive-border rounded-2xl p-6 shadow-drive`}>
        {children}
      </div>
    </main>
  );
}
