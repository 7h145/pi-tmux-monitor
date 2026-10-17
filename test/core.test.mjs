import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth, stripTerminalSequences } from "@earendil-works/pi-tui";
import { DEFAULTS, applyLayer, loadConfig } from "../src/config.mts";
import { format, fullSummary } from "../src/formatter.mts";
import {
  STATES,
  parseRecord,
  parseTmux,
  lineage,
  serializeRecord,
} from "../src/protocol.mts";
import { Reconciler, eligible } from "../src/reconcile.mts";
import { parseCLI, piArgs } from "../src/launch.mts";
import { quote } from "../src/shell.mts";
const theme = { fg: (_, s) => `\x1b[32m${s}\x1b[39m` };
import { job, reporter } from "./fixtures.mjs";
const pane = (j = null, r = null, patch = {}) => ({
  paneId: "%1",
  pid: "10",
  sessions: [
    { name: "owned", owner: { ownerSessionId: "owner", ancestors: ["root"] } },
  ],
  job: j,
  pi: r,
  ...patch,
});
const slots = (...counts) =>
  STATES.flatMap((state, i) =>
    Array.from({ length: counts[i] ?? 0 }, () => ({ state })),
  );
const plain = (r) => stripTerminalSequences(r.text ?? r);
test("formatter thresholds, singleton groups and priority", () => {
  assert.equal(format([], DEFAULTS, theme, 80).mode, "hidden");
  assert.equal(format(slots(2), DEFAULTS, theme, 0).mode, "hidden");
  assert.equal(plain(format(slots(2), DEFAULTS, theme, 2)), "__");
  const fixture = ["unregistered", "idle", "idle", "running"].map((state) => ({
    state,
  }));
  assert.equal(plain(format(fixture, DEFAULTS, theme, 4)), ":__R");
  assert.equal(
    plain(fullSummary(slots(5, 3, 1, 1, 0, 1), DEFAULTS, theme)),
    "A3_5R+?",
  );
  assert.equal(
    format(slots(5, 3, 1, 1, 0, 1), DEFAULTS, theme, 9).mode,
    "summary",
  );
  assert.equal(
    plain(format(slots(100, 20, 0, 0, 2, 1), DEFAULTS, theme, 6)),
    "!2A20…",
  );
  assert.equal(
    plain(format(slots(100, 20, 0, 0, 2, 1), DEFAULTS, theme, 8)),
    "!2A20?…",
  );
  assert.equal(plain(format(slots(10000, 1000), DEFAULTS, theme, 1)), "…");
  assert.equal(plain(format(slots(10000, 1000), DEFAULTS, theme, 3)), "…");
});
test("both themes fit every budget and preserve full-set counts", () => {
  const gaudy = applyLayer(
    DEFAULTS,
    {
      activeTheme: "gaudy",
      themes: {
        gaudy: {
          states: Object.fromEntries(
            STATES.map((s, i) => [
              s,
              { glyph: ["·", "●", "◇", "✓", "!", "?", "○"][i] },
            ]),
          ),
        },
      },
    },
    "/config.json",
  );
  for (const config of [DEFAULTS, gaudy])
    for (let width = 0; width <= 160; width++)
      for (const counts of [
        [1, 1, 1, 1, 1, 1, 1],
        [0, 0, 0, 0, 0, 0, 1],
        [15, 10, 2, 5, 20, 4, 3],
      ]) {
        const result = format(slots(...counts), config, theme, width);
        assert.ok(
          visibleWidth(result.text) <= width,
          JSON.stringify({ result, width }),
        );
      }
  assert.equal(
    plain(format(slots(1, 1, 1, 1, 1, 1, 1), DEFAULTS, theme, 7)),
    "_AR+!?:",
  );
  assert.equal(
    plain(format(slots(1, 1, 1, 1, 1, 1, 1), gaudy, theme, 7)),
    "·●◇✓!?○",
  );
});
test("configuration layers, trust, malformed files, selection, inheritance", async () => {
  const dir = await mkdtemp(join(tmpdir(), "monitor-config-"));
  try {
    const agent = join(dir, "agent"),
      project = join(dir, "project");
    await mkdir(agent);
    await mkdir(join(project, ".pi"), { recursive: true });
    await writeFile(
      join(agent, "pi-tmux-monitor.json"),
      JSON.stringify({
        scope: "server",
        themes: {
          default: { states: { active: { fg: null } } },
          custom: { states: { active: { glyph: "A" } } },
        },
        socketPath: "socket",
      }),
    );
    await writeFile(
      join(project, ".pi/pi-tmux-monitor.json"),
      JSON.stringify({
        scope: "children",
        activeTheme: "custom",
        themes: { custom: { states: { idle: { fg: "text" } } } },
      }),
    );
    const global = await loadConfig(agent, project, false);
    assert.equal(global.scope, "server");
    assert.equal(global.socketPath, join(agent, "socket"));
    const config = await loadConfig(agent, project, true);
    assert.equal(config.scope, "children");
    assert.equal(config.activeTheme, "custom");
    assert.equal(config.themes.custom.states.active.glyph, "A");
    assert.equal(config.themes.custom.states.running.glyph, "R");
    assert.equal(config.themes.custom.states.idle.fg, "text");
    const diagnostics = [];
    await writeFile(join(project, ".pi/pi-tmux-monitor.json"), "{broken");
    assert.equal(
      (await loadConfig(agent, project, true, (s) => diagnostics.push(s)))
        .scope,
      "server",
    );
    assert.equal(diagnostics.length, 1);
    await writeFile(
      join(project, ".pi/pi-tmux-monitor.json"),
      '{"activeTheme":"absent"}',
    );
    assert.equal(
      (await loadConfig(agent, project, true)).activeTheme,
      "default",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("reject invalid config layers wholly", () => {
  for (const patch of [
    { schemaVersion: 2 },
    { wat: true },
    { pollIntervalMs: 0 },
    { heartbeatIntervalMs: 6000 },
    { staleAfterMs: 14999 },
    { ownedSessions: "owned" },
    { summaryOrder: ["active"] },
    JSON.parse('{"themes":{"__proto__":{}}}'),
    { themes: { default: { states: { active: { glyph: "_" } } } } },
    { themes: { x: { states: { active: { glyph: "3" } } } } },
    { themes: { x: { states: { active: { glyph: "界" } } } } },
    { themes: { x: { states: { active: { glyph: "\x1b" } } } } },
    { themes: { x: { states: { active: { fg: "red" } } } } },
  ])
    assert.throws(() => applyLayer(DEFAULTS, patch, "/config.json"));
});
test("protocol validation, identity and bounded redacted diagnostics", () => {
  assert.equal(parseTmux("/tmp/a,b,123,0"), "/tmp/a,b");
  assert.equal(parseTmux("bad"), null);
  assert.deepEqual(lineage("owner", ["root"]), ["root", "owner"]);
  for (const a of [["owner"], ["root", "root"]])
    assert.throws(() => lineage("owner", a));
  assert.ok(parseRecord(JSON.stringify(job()), "job", "%1"));
  assert.ok(
    parseRecord(JSON.stringify(job({ phase: undefined })), "job", "%1"),
  );
  assert.ok(parseRecord(JSON.stringify(reporter()), "pi", "%1"));
  const diagnostics = [];
  for (const raw of [
    "{secret",
    "x".repeat(16385),
    JSON.stringify(job({ paneId: "%2" })),
    JSON.stringify(job({ v: 2 })),
    JSON.stringify(reporter({ ancestors: ["child", "owner"] })),
  ])
    assert.equal(
      parseRecord(raw, "job", "%1", (s) => diagnostics.push(s)),
      null,
    );
  assert.ok(
    diagnostics.every((s) => s === "Rejected invalid monitor metadata"),
  );
});
test("freshness and independent lifetime precedence", () => {
  const r = new Reconciler(15000),
    j = job(),
    p = pane(j);
  const state = (time) => r.reconcile([p], time)[0].state;
  assert.equal(state(0), "unknown");
  j.heartbeatSeq++;
  assert.equal(state(5000), "running");
  assert.equal(state(20000), "unknown");
  j.phase = "success";
  j.exitCode = 0;
  assert.equal(state(25000), "success");
  r.disconnect();
  assert.equal(state(30000), "success");
  j.jobId = "new";
  j.phase = "running";
  j.exitCode = null;
  j.kind = "service";
  assert.equal(state(35000), "unknown");
  j.heartbeatSeq++;
  assert.equal(state(40000), "running");
  j.kind = "interactive";
  assert.equal(state(40001), "running");
  j.runtime = "pi";
  p.pi = reporter({ jobId: "new", state: "idle" });
  assert.equal(state(40002), "running");
  p.pi.heartbeatSeq++;
  assert.equal(state(45000), "idle");
  p.pi.state = "failed";
  p.pi.heartbeatSeq++;
  assert.equal(state(45001), "failed");
  assert.equal(state(60001), "unknown");
  j.kind = "batch";
  p.pi.kind = "batch";
  p.pi.state = "idle";
  p.pi.heartbeatSeq++;
  assert.equal(state(60002), "idle");
  j.phase = "failed";
  j.exitCode = 2;
  assert.equal(state(60003), "failed");
});
test("generation reuse permanently invalidates old outcomes", () => {
  const r = new Reconciler(15000),
    p = pane(job({ phase: "success", exitCode: 0 }));
  assert.equal(r.reconcile([p], 0)[0].state, "success");
  p.pi = reporter();
  assert.equal(r.reconcile([p], 1)[0].state, "success");
  p.pi.heartbeatSeq++;
  assert.equal(r.reconcile([p], 5000)[0].state, "idle");
  assert.equal(r.reconcile([p], 20000)[0].state, "unknown");
  p.job = job({ jobId: "next", phase: "success", exitCode: 0 });
  p.pi = null;
  assert.equal(r.reconcile([p], 20001)[0].state, "success");
  p.pid = "20";
  assert.equal(r.reconcile([p], 20002)[0].state, "unknown");
  r.reconcile([], 20003);
  assert.equal(r.reconcile([p], 20004)[0].state, "success");
});
test("scope modes, registered authority, unregistered evidence and own pane", () => {
  const p = pane(job()),
    config = { ...DEFAULTS };
  assert.equal(eligible(p, "root", config, null), true);
  config.scope = "children";
  assert.equal(eligible(p, "root", config, null), false);
  assert.equal(eligible(p, "owner", config, null), true);
  assert.equal(eligible(p, "owner", config, "%1"), false);
  const u = pane();
  assert.equal(eligible(u, "owner", config, null), true);
  assert.equal(eligible(u, "stranger", config, null), false);
  u.sessions = [{ name: "agent-unrelated", owner: null }];
  assert.equal(eligible(u, "owner", config, null), false);
  assert.equal(
    eligible(
      u,
      "owner",
      { ...config, ownedSessions: ["agent-unrelated"] },
      null,
    ),
    true,
  );
  assert.equal(eligible(u, "owner", config, null), false);
  assert.equal(
    eligible(u, "stranger", { ...config, scope: "server" }, null),
    true,
  );
  assert.equal(
    eligible(
      u,
      "stranger",
      { ...config, scope: "server", includeUnregistered: false },
      null,
    ),
    false,
  );
  p.job = job({ ownerSessionId: "other", ancestors: ["other"] });
  assert.equal(eligible(p, "owner", config, null), false);
});
test("helper explicit owner/ancestry, flags, quoting and defaults", () => {
  const plan = parseCLI(
    [
      "pi",
      "--session",
      "a",
      "--window",
      "w",
      "--owner",
      "fresh",
      "--ancestors-json",
      '["root"]',
      "--mode",
      "batch",
      "--",
      "--no-extensions",
      "--provider",
      "X",
      "--model",
      "Y",
      "--",
      "-prompt",
    ],
    { PI_SESSION_ID: "stale" },
    "/work",
  );
  assert.equal(plan.owner, "fresh");
  assert.deepEqual(plan.ancestors, ["root", "fresh"]);
  assert.equal(plan.heartbeat, 5000);
  assert.deepEqual(plan.argv.slice(-2), ["--", "-prompt"]);
  assert.ok(plan.argv.includes("--print"));
  assert.ok(plan.argv.includes("-e"));
  assert.ok(plan.argv.includes("--no-extensions"));
  assert.deepEqual(piArgs(["--model", "m", "--", "x"], "interactive", true), [
    "--model",
    "m",
    "--",
    "x",
  ]);
  assert.equal(quote("a'b; $x"), "'a'\\''b; $x'");
  assert.throws(() =>
    parseCLI(
      ["launch", "--session", "a", "--window", "w", "--", "true"],
      {},
      "/work",
    ),
  );
  assert.throws(() =>
    parseCLI(
      [
        "launch",
        "--session",
        "a",
        "--window",
        "w",
        "--owner",
        "x",
        "--ancestors-json",
        '["x"]',
        "--",
        "true",
      ],
      {},
      "/work",
    ),
  );
});

test("display states and glyphs are distinct from workload kinds", () => {
  assert.deepEqual(STATES, [
    "idle",
    "active",
    "running",
    "success",
    "failed",
    "unknown",
    "unregistered",
  ]);
  assert.deepEqual(DEFAULTS.themes.default.states.active, {
    glyph: "A",
    fg: "accent",
  });
  assert.deepEqual(DEFAULTS.themes.default.states.running, {
    glyph: "R",
    fg: "muted",
  });
  assert.ok(parseRecord(JSON.stringify(job({ kind: "service" })), "job", "%1"));
  assert.equal(
    parseRecord(JSON.stringify(job({ kind: "running" })), "job", "%1"),
    null,
  );
  assert.equal(
    parseRecord(JSON.stringify(reporter({ state: "running" })), "pi", "%1"),
    null,
  );
  assert.throws(() =>
    applyLayer(
      DEFAULTS,
      { themes: { default: { states: { service: { glyph: "S" } } } } },
      "/config.json",
    ),
  );
  assert.throws(() =>
    applyLayer(
      DEFAULTS,
      {
        summaryOrder: DEFAULTS.summaryOrder.map((s) =>
          s === "running" ? "service" : s,
        ),
      },
      "/config.json",
    ),
  );
});

for (const kind of ["batch", "service", "interactive"]) {
  test(`${kind}: fresh application state, independent liveness, reporter loss and retained outcomes`, () => {
    const diagnostics = [];
    const reconciler = new Reconciler(15, (message) =>
      diagnostics.push(message),
    );
    const j = job({ kind, runtime: "pi" });
    const p = pane(j, reporter({ kind, jobId: j.jobId }));
    const state = (time) => reconciler.reconcile([p], time)[0].state;
    assert.equal(state(0), "unknown");
    j.heartbeatSeq++;
    assert.equal(state(1), "running"); // New application evidence cannot displace fresh liveness.
    assert.equal(diagnostics.length, 0);
    p.pi.heartbeatSeq++;
    assert.equal(state(2), "idle");
    for (const [time, activity] of [
      [3, "active"],
      [4, "failed"],
      [5, "idle"],
    ]) {
      p.pi.state = activity;
      p.pi.heartbeatSeq++;
      assert.equal(state(time), activity);
    }
    // A settled batch/service Pi stays idle before wrapper exit, even with a stale runner.
    p.pi.heartbeatSeq++;
    assert.equal(state(16), "idle");
    j.heartbeatSeq++;
    assert.equal(state(30), "idle");
    assert.equal(state(31), "running"); // Application state is stale; runner remains fresh.
    assert.match(diagnostics[0], /No fresh application state for pane %1/);
    assert.equal(state(32), "running");
    assert.equal(diagnostics.length, 1);
    p.pi = null;
    assert.equal(state(33), "running");
    assert.equal(state(45), "unknown");
    j.heartbeatSeq++;
    assert.equal(state(46), "running");
    p.pi = reporter({ kind, jobId: j.jobId, instanceId: "replacement" });
    assert.equal(state(47), "running");
    p.pi.heartbeatSeq++;
    assert.equal(state(48), "idle");
    p.pi.state = "failed";
    p.pi.heartbeatSeq++;
    assert.equal(state(49), "failed");
    j.heartbeatSeq++;
    assert.equal(state(63), "failed");
    assert.equal(state(64), "running"); // A stale application failure is not a command outcome.
    assert.equal(diagnostics.length, 2);
    j.phase = "success";
    j.exitCode = 0;
    assert.equal(state(65), "success");
    reconciler.disconnect();
    assert.equal(state(1000), "success");
    j.phase = "failed";
    j.exitCode = 2;
    assert.equal(state(1001), "failed");
    assert.equal(diagnostics.length, 2);
  });

  test(`${kind}: generic commands need running-phase evidence; standalone Pi state ignores kind`, () => {
    const r = new Reconciler(15);
    const p = pane(job({ kind }));
    assert.equal(r.reconcile([p], 0)[0].state, "unknown");
    p.job.heartbeatSeq++;
    assert.equal(r.reconcile([p], 1)[0].state, "running");
    p.job.phase = undefined;
    p.job.heartbeatSeq++;
    assert.equal(r.reconcile([p], 2)[0].state, "unknown");
    p.job = null;
    p.pi = reporter({ kind });
    assert.equal(r.reconcile([p], 3)[0].state, "unknown");
    p.pi.heartbeatSeq++;
    assert.equal(r.reconcile([p], 4)[0].state, "idle");
    p.pi.state = "active";
    p.pi.heartbeatSeq++;
    assert.equal(r.reconcile([p], 5)[0].state, "active");
    p.pi.state = undefined;
    p.pi.heartbeatSeq++;
    assert.equal(r.reconcile([p], 6)[0].state, "unknown");
    p.pi = null;
    assert.equal(r.reconcile([p], 7)[0].state, "unregistered");
  });
}

test("fresh runner survives reporter removal, incompatible reports, and reporter restart", () => {
  const diagnostics = [];
  const r = new Reconciler(15, (message) => diagnostics.push(message));
  const p = pane(
    job({ kind: "interactive", runtime: "pi" }),
    reporter({ jobId: "j" }),
  );
  r.reconcile([p], 0);
  p.job.heartbeatSeq++;
  p.pi.heartbeatSeq++;
  assert.equal(r.reconcile([p], 1)[0].state, "idle");
  p.pi = null;
  assert.equal(r.reconcile([p], 2)[0].state, "running");
  assert.equal(diagnostics.length, 1);
  p.pi = reporter({ jobId: "other-job", state: "active", instanceId: "other" });
  r.reconcile([p], 3);
  p.pi.heartbeatSeq++;
  assert.equal(r.reconcile([p], 4)[0].state, "running");
  p.pi = reporter({ jobId: "j", state: "active", instanceId: "new" });
  assert.equal(r.reconcile([p], 5)[0].state, "running");
  p.pi.heartbeatSeq++;
  assert.equal(r.reconcile([p], 6)[0].state, "active");
  assert.equal(r.reconcile([p], 21)[0].state, "unknown");
  p.job = job({ jobId: "next", kind: "interactive" });
  p.pi = null;
  r.reconcile([p], 22);
  p.job.heartbeatSeq++;
  assert.equal(r.reconcile([p], 23)[0].state, "running");
  assert.equal(diagnostics.length, 2); // New workload does not inherit the prior reporter expectation.
});

test("record serialization preserves text in bounded ASCII JSON", () => {
  const record = job({ label: "quote ' \" $HOME ${HOME} \\ 雪 🦊" });
  const raw = serializeRecord(record);
  assert.match(raw, /^[\x20-\x7e]+$/);
  assert.ok(!raw.includes("$"));
  assert.deepEqual(parseRecord(raw, "job", "%1"), record);
  assert.throws(
    () => serializeRecord({ value: "雪".repeat(3000) }),
    /exceeds limit/,
  );
});
