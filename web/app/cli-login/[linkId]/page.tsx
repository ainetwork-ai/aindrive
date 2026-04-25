"use client";
import Link from "next/link";
import { use, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

type Mode =
  | { kind: "loading" }
  | { kind: "needs-login" }
  | { kind: "ready" }
  | { kind: "approving" }
  | { kind: "approved" }
  | { kind: "error"; message: string };

export default function CliLoginByLinkPage({
  params,
}: {
  params: Promise<{ linkId: string }>;
}) {
  const { linkId } = use(params);
  const router = useRouter();
  const [mode, setMode] = useState<Mode>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const me = await fetch("/api/auth/me", { cache: "no-store" }).catch(() => null);
      if (cancelled) return;
      if (!me || me.status === 401) {
        setMode({ kind: "needs-login" });
        return;
      }
      setMode({ kind: "ready" });
    })();
    return () => { cancelled = true; };
  }, []);

  async function approve() {
    setMode({ kind: "approving" });
    const res = await fetch("/api/auth/cli/approve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ linkId }),
    });
    if (res.ok) {
      setMode({ kind: "approved" });
      return;
    }
    if (res.status === 410) {
      setMode({ kind: "error", message: "this link has expired or already been used" });
      return;
    }
    if (res.status === 401) {
      setMode({ kind: "needs-login" });
      return;
    }
    const msg = (await res.json().catch(() => ({}))).error || "could not approve";
    setMode({ kind: "error", message: msg });
  }

  if (mode.kind === "needs-login") {
    const next = `/cli-login/${linkId}`;
    return (
      <Card>
        <h1 className="text-xl font-semibold">Sign in to authorize</h1>
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
          New here?{" "}
          <Link className="text-drive-accent hover:underline" href={`/signup?next=${encodeURIComponent(next)}`}>
            Create an account
          </Link>
        </p>
      </Card>
    );
  }

  if (mode.kind === "loading") {
    return <Card><p className="text-sm text-drive-muted">Loading…</p></Card>;
  }

  if (mode.kind === "approved") {
    return (
      <Card>
        <h1 className="text-xl font-semibold">CLI authorized ✓</h1>
        <p className="mt-2 text-sm text-drive-muted">
          You can return to your terminal — it should now be signed in.
        </p>
      </Card>
    );
  }

  if (mode.kind === "error") {
    return <Card><p className="text-sm text-red-600">{mode.message}</p></Card>;
  }

  return (
    <Card>
      <h1 className="text-xl font-semibold">Authorize the aindrive CLI</h1>
      <p className="mt-2 text-sm text-drive-muted">
        A terminal on this device is asking to sign in to your aindrive account.
        Approve only if you started <code>aindrive login</code> just now.
      </p>
      <div className="mt-3 text-xs text-drive-muted font-mono break-all">
        link: {linkId}
      </div>
      <button
        disabled={mode.kind === "approving"}
        onClick={approve}
        className="mt-5 w-full rounded-lg bg-drive-accent text-white py-2 hover:bg-drive-accentHover disabled:opacity-60"
      >
        {mode.kind === "approving" ? "Authorizing…" : "Authorize"}
      </button>
      <button
        onClick={() => router.push("/")}
        className="mt-2 w-full rounded-lg border border-drive-border py-2 hover:bg-drive-surface"
      >
        Cancel
      </button>
    </Card>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-screen min-h-[100dvh] flex items-center justify-center px-6">
      <div className="w-full max-w-sm bg-white border border-drive-border rounded-2xl p-6 shadow-drive">
        {children}
      </div>
    </main>
  );
}
