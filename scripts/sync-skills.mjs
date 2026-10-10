// Copies the CalMonkey skills into this package (skills/), so `npx calmonkey init` can install
// them without the network. The skills are generated from the documentation and live in
// https://github.com/calmonkey/skills; this folder is a copy and is never edited here.
//
//   node scripts/sync-skills.mjs [path to a checkout of calmonkey/skills]     default ../calmonkey-skills
//   node scripts/sync-skills.mjs --check [path]                               exit 1 when the copy differs
import { cpSync, existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
const check = args.includes("--check");
const from = path.resolve(args.find((a) => !a.startsWith("--")) ?? path.join(root, "..", "calmonkey-skills"), "skills");
const to = path.join(root, "skills");

if (!existsSync(from)) {
  console.error(`No skills folder at ${from}. Pass the path of a checkout of https://github.com/calmonkey/skills.`);
  process.exit(1);
}

const filesOf = (dir, base = dir) =>
  readdirSync(dir)
    .sort()
    .flatMap((entry) => {
      const full = path.join(dir, entry);
      return statSync(full).isDirectory() ? filesOf(full, base) : [path.relative(base, full)];
    });

if (check) {
  const want = filesOf(from);
  const have = existsSync(to) ? filesOf(to) : [];
  const differing = [...new Set([...want, ...have])].filter((f) => !want.includes(f) || !have.includes(f) || !readFileSync(path.join(from, f)).equals(readFileSync(path.join(to, f))));
  if (differing.length) {
    console.error(`skills/ differs from ${from}:\n${differing.map((f) => `  ${f}`).join("\n")}\nRun: npm run skills:sync`);
    process.exit(1);
  }
  console.log(`skills/ matches ${from} (${want.length} files).`);
} else {
  rmSync(to, { recursive: true, force: true });
  cpSync(from, to, { recursive: true });
  console.log(`Copied ${filesOf(to).length} files from ${from} to skills/.`);
}
