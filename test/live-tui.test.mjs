import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  access,
  cp,
  readdir,
} from "node:fs/promises";
import { join } from "node:path";
import { Tmux } from "../src/tmux.mts";
import { parseCLI, launch } from "../src/launch.mts";
import { visibleWidth } from "@earendil-works/pi-tui";
import { STATUS_KEY } from "../src/footer.mts";
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
for (const [mode, activeTheme, producerFirst] of [
  ["regular", "default", true],
  ["regular", "default", false],
  ["fullscreen", "gaudy", true],
  ["fullscreen", "gaudy", false],
])
  test(
    `live Pi ${mode}/${activeTheme}/${producerFirst ? "monitor-first" : "compositor-first"}: real compositor, quiet startup/reload, source edits, right placement, resize, cleanup (no model requests)`,
    { skip: !available },
    async () => {
      const dir = await mkdtemp("/tmp/monitor-live-tui-"),
        socket = join(dir, "socket"),
        agent = join(dir, "agent"),
        tmux = new Tmux(socket);
      let pane;
      try {
        await mkdir(agent);
        const bundle = join(dir, "package");
        await mkdir(bundle);
        await cp(new URL("../src", import.meta.url), join(bundle, "src"), {
          recursive: true,
        });
        await cp(
          new URL("../package.json", import.meta.url),
          join(bundle, "package.json"),
        );
        const entry = join(bundle, "pi-tmux-monitor.ts");
        const currentEntry = await readFile(
          new URL("../pi-tmux-monitor.ts", import.meta.url),
          "utf8",
        );
        const warmKey = "footer-compositor:left:5:tmux-monitor";
        for (const name of await readdir(join(bundle, "src"))) {
          if (!name.endsWith(".mts")) continue;
          const text = (await readFile(join(bundle, "src", name), "utf8"))
            .replaceAll('.mts"', '.mjs"')
            .replaceAll(
              "@earendil-works/pi-tui",
              import.meta.resolve("@earendil-works/pi-tui"),
            )
            .replaceAll(
              '"@earendil-works/pi-coding-agent"',
              JSON.stringify(
                import.meta.resolve("@earendil-works/pi-coding-agent"),
              ),
            )
            .replace(STATUS_KEY, warmKey);
          await writeFile(
            join(bundle, "src", name.replace(/\.mts$/, ".mjs")),
            text,
          );
        }
        await writeFile(entry, currentEntry.replaceAll('.mts"', '.mjs"'));
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
      const prefix='footer-compositor:dynamic:';
      const dynamic=[['footer-compositor:left:20:synthetic-dynamic-left','LD'],['footer-compositor:right:30:synthetic-dynamic-right','dyn']];
      const entries=[['footer-compositor:left:10:synthetic-read-only','(ro)'],['footer-compositor:right:10:synthetic-git','clean'],['footer-compositor:right:20:synthetic-usage','C W2%'],['synthetic-ordinary','ordinary'],...dynamic.map(([key,text])=>[key,'cached '+text])];
      let instance, removers=[], subscriptions=[];
      pi.on('session_start',(_event,ctx)=> {
        const publish=()=>entries.forEach(([key,text])=>ctx.ui.setStatus(key,text));
        const accept=cap=> {
          if(cap?.version!==1 || cap.instanceId===instance) return;
          const next=dynamic.map(([key,text])=>cap.register({key,render:({maxWidth,theme})=>maxWidth>=text.length ? theme.fg('accent',text) : ''}));
          removers.forEach(remove=>remove()); removers=next; instance=cap.instanceId; publish();
        };
        const discover=()=>pi.events.emit(prefix+'discover',{version:1,accept});
        subscriptions=[pi.events.on(prefix+'available',accept),pi.events.on(prefix+'unavailable',notice=> {
          if(notice?.version!==1 || notice.instanceId!==instance) return;
          removers.forEach(remove=>remove()); removers=[]; instance=undefined; publish(); discover();
        })];
        publish(); discover();
      });
      pi.on('session_shutdown',(_event,ctx)=> {
        subscriptions.forEach(stop=>stop()); subscriptions=[];
        removers.forEach(remove=>remove()); removers=[]; instance=undefined;
        entries.forEach(([key])=>ctx.ui.setStatus(key,undefined));
      });
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
          "--uninstrumented",
          "--",
          "--offline",
          "--no-extensions",
          "--no-skills",
          "--no-context-files",
          "--no-approve",
          "--no-session",
          "--tui-mode",
          mode,
          ...(producerFirst
            ? ["-e", entry, "-e", source]
            : ["-e", source, "-e", entry]),
          "-e",
          synth,
        ]);
        pane = (await launch(plan)).paneId;
        let first;
        try {
          first = await until(() => tmux.record("pi", pane));
        } catch (error) {
          throw Error(
            `${error.message}\n${await tmux.call("capture-pane", "-p", "-S", "-100", "-t", pane)}`,
          );
        }
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
        const block = `${unregistered}${outcome} • clean • C W2% • dyn`;
        await tmux.call(
          "send-keys",
          "-t",
          pane,
          "/tmux-monitor diagnostics",
          "Enter",
        );
        await until(async () => (await snapshot()).includes(warmKey));
        assert.ok(!(await snapshot()).includes("Width-aware compositor"));
        await writeFile(entry, currentEntry);
        await tmux.call("send-keys", "-t", pane, "/reload", "Enter");
        const updated = await until(async () => {
          const r = await tmux.record("pi", pane);
          return r && r.instanceId !== first.instanceId ? r : null;
        });
        assert.equal(updated.processInstanceId, first.processInstanceId);

        const placement = async (width) =>
          until(async () => {
            const output = await tmux.call("capture-pane", "-p", "-t", pane);
            const line = output
              .split("\n")
              .find((line) => line.trimEnd().endsWith(block));
            if (!line || !line.includes("(ro)")) return null;
            if (width === 100) assert.ok(line.includes("(ro) LD"), line);
            assert.match(line, /\(ro\)(?: LD)? {2,}/);
            assert.ok(line.indexOf(block) > line.indexOf("(ro)"), line);
            assert.equal(visibleWidth(line), width, line);
            assert.equal(
              line.split(unregistered + outcome).length - 1,
              1,
              line,
            );
            return line;
          });
        await placement(100);
        await tmux.call(
          "send-keys",
          "-t",
          pane,
          "/tmux-monitor diagnostics",
          "Enter",
        );
        await until(async () => {
          const output = await snapshot();
          return output.includes("dynamic-v1") && output.includes(STATUS_KEY);
        });
        let output = await snapshot();
        assert.ok(!output.includes("Width-aware compositor"), output);
        assert.match(output, /"diagnostics":\s*\[\]/);
        assert.ok(output.includes("(ro)"));
        assert.ok(output.includes("C W2%"));
        assert.ok(output.includes("ordinary"));
        await tmux.call("send-keys", "-t", pane, "/tmux-monitor", "Enter");
        await until(async () =>
          (await snapshot()).includes("2 monitored panes."),
        );
        output = await snapshot();
        assert.ok(output.includes("unregistered"), output);
        assert.ok(output.includes("success"), output);
        assert.ok(output.includes("┌") && output.includes("┼"), output);
        assert.ok(!output.includes("| --- |"), output);
        // Fullscreen has no tmux scrollback; give the complete notice room.
        await tmux.call("resize-window", "-t", pane, "-x", "100", "-y", "60");
        await tmux.call("send-keys", "-t", pane, "/tmux-monitor help", "Enter");
        try {
          await until(async () => {
            const text = await snapshot();
            return (
              text.includes("Commands:") &&
              text.includes(`active theme ${activeTheme}`) &&
              text.includes("Ctrl+b")
            );
          });
        } catch (error) {
          throw Error(`${error.message}\n${await snapshot()}`);
        }
        output = await snapshot();
        assert.ok(output.includes("/tmux-monitor config (c)"), output);
        assert.ok(output.includes("tmux-monitor v0.1.0:"), output);
        assert.ok(output.includes("┌") && output.includes("┼"), output);
        assert.ok(
          !output.includes("| --- |") && !output.includes("\\_"),
          output,
        );
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
        await placement(45);
        await tmux.call("send-keys", "-t", pane, "/tmux-monitor s", "Enter");
        await until(async () => (await snapshot()).includes("Glyph:"));
        output = await snapshot();
        assert.ok(
          output.includes("Pane:") && output.includes("Meaning:"),
          output,
        );
        assert.ok(!output.includes("| --- |"), output);
        await tmux.call("send-keys", "-t", pane, "/tmux-monitor h", "Enter");
        await new Promise((r) => setTimeout(r, 100));
        await until(async () =>
          (await snapshot()).includes("tmux-monitor never controls workloads"),
        );
        for (const line of (
          await tmux.call("capture-pane", "-p", "-t", pane)
        ).split("\n"))
          assert.ok(visibleWidth(line) <= 45);
        await tmux.call("send-keys", "-t", pane, "/reload", "Enter");
        const reloaded = await until(async () => {
          const r = await tmux.record("pi", pane);
          return r && r.instanceId !== updated.instanceId ? r : null;
        });
        assert.equal(reloaded.processInstanceId, first.processInstanceId);
        assert.equal(reloaded.state, "idle");
        await placement(45);
        // Edit an already loaded transitive module, not just the entry file.
        const formatterPath = join(bundle, "src", "formatter.mts");
        const formatter = await readFile(formatterPath, "utf8");
        const changed = formatter.replace(
          "const style = (state, config, theme) => {",
          'const style = (state, config, theme) => {\n  if (state === "unregistered") return theme.fg("dim", "~");',
        );
        assert.notEqual(changed, formatter);
        await writeFile(formatterPath, changed);
        await tmux.call("send-keys", "-t", pane, "/reload", "Enter");
        const leafReload = await until(async () => {
          const r = await tmux.record("pi", pane);
          return r && r.instanceId !== reloaded.instanceId ? r : null;
        });
        assert.equal(leafReload.processInstanceId, first.processInstanceId);
        await until(async () => {
          const output = await tmux.call("capture-pane", "-p", "-t", pane);
          return output
            .split("\n")
            .some((line) =>
              line.trimEnd().endsWith(`~${outcome} • clean • C W2% • dyn`),
            );
        });
        const footerPath = join(bundle, "src", "footer.mts");
        const changedKey = "footer-compositor:right:40:tmux-monitor";
        await writeFile(
          footerPath,
          (await readFile(footerPath, "utf8")).replace(STATUS_KEY, changedKey),
        );
        await tmux.call("send-keys", "-t", pane, "/reload", "Enter");
        const directReload = await until(async () => {
          const r = await tmux.record("pi", pane);
          return r && r.instanceId !== leafReload.instanceId ? r : null;
        });
        assert.equal(directReload.processInstanceId, first.processInstanceId);
        await tmux.call("resize-window", "-t", pane, "-x", "100", "-y", "30");
        await until(async () => {
          const output = await tmux.call("capture-pane", "-p", "-t", pane);
          return output
            .split("\n")
            .some((line) =>
              line.trimEnd().endsWith(`clean • C W2% • dyn • ~${outcome}`),
            );
        });
        await tmux.call(
          "send-keys",
          "-t",
          pane,
          "/tmux-monitor diagnostics",
          "Enter",
        );
        await until(async () =>
          (await snapshot()).replace(/\s+/g, "").includes(changedKey),
        );
        output = await snapshot();
        assert.ok(!output.includes("Width-aware compositor"), output);
        assert.match(output, /"diagnostics":\s*\[\]/);
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
