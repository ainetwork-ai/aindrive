import type { NextConfig } from "next";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const config: NextConfig = {
  // GitHub-like repo pages (lib/git-urls.ts): a BROWSER opening `/<org>/git/<repo>[/tree|blob|raw|
  // commits|commit|deployments/…]` is served app/d/by-slug/[slug]/[...rest] *at that URL* — the
  // address bar keeps the pretty form. Git clients keep reaching the smart-HTTP route
  // (app/[slug]/git/[...path]): they never send `text/html` in Accept, and the source pattern
  // itself refuses the three paths they use (`…/info/refs`, `…/git-upload-pack`,
  // `…/git-receive-pack`) and any `?service=` query, so a push or clone is never rewritten even
  // by a client that did say text/html. Mirrored by GIT_PAGE_REWRITE in lib/git-urls.ts (tested).
  async rewrites() {
    return {
      beforeFiles: [
        {
          source: "/:slug/git/:rest((?!.*(?:^|/)(?:info/refs|git-upload-pack|git-receive-pack)$).+)",
          has: [{ type: "header", key: "accept", value: "(?<acc>.*text/html.*)" }],
          missing: [{ type: "query", key: "service" }],
          destination: "/d/by-slug/:slug/:rest",
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
