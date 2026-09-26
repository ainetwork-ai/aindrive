"use client";

import { Laptop, Terminal } from "lucide-react";
import { useEffect, useState } from "react";

/**
 * "Share a folder from your Mac": the Mac app (desktop/) instead of
 * `npm i -g aindrive`. The app opens from `aindrive://share` when installed.
 * The terminal route stays one click away, and is what non-Mac visitors see first.
 */
export function GetMacApp({ server, compact = false }: { server: string; compact?: boolean }) {
  // decided after mount: the server render cannot know the visitor's OS
  const [mac, setMac] = useState(true);
  useEffect(() => {
    setMac(/Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent));
  }, []);
  const open = `aindrive://share?server=${encodeURIComponent(server)}`;

  if (compact) {
    return (
      <a href="/download/mac" className="text-sm text-drive-muted hover:text-drive-accent hover:underline" data-testid="get-mac-app-link">
        Get the Mac app
      </a>
    );
  }

  return (
    <div className="rounded-2xl border border-drive-border bg-white p-8 text-center" data-testid="get-mac-app">
      <p className="text-lg font-medium">Share a folder from your computer</p>
      <p className="mt-1 text-sm text-drive-muted">
        Its files stay on your computer — aindrive shows them here while it runs.
      </p>
      {mac ? (
        <>
          <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
            <a
              href="/download/mac"
              className="inline-flex items-center gap-2 rounded-full bg-drive-accent px-5 py-2.5 font-medium text-white hover:bg-drive-accentHover"
            >
              <Laptop className="h-4 w-4" /> Download for Mac
            </a>
            <a href={open} className="rounded-full border border-drive-border px-5 py-2.5 hover:bg-drive-hover">
              Open the app
            </a>
          </div>
          <p className="mt-3 text-xs text-drive-muted">
            Apple silicon (M1 or later) · <a href="/download/mac?arch=x64" className="underline hover:text-drive-accent">Intel Mac</a>
          </p>
          <ol className="mx-auto mt-6 max-w-sm space-y-1 text-left text-sm text-drive-muted">
            <li>1. Open the downloaded file and drag <b>aindrive</b> to Applications.</li>
            <li>
              2. Open it. The first time, macOS asks to confirm an app from outside the App Store: go to
              System Settings → <b>Privacy &amp; Security</b> → <b>Open Anyway</b>.
            </li>
            <li>3. Click <b>Share a folder…</b>, pick one, and approve in this browser.</li>
          </ol>
        </>
      ) : null}
      <details className={`mx-auto max-w-sm text-left text-sm ${mac ? "mt-6" : "mt-5"}`} open={!mac}>
        <summary className="flex cursor-pointer items-center justify-center gap-1.5 text-drive-muted">
          <Terminal className="h-4 w-4" /> Use the terminal instead
        </summary>
        <pre className="mt-3 overflow-x-auto rounded-xl border border-drive-border bg-drive-hover p-3 text-xs">
{`npm i -g aindrive
cd ~/Documents
aindrive`}
        </pre>
      </details>
    </div>
  );
}
