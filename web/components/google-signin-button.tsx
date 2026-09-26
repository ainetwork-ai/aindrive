"use client";
/**
 * "Continue with Google" on the web — the same sign-in the mobile app does
 * natively (Credential Manager), done with Google Identity Services here:
 * Google's own button hands back an ID token, which POST /api/auth/google
 * verifies and turns into a session (lib/google-auth).
 *
 * Renders nothing when the server has no Google client configured
 * (GET /api/auth/google → 404) or Google's script can't load — the email and
 * wallet paths stay as they are. The web OAuth client must list this site's
 * origin under "Authorized JavaScript origins" in Google Cloud.
 */
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

type Gis = {
  accounts: {
    id: {
      initialize(opts: {
        client_id: string;
        callback: (r: { credential?: string }) => void;
        ux_mode?: "popup" | "redirect";
        auto_select?: boolean;
        itp_support?: boolean;
        use_fedcm_for_button?: boolean;
      }): void;
      renderButton(el: HTMLElement, opts: Record<string, unknown>): void;
    };
  };
};
declare global {
  interface Window {
    google?: Gis;
  }
}

const GIS_SRC = "https://accounts.google.com/gsi/client";
let gisLoad: Promise<Gis> | null = null;

function loadGis(): Promise<Gis> {
  if (window.google?.accounts?.id) return Promise.resolve(window.google);
  gisLoad ??= new Promise<Gis>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = GIS_SRC;
    s.async = true;
    s.onload = () => (window.google?.accounts?.id ? resolve(window.google) : reject(new Error("gis_missing")));
    s.onerror = () => {
      gisLoad = null;
      reject(new Error("gis_load_failed"));
    };
    document.head.appendChild(s);
  });
  return gisLoad;
}

const ERRORS: Record<string, string> = {
  email_not_verified: "Your Google account's email isn't verified yet.",
  no_email: "Google didn't share an email address for this account.",
  rate_limited: "Too many attempts — try again in a minute.",
};

export default function GoogleSignInButton({ next, text = "continue_with" }: { next: string; text?: "continue_with" | "signup_with" | "signin_with" }) {
  const router = useRouter();
  const slot = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      const res = await fetch("/api/auth/google").catch(() => null);
      if (!res?.ok) return; // not configured here
      const { clientId } = (await res.json()) as { clientId?: string };
      if (!clientId || !alive) return;
      const gis = await loadGis().catch(() => null);
      if (!gis || !alive || !slot.current) return;
      gis.accounts.id.initialize({
        client_id: clientId,
        ux_mode: "popup",
        auto_select: false,
        itp_support: true,
        use_fedcm_for_button: true,
        callback: async ({ credential }) => {
          if (!credential) return;
          setBusy(true);
          setErr(null);
          const r = await fetch("/api/auth/google", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ idToken: credential }),
          }).catch(() => null);
          if (!r?.ok) {
            const body = (await r?.json().catch(() => ({}))) as { error?: string } | undefined;
            setBusy(false);
            setErr(ERRORS[body?.error ?? ""] ?? "Google sign-in failed. Try again or use email.");
            return;
          }
          router.push(next);
          router.refresh();
        },
      });
      // Google draws its own branded button; width follows the card (max 400)
      const width = Math.min(400, Math.round(slot.current.getBoundingClientRect().width || 320));
      gis.accounts.id.renderButton(slot.current, { type: "standard", theme: "outline", size: "large", shape: "rectangular", text, logo_alignment: "center", width });
      setReady(true);
    })();
    return () => {
      alive = false;
    };
  }, [next, router, text]);

  return (
    <div data-testid="google-signin" hidden={!ready} className="mt-4">
      <div ref={slot} className={`flex w-full justify-center ${busy ? "pointer-events-none opacity-60" : ""}`} />
      {err && <p className="mt-2 text-center text-sm text-red-600">{err}</p>}
    </div>
  );
}
