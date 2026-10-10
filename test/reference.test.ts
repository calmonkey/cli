import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildReference } from "../src/reference.js";

// What other repositories take from this one must be what the code says now: the tool's
// description of itself (the docs site renders /docs/cli from it), and the version the bundled
// skill names.

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

describe("the tool described by itself", () => {
  it("docs/reference.json is what the code says (npm run reference)", () => {
    expect(JSON.parse(readFileSync(new URL("../docs/reference.json", import.meta.url), "utf8"))).toEqual(JSON.parse(JSON.stringify(buildReference(pkg.version))));
  });

  it("names every command once, with its help, and shows no secret", () => {
    const reference = buildReference(pkg.version);
    const names = reference.groups.flatMap((g) => g.commands.map((c) => c.name));
    expect(new Set(names).size).toBe(names.length);
    for (const name of ["status", "init", "agent-guide", "events list", "events get", "events put", "events edit", "events delete", "freebusy", "calendars list", "calendars open-test", "accounts list", "accounts connect-link", "channels list", "logs requests", "logs webhooks", "docs search", "docs get", "schema", "explain", "apps list", "apps create", "api", "skill install", "listen", "doctor", "mcp add", "login", "logout"]) expect(names, name).toContain(name);
    expect(JSON.stringify(reference)).not.toMatch(/cmsec_|cmat_|cmrt_|cmmat_|cmmrt_/);
  });

  it("the bundled skill names this version of the tool", () => {
    expect(readFileSync(new URL("../skills/calmonkey-api/SKILL.md", import.meta.url), "utf8")).toContain(`cli_version: "${pkg.version}"`);
  });
});
