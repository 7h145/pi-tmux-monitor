import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import monitor, { replaceContext } from "../pi-tmux-monitor.ts";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { Tmux } from "../src/tmux.mts";
import { STATUS_KEY } from "../src/footer.mts";
import { parseCLI, launch } from "../src/launch.mts";
const saved = { ...process.env };
async function scenario(fn) {
  const diagnosticsKey = Symbol.for("pi-tmux-monitor.diagnostics.v1");
  const previousDiagnostics = globalThis[diagnosticsKey];
  delete globalThis[diagnosticsKey];
  const dir = await mkdtemp("/tmp/monitor-extension-"),
    tmux = new Tmux(join(dir, "socket"));
  const agent = join(dir, "agent"),
    cwd = join(dir, "cwd");
  await mkdir(agent);
  await mkdir(join(cwd, ".pi"), { recursive: true });
  const handlers = new Map(),
    commands = new Map(),
    statuses = new Map(),
    notices = [];
  const pi = {
    events: createEventBus(),
    on: (name, h) => handlers.set(name, h),
    registerCommand: (name, c) => commands.set(name, c),
  };
  let sessionId = "original",
    trusted = false,
    idle = true;
  const ctx = {
    cwd,
    mode: "tui",
    hasUI: true,
    sessionManager: { getSessionId: () => sessionId },
    isIdle: () => idle,
    isProjectTrusted: () => trusted,
    ui: {
      theme: { fg: (_, s) => s, style: (s) => s },
      setStatus: (k, s) =>
        s === undefined ? statuses.delete(k) : statuses.set(k, s),
      notify: (s) => notices.push(s),
    },
  };
  process.env.PI_CODING_AGENT_DIR = agent;
  delete process.env.TMUX;
  delete process.env.TMUX_PANE;
  try {
    await tmux.call("-f", "/dev/null", "new-session", "-d", "-s", "self");
    await writeFile(
      join(agent, "pi-tmux-monitor.json"),
      JSON.stringify({
        socketPath: tmux.socket,
        pollIntervalMs: 50,
        heartbeatIntervalMs: 50,
        staleAfterMs: 150,
      }),
    );
    await writeFile(
      join(cwd, ".pi/pi-tmux-monitor.json"),
      '{"scope":"server"}',
    );
    monitor(pi);
    const emit = (name, event = {}) => handlers.get(name)?.(event, ctx);
    await fn({
      emit,
      commands,
      statuses,
      notices,
      ctx,
      pi,
      tmux,
      agent,
      cwd,
      setTrusted: (v) => (trusted = v),
      setSession: (v) => (sessionId = v),
      setIdle: (v) => (idle = v),
    });
    await emit("session_shutdown", { reason: "quit" });
  } finally {
    await handlers.get("session_shutdown")?.({ reason: "quit" }, ctx);
    if (previousDiagnostics === undefined) delete globalThis[diagnosticsKey];
    else globalThis[diagnosticsKey] = previousDiagnostics;
    for (const k of Object.keys(process.env))
      if (!Object.hasOwn(saved, k)) delete process.env[k];
    Object.assign(process.env, saved);
    await tmux.call("kill-server").catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
}
test("launch addendum replaces only its own block and preserves other append sections", () => {
  const text = replaceContext("unrelated\n", "one");
  const next = replaceContext(text + "\nother", "two");
  assert.ok(next.includes("unrelated"));
  assert.ok(next.includes("other"));
  assert.ok(next.includes("two"));
  assert.ok(!next.includes("\none\n"));
  assert.equal(
    (next.match(/<pi-tmux-monitor-launch-context>/g) ?? []).length,
    1,
  );
});
test("extension session replacement, trust/config reload, diagnostics and child context", async () =>
  scenario(
    async ({
      emit,
      commands,
      statuses,
      notices,
      ctx,
      setSession,
      setTrusted,
      tmux,
    }) => {
      await emit("session_start");
      assert.equal(process.env.PI_TMUX_MONITOR_OWNER, "original");
      const event = {
        systemPromptOptions: { appendSystemPrompt: "other instructions" },
      };
      await emit("before_agent_start", event);
      assert.ok(
        event.systemPromptOptions.appendSystemPrompt.includes(
          '"owner":"original"',
        ),
      );
      assert.ok(
        event.systemPromptOptions.appendSystemPrompt.includes(
          '"heartbeatIntervalMs":50',
        ),
      );
      await commands.get("tmux-monitor").handler("diagnostics", ctx);
      assert.equal(JSON.parse(notices.at(-1)).scope, "descendants");
      assert.equal(JSON.parse(notices.at(-1)).statusKey, STATUS_KEY);
      assert.equal(JSON.parse(notices.at(-1)).capability, "missing");
      const plan = parseCLI([
        "launch",
        "--socket",
        tmux.socket,
        "--session",
        "self",
        "--window",
        "completed",
        "--owner",
        "original",
        "--",
        "true",
      ]);
      await launch(plan);
      await emit("session_shutdown", { reason: "new" });
      assert.equal(statuses.size, 0);
      setSession("replacement");
      setTrusted(true);
      await emit("session_start");
      await commands.get("tmux-monitor").handler("diagnostics", ctx);
      const diagnostic = JSON.parse(notices.at(-1));
      assert.equal(diagnostic.owner, "replacement");
      assert.equal(diagnostic.scope, "server");
      await emit("before_agent_start", event);
      assert.equal(
        (
          event.systemPromptOptions.appendSystemPrompt.match(
            /<pi-tmux-monitor-launch-context>/g,
          ) ?? []
        ).length,
        1,
      );
      assert.ok(
        event.systemPromptOptions.appendSystemPrompt.includes(
          '"owner":"replacement"',
        ),
      );
      assert.ok(
        !event.systemPromptOptions.appendSystemPrompt.includes(
          '"owner":"original"',
        ),
      );
    },
  ));
test("synthetic Pi events use actual pane metadata; reload retains failure, quit cleans it", async () =>
  scenario(async ({ emit, tmux, ctx }) => {
    process.env.TMUX =
      tmux.socket +
      "," +
      (await tmux.call("display-message", "-p", "#{pid}")) +
      ",0";
    process.env.TMUX_PANE = "%0";
    await emit("session_start");
    const first = await tmux.record("pi", "%0");
    assert.equal(first.state, "idle");
    await emit("agent_start");
    assert.equal((await tmux.record("pi", "%0")).state, "active");
    await emit("agent_before_settle", { outcome: "error" });
    assert.equal((await tmux.record("pi", "%0")).state, "active");
    await emit("agent_settled", { aborted: false });
    assert.equal((await tmux.record("pi", "%0")).state, "failed");
    await emit("session_shutdown", { reason: "reload" });
    assert.equal(await tmux.record("pi", "%0"), null);
    await emit("session_start");
    const second = await tmux.record("pi", "%0");
    assert.equal(second.state, "failed");
    assert.notEqual(second.instanceId, first.instanceId);
    assert.equal(second.processInstanceId, first.processInstanceId);
    await emit("session_before_compact");
    assert.equal((await tmux.record("pi", "%0")).state, "active");
    await emit("session_compact_failed", { aborted: true });
    assert.equal((await tmux.record("pi", "%0")).state, "failed");
    await emit("agent_start");
    await emit("agent_before_settle", { outcome: "aborted" });
    await emit("agent_settled", { aborted: true });
    assert.equal((await tmux.record("pi", "%0")).state, "idle");
    await emit("session_shutdown", { reason: "quit" });
    assert.equal(await tmux.record("pi", "%0"), null);
  }));

test("persistent absence is recorded once without notifications and keeps fallback", async () =>
  scenario(async ({ emit, commands, ctx, notices, statuses, tmux }) => {
    const warning =
      "Width-aware compositor capability unavailable; using static summary";
    await launch(
      parseCLI([
        "launch",
        "--socket",
        tmux.socket,
        "--session",
        "self",
        "--window",
        "completed",
        "--owner",
        "original",
        "--",
        "true",
      ]),
    );
    await emit("session_start");
    assert.equal(notices.filter((message) => message === warning).length, 0);
    for (let i = 0; i < 100 && statuses.get(STATUS_KEY) !== "+"; i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(notices, []);
    assert.equal(statuses.get(STATUS_KEY), "+");
    await new Promise((resolve) => setTimeout(resolve, 100));
    await commands.get("tmux-monitor").handler("diagnostics", ctx);
    const info = JSON.parse(notices.at(-1));
    assert.equal(info.capability, "missing");
    assert.equal(
      info.diagnostics.filter((message) => message === warning).length,
      1,
    );
    await emit("session_shutdown", { reason: "reload" });
    await emit("session_start");
    // Retire a new runtime before its absence grace expires.
    await emit("session_shutdown", { reason: "quit" });
    const count = notices.length;
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(notices.length, count);
    assert.equal(statuses.size, 0);
  }));

test("slow initial observation stays quiet until later startup capability discovery", async () =>
  scenario(async ({ emit, pi, tmux, notices }) => {
    const inventory = Tmux.prototype.inventory;
    let release, entered;
    const pause = new Promise((resolve) => {
      release = resolve;
    });
    const observing = new Promise((resolve) => {
      entered = resolve;
    });
    Tmux.prototype.inventory = async function (...args) {
      if (this.socket === tmux.socket) {
        entered();
        await pause;
      }
      return inventory.apply(this, args);
    };
    const starting = emit("session_start");
    try {
      await observing;
      // Two poll intervals pass while the monitor's session_start is awaiting tmux.
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.ok(
        !notices.some((message) => message.includes("Width-aware compositor")),
      );
      release();
      await starting;
      pi.events.emit("footer-compositor:dynamic:available", {
        version: 1,
        instanceId: "later-startup-handler",
        register: () => () => {},
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.ok(
        !notices.some((message) => message.includes("Width-aware compositor")),
      );
    } finally {
      release();
      Tmux.prototype.inventory = inventory;
      await starting;
    }
  }));

test("loading, polling and server status never bootstrap an absent explicit socket", async () =>
  scenario(async ({ emit, commands, agent, cwd, ctx, notices }) => {
    const socket = join(cwd, "never-created/socket");
    await writeFile(
      join(agent, "pi-tmux-monitor.json"),
      JSON.stringify({
        socketPath: socket,
        pollIntervalMs: 50,
        heartbeatIntervalMs: 50,
        staleAfterMs: 150,
      }),
    );
    await emit("session_start");
    await new Promise((r) => setTimeout(r, 150));
    assert.deepEqual(notices, []);
    await commands.get("tmux-monitor").handler("t s", ctx);
    assert.match(notices.at(-1), /Server: absent/);
    const { access } = await import("node:fs/promises");
    await assert.rejects(access(join(cwd, "never-created")), {
      code: "ENOENT",
    });
  }));

test("fresh context resolves launch socket independently of inherited observation", async () =>
  scenario(async ({ emit, agent, cwd, tmux, commands, ctx, notices }) => {
    await writeFile(
      join(agent, "pi-tmux-monitor.json"),
      JSON.stringify({
        pollIntervalMs: 50,
        heartbeatIntervalMs: 50,
        staleAfterMs: 150,
      }),
    );
    process.env.TMUX = `${tmux.socket},${await tmux.call("display-message", "-p", "#{pid}")},0`;
    await emit("session_start");
    const event = { systemPromptOptions: {} };
    await emit("before_agent_start", event);
    const info = JSON.parse(
      event.systemPromptOptions.appendSystemPrompt
        .split("<pi-tmux-monitor-launch-context>")[1]
        .trim()
        .split("\n")[0],
    );
    assert.equal(info.socket, join(cwd, ".agents/run/tmux-socket"));
    assert.equal(info.observerSocket, tmux.socket);
    assert.equal(info.owner, "original");
    assert.ok(info.helper.endsWith("/scripts/pi-tmux-monitor.mjs"));
    await commands.get("tmux-monitor").handler("diagnostics", ctx);
    assert.equal(JSON.parse(notices.at(-1)).socket, info.socket);
  }));

test("reporter loss and inventory failures stay in diagnostics without notifications", async () =>
  scenario(
    async ({ emit, tmux, setTrusted, commands, ctx, notices, statuses }) => {
      const { job, reporter } = await import("./fixtures.mjs");
      let seq = 1,
        failing = false;
      const original = Tmux.prototype.inventory;
      Tmux.prototype.inventory = async function (...args) {
        if (this.socket !== tmux.socket) return original.apply(this, args);
        if (failing) throw Error("unavailable");
        return [
          {
            paneId: "%20",
            pid: "20",
            sessions: [],
            job: job({ paneId: "%20", heartbeatSeq: seq }),
            pi: reporter({
              paneId: "%20",
              jobId: "j",
              kind: "batch",
              state: "active",
              heartbeatSeq: seq,
            }),
          },
        ];
      };
      try {
        setTrusted(true);
        await emit("session_start");
        seq++;
        for (let i = 0; i < 60 && statuses.get(STATUS_KEY) !== "A"; i++)
          await new Promise((r) => setTimeout(r, 10));
        assert.equal(statuses.get(STATUS_KEY), "A");
        await new Promise((r) => setTimeout(r, 220));
        assert.ok(!notices.some((s) => s.startsWith("No fresh application")));
        await commands.get("tmux-monitor").handler("diagnostics", ctx);
        const info = JSON.parse(notices.at(-1));
        assert.ok(
          info.diagnostics.some((s) => s.startsWith("No fresh application")),
        );
        assert.equal(info.slots[0].presentationState, "active");
        assert.equal(info.slots[0].uncertain, true);
        failing = true;
        const count = notices.length;
        await new Promise((r) => setTimeout(r, 150));
        assert.equal(notices.length, count);
        await commands.get("tmux-monitor").handler("diagnostics", ctx);
        const failure = JSON.parse(notices.at(-1));
        assert.equal(failure.degraded, true);
        assert.ok(
          failure.diagnostics.some((s) =>
            s.startsWith("Monitor server unavailable"),
          ),
        );
      } finally {
        Tmux.prototype.inventory = original;
      }
    },
  ));

function captureBackground(t, pi) {
  const output = [];
  for (const method of ["log", "info", "warn", "error", "debug"])
    t.mock.method(console, method, (...args) => output.push(args));
  for (const method of ["sendMessage", "sendUserMessage", "appendEntry"])
    pi[method] = (...args) => output.push(args);
  return output;
}

function ownPaneEnvironment(tmux) {
  return tmux.call("display-message", "-p", "#{pid}").then((pid) => {
    process.env.TMUX = `${tmux.socket},${pid},0`;
    process.env.TMUX_PANE = "%0";
  });
}

test("rejected configuration and reporter registration remain inspectable without startup output", (t) =>
  scenario(async ({ emit, agent, commands, ctx, notices, pi }) => {
    const output = captureBackground(t, pi);
    await writeFile(join(agent, "pi-tmux-monitor.json"), "{invalid");
    process.env.TMUX = "/missing-monitor-server,1,0";
    process.env.TMUX_PANE = "%0";
    await emit("session_start");
    assert.deepEqual(notices, []);
    assert.deepEqual(output, []);
    await commands.get("tmux-monitor").handler("diagnostics", ctx);
    const info = JSON.parse(notices.at(-1));
    assert.ok(
      info.diagnostics.some((s) =>
        s.startsWith("Rejected monitor configuration:"),
      ),
    );
    assert.ok(
      info.diagnostics.includes(
        "Pi reporter could not register with its tmux server",
      ),
    );
    assert.equal(info.scope, "descendants");
    await commands.get("tmux-monitor").handler("unknown", ctx);
    assert.match(notices.at(-1), /Unknown or extra arguments/);
    assert.deepEqual(output, []);
  }));

test("theme fallback, invalid metadata and cyclic lineage are quiet and retained", (t) =>
  scenario(async ({ emit, tmux, agent, commands, ctx, notices, pi }) => {
    const output = captureBackground(t, pi);
    await writeFile(
      join(agent, "pi-tmux-monitor.json"),
      JSON.stringify({
        socketPath: tmux.socket,
        activeTheme: "missing",
        pollIntervalMs: 50,
        heartbeatIntervalMs: 50,
        staleAfterMs: 150,
      }),
    );
    await ownPaneEnvironment(tmux);
    await tmux.write("owner", "$0", {
      v: 1,
      ownerSessionId: "original",
      ancestors: [],
    });
    await tmux.call(
      "set-option",
      "-p",
      "-t",
      "%0",
      "@pi-tmux-monitor-pi",
      "invalid",
    );
    await emit("session_start");
    await new Promise((r) => setTimeout(r, 120));
    assert.deepEqual(notices, []);
    assert.deepEqual(output, []);
    await commands.get("tmux-monitor").handler("diagnostics", ctx);
    const info = JSON.parse(notices.at(-1));
    for (const message of [
      "Unknown active monitor theme; using default",
      "Rejected invalid monitor metadata",
      "Ignored cyclic reporter lineage",
    ])
      assert.equal(info.diagnostics.filter((s) => s === message).length, 1);
    assert.equal(info.scope, "descendants");
  }));

test("reporter writes, replacement and shutdown cleanup remain quiet across runtime reload", (t) =>
  scenario(async ({ emit, tmux, commands, ctx, notices, pi }) => {
    const output = captureBackground(t, pi);
    await ownPaneEnvironment(tmux);
    const write = Tmux.prototype.write,
      identity = Tmux.prototype.identity;
    let failWrite = true,
      replaced = false,
      failIdentity = false;
    t.mock.method(Tmux.prototype, "write", async function (...args) {
      if (args[0] === "pi" && failWrite) throw Error("write rejected");
      return write.apply(this, args);
    });
    t.mock.method(Tmux.prototype, "identity", async function (...args) {
      if (failIdentity) throw Error("unavailable");
      const value = await identity.apply(this, args);
      return replaced ? value + ":replacement" : value;
    });
    await emit("session_start");
    await emit("agent_start");
    failWrite = false;
    await emit("agent_settled", { aborted: false });
    replaced = true;
    await emit("agent_start");
    failIdentity = true;
    await emit("session_shutdown", { reason: "reload" });
    assert.deepEqual(notices, []);
    assert.deepEqual(output, []);
    failIdentity = replaced = false;
    // A new extension factory models the state boundary of module-graph reload.
    monitor(pi);
    await emit("session_start");
    assert.deepEqual(notices, []);
    await commands.get("tmux-monitor").handler("diagnostics", ctx);
    const info = JSON.parse(notices.at(-1));
    for (const message of [
      "Pi reporter metadata write failed",
      "Pi reporter server was replaced; reporting stopped",
      "Pi reporter cleanup failed",
    ])
      assert.equal(info.diagnostics.filter((s) => s === message).length, 1);
    assert.equal((await tmux.record("pi", "%0")).state, "idle");
    assert.deepEqual(output, []);
  }));

test("compositor registration and cleanup failures do not interrupt shutdown or lose diagnostics", (t) =>
  scenario(async ({ emit, commands, ctx, notices, pi, statuses }) => {
    const output = captureBackground(t, pi);
    await emit("session_start");
    pi.events.emit("footer-compositor:dynamic:available", {
      version: 1,
      instanceId: "broken",
      register() {
        throw Error("registration rejected");
      },
    });
    pi.events.emit("footer-compositor:dynamic:available", {
      version: 1,
      instanceId: "cleanup-broken",
      register: () => () => {
        throw Error("cleanup rejected");
      },
    });
    await emit("session_shutdown", { reason: "reload" });
    assert.deepEqual(notices, []);
    assert.deepEqual(output, []);
    assert.equal(statuses.size, 0);
    monitor(pi);
    await emit("session_start");
    await commands.get("tmux-monitor").handler("diagnostics", ctx);
    const info = JSON.parse(notices.at(-1));
    assert.ok(
      info.diagnostics.includes(
        "Compositor registration failed; retaining any working registration or static fallback",
      ),
    );
    assert.ok(info.diagnostics.includes("Compositor cleanup failed"));
    assert.deepEqual(output, []);
  }));

test("explicit diagnostics remain bounded across repeated extension reloads without emitting raw rejected content", (t) =>
  scenario(async ({ emit, agent, commands, ctx, notices, pi }) => {
    const output = captureBackground(t, pi);
    for (let i = 0; i < 20; i++) {
      const layer = join(agent, "reload-" + i);
      await mkdir(layer);
      await writeFile(
        join(layer, "pi-tmux-monitor.json"),
        "private rejected content",
      );
      process.env.PI_CODING_AGENT_DIR = layer;
      await emit("session_shutdown", { reason: "reload" });
      monitor(pi);
      await emit("session_start");
    }
    assert.deepEqual(notices, []);
    assert.deepEqual(output, []);
    await commands.get("tmux-monitor").handler("diagnostics", ctx);
    const info = JSON.parse(notices.at(-1));
    assert.equal(info.diagnostics.length, 16);
    assert.equal(new Set(info.diagnostics).size, 16);
    assert.ok(info.diagnostics.every((s) => s.length <= 320));
    assert.ok(!notices.at(-1).includes("private rejected content"));
  }));
