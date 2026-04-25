import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "aindrive — your folder, on the web",
  description: "Self-hosted Google Drive. Run `aindrive` in any local folder and share it like a Drive.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-drive-bg text-drive-text font-sans antialiased">{children}</body>
    </html>
  );
}
