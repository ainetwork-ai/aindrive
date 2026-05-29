import type { Metadata, Viewport } from "next";
import { Instrument_Serif } from "next/font/google";
import { Toaster } from "sonner";
import "./globals.css";

const display = Instrument_Serif({
  subsets: ["latin"],
  weight: "400",
  style: ["normal", "italic"],
  variable: "--font-display",
  display: "swap",
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
  // intentionally NOT mounted here — only the /s/[token] share route uses
  // wallet hooks, so it owns the provider via app/s/[token]/layout.tsx. This
  // keeps the ~300-600KB web3 bundle (and its Reown config fetch) off the
  // landing page, auth pages, and the main drive workspace.
  // Toaster stays at the root: toast() is called app-wide and does not
  // depend on the wallet context.
  return (
    <html lang="en" className={display.variable}>
      <body className="bg-drive-bg text-drive-text font-sans antialiased">
        {children}
        <Toaster position="bottom-right" richColors closeButton />
      </body>
    </html>
  );
}
