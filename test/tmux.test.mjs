import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Tmux } from "../src/tmux.mjs";
import { JOB, PI } from "../src/protocol.mjs";
import { parseCLI, launch, helperPath, reporterPath } from "../src/launch.mjs";
import { job } from "./fixtures.mjs";
async function server(fn) {
  const dir = await mkdtemp(join(tmpdir(), "monitor-tmux-")),
    socket = join(dir, "socket"),
    tmux = new Tmux(socket, 1000);
  try {
    await tmux.call("-f", "/dev/null", "new-session", "-d", "-s", "shared");
    await fn({ dir, socket, tmux });
  } finally {
    await tmux.call("kill-server").catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
}
async function until(fn) {
  for (let i = 0; i < 100; i++) {
    const value = await fn();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw Error("Timed out");
}
const cli = (socket, args) =>
  parseCLI([
    "launch",
    "--socket",
    socket,
    "--session",
    "shared",
    "--window",
    "work",
    "--owner",
    "owner",
    "--ancestors-json",
    '["root"]',
    "--heartbeat-interval-ms",
    "50",
    "--",
    ...args,
  ]);
test("pane-local metadata rejects inheritance, JSON roundtrip and linked duplicates", async () =>
  server(async ({ tmux }) => {
    await tmux.call(
      "set-option",
      "-t",
      "shared",
      JOB,
      JSON.stringify(job({ paneId: "%0" })),
    );
    assert.equal(await tmux.record("job", "%0"), null);
    await tmux.write("job", "%0", job({ paneId: "%0", label: 'quote " #{}' }));
    assert.equal((await tmux.record("job", "%0")).label, 'quote " #{}');
    await tmux.call("new-session", "-d", "-s", "linked");
    await tmux.call("link-window", "-s", "shared:0", "-t", "linked:1");
    const panes = await tmux.inventory();
    assert.equal(panes.filter((p) => p.paneId === "%0").length, 1);
    assert.equal(panes[0].sessions.length, 2);
    await tmux.write("job", "%0", job({ paneId: "%0", jobId: "new" }));
    await tmux.removeOwned("job", "%0", "jobId", "j");
    assert.equal((await tmux.record("job", "%0")).jobId, "new");
  }));
test("direct helper preserves argv, server environment and nonzero exit in retained shell", async () =>
  server(async ({ dir, socket, tmux }) => {
    const output = join(dir, "argv.json"),
      script = join(dir, "argv.mjs");
    await writeFile(
      script,
      `import {writeFileSync} from 'node:fs'; writeFileSync(process.argv[2],JSON.stringify({args:process.argv.slice(3),pane:process.env.TMUX_PANE,tmux:process.env.TMUX,owner:process.env.PI_TMUX_MONITOR_PARENT,session:process.env.PI_SESSION_ID??null})); process.exit(7);`,
    );
    const args = [
      "a b",
      "it's",
      "$HOME; touch not-executed",
      "#{pane_id}",
      "--",
      "\n",
    ];
    process.env.TMUX = "/stale,9,0";
    process.env.TMUX_PANE = "%999";
    try {
      const result = await launch(
        cli(socket, [process.execPath, script, output, ...args]),
      );
      const final = await until(async () => {
        const r = await tmux.record("job", result.paneId);
        return r?.phase === "failed" ? r : null;
      });
      assert.equal(final.exitCode, 7);
      assert.deepEqual(final.ancestors, ["root", "owner"]);
      const data = JSON.parse(
        await (await import("node:fs/promises")).readFile(output, "utf8"),
      );
      assert.deepEqual(data.args, args);
      assert.equal(data.pane, result.paneId);
      assert.ok(data.tmux.startsWith(socket + ","));
      assert.equal(data.owner, "owner");
      assert.equal(data.session, null);
      assert.equal(
        await tmux.call(
          "display-message",
          "-p",
          "-t",
          result.paneId,
          "#{pane_dead}",
        ),
        "0",
      );
      assert.equal(await tmux.record("owner", "shared"), null);
    } finally {
      delete process.env.TMUX;
      delete process.env.TMUX_PANE;
    }
  }));
test("dedicated session ownership, service heartbeat and interrupt", async () =>
  server(async ({ socket, tmux }) => {
    const plan = cli(socket, [
      process.execPath,
      "-e",
      "setInterval(()=>{},1000)",
    ]);
    plan.session = "dedicated";
    plan.kind = "service";
    const result = await launch(plan),
      initial = await tmux.record("job", result.paneId);
    const owner = await tmux.record("owner", "dedicated");
    assert.equal(owner.ownerSessionId, "owner");
    assert.deepEqual(owner.ancestors, ["root"]);
    await until(
      async () =>
        (await tmux.record("job", result.paneId))?.heartbeatSeq >
        initial.heartbeatSeq,
    );
    await tmux.call("send-keys", "-t", result.paneId, "C-c");
    const final = await until(async () => {
      const r = await tmux.record("job", result.paneId);
      return r?.phase === "failed" ? r : null;
    });
    assert.equal(final.exitCode, 130);
    assert.equal(final.signal, "SIGINT");
    assert.equal(
      await tmux.call(
        "display-message",
        "-p",
        "-t",
        result.paneId,
        "#{pane_dead}",
      ),
      "0",
    );
  }));
test("Pi helper injection before delimiter, explicit loading with no discovery, no model request", async () =>
  server(async ({ dir, socket, tmux }) => {
    // Real Pi --help loads the explicit extension but exits before starting a
    // session/provider. Verify it parses under Pi's loader, not just Node stripping.
    const plan = parseCLI([
      "pi",
      "--socket",
      socket,
      "--session",
      "shared",
      "--window",
      "pi-help",
      "--owner",
      "owner",
      "--mode",
      "batch",
      "--",
      "--offline",
      "--no-extensions",
      "--no-skills",
      "--no-context-files",
      "--help",
    ]);
    const result = await launch(plan);
    const final = await until(async () => {
      const r = await tmux.record("job", result.paneId);
      return r?.phase === "success" || r?.phase === "failed" ? r : null;
    });
    const output = await tmux.call(
      "capture-pane",
      "-p",
      "-t",
      result.paneId,
      "-S",
      "-200",
    );
    assert.equal(final.exitCode, 0, output);
    assert.ok(plan.argv.includes("-e"));
    assert.ok(plan.argv.includes(reporterPath));
    assert.match(output, /--no-extensions|--print/);
    assert.equal(await tmux.record("pi", result.paneId), null);
  }));
test("missing server-side runner path is visible, not silently retried", async () =>
  server(async ({ socket, tmux }) => {
    const plan = cli(socket, ["true"]);
    plan.cwd = "/definitely-missing-directory";
    await assert.rejects(() => launch(plan));
    assert.equal(
      (await tmux.call("list-windows", "-t", "shared")).split("\n").length,
      1,
    );
  }));
test("server replacement changes identity and stale inherited server PID is rejected", async () =>
  server(async ({ socket, tmux }) => {
    const original = await tmux.identity(),
      pid = await tmux.call("display-message", "-p", "#{pid}");
    assert.equal(await tmux.ownIdentity(socket + "," + pid + ",0"), original);
    await tmux.call("kill-server");
    await tmux.call(
      "-f",
      "/dev/null",
      "new-session",
      "-d",
      "-s",
      "replacement",
    );
    assert.notEqual(await tmux.identity(), original);
    await assert.rejects(() => tmux.ownIdentity(socket + "," + pid + ",0"));
  }));
test("missing executable becomes terminal failure, not a disappearing window", async () =>
  server(async ({ socket, tmux }) => {
    const result = await launch(cli(socket, ["/definitely-missing-command"]));
    const final = await until(async () => {
      const r = await tmux.record("job", result.paneId);
      return r?.phase === "failed" ? r : null;
    });
    assert.equal(final.exitCode, 127);
    assert.equal(
      await tmux.call(
        "display-message",
        "-p",
        "-t",
        result.paneId,
        "#{pane_dead}",
      ),
      "0",
    );
  }));
test("actual Pi helper TUI starts reporter with no extensions discovery and cleans up on quit", async () =>
  server(async ({ dir, socket, tmux }) => {
    const agent = join(dir, "agent");
    await mkdir(agent);
    await writeFile(
      join(agent, "settings.json"),
      '{"enableAnalytics":false,"enableInstallTelemetry":false}',
    );
    await tmux.call("set-environment", "-g", "PI_CODING_AGENT_DIR", agent);
    await tmux.call("set-environment", "-g", "PI_OFFLINE", "1");
    await tmux.call("set-environment", "-g", "PI_TELEMETRY", "0");
    const plan = parseCLI([
      "pi",
      "--socket",
      socket,
      "--session",
      "shared",
      "--window",
      "pi-tui",
      "--owner",
      "owner",
      "--ancestors-json",
      '["root"]',
      "--mode",
      "interactive",
      "--",
      "--offline",
      "--no-extensions",
      "--no-skills",
      "--no-context-files",
      "--no-session",
      "--no-approve",
      "--tui-mode",
      "regular",
    ]);
    const result = await launch(plan),
      record = await until(() => tmux.record("pi", result.paneId));
    assert.equal(record.state, "idle");
    assert.equal(record.kind, "interactive");
    assert.equal(record.jobId, result.jobId);
    assert.equal(record.parentSessionId, "owner");
    assert.deepEqual(record.ancestors, ["root", "owner"]);
    await tmux.call("send-keys", "-t", result.paneId, "/quit", "Enter");
    const final = await until(async () => {
      const r = await tmux.record("job", result.paneId);
      return r?.phase !== "running" ? r : null;
    });
    assert.equal(final.phase, "success");
    assert.equal(await tmux.record("pi", result.paneId), null);
    assert.equal(
      await tmux.call(
        "display-message",
        "-p",
        "-t",
        result.paneId,
        "#{pane_dead}",
      ),
      "0",
    );
  }));
test("cleanup compare-and-delete preserves a replacement arriving after its read", async () =>
  server(async ({ tmux }) => {
    await tmux.write("job", "%0", job({ paneId: "%0" }));
    const original = tmux.record.bind(tmux);
    tmux.record = async (type, target) => {
      const r = await original(type, target);
      if (type === "job" && r?.jobId === "j")
        await tmux.write(
          "job",
          "%0",
          job({ paneId: "%0", jobId: "replacement" }),
        );
      return r;
    };
    await tmux.removeOwned("job", "%0", "jobId", "j");
    assert.equal((await original("job", "%0")).jobId, "replacement");
  }));
test("missing packaged reporter fails before launch; explicit uninstrumented Pi still registers", async () =>
  server(async ({ dir, socket, tmux }) => {
    const { cp } = await import("node:fs/promises"),
      { execFile } = await import("node:child_process"),
      { promisify } = await import("node:util");
    const exec = promisify(execFile);
    const incomplete = join(dir, "incomplete");
    await mkdir(incomplete);
    await cp(new URL("../src", import.meta.url), join(incomplete, "src"), {
      recursive: true,
    });
    await cp(
      new URL("../scripts", import.meta.url),
      join(incomplete, "scripts"),
      { recursive: true },
    );
    const helper = join(incomplete, "scripts/pi-tmux-monitor.mjs"),
      flags = [
        "pi",
        "--socket",
        socket,
        "--session",
        "shared",
        "--window",
        "missing",
        "--owner",
        "owner",
      ];
    await assert.rejects(
      () =>
        exec(process.execPath, [
          helper,
          ...flags,
          "--",
          "--no-extensions",
          "--offline",
          "--help",
        ]),
      /ENOENT/,
    );
    assert.equal(
      (await tmux.call("list-windows", "-t", "shared")).split("\n").length,
      1,
    );
    const { stdout } = await exec(process.execPath, [
      helper,
      ...flags,
      "--uninstrumented",
      "--",
      "--no-extensions",
      "--offline",
      "--help",
    ]);
    const result = JSON.parse(stdout);
    const final = await until(async () => {
      const r = await tmux.record("job", result.paneId);
      return r?.phase !== "running" ? r : null;
    });
    assert.equal(final.phase, "success");
    assert.equal(await tmux.record("pi", result.paneId), null);
  }));
test("guarded writes preserve literals and cannot overwrite another generation or server", async () =>
  server(async ({ tmux }) => {
    const serverIdentity = await tmux.identity();
    const label = "quote ' $HOME #{pane_id} \\ literal";
    await tmux.write("job", "%0", job({ paneId: "%0", label }), {
      serverIdentity,
      allowAbsent: true,
    });
    assert.equal((await tmux.record("job", "%0")).label, label);
    await tmux.write("job", "%0", job({ paneId: "%0", jobId: "new" }));
    await tmux.write(
      "job",
      "%0",
      job({ paneId: "%0", phase: "success", exitCode: 0 }),
      { serverIdentity },
    );
    assert.equal((await tmux.record("job", "%0")).jobId, "new");
    await tmux.write(
      "job",
      "%0",
      job({ paneId: "%0", jobId: "new", phase: "success", exitCode: 0 }),
      { serverIdentity: serverIdentity.replace(/:\d+:\d+$/, ":0:0") },
    );
    assert.equal((await tmux.record("job", "%0")).phase, "running");
  }));
test("actual RPC Pi reports without a TUI observer and retires on stdin EOF", async () =>
  server(async ({ dir, socket, tmux }) => {
    const agent = join(dir, "agent");
    await mkdir(agent);
    await tmux.call("set-environment", "-g", "PI_CODING_AGENT_DIR", agent);
    await tmux.call("set-environment", "-g", "PI_TELEMETRY", "0");
    const plan = parseCLI([
      "pi",
      "--socket",
      socket,
      "--session",
      "shared",
      "--window",
      "rpc",
      "--owner",
      "owner",
      "--mode",
      "interactive",
      "--",
      "--mode",
      "rpc",
      "--offline",
      "--no-extensions",
      "--no-skills",
      "--no-context-files",
      "--no-session",
      "--no-approve",
    ]);
    const result = await launch(plan),
      r = await until(() => tmux.record("pi", result.paneId));
    assert.equal(r.kind, "interactive");
    assert.equal(r.state, "idle");
    assert.equal(r.jobId, result.jobId);
    await tmux.call("send-keys", "-t", result.paneId, "C-d");
    const final = await until(async () => {
      const record = await tmux.record("job", result.paneId);
      return record?.phase !== "running" ? record : null;
    });
    assert.equal(final.phase, "success");
    assert.equal(await tmux.record("pi", result.paneId), null);
    assert.ok(
      !(await tmux.call("capture-pane", "-p", "-t", result.paneId)).includes(
        "capability unavailable",
      ),
    );
  }));
test("observer does not exclude a reused own-pane ID on a replacement server", async () =>
  server(async ({ dir, socket, tmux }) => {
    const { Observer } = await import("../src/observer.mjs"),
      { DEFAULTS } = await import("../src/config.mjs");
    const pid = await tmux.call("display-message", "-p", "#{pid}");
    const observer = new Observer({
      cwd: dir,
      owner: "owner",
      config: { ...DEFAULTS, scope: "server", socketPath: socket },
      env: { TMUX: socket + "," + pid + ",0", TMUX_PANE: "%0" },
      publish: () => {},
    });
    try {
      await observer.scan();
      assert.equal(observer.slots.length, 0);
      await tmux.call("kill-server");
      await tmux.call(
        "-f",
        "/dev/null",
        "new-session",
        "-d",
        "-s",
        "replacement",
      );
      await observer.scan();
      assert.equal(observer.slots.length, 1);
      assert.equal(observer.slots[0].state, "unregistered");
    } finally {
      observer.stop();
    }
  }));
