import { main } from "./cli.js";
import { proxyDecision, restartWithProxy } from "./proxy.js";

// The program itself: `calmonkey …`. Everything else is in cli.ts, which tests call directly.

const decision = proxyDecision(process.env, process.versions.node);
if (decision === "restart") {
  process.exit(restartWithProxy(process.argv.slice(1), process.env));
} else {
  if (decision === "unsupported") process.stderr.write(`A proxy is set in the environment, but Node ${process.versions.node} cannot use it for this tool. Use Node 22.21 or later (or 24.5 or later).\n`);
  void main(process.argv.slice(2)).then((code) => {
    // Ended here rather than left to end: a connection still held open (a proxy's, a keep-alive)
    // must not keep a finished command running. Whatever was written is flushed first.
    process.exitCode = code;
    process.stdout.write("", () => process.stderr.write("", () => process.exit(code)));
  });
}
