import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "ai.ainetwork.aindrive",
  appName: "aindrive",
  webDir: "dist",
  android: {
    // The drive UI is loaded from the aindrive server in a child WebView;
    // the shell itself is local assets only.
    allowMixedContent: false,
  },
  plugins: {
    // Native HTTP so the shell's fetch() to the aindrive server is not subject
    // to WebView CORS (origin https://localhost; the server sets no CORS headers).
    CapacitorHttp: { enabled: true },
  },
};

export default config;
