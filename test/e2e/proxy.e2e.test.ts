import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import net, { type AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { supportsEnvProxy } from "../../src/proxy.js";
import { CLI } from "./harness.js";

// The built program behind a proxy. The CalMonkey addresses it is given do not exist
// (`*.calmonkey.invalid`), so the only way it can reach "the MCP server" is through the proxy
// in HTTP_PROXY, which here tunnels every connection to a small server on this machine.
// Needs the build (dist/cli.js) and a Node that reads proxy settings from the environment.

describe.skipIf(!existsSync(CLI) || !supportsEnvProxy(process.versions.node))("behind a proxy", () => {
  let target: http.Server;
  let proxy: http.Server;
  let proxyUrl = "";
  const tunnelled: string[] = [];
  const dir = mkdtempSync(path.join(os.tmpdir(), "calmonkey-proxy-"));

  beforeAll(async () => {
    // What the MCP host answers to `calmonkey doctor`: its metadata, and a refusal without a token.
    target = http.createServer((req, res) => {
      if (req.url?.startsWith("/.well-known/oauth-protected-resource")) res.writeHead(200, { "Content-Type": "application/json" }).end("{}");
      else if (req.url === "/mcp") res.writeHead(401).end();
      else res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    const targetPort = (target.address() as AddressInfo).port;
    // A forward proxy: asked to CONNECT to a host, it joins the caller to the server above.
    proxy = http.createServer((_req, res) => res.writeHead(405).end());
    proxy.on("connect", (req, socket) => {
      tunnelled.push(req.url ?? "");
      const upstream = net.connect(targetPort, "127.0.0.1", () => {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        upstream.pipe(socket);
        socket.pipe(upstream);
      });
      upstream.on("error", () => socket.destroy());
      socket.on("error", () => upstream.destroy());
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    rmSync(dir, { recursive: true, force: true });
    for (const server of [proxy, target]) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  const doctor = (env: NodeJS.ProcessEnv) =>
    new Promise<{ code: number | null; stdout: string }>((resolve) => {
      const child = spawn(process.execPath, [CLI, "doctor"], {
        cwd: dir,
        env: { PATH: "", HOME: dir, CALMONKEY_CONFIG_DIR: path.join(dir, "cfg"), NO_COLOR: "1", CALMONKEY_APP_URL: "http://app.calmonkey.invalid", CALMONKEY_API_URL: "http://api.calmonkey.invalid", CALMONKEY_MCP_URL: "http://mcp.calmonkey.invalid/mcp", ...env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
      child.on("close", (code) => resolve({ code, stdout }));
    });

  it("reaches CalMonkey through HTTP_PROXY", async () => {
    const result = await doctor({ HTTP_PROXY: proxyUrl });
    expect(tunnelled).toContain("mcp.calmonkey.invalid:80");
    expect(result.stdout).toContain("✓ The MCP server answers at http://mcp.calmonkey.invalid/mcp");
  }, 30_000);

  it("leaves hosts named in NO_PROXY alone, and uses no proxy when none is set", async () => {
    tunnelled.length = 0;
    const direct = await doctor({ HTTP_PROXY: proxyUrl, NO_PROXY: "mcp.calmonkey.invalid" });
    expect(tunnelled).toEqual([]);
    expect(direct.stdout).toContain("The MCP server could not be reached");
    const none = await doctor({});
    expect(tunnelled).toEqual([]);
    expect(none.stdout).toContain("The MCP server could not be reached");
  }, 30_000);
});
