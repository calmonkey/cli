// Writes docs/reference.json: the tool described by itself (src/reference.ts), which the docs
// site's /docs/cli page and the skill's reference file are made from.
//
//   node scripts/reference.mjs            writes docs/reference.json
//   node scripts/reference.mjs --check    exit 1 when the file is not what the code says
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = new URL("../", import.meta.url);
const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
const tmp = mkdtempSync(path.join(os.tmpdir(), "calmonkey-reference-"));
const outfile = path.join(tmp, "reference.mjs");
await build({ entryPoints: [new URL("src/reference.ts", root).pathname], outfile, bundle: true, platform: "node", format: "esm", mainFields: ["module", "main"], logLevel: "silent" });
const { buildReference } = await import(pathToFileURL(outfile).href);
const text = `${JSON.stringify(buildReference(pkg.version), null, 1)}\n`;
rmSync(tmp, { recursive: true, force: true });

const file = new URL("docs/reference.json", root);
if (process.argv.includes("--check")) {
  if (!existsSync(file) || readFileSync(file, "utf8") !== text) {
    console.error("docs/reference.json is not what the code says. Run: npm run reference");
    process.exit(1);
  }
  console.log("docs/reference.json matches the code.");
} else {
  writeFileSync(file, text);
  console.log(`Wrote docs/reference.json (${Math.round(text.length / 1024)} KB).`);
}
