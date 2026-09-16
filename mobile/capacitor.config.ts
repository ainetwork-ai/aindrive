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
    CapacitorHttp: { enabled: false },
  },
};

export default config;
