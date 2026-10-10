// Bundles the CLI into one file, dist/cli.js, with nothing to install at run time: `npx
// calmonkey` downloads one small package and starts.
import { readFileSync, rmSync, chmodSync } from "node:fs";
import { build } from "esbuild";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
rmSync(new URL("../dist", import.meta.url), { recursive: true, force: true });

await build({
  entryPoints: ["src/bin.ts"],
  outfile: "dist/cli.js",
  bundle: true,
  platform: "node",
  format: "esm",
  // jsonc-parser's ES module build: its UMD one cannot be bundled.
  mainFields: ["module", "main"],
  target: "node20.12",
  banner: { js: "#!/usr/bin/env node" },
  define: { __CLI_VERSION__: JSON.stringify(pkg.version) },
  legalComments: "none",
  logLevel: "info",
});
chmodSync(new URL("../dist/cli.js", import.meta.url), 0o755);
