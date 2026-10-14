import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  access,
} from "node:fs/promises";
import { join } from "node:path";
import { Tmux } from "../src/tmux.mjs";
import { parseCLI, launch } from "../src/launch.mjs";
const source =
  process.env.PI_MONITOR_COMPOSITOR ??
  "/root/.local/share/pi/agent/packages/git/github.com/7h145/pi-footer-compositor/pi-footer-compositor.ts";
let available = true;
try {
  await access(source);
} catch {
  available = false;
}
async function until(fn) {
  for (let i = 0; i < 150; i++) {
    const value = await fn();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw Error("Timed out");
}
for (const [mode, activeTheme] of [
  ["regular", "default"],
  ["fullscreen", "gaudy"],
])
  test(
    `live Pi ${mode}/${activeTheme}: real compositor, theme, resize, reload, cleanup (no model requests)`,
    { skip: !available },
    async () => {
      const dir = await mkdtemp("/tmp/monitor-live-tui-"),
        socket = join(dir, "socket"),
        agent = join(dir, "agent"),
        tmux = new Tmux(socket);
      let pane;
      try {
        await mkdir(agent);
        await writeFile(
          join(agent, "settings.json"),
          '{"enableAnalytics":false,"enableInstallTelemetry":false}',
        );
        const config = JSON.parse(
          await readFile(
            new URL("../examples/pi-tmux-monitor.json", import.meta.url),
            "utf8",
          ),
        );
        Object.assign(config, {
          scope: "server",
          socketPath: socket,
          pollIntervalMs: 50,
          heartbeatIntervalMs: 100,
          staleAfterMs: 300,
          activeTheme,
        });
        await writeFile(
          join(agent, "pi-tmux-monitor.json"),
          JSON.stringify(config),
        );
        const synth = join(dir, "synthetic.ts");
        await writeFile(
          synth,
          `export default function(pi) {
      const keys=['footer-compositor:left:10:synthetic-read-only','footer-compositor:right:20:synthetic-usage','synthetic-ordinary'];
      pi.on('session_start',(_event,ctx)=>keys.forEach((key,i)=>ctx.ui.setStatus(key,['(ro)','C W2%','ordinary'][i])));
      pi.on('session_shutdown',(_event,ctx)=>keys.forEach(key=>ctx.ui.setStatus(key,undefined)));
      pi.registerCommand('monitor-test-theme',{description:'Synthetic theme test',handler:async(_args,ctx)=> {ctx.ui.setTheme('light');ctx.ui.notify('THEME CHANGED','info');}});
    }`,
        );
        await tmux.call(
          "-f",
          "/dev/null",
          "new-session",
          "-d",
          "-s",
          "tests",
          "-x",
          "100",
          "-y",
          "30",
        );
        await tmux.call("set-environment", "-g", "PI_CODING_AGENT_DIR", agent);
        await tmux.call("set-environment", "-g", "PI_TELEMETRY", "0");
        await tmux.call("set-environment", "-g", "PI_OFFLINE", "1");
        const plan = parseCLI([
          "pi",
          "--socket",
          socket,
          "--session",
          "tests",
          "--window",
          "pi",
          "--owner",
          "test-owner",
          "--heartbeat-interval-ms",
          "100",
          "--",
          "--offline",
          "--no-extensions",
          "--no-skills",
          "--no-context-files",
          "--no-approve",
          "--no-session",
          "--tui-mode",
          mode,
          "-e",
          source,
          "-e",
          synth,
        ]);
        pane = (await launch(plan)).paneId;
        const first = await until(() => tmux.record("pi", pane));
        assert.equal(first.state, "idle");
        await launch(
          parseCLI([
            "launch",
            "--socket",
            socket,
            "--session",
            "tests",
            "--window",
            "outcome",
            "--owner",
            first.sessionId,
            "--",
            "true",
          ]),
        );
        const outcome = config.themes[activeTheme].states.success.glyph,
          unregistered = config.themes[activeTheme].states.unregistered.glyph;
        const snapshot = () =>
          tmux.call("capture-pane", "-p", "-t", pane, "-S", "-60");
        await until(async () => {
          const output = await snapshot();
          return output.includes(unregistered + outcome) ? output : null;
        });
        let output = await snapshot();
        assert.ok(output.includes("(ro)"));
        assert.ok(output.includes("C W2%"));
        assert.ok(output.includes("ordinary"));
        const rawBefore = await tmux.call(
          "capture-pane",
          "-p",
          "-e",
          "-t",
          pane,
        );
        await tmux.call(
          "send-keys",
          "-t",
          pane,
          "/monitor-test-theme",
          "Enter",
        );
        await until(async () => (await snapshot()).includes("THEME CHANGED"));
        assert.notEqual(
          await tmux.call("capture-pane", "-p", "-e", "-t", pane),
          rawBefore,
        );
        await tmux.call("resize-window", "-t", pane, "-x", "45", "-y", "24");
        await until(async () =>
          (await snapshot()).includes(unregistered + outcome),
        );
        await tmux.call("send-keys", "-t", pane, "/reload", "Enter");
        const reloaded = await until(async () => {
          const r = await tmux.record("pi", pane);
          return r?.instanceId !== first.instanceId ? r : null;
        });
        assert.equal(reloaded.processInstanceId, first.processInstanceId);
        assert.equal(reloaded.state, "idle");
        await until(async () =>
          (await snapshot()).includes(unregistered + outcome),
        );
        await tmux.call("send-keys", "-t", pane, "/quit", "Enter");
        const final = await until(async () => {
          const r = await tmux.record("job", pane);
          return r?.phase !== "running" ? r : null;
        });
        assert.equal(final.phase, "success");
        assert.equal(await tmux.record("pi", pane), null);
      } finally {
        await tmux.call("kill-server").catch(() => {});
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
