import type { NextConfig } from "next";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const config: NextConfig = {
  // A person opening a repo's pretty URL (`/<org>/git/<repo>`) in a browser sees the drive folder
  // view *at that URL*; git clients (no `text/html` in Accept, and they always ask for
  // `info/refs?service=…`) still reach the smart-HTTP route untouched. Rewrites run before
  // routing and before middleware's body handling, so pushes are unaffected.
  async rewrites() {
    return {
      beforeFiles: [
        {
          source: "/:slug/git/:repo*",
          has: [{ type: "header", key: "accept", value: "(?<acc>.*text/html.*)" }],
          missing: [{ type: "query", key: "service" }],
          destination: "/d/by-slug/:slug?path=:repo*",
        },
      ],
      afterFiles: [],
      fallback: [],
    };
  },
  output: "standalone",
  outputFileTracingRoot: __dirname,
  reactStrictMode: true,
  experimental: {
    serverActions: { bodySizeLimit: "100mb" },
  },
};

export default config;
