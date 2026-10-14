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
      theme: { fg: (_, s) => s },
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
      await commands.get("tmux-monitor").handler("", ctx);
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
      await commands.get("tmux-monitor").handler("", ctx);
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
