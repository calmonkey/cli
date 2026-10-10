import { COMMON, flag, int, on, type Command } from "../command.js";
import { CLI_CODES } from "../data/codes.js";
import { loadDocs, searchDocs } from "../docs.js";
import { EXIT, Failure, nearest, registerCodes } from "../fail.js";
import errors from "../generated/errors.json" with { type: "json" };
import openapi from "../generated/openapi.json" with { type: "json" };
import { agentGuide } from "../guide.js";
import { print, printJson } from "../out.js";

// Finding out: the guide, the docs, the API call behind a command, what an error code means.
// None of it needs a sign-in.

const MEANINGS = errors as Record<string, { on: string; means: string }[]>;
registerCodes([...Object.keys(CLI_CODES), ...Object.keys(MEANINGS)]);

const guideCommand: Command = {
  name: "agent-guide",
  group: "start",
  summary: "The short guide for AI agents: nine rules for using this tool",
  flags: [],
  examples: ["calmonkey agent-guide"],
  async run(input) {
    print(input.ctx, agentGuide(input.ctx.version));
    return EXIT.ok;
  },
};

const docsSearch: Command = {
  name: "docs search",
  group: "learn",
  summary: "Search CalMonkey's documentation; the best sections, each with a short extract. No sign-in needed",
  operation: "the docs' own text, fetched once a day",
  usage: "<words>",
  flags: [COMMON.limit(5, 20), flag.bool("refresh", "fetch the documentation again now"), COMMON.json],
  examples: ['calmonkey docs search "webhook signature"', "calmonkey docs search free busy include_managed"],
  seeAlso: "calmonkey docs get <page>#<section>, calmonkey schema <command>",
  async run(input) {
    const query = input.args.join(" ").trim();
    if (query.length < 2) throw new Failure({ code: "missing_argument", message: "calmonkey docs search needs words to look for", exit: EXIT.usage, fix: ['calmonkey docs search "webhook signature"'] });
    const limit = int(input.flags, "limit", 5, 1, 20, input.spec);
    const { pages } = await loadDocs(input.ctx, { refresh: on(input.flags, "refresh") });
    const hits = searchDocs(pages, query);
    const shown = hits.slice(0, limit);
    const ref = (h: (typeof hits)[number]) => `${h.page.name}${h.section ? `#${h.section.id}` : ""}`;
    if (on(input.flags, "json")) printJson(input.ctx, { results: shown.map((h) => ({ ref: ref(h), page: h.page.title, section: h.section?.title, url: `${h.page.url}${h.section ? `#${h.section.id}` : ""}`, extract: h.extract })), total: hits.length });
    else
      print(
        input.ctx,
        [`docs ${shown.length} of ${hits.length} sections for ${JSON.stringify(query.slice(0, 60))} | read one: calmonkey docs get <ref>`, ...(shown.length ? shown.flatMap((h) => [`${ref(h)}  ${h.page.title}${h.section ? `: ${h.section.title}` : ""}`, `    ${h.extract}`]) : [`nothing found. Pages: ${pages.map((p) => p.name).join(", ")}`]), ...(hits.length > shown.length ? [`${hits.length - shown.length} more: add --limit ${Math.min(20, limit * 2)}`] : [])].join("\n"),
        { explicit: input.flags.limit !== undefined },
      );
    return EXIT.ok;
  },
};

const PAGE_CHARS = 6000;

const docsGet: Command = {
  name: "docs get",
  group: "learn",
  summary: "Read one page of the documentation as Markdown, or one section of it. A long page comes as its introduction and its list of sections",
  usage: "<page>[#section]",
  flags: [flag.bool("full", "the whole page, however long"), flag.bool("refresh", "fetch the documentation again now")],
  examples: ["calmonkey docs get quickstart", "calmonkey docs get api#events-upsert"],
  seeAlso: "calmonkey docs search <words>",
  async run(input) {
    const { pages } = await loadDocs(input.ctx, { refresh: on(input.flags, "refresh") });
    const list = pages.map((p) => p.name).join(", ");
    const [name = "", sectionId] = (input.args[0] ?? "").replace(/^\/?docs\//, "").replace(/\.md$/, "").split("#");
    if (!name) throw new Failure({ code: "missing_argument", message: `calmonkey docs get needs a page: ${list}`, exit: EXIT.usage, fix: ["calmonkey docs get quickstart"] });
    const page = pages.find((p) => p.name === name) ?? pages.find((p) => p.name === nearest(name, pages.map((x) => x.name)));
    if (!page || page.name !== name) throw new Failure({ code: "page_not_found", message: `no docs page ${JSON.stringify(name.slice(0, 40))}. The pages are: ${list}`, exit: EXIT.notFound, fix: [`calmonkey docs get ${page?.name ?? "quickstart"}`] });
    const sections = page.sections.map((s) => `  ${page.name}#${s.id}  ${s.title}`);
    if (sectionId) {
      const section = page.sections.find((s) => s.id === sectionId);
      if (!section) throw new Failure({ code: "section_not_found", message: `${page.name} has no section ${JSON.stringify(sectionId.slice(0, 40))}`, exit: EXIT.notFound, fix: [`calmonkey docs get ${page.name}   (lists its sections)`] });
      print(input.ctx, `## ${section.title}\n\n${section.markdown}\n\nSource: ${page.url}#${section.id}`, { explicit: true, argv: input.argv });
      return EXIT.ok;
    }
    const whole = [`# ${page.title}`, page.intro, ...page.sections.map((s) => `## ${s.title}\n\n${s.markdown}`)].filter(Boolean).join("\n\n");
    if (whole.length <= PAGE_CHARS || on(input.flags, "full")) print(input.ctx, `${whole}\n\nSource: ${page.url}`, { explicit: true, argv: input.argv });
    else print(input.ctx, [`# ${page.title}`, page.intro, `This page is long (${Math.round(whole.length / 1000)}k characters). Read one section: calmonkey docs get <ref>`, ...sections].filter(Boolean).join("\n"));
    return EXIT.ok;
  },
};

// --- schema ---------------------------------------------------------------------------------

type Json = Record<string, unknown>;
type Schema = { type?: string | string[]; description?: string; properties?: Record<string, Schema>; required?: string[]; items?: Schema; enum?: unknown[]; anyOf?: Schema[]; oneOf?: Schema[]; $ref?: string; maxLength?: number; maximum?: number };
type Operation = { operationId: string; summary: string; parameters?: { name: string; in: string; required?: boolean; description?: string; schema?: Schema }[]; requestBody?: { content: Record<string, { schema: Schema }> }; responses: Record<string, unknown>; externalDocs?: { url: string } };

const DOC = openapi as unknown as { paths: Record<string, Record<string, Operation>>; components: { schemas: Record<string, Schema> } };

const deref = (s: Schema | undefined): Schema => (s?.$ref ? (DOC.components.schemas[s.$ref.split("/").pop()!] ?? {}) : (s ?? {}));

function typeOf(raw: Schema): string {
  const s = deref(raw);
  if (s.enum) return s.enum.map(String).join("|");
  const any = s.anyOf ?? s.oneOf;
  if (any) return [...new Set(any.map(typeOf))].join(" or ");
  if (s.type === "array") return `${typeOf(s.items ?? {})}[]`;
  if (s.type === "object" || s.properties) return `{${Object.keys(s.properties ?? {}).join(", ")}}`;
  return Array.isArray(s.type) ? s.type.filter((t) => t !== "null").join("|") : (s.type ?? "any");
}

const short = (text: string | undefined, max = 90) => {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

export function operations(): { id: string; method: string; path: string; op: Operation }[] {
  return Object.entries(DOC.paths).flatMap(([path, methods]) => Object.entries(methods).map(([method, op]) => ({ id: op.operationId, method: method.toUpperCase(), path, op })));
}

/** One API operation in a screenful: its fields with types and what they mean, and its answers. */
export function operationText(id: string, command?: Command): string | null {
  const found = operations().find((o) => o.id === id);
  if (!found) return null;
  const { op, method, path } = found;
  const lines = [`${command ? `calmonkey ${command.name} = ` : ""}${method} ${path} (${op.operationId}): ${op.summary}`];
  const field = (name: string, required: boolean, type: string, description?: string) => `  ${`${name}${required ? "*" : ""}`.padEnd(18)} ${type.length > 44 ? `${type.slice(0, 43)}…` : type}${description ? `  ${short(description)}` : ""}`;
  const params = (op.parameters ?? []).filter((p) => p.in !== "header");
  if (params.length) lines.push("parameters", ...params.map((p) => field(p.name, !!p.required, `${typeOf(p.schema ?? {})} (${p.in})`, p.description)));
  const body = deref(Object.values(op.requestBody?.content ?? {})[0]?.schema);
  if (body.properties) lines.push("body (JSON)", ...Object.entries(body.properties).map(([name, s]) => field(name, !!body.required?.includes(name), typeOf(s), deref(s).description ?? s.description)));
  lines.push(`answers: ${Object.keys(op.responses).join(", ")}${"422" in op.responses ? " (422 names the field and a key: calmonkey explain <key>)" : ""}`);
  lines.push(`* = required. More: calmonkey docs get ${op.externalDocs?.url.replace(/^.*\/docs\//, "") ?? "api"}`);
  return lines.join("\n");
}

let registry: () => Command[] = () => [];
/** Told by cli.ts which commands exist, so `schema` can answer for any of them. */
export const setRegistry = (all: () => Command[]) => void (registry = all);

const schemaCommand: Command = {
  name: "schema",
  group: "learn",
  summary: "The API call behind a command: its fields, types and limits, from the API's own description (OpenAPI). Takes a command or an operation id",
  usage: "<command | operationId>",
  flags: [COMMON.json],
  examples: ["calmonkey schema events put", "calmonkey schema createChannel", "calmonkey schema   (lists every operation)"],
  seeAlso: "calmonkey docs get api, the whole description: https://calmonkey.com/openapi.json",
  async run(input) {
    const name = input.args.join(" ").trim();
    const ops = operations();
    if (!name) {
      const byId = new Map(registry().filter((c) => c.operationId).map((c) => [c.operationId!, c.name]));
      print(input.ctx, ["API operations | calmonkey schema <operationId or command>", ...ops.map((o) => `  ${o.id.padEnd(24)} ${`${o.method} ${o.path}`.padEnd(50)} ${byId.get(o.id) ? `calmonkey ${byId.get(o.id)}` : ""}`.trimEnd())].join("\n"));
      return EXIT.ok;
    }
    const command = registry().find((c) => c.name === name);
    const id = command?.operationId ?? ops.find((o) => o.id.toLowerCase() === name.toLowerCase())?.id;
    if (command && !id) {
      print(input.ctx, `calmonkey ${command.name}: ${command.summary}${command.operation ? ` (${command.operation})` : ""}\nNo single API call corresponds to it. Its flags: calmonkey ${command.name} --help`);
      return EXIT.ok;
    }
    if (!id) {
      const guess = nearest(name, [...ops.map((o) => o.id), ...registry().map((c) => c.name)]);
      throw new Failure({ code: "unknown_operation", message: `no command or API operation ${JSON.stringify(name.slice(0, 40))}`, exit: EXIT.usage, fix: [guess ? `calmonkey schema ${guess}` : "calmonkey schema   (lists them)"] });
    }
    if (on(input.flags, "json")) printJson(input.ctx, ops.find((o) => o.id === id)!.op as unknown as Json);
    else print(input.ctx, operationText(id, command)!);
    return EXIT.ok;
  },
};

const explainCommand: Command = {
  name: "explain",
  group: "learn",
  summary: "What an error code means and how to fix it: this tool's own codes and the API's 422 keys",
  usage: "<code>",
  flags: [],
  examples: ["calmonkey explain invalid_local_time", "calmonkey explain attendees_unsupported"],
  seeAlso: "calmonkey logs requests --errors, calmonkey docs get errors",
  async run(input) {
    const code = (input.args[0] ?? "").replace(/^errors\./, "").toLowerCase();
    const all = [...Object.keys(CLI_CODES), ...Object.keys(MEANINGS)];
    if (!code) {
      print(input.ctx, `codes this tool explains\n  the tool's own: ${Object.keys(CLI_CODES).join(", ")}\n  the API's 422 keys: ${Object.keys(MEANINGS).join(", ")}`);
      return EXIT.ok;
    }
    const own = CLI_CODES[code];
    const api = MEANINGS[code];
    if (!own && !api) {
      const guess = nearest(code, all);
      throw new Failure({ code: "unknown_code", message: `no error code ${JSON.stringify(code.slice(0, 40))}`, exit: EXIT.notFound, fix: [guess ? `calmonkey explain ${guess}` : "calmonkey explain   (lists them)"] });
    }
    print(input.ctx, [...(own ? [`${code}: ${own.means}`, `fix: ${own.fix}`] : []), ...(api ? [`errors.${code} (a 422 key of the API)`, ...api.map((m) => `  on ${m.on}: ${m.means}`), "see the request that got it: calmonkey logs requests --errors"] : [])].join("\n"));
    return EXIT.ok;
  },
};

export const LEARN_COMMANDS: Command[] = [guideCommand, docsSearch, docsGet, schemaCommand, explainCommand];
