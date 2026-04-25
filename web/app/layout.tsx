import type { Metadata, Viewport } from "next";
import { Instrument_Serif } from "next/font/google";
import { Toaster } from "sonner";
import { WalletProvider } from "@/components/wallet-provider";
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
  return (
    <html lang="en" className={display.variable}>
      <body className="bg-drive-bg text-drive-text font-sans antialiased">
        <WalletProvider>
          {children}
          <Toaster position="bottom-right" richColors closeButton />
        </WalletProvider>
      </body>
    </html>
  );
}
