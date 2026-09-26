"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import {
  Bot,
  Check,
  Copy,
  Globe,
  HardDrive,
  Laptop,
  Lock,
  Share2,
  Smartphone,
  Terminal,
  Users,
} from "lucide-react";

/**
 * The signed-out home: what aindrive is, then the four ways in — Web, Mac,
 * Android, Terminal — as tabs (#web / #mac / #android / #terminal deep-link).
 * The web is where you *use* aindrive; the other three are how a folder gets
 * *into* it, from the device that holds it.
 */

type SurfaceId = "web" | "mac" | "android" | "terminal";
const SURFACE_IDS: SurfaceId[] = ["web", "mac", "android", "terminal"];

const display = { fontFamily: "var(--font-display), Georgia, serif" };

function CopyCommand({ command, label }: { command: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-3 rounded-xl bg-[#0f1319] px-4 py-3 font-mono text-sm text-white">
      <span className="select-none text-white/40">$</span>
      <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap">{command}</code>
      <button
        type="button"
        aria-label={label ?? "Copy command"}
        onClick={() => {
          void navigator.clipboard?.writeText(command).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
        className="shrink-0 rounded-md p-1 text-white/60 hover:bg-white/10 hover:text-white"
      >
        {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
      </button>
    </div>
  );
}

function Steps({ items }: { items: ReactNode[] }) {
  return (
    <ol className="space-y-3">
      {items.map((item, i) => (
        <li key={i} className="flex gap-3 text-sm text-drive-text">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-drive-selected text-xs font-semibold text-drive-accent">
            {i + 1}
          </span>
          <span className="pt-0.5">{item}</span>
        </li>
      ))}
    </ol>
  );
}

function Bullets({ items }: { items: string[] }) {
  return (
    <ul className="mt-5 space-y-2">
      {items.map((item) => (
        <li key={item} className="flex gap-2 text-sm text-drive-muted">
          <Check className="mt-0.5 h-4 w-4 shrink-0 text-drive-accent" />
          {item}
        </li>
      ))}
    </ul>
  );
}

interface Surface {
  id: SurfaceId;
  label: string;
  icon: typeof Globe;
  title: string;
  body: string;
  bullets: string[];
  action: ReactNode;
  side: ReactNode;
}

function surfaces(macAvailable: boolean): Surface[] {
  const primary = "inline-flex items-center gap-2 rounded-full bg-drive-accent px-5 py-2.5 text-sm font-medium text-white hover:bg-drive-accentHover";
  return [
    {
      id: "web",
      label: "Web",
      icon: Globe,
      title: "Use aindrive from any browser",
      body: "Nothing to install. Sign in, and every folder shared from your devices, or shared with you, is here: open it, preview it, edit it with others, share a link, or sell a file.",
      bullets: [
        "Previews for photos, video, PDF, PSD, fonts and more",
        "Edit text and code together in real time, people and AI agents alike",
        "Share links by role, or put a price on a file or folder and get paid in USDC (x402)",
        "Sign in with email or a wallet",
      ],
      action: (
        <div className="flex flex-wrap gap-3">
          <Link href="/signup" className={primary}>
            Create account
          </Link>
          <Link href="/login" className="rounded-full border border-drive-border px-5 py-2.5 text-sm hover:bg-drive-hover">
            Sign in
          </Link>
        </div>
      ),
      side: (
        <Steps
          items={[
            <>Create an account, or sign in with your wallet.</>,
            <>Add a folder from your Mac, phone or terminal. It shows up under <b>My drives</b>.</>,
            <>Open it from anywhere. The files stay on your device, and the browser reaches them through it.</>,
          ]}
        />
      ),
    },
    {
      id: "mac",
      label: "Mac",
      icon: Laptop,
      title: "aindrive for Mac",
      body: "Share folders on your Mac without a terminal. It is the same app as on your phone: your folders, the file browser, sharing and agents, with the Mac serving the files.",
      bullets: [
        "Pick a folder and it becomes a drive, with no commands",
        "Opens at login and keeps your folders served",
        "Files never leave the Mac; nothing opens an inbound port",
      ],
      action: macAvailable ? (
        <div className="flex flex-wrap items-center gap-3">
          <a href="/download/mac" className={primary}>
            <Laptop className="h-4 w-4" /> Download for Mac
          </a>
          <span className="text-xs text-drive-muted">
            Apple silicon ·{" "}
            <a href="/download/mac?arch=x64" className="underline hover:text-drive-accent">
              Intel Mac
            </a>
          </span>
        </div>
      ) : (
        <p className="text-sm text-drive-muted">
          The Mac app pairs with aindrive.ainetwork.ai. On this server, use the terminal.
        </p>
      ),
      side: (
        <Steps
          items={[
            <>Open the downloaded file and drag <b>aindrive</b> to Applications.</>,
            <>
              The first time, macOS asks about an app from outside the App Store: System Settings →{" "}
              <b>Privacy &amp; Security</b> → <b>Open Anyway</b>.
            </>,
            <><b>Sign in with your browser</b>, approve, then <b>Choose a folder</b>.</>,
          ]}
        />
      ),
    },
    {
      id: "android",
      label: "Android",
      icon: Smartphone,
      title: "Your phone, as a drive",
      body: "The Android app serves folders on your phone, like your photos, as drives you can open from any browser. The phone is the server, and the files stay on it.",
      bullets: [
        "Share several folders, one drive each",
        "Ask about your photos: an on-device agent finds them by place and date, offline",
        "Share a folder straight into a connected app",
      ],
      action: (
        <span className="inline-flex items-center gap-2 rounded-full border border-dashed border-drive-border px-5 py-2.5 text-sm text-drive-muted">
          <Smartphone className="h-4 w-4" /> Coming soon to Google Play
        </span>
      ),
      side: (
        <Steps
          items={[
            <>Install aindrive from Google Play (coming soon).</>,
            <>Sign in and choose the folders to share.</>,
            <>Open them here, from any browser. Keep the app running to stay reachable.</>,
          ]}
        />
      ),
    },
    {
      id: "terminal",
      label: "Terminal",
      icon: Terminal,
      title: "Any folder, one command",
      body: "The aindrive agent runs in any folder on a Mac or Linux machine. That folder becomes a drive in your account, and the same CLI plugs your drives into Claude Code, Claude Desktop, Cursor or any MCP client.",
      bullets: [
        "Node.js 20+; installs from npm",
        "Connects out over a WebSocket, so no port opens on your machine",
        "aindrive mcp gives AI assistants every drive operation",
      ],
      action: (
        <Link href="/docs/mcp" className="text-sm font-medium text-drive-accent hover:underline">
          Read the MCP docs →
        </Link>
      ),
      side: (
        <div className="space-y-3">
          <p className="text-xs font-medium uppercase tracking-wide text-drive-muted">Install once</p>
          <CopyCommand command="npm i -g aindrive" />
          <p className="pt-2 text-xs font-medium uppercase tracking-wide text-drive-muted">Inside the folder to share</p>
          <CopyCommand command="aindrive" />
          <p className="pt-2 text-xs font-medium uppercase tracking-wide text-drive-muted">For AI assistants (MCP)</p>
          <CopyCommand command="aindrive mcp" />
        </div>
      ),
    },
  ];
}

const FEATURES = [
  { icon: HardDrive, title: "Files stay on your devices", body: "aindrive stores nothing. The browser reaches your files through the agent on the device that holds them." },
  { icon: Share2, title: "Share, or sell", body: "Links by role and path. Put a price on a file or folder; buyers pay in USDC with x402 and get in." },
  { icon: Users, title: "Work on it together", body: "Several people and agents edit the same document at once, merged character by character." },
  { icon: Bot, title: "Agents are members too", body: "AI agents read and act on a drive over MCP and A2A, with the same permissions as a person." },
];

export function Landing({ macAvailable }: { macAvailable: boolean }) {
  const all = surfaces(macAvailable);
  const [tab, setTab] = useState<SurfaceId>("web");
  useEffect(() => {
    const follow = () => {
      const fromHash = window.location.hash.slice(1) as SurfaceId;
      if (SURFACE_IDS.includes(fromHash)) setTab(fromHash);
    };
    follow();
    window.addEventListener("hashchange", follow);
    return () => window.removeEventListener("hashchange", follow);
  }, []);
  const active = all.find((s) => s.id === tab)!;

  return (
    <div className="min-h-screen min-h-[100dvh] bg-drive-bg text-drive-text">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-4 py-5 sm:px-6">
        <Link href="/" className="flex items-center gap-2 text-lg font-semibold tracking-tight">
          <HardDrive className="h-5 w-5 text-drive-accent" /> aindrive
        </Link>
        <nav className="flex items-center gap-1 text-sm sm:gap-3">
          <Link href="/docs" className="hidden rounded-full px-3 py-1.5 text-drive-muted hover:text-drive-text sm:inline">
            Docs
          </Link>
          <Link href="/login" className="rounded-full px-3 py-1.5 text-drive-muted hover:text-drive-text">
            Sign in
          </Link>
          <Link href="/signup" className="rounded-full bg-drive-accent px-4 py-1.5 font-medium text-white hover:bg-drive-accentHover">
            Get started
          </Link>
        </nav>
      </header>

      <main>
        {/* hero */}
        <section className="mx-auto max-w-4xl px-4 pb-16 pt-12 text-center sm:px-6 sm:pt-20">
          <h1 className="text-5xl leading-[1.05] tracking-tight sm:text-7xl" style={display}>
            Your folders, <i>on the web</i>
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-lg text-drive-muted">
            aindrive turns a folder on your Mac, phone or server into a drive you open from any browser. Share it, sell
            it, and let AI agents work in it, while the files stay on your device.
          </p>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <Link href="/signup" className="rounded-full bg-drive-accent px-6 py-3 font-medium text-white hover:bg-drive-accentHover">
              Get started free
            </Link>
            <a href="#ways" className="rounded-full border border-drive-border bg-drive-panel px-6 py-3 font-medium hover:bg-drive-hover">
              Ways to use it
            </a>
          </div>
          <div className="mx-auto mt-10 max-w-md text-left">
            <CopyCommand command="npm i -g aindrive" />
          </div>
        </section>

        {/* the four ways in */}
        <section id="ways" className="scroll-mt-6 bg-drive-panel py-16 sm:py-20">
          <div className="mx-auto max-w-6xl px-4 sm:px-6">
            <h2 className="text-center text-4xl tracking-tight sm:text-5xl" style={display}>
              Use aindrive wherever you are
            </h2>
            <p className="mx-auto mt-4 max-w-xl text-center text-drive-muted">
              Use it on the web. Add folders from your Mac, your Android phone or a terminal.
            </p>

            <div role="tablist" aria-label="Ways to use aindrive" className="mx-auto mt-10 grid max-w-2xl grid-cols-4 gap-1 rounded-full bg-drive-sidebar p-1">
              {all.map((s) => (
                <button
                  key={s.id}
                  role="tab"
                  id={`tab-${s.id}`}
                  aria-selected={tab === s.id}
                  aria-controls={`panel-${s.id}`}
                  onClick={() => {
                    setTab(s.id);
                    history.replaceState(null, "", `#${s.id}`);
                  }}
                  className={`flex items-center justify-center gap-1.5 rounded-full px-2 py-2 text-sm font-medium transition ${
                    tab === s.id ? "bg-drive-panel text-drive-text shadow-e2" : "text-drive-muted hover:text-drive-text"
                  }`}
                >
                  <s.icon className="hidden h-4 w-4 sm:block" /> {s.label}
                </button>
              ))}
            </div>

            <div
              role="tabpanel"
              id={`panel-${active.id}`}
              aria-labelledby={`tab-${active.id}`}
              data-testid={`surface-${active.id}`}
              className="mt-10 grid gap-8 rounded-2xl border border-drive-border bg-drive-bg/60 p-6 sm:p-10 md:grid-cols-2 md:gap-12"
            >
              <div className="min-w-0">
                <active.icon className="h-8 w-8 text-drive-accent" />
                <h3 className="mt-4 text-3xl tracking-tight" style={display}>
                  {active.title}
                </h3>
                <p className="mt-3 text-drive-muted">{active.body}</p>
                <Bullets items={active.bullets} />
                <div className="mt-8">{active.action}</div>
              </div>
              <div className="min-w-0 rounded-xl bg-drive-panel p-5 shadow-e2 sm:p-6">{active.side}</div>
            </div>
          </div>
        </section>

        {/* how it works */}
        <section className="mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-20">
          <h2 className="text-center text-4xl tracking-tight sm:text-5xl" style={display}>
            How it works
          </h2>
          <div className="mt-10 grid gap-4 md:grid-cols-3">
            {[
              { n: "1", title: "A folder, on its device", body: "The aindrive agent (Mac app, Android app or CLI) runs next to the folder you choose." },
              { n: "2", title: "An outbound connection", body: "The agent dials out to aindrive over a WebSocket and signs every reply. Nothing listens on your machine." },
              { n: "3", title: "Open it anywhere", body: "You, the people you share with, and your agents open it at aindrive.ainetwork.ai." },
            ].map((s) => (
              <div key={s.n} className="rounded-2xl bg-drive-panel p-6 shadow-e1">
                <span className="text-4xl text-drive-accent" style={display}>
                  {s.n}
                </span>
                <h3 className="mt-3 font-semibold">{s.title}</h3>
                <p className="mt-2 text-sm text-drive-muted">{s.body}</p>
              </div>
            ))}
          </div>
        </section>

        {/* what you can do */}
        <section className="bg-drive-panel py-16 sm:py-20">
          <div className="mx-auto grid max-w-6xl gap-8 px-4 sm:grid-cols-2 sm:px-6 lg:grid-cols-4">
            {FEATURES.map((f) => (
              <div key={f.title}>
                <f.icon className="h-6 w-6 text-drive-accent" />
                <h3 className="mt-3 font-semibold">{f.title}</h3>
                <p className="mt-2 text-sm text-drive-muted">{f.body}</p>
              </div>
            ))}
          </div>
        </section>

        {/* closing call */}
        <section className="mx-auto max-w-3xl px-4 py-20 text-center sm:px-6">
          <Lock className="mx-auto h-7 w-7 text-drive-accent" />
          <h2 className="mt-4 text-4xl tracking-tight sm:text-5xl" style={display}>
            Your files stay yours
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-drive-muted">Start on the web, then add your first folder from whichever device holds it.</p>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <Link href="/signup" className="rounded-full bg-drive-accent px-6 py-3 font-medium text-white hover:bg-drive-accentHover">
              Create account
            </Link>
            <Link href="/login" className="rounded-full border border-drive-border bg-drive-panel px-6 py-3 font-medium hover:bg-drive-hover">
              Sign in
            </Link>
          </div>
        </section>
      </main>

      <footer className="border-t border-drive-border py-8 text-center text-xs text-drive-muted">
        aindrive · <Link href="/docs" className="hover:underline">Docs</Link> ·{" "}
        <a href="https://github.com/ainetwork-ai/aindrive" className="hover:underline">GitHub</a>
      </footer>
    </div>
  );
}
