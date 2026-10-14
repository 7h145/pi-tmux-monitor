#!/usr/bin/env node
import { parseCLI, launch } from "../src/launch.mjs";
import { run } from "../src/runner.mjs";
const argv = process.argv.slice(2);
const delimiter = argv.indexOf("--");
const helperArgs = delimiter < 0 ? argv : argv.slice(0, delimiter);
if (helperArgs.includes("--help") && argv[0] !== "run") {
  console.log(`pi-tmux-monitor launch --socket PATH --session NAME --window NAME --owner ID --kind batch|service|interactive [options] -- COMMAND [ARGS...]
pi-tmux-monitor pi --socket PATH --session NAME --window NAME --owner ID --mode interactive|batch [options] -- [PI ARGS...]
Options: --ancestors-json JSON --cwd PATH --label LABEL --heartbeat-interval-ms N --tmux-timeout-ms N --uninstrumented
Defaults: cwd=calling directory, heartbeat=5000ms, timeout=1000ms, socket=.agents/run/tmux-socket.
The helper does not load configuration or read task results. Launch is asynchronous; inspect the retained shell with tmux. Commands run in the server environment.`);
} else {
  try {
    if (argv[0] === "run")
      process.exitCode = await run(
        JSON.parse(Buffer.from(argv[1], "base64url").toString()),
      );
    else console.log(JSON.stringify(await launch(parseCLI(argv))));
  } catch (error) {
    console.error(`pi-tmux-monitor: ${error.message}`);
    process.exitCode = 1;
  }
}
