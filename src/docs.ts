import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { codexNetworkOff } from "./agent.js";
import type { Context } from "./context.js";
import { EXIT, Failure } from "./fail.js";
import { NetworkError, request } from "./http.js";

// The documentation, for `calmonkey docs search` and `docs get`: one file, <site>/llms-full.txt
// (every docs page as Markdown), fetched without a sign-in and kept for a day. Searching is
// done on this machine; nothing about what was searched for leaves it.

export type Section = { id: string; title: string; markdown: string };
export type Page = { name: string; title: string; url: string; intro: string; sections: Section[] };

const DAY_MS = 24 * 3600_000;
const MAX_BYTES = 2 * 1024 * 1024;

const cacheFile = (ctx: Pick<Context, "configDir" | "site">) => path.join(ctx.configDir, "cache", `docs-${createHash("sha256").update(ctx.site).digest("hex").slice(0, 12)}.md`);

export async function loadDocs(ctx: Context, opts: { refresh?: boolean } = {}): Promise<{ pages: Page[]; cached: boolean }> {
  const file = cacheFile(ctx);
  const fresh = existsSync(file) && Date.now() - statSync(file).mtimeMs < DAY_MS;
  if (fresh && !opts.refresh) return { pages: parseDocs(readFileSync(file, "utf8")), cached: true };
  const url = `${ctx.site}/llms-full.txt`;
  try {
    const res = await request(ctx, url, { headers: { Accept: "text/plain, text/markdown" }, redirect: "error" });
    if (res.status !== 200 || !res.text.startsWith("# ") || Buffer.byteLength(res.text) > MAX_BYTES) throw new Failure({ code: "docs_unavailable", message: `${url} answered ${res.status}${res.status === 200 ? " with something that is not the documentation" : ""}`, exit: EXIT.failed });
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, res.text);
    } catch {
      // A sandbox that cannot write the tool's folder (Codex's default): answer anyway, keep nothing.
    }
    return { pages: parseDocs(res.text), cached: false };
  } catch (error) {
    // An older copy is better than none when the network is not there.
    if (existsSync(file)) return { pages: parseDocs(readFileSync(file, "utf8")), cached: true };
    if (error instanceof NetworkError) {
      throw codexNetworkOff(ctx.env)
        ? new Failure({ code: "network_blocked", message: "the Codex sandbox has no network, so the documentation cannot be fetched", exit: EXIT.network, fix: ["ask the person to allow network for this command; the bundled skill has the same pages: .agents/skills/calmonkey-api/references/"] })
        : new Failure({ code: "network", message: error.message.replace(/\.$/, ""), exit: EXIT.network, fix: ["the bundled skill has the same pages offline: calmonkey skill install, then read .agents/skills/calmonkey-api/references/"] });
    }
    throw error;
  }
}

/** llms-full.txt as pages and sections. Headings inside code blocks are not headings. */
export function parseDocs(text: string): Page[] {
  const pages: Page[] = [];
  let page: Page | null = null;
  let section: Section | null = null;
  let pendingId = "";
  let fence = false;
  const lines: string[] = [];
  const flush = () => {
    const body = lines.splice(0).join("\n").trim();
    if (section) section.markdown = body;
    else if (page) page.intro = body;
  };
  for (const line of text.split(/\r?\n/)) {
    if (/^(```|~~~)/.test(line)) fence = !fence;
    if (!fence) {
      const h1 = /^# (.+)$/.exec(line);
      if (h1) {
        flush();
        page = { name: "", title: h1[1]!.trim(), url: "", intro: "", sections: [] };
        section = null;
        pages.push(page);
        continue;
      }
      const anchor = /^<a id="([^"]+)"><\/a>$/.exec(line);
      if (anchor) {
        pendingId = anchor[1]!;
        continue;
      }
      const h2 = /^## (.+)$/.exec(line);
      if (h2 && page) {
        flush();
        section = { id: pendingId || h2[1]!.toLowerCase().replace(/[^a-z0-9]+/g, "-"), title: h2[1]!.trim(), markdown: "" };
        pendingId = "";
        page.sections.push(section);
        continue;
      }
      const source = /^Source: (\S+)$/.exec(line);
      if (source && page) {
        page.url = source[1]!;
        page.name = new URL(source[1]!).pathname.replace(/^\/docs\/?/, "") || "overview";
        continue;
      }
      if (line === "---") continue;
    }
    lines.push(line);
  }
  flush();
  return pages.filter((p) => p.name);
}

export type Hit = { page: Page; section: Section | null; score: number; extract: string };

const words = (query: string): string[] => [...new Set(query.toLowerCase().split(/[^a-z0-9_/.]+/).filter((w) => w.length > 1))];

const count = (haystack: string, needle: string): number => {
  let n = 0;
  for (let at = haystack.indexOf(needle); at !== -1 && n < 20; at = haystack.indexOf(needle, at + needle.length)) n++;
  return n;
};

function extract(markdown: string, terms: string[]): string {
  const lower = markdown.toLowerCase();
  const first = terms.map((t) => lower.indexOf(t)).filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, first - 60);
  const piece = markdown.slice(start, start + 200).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${piece}${start + 200 < markdown.length ? "…" : ""}`;
}

/** The sections that best match the words: a word in a heading counts for more than one in the text, and matching every word doubles the score. */
export function searchDocs(pages: Page[], query: string): Hit[] {
  const terms = words(query);
  if (!terms.length) return [];
  const hits: Hit[] = [];
  for (const page of pages) {
    for (const section of [null, ...page.sections]) {
      const title = `${page.title} ${section?.title ?? ""} ${section?.id ?? ""}`.toLowerCase();
      const body = (section ? section.markdown : page.intro).toLowerCase();
      const matched = terms.filter((t) => title.includes(t) || body.includes(t)).length;
      if (!matched) continue;
      const score = terms.reduce((sum, t) => sum + (title.includes(t) ? 8 : 0) + Math.min(6, count(body, t)), 0) * (matched === terms.length ? 2 : 1);
      hits.push({ page, section, score, extract: extract(section ? section.markdown : page.intro, terms) });
    }
  }
  return hits.sort((a, b) => b.score - a.score);
}
