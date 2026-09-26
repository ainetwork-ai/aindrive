// Bundles the Willow server peer (TypeScript, @/ imports) into one ESM file that
// server.js can import: node runs server.js directly, without Next's compiler.
// npm packages and the app's own lib/*.js stay external, so the peer shares their
// single instances (the db handle, the hubs) with the rest of the server.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const web = join(dirname(fileURLToPath(import.meta.url)), "..");

await build({
  entryPoints: [join(web, "lib/willow/server-entry.ts")],
  outfile: join(web, "lib/willow/peer.bundle.mjs"),
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  packages: "external",
  logLevel: "warning",
  tsconfig: join(web, "tsconfig.json"), // resolves the other @/ imports (TypeScript) into the bundle
  plugins: [{
    name: "app-lib-external",
    setup(b) {
      // "@/lib/x.js" → "../x.js" relative to lib/willow/, left for node to load
      b.onResolve({ filter: /^@\/lib\/[^/]+\.js$/ }, (a) => ({ path: `../${a.path.slice("@/lib/".length)}`, external: true }));
      // relative imports of the same files (lib/rpc.ts → "./agents.js") must not bundle a second copy either
      b.onResolve({ filter: /^\.\.?\/.*\.js$/ }, (a) => {
        const abs = join(a.resolveDir, a.path);
        return dirname(abs) === join(web, "lib") ? { path: `../${abs.slice(join(web, "lib").length + 1)}`, external: true } : undefined;
      });
    },
  }],
});
