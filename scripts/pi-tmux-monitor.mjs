#!/usr/bin/env node
import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";
// Shared helper modules are plain JavaScript. Load only this package's .mts
// sources as JavaScript, including when installed beneath node_modules.
const sourceRoot = new URL("../src/", import.meta.url).href;
registerHooks({
  load(url, context, nextLoad) {
    if (url.startsWith(sourceRoot) && url.endsWith(".mts"))
      return {
        format: "module",
        source: readFileSync(new URL(url), "utf8"),
        shortCircuit: true,
      };
    return nextLoad(url, context);
  },
});
const { executeHelper } = await import("../src/helper.mts");
const { run } = await import("../src/runner.mjs");
const argv = process.argv.slice(2);
const delimiter = argv.indexOf("--");
const helperArgs = delimiter < 0 ? argv : argv.slice(0, delimiter);
if (helperArgs.includes("--help") && argv[0] !== "run") {
  console.log(`pi-tmux-monitor inspect [--socket PATH] [--cwd PATH] [--tmux-timeout-ms N]
pi-tmux-monitor start --owner ID [--socket PATH] [--ancestors-json JSON] [--cwd PATH]
pi-tmux-monitor launch --socket PATH [--session NAME] --window NAME --owner ID --kind batch|service|interactive [options] -- COMMAND [ARGS...]
pi-tmux-monitor pi --socket PATH [--session NAME] --window NAME --owner ID --mode interactive|batch [options] -- [PI ARGS...]
Options: --ancestors-json JSON --cwd PATH --label LABEL --heartbeat-interval-ms N --tmux-timeout-ms N --uninstrumented
Defaults: cwd=calling directory, heartbeat=5000ms, timeout=1000ms, socket=.agents/run/tmux-socket.
The helper does not load configuration or read task results. Launch is asynchronous; inspect the retained shell with tmux. Commands run in the server environment.`);
} else {
  try {
    if (argv[0] === "run")
      process.exitCode = await run(
        JSON.parse(Buffer.from(argv[1], "base64url").toString()),
      );
    else {
      const result = await executeHelper(argv);
      console.log(JSON.stringify(result));
      if (result.state === "unavailable") process.exitCode = 1;
    }
  } catch (error) {
    console.error(`pi-tmux-monitor: ${error.message}`);
    process.exitCode = 1;
  }
}
