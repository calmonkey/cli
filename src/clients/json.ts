import { isDeepStrictEqual } from "node:util";
import { findNodeAtLocation, parse, parseTree, type Node, type ParseError } from "jsonc-parser";

// Adding one entry to a JSON settings file that belongs to someone else's program and to the
// person who edited it. The file is changed as text: one property is inserted, in the file's
// own indentation, and not one existing character is rewritten or moved. Comments, order,
// trailing commas and line endings stay exactly as they were. (jsonc-parser reads the file;
// its own editing re-formats neighbouring lines, so the insertion is done here.)
//
// The result is parsed again and compared with what was meant; if it is not exactly the old
// content plus the entry, the file is reported as one this tool cannot edit and is left alone.

export type JsonEdit =
  /** Nothing to do: the entry is there and points at the same address. */
  | { status: "unchanged"; content: string }
  /** The file does not exist or has no such entry: `content` is the file with the entry added. */
  | { status: "create" | "update"; content: string }
  /** An entry with this name exists and points somewhere else. It is the person's: left alone. */
  | { status: "conflict"; content: string; reason: string }
  /** The file is not JSON we can add to safely. Left alone. */
  | { status: "invalid"; content: string; reason: string };

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const PARSE = { allowTrailingComma: true, disallowComments: false } as const;

/** One level of indentation as the file writes it. */
function indentUnit(text: string): string {
  const indent = /^([ \t]+)\S/m.exec(text)?.[1];
  if (!indent) return "  ";
  return indent.includes("\t") ? "\t" : indent;
}

const lineStart = (text: string, offset: number) => text.lastIndexOf("\n", offset - 1) + 1;
const indentAt = (text: string, offset: number) => /^[ \t]*/.exec(text.slice(lineStart(text, offset)))![0];

/** A value as text over several lines, its inner lines indented from `indent`. */
const pretty = (value: unknown, indent: string, unit: string, eol: string) => JSON.stringify(value, null, unit).split("\n").join(`${eol}${indent}`);
/** A value as text on one line, with a space inside braces as people write it. */
const inline = (value: unknown): string => (isObject(value) ? `{ ${Object.entries(value).map(([k, v]) => `${JSON.stringify(k)}: ${inline(v)}`).join(", ")} }` : JSON.stringify(value));

/**
 * `text` with the property `key: value` added to the object at `node`. Only insertions: after
 * the object's last property (with a comma where one is missing), or inside its empty braces.
 */
function insertProperty(text: string, node: Node, key: string, value: unknown, unit: string, eol: string): string {
  const props = node.children ?? [];
  const close = node.offset + node.length - 1;
  if (!props.length) {
    const inner = text.slice(node.offset + 1, close);
    const closeIndent = indentAt(text, node.offset);
    const childIndent = closeIndent + unit;
    const entry = `${childIndent}${JSON.stringify(key)}: ${pretty(value, childIndent, unit, eol)}`;
    // Nothing between the braces: they are opened up. Comments between them: the entry goes before the closing brace.
    if (!inner.trim()) return `${text.slice(0, node.offset + 1)}${eol}${entry}${eol}${closeIndent}${text.slice(close)}`;
    const braceLine = lineStart(text, close);
    if (!text.slice(braceLine, close).trim()) return `${text.slice(0, braceLine)}${entry}${eol}${text.slice(braceLine)}`;
    return `${text.slice(0, close)}${eol}${entry}${eol}${closeIndent}${text.slice(close)}`;
  }
  const last = props[props.length - 1]!;
  const end = last.offset + last.length;
  // What follows the last property on its own line: perhaps a comma, perhaps a comment.
  const rest = /^([ \t]*)(,?)([ \t]*(?:\/\/[^\r\n]*|\/\*(?:[^*\r\n]|\*(?!\/))*\*\/[ \t]*)?)(\r?\n|$)/.exec(text.slice(end));
  if (!rest) {
    // More JSON follows on the same line (an object written on one line): the entry joins that line.
    const comma = /^[ \t]*,/.test(text.slice(end)) ? "" : ",";
    return `${text.slice(0, end)}${comma} ${JSON.stringify(key)}: ${inline(value)}${text.slice(end)}`;
  }
  const hadComma = rest[2] === ",";
  const childIndent = indentAt(text, last.offset);
  const lineEnd = end + rest[1]!.length + rest[2]!.length + rest[3]!.length;
  // A file that ends its lists with a comma gets one after the new entry too.
  const entry = `${eol}${childIndent}${JSON.stringify(key)}: ${pretty(value, childIndent, unit, eol)}${hadComma ? "," : ""}`;
  return `${text.slice(0, end)}${hadComma ? "" : ","}${text.slice(end, lineEnd)}${entry}${text.slice(lineEnd)}`;
}

/**
 * Sets `<container>.<name>` to `entry` in a JSON (or JSON-with-comments) document.
 * `urlKeys` are the properties that hold the server's address in this client's format: an
 * existing entry whose address is `url` already is "unchanged", whatever else the person added
 * to it; an existing entry with another address is a conflict and is not touched.
 */
export function upsertJsonEntry(current: string | null, container: string, name: string, entry: Record<string, unknown>, url: string, urlKeys: string[]): JsonEdit {
  const text = current ?? "";
  if (!text.trim()) {
    return { status: current === null ? "create" : "update", content: `${JSON.stringify({ [container]: { [name]: entry } }, null, 2)}\n` };
  }
  const errors: ParseError[] = [];
  const root: unknown = parse(text, errors, PARSE);
  if (errors.length) return { status: "invalid", content: text, reason: "it is not valid JSON" };
  if (!isObject(root)) return { status: "invalid", content: text, reason: "its top level is not an object" };
  const holder = root[container];
  if (holder !== undefined && !isObject(holder)) return { status: "invalid", content: text, reason: `"${container}" is not an object` };
  const existing = holder?.[name];
  if (existing !== undefined) {
    if (!isObject(existing)) return { status: "conflict", content: text, reason: `"${container}.${name}" is already set to something else` };
    const address = urlKeys.map((k) => existing[k]).find((v) => typeof v === "string");
    if (address === url) return { status: "unchanged", content: text };
    return { status: "conflict", content: text, reason: `"${container}.${name}" already points at ${typeof address === "string" ? address : "another server"}` };
  }

  const tree = parseTree(text, [], PARSE);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const unit = indentUnit(text);
  const target = tree && holder !== undefined ? findNodeAtLocation(tree, [container]) : tree;
  if (!tree || !target || target.type !== "object") return { status: "invalid", content: text, reason: "it could not be read as a settings file" };
  const content = holder !== undefined ? insertProperty(text, target, name, entry, unit, eol) : insertProperty(text, tree, container, { [name]: entry }, unit, eol);

  // The check that makes the promise above true: the new text is the old content plus the entry, and nothing else.
  const after: ParseError[] = [];
  const reread: unknown = parse(content, after, PARSE);
  const meant = { ...root, [container]: { ...(holder ?? {}), [name]: entry } };
  if (after.length || !isDeepStrictEqual(reread, meant)) return { status: "invalid", content: text, reason: "it is laid out in a way this tool cannot add to safely" };
  return { status: "update", content };
}

/** Is `<container>.<name>` present with this address? (`calmonkey doctor`.) */
export function hasJsonEntry(text: string, container: string, name: string, url: string, urlKeys: string[]): boolean {
  const root: unknown = parse(text, [], PARSE);
  if (!isObject(root) || !isObject(root[container])) return false;
  const existing = (root[container] as Record<string, unknown>)[name];
  return isObject(existing) && urlKeys.some((k) => existing[k] === url);
}
