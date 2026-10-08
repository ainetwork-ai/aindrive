import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import { Toaster } from "sonner";
import "./globals.css";

const display = localFont({
  src: [
    { path: "../fonts/InstrumentSerif-Regular.ttf", weight: "400", style: "normal" },
    { path: "../fonts/InstrumentSerif-Italic.ttf", weight: "400", style: "italic" },
  ],
  variable: "--font-display",
  display: "swap",
  adjustFontFallback: "Times New Roman",
  fallback: ["Georgia", "Times New Roman", "serif"],
});

// Bundled font files keep QA builds independent of Google Fonts availability.
// --font-sans is the head of tailwind fontFamily.sans.
const sans = localFont({
  src: "../fonts/Inter-Variable.ttf",
  weight: "100 900",
  style: "normal",
  variable: "--font-sans",
  display: "swap",
  fallback: ["Arial", "ui-sans-serif", "system-ui", "sans-serif"],
});

export const metadata: Metadata = {
  title: "aindrive — your folder, on the web",
  description: "Self-hosted Google Drive. Run `aindrive` in any local folder and share it like a Drive.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f8fafd" },
    { media: "(prefers-color-scheme: dark)",  color: "#1f1f1f" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // WalletProvider (wagmi + RainbowKit + WalletConnect + MetaMask SDK) is
  // intentionally NOT mounted here — only surfaces that use wallet hooks pull
  // it in: app/s/[token]/layout.tsx (paywall) and app/account/wallet/layout.tsx
  // (add wallet) own it via their layout, and /login code-splits it behind a
  // dynamic import (components/wallet-auth-panel) that loads only when a visitor
  // clicks "Continue with a wallet". This keeps the ~300-600KB web3 bundle (and
  // its Reown config fetch) off the landing page, the email /login form on first
  // paint, other auth pages, and the main drive workspace.
  // Toaster stays at the root: toast() is called app-wide and does not
  // depend on the wallet context.
  return (
    <html lang="en" className={`${display.variable} ${sans.variable}`}>
      <body className="bg-drive-bg text-drive-text font-sans antialiased">
        {children}
        <Toaster position="bottom-right" richColors closeButton />
      </body>
    </html>
  );
}
