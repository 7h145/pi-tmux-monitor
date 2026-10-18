import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { DEFAULTS, applyLayer, loadConfig } from "../src/config.mts";
import { ForegroundCycles } from "../src/cycles.mts";
import { Reconciler } from "../src/reconcile.mts";
import { Observer } from "../src/observer.mts";
import { format, fullSummary } from "../src/formatter.mts";
import { job, reporter } from "./fixtures.mjs";
const theme = {
  fg: (fg, text) => `\x1b[${fg === "dim" ? 90 : 32}m${text}\x1b[39m`,
};
const plain = (value) => stripTerminalSequences(value.text ?? value);
const pane = (i, patch = {}) => ({
  paneId: `%${i}`,
  pid: String(i + 10),
  sessions: [],
  pi: null,
  job: job({ paneId: `%${i}`, jobId: `j${i}`, ...patch }),
});
function fixture(delay = 3) {
  const cycles = new ForegroundCycles();
  const config = { ...DEFAULTS, hybridDelayCycles: delay };
  const reconciler = new Reconciler(config, undefined, cycles);
  let rows = [pane(1)],
    time = 0;
  const scan = () => reconciler.reconcile(structuredClone(rows), time);
  const cached = () => reconciler.expire(structuredClone(rows), time);
  const start = () => {
    cycles.input(true, true, false);
    cycles.prepare();
    cycles.start();
    cycles.message("user");
  };
  const finish = () => {
    const id = cycles.settle();
    if (id !== null) reconciler.completeCycle(id);
    return cached();
  };
  const cycle = () => {
    start();
    return finish();
  };
  const success = (i = 0) =>
    Object.assign(rows[i].job, { phase: "success", exitCode: 0 });
  return {
    cycles,
    reconciler,
    config,
    scan,
    cached,
    start,
    finish,
    cycle,
    success,
    get rows() {
      return rows;
    },
    set rows(value) {
      rows = value;
    },
    set time(value) {
      time = value;
    },
  };
}

test("hybrid delay defaults to three and accepts only nonnegative safe integers", () => {
  assert.equal(DEFAULTS.hybridDelayCycles, 3);
  for (const value of [0, 1, 2, 3, Number.MAX_SAFE_INTEGER])
    assert.equal(
      applyLayer(DEFAULTS, { hybridDelayCycles: value }, "/config")
        .hybridDelayCycles,
      value,
    );
  for (const value of [
    -1,
    0.5,
    "3",
    null,
    true,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
  ])
    assert.throws(() =>
      applyLayer(DEFAULTS, { hybridDelayCycles: value }, "/config"),
    );
});

test("hybrid delay follows trust and layer precedence, rejecting an invalid file wholly", async () => {
  const dir = await mkdtemp("/tmp/monitor-delay-config-");
  try {
    const agent = join(dir, "agent"),
      cwd = join(dir, "project");
    await mkdir(agent);
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await writeFile(
      join(agent, "pi-tmux-monitor.json"),
      '{"hybridDelayCycles":2}',
    );
    await writeFile(
      join(cwd, ".pi/pi-tmux-monitor.json"),
      '{"hybridDelayCycles":0}',
    );
    assert.equal((await loadConfig(agent, cwd, false)).hybridDelayCycles, 2);
    assert.equal((await loadConfig(agent, cwd, true)).hybridDelayCycles, 0);
    await writeFile(
      join(cwd, ".pi/pi-tmux-monitor.json"),
      '{"hybridDelayCycles":-1,"scope":"server"}',
    );
    const diagnostics = [];
    const effective = await loadConfig(agent, cwd, true, (message) =>
      diagnostics.push(message),
    );
    assert.equal(effective.hybridDelayCycles, 2);
    assert.equal(effective.scope, "descendants");
    assert.equal(diagnostics.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

for (const delay of [0, 1, 2, 3])
  for (const duringCycle of [false, true])
    test(`delay ${delay}, outcome ${duringCycle ? "during a cycle" : "at the prompt"}: immediate glyph, exact eligible return`, () => {
      const f = fixture(delay);
      f.scan();
      if (duringCycle) f.start();
      f.success();
      let slot = f.scan()[0];
      assert.equal(slot.state, "success");
      assert.equal(slot.presentationState, "success");
      assert.equal(slot.compressionEligible, delay === 0);
      if (duringCycle)
        assert.equal(f.finish()[0].compressionEligible, delay === 0);
      for (let i = 1; i <= delay; i++) {
        slot = f.cycle()[0];
        assert.equal(slot.compressionEligible, i === delay);
      }
      assert.ok(!f.reconciler.generations.get("%1").hybridDelay);
    });

test("only final user-cycle returns advance the clock; other inputs, loop restarts and duplicate returns do not", () => {
  const f = fixture(2);
  f.scan();
  f.success();
  f.scan();
  for (let i = 0; i < 10; i++) {
    f.cycles.input(false, true, false);
    f.cycles.prepare();
    f.cycles.start();
    f.finish();
    f.cycles.start();
    f.finish();
    f.time = 1e6 + i;
    f.scan();
    f.cached();
    assert.equal(f.cycles.completed, 0n);
    assert.equal(f.cached()[0].compressionEligible, false);
  }
  f.start();
  for (let i = 0; i < 10; i++) {
    f.cycles.input(true, false, true);
    f.cycles.start();
    assert.equal(f.cycles.completed, 0n);
  }
  assert.equal(f.finish()[0].compressionEligible, false);
  f.finish();
  assert.equal(f.cycles.completed, 1n);
  assert.equal(f.cycle()[0].compressionEligible, true);
});

test("handled or failed preflight inputs do not consume cycles or leave a phantom exclusion", () => {
  const f = fixture(1);
  f.scan();
  f.cycles.input(true, true, false);
  f.success();
  f.scan();
  // No agent run followed this input. A later custom/background run is not it.
  f.cycles.start();
  f.finish();
  assert.equal(f.cycles.completed, 0n);
  assert.equal(f.cycle()[0].compressionEligible, true);
});

test("an outcome seen during preflight excludes that request if it actually runs", () => {
  const f = fixture(1);
  f.scan();
  f.cycles.input(true, true, false);
  f.success();
  f.scan();
  f.cycles.prepare();
  f.cycles.start();
  f.cycles.message("user");
  assert.equal(f.finish()[0].compressionEligible, false);
  assert.equal(f.cycle()[0].compressionEligible, true);
});

test("custom-message starts cannot claim a pending input", () => {
  const f = fixture(1);
  f.scan();
  f.success();
  f.scan();
  f.cycles.input(true, true, false);
  f.cycles.prepare();
  f.cycles.start();
  f.cycles.message("custom");
  f.finish();
  assert.equal(f.cycles.completed, 0n);
  assert.equal(f.cycle()[0].compressionEligible, true);
});

test("initial outcomes form a mature baseline, but later fast jobs get independent delays", () => {
  const f = fixture(2);
  f.rows = Array.from({ length: 6 }, (_, i) =>
    pane(i + 1, { phase: "success", exitCode: 0 }),
  );
  assert.ok(f.scan().every((p) => p.compressionEligible));
  assert.equal(plain(format(f.scan(), f.config, theme, 100)), "+6");
  f.rows.push(pane(7, { phase: "failed", exitCode: 1 }));
  assert.equal(f.scan().at(-1).compressionEligible, false);
  f.cycle();
  f.rows.push(pane(8, { phase: "success", exitCode: 0 }));
  f.scan();
  const slots = f.cycle();
  assert.equal(slots[6].compressionEligible, true);
  assert.equal(slots[7].compressionEligible, false);
  assert.equal(f.cycle()[7].compressionEligible, true);
});

test("empty initial inventory is still a baseline; later completed workloads are recent", () => {
  const f = fixture(1);
  f.rows = [];
  f.scan();
  f.rows = [pane(1, { phase: "success", exitCode: 0 })];
  assert.equal(f.scan()[0].compressionEligible, false);
});

test("unchanged reports and uncertainty/recovery neither reset nor bypass pending or mature outcomes", () => {
  const f = fixture(2);
  f.rows[0].job = null;
  f.rows[0].pi = reporter({ state: "active" });
  f.scan();
  f.rows[0].pi.heartbeatSeq++;
  f.scan();
  f.rows[0].pi.state = "failed";
  f.rows[0].pi.heartbeatSeq++;
  assert.equal(f.scan()[0].compressionEligible, false);
  f.cycle();
  f.time = 15000;
  let slot = f.cached()[0];
  assert.equal(slot.uncertain, true);
  assert.equal(slot.presentationState, "failed");
  assert.equal(slot.compressionEligible, false);
  f.rows[0].pi.heartbeatSeq++;
  assert.equal(f.scan()[0].compressionEligible, false);
  assert.equal(f.cycle()[0].compressionEligible, true);
  f.time = 30000;
  assert.equal(f.cached()[0].compressionEligible, true);
  f.rows[0].pi.heartbeatSeq++;
  assert.equal(f.scan()[0].compressionEligible, true);
});

test("fresh outcome transitions and generation/pane replacement get new delays, never old age", () => {
  const f = fixture(2);
  f.scan();
  f.success();
  f.scan();
  f.cycle();
  f.cycle();
  assert.equal(f.cached()[0].compressionEligible, true);
  Object.assign(f.rows[0].job, { phase: "failed", exitCode: 1 });
  assert.equal(f.scan()[0].compressionEligible, false);
  f.cycle();
  f.rows[0].job.jobId = "replacement";
  assert.equal(f.scan()[0].compressionEligible, false);
  assert.equal(f.cycle()[0].compressionEligible, false);
  assert.equal(f.cycle()[0].compressionEligible, true);
  f.rows = [];
  f.scan();
  assert.equal(f.reconciler.generations.size, 0);
  f.rows = [pane(1, { phase: "success", exitCode: 0 })];
  assert.equal(f.scan()[0].compressionEligible, false);
});

test("large completed counts and maximum-safe delay values remain exact", () => {
  const f = fixture(Number.MAX_SAFE_INTEGER);
  f.cycles.completed = BigInt(Number.MAX_SAFE_INTEGER);
  f.scan();
  f.success();
  f.scan();
  const pending = f.reconciler.generations.get("%1").hybridDelay;
  assert.equal(pending.after, 2n * BigInt(Number.MAX_SAFE_INTEGER));
  f.cycles.completed = pending.after - 1n;
  assert.equal(f.cached()[0].compressionEligible, false);
  assert.equal(f.cycle()[0].compressionEligible, true);
});

test("pending outcomes split mature runs, expiration joins them, and all fallbacks still count everything", () => {
  const f = fixture(1);
  f.rows = Array.from({ length: 13 }, (_, i) =>
    pane(i + 1, { phase: "success", exitCode: 0 }),
  );
  f.rows[6] = pane(7);
  f.scan();
  f.success(6);
  const before = f.scan();
  assert.equal(plain(format(before, f.config, theme, 100)), "+6|+|+6");
  assert.equal(plain(fullSummary(before, f.config, theme)), "+13");
  for (let width = 0; width < 25; width++)
    assert.ok(
      visibleWidth(format(before, f.config, theme, width).text) <= width,
    );
  assert.equal(plain(format(before, f.config, theme, 3)), "+13");
  assert.equal(plain(format(before, f.config, theme, 1)), "…");
  const after = f.cycle();
  assert.equal(plain(format(after, f.config, theme, 100)), "+13");
  assert.equal(plain(fullSummary(after, f.config, theme)), "+13");
});

test("a counted return republishes cached eligibility during a pending scan without tmux I/O or freshness renewal", async () => {
  let reads = 0,
    rows = [pane(1)],
    release;
  const publications = [];
  const tmux = {
    identity: async () => {
      reads++;
      return "server";
    },
    inventory: async () => {
      reads++;
      return structuredClone(rows);
    },
  };
  const observer = new Observer({
    cwd: "/unused",
    owner: "owner",
    env: {},
    config: { ...DEFAULTS, socketPath: "/unused", hybridDelayCycles: 1 },
    tmuxFactory: () => tmux,
    clock: () => 0,
    publish: (p) => publications.push(p),
  });
  try {
    await observer.scan();
    rows[0].job.phase = "success";
    rows[0].job.exitCode = 0;
    await observer.scan();
    const age = observer.lastSuccessfulScanAt;
    tmux.inventory = async () => {
      reads++;
      return new Promise((r) => {
        release = () => r(structuredClone(rows));
      });
    };
    const scan = observer.scan();
    await new Promise((r) => setImmediate(r));
    const before = reads;
    observer.cycles.input(true, true, false);
    observer.cycles.prepare();
    observer.cycles.start();
    observer.cycles.message("user");
    observer.completeUserCycle();
    assert.equal(reads, before);
    assert.equal(observer.lastSuccessfulScanAt, age);
    assert.equal(observer.slots[0].compressionEligible, true);
    assert.equal(publications.at(-1)[0].compressionEligible, true);
    release();
    await scan;
    observer.stop();
    const count = publications.length;
    observer.completeUserCycle();
    assert.equal(publications.length, count);
  } finally {
    release?.();
    observer.stop();
  }
});

test("Pi reporter reload preserves age, but confirmed process and physical pane replacement do not", () => {
  const f = fixture(1);
  f.rows[0].job = null;
  f.rows[0].pi = reporter({ state: "active" });
  f.scan();
  f.rows[0].pi.heartbeatSeq++;
  f.scan();
  f.rows[0].pi.state = "failed";
  f.rows[0].pi.heartbeatSeq++;
  f.scan();
  assert.equal(f.cycle()[0].compressionEligible, true);
  f.rows[0].pi.instanceId = "reload";
  assert.equal(f.scan()[0].compressionEligible, true);
  f.rows[0].pi.heartbeatSeq++;
  assert.equal(f.scan()[0].compressionEligible, true);
  f.rows[0].pi.instanceId = "new-instance";
  f.rows[0].pi.processInstanceId = "new-process";
  f.scan();
  f.rows[0].pi.heartbeatSeq++;
  assert.equal(f.scan()[0].compressionEligible, false);
  f.rows[0].pid = "reused-pid";
  const slot = f.scan()[0];
  assert.equal(slot.compressionEligible, false);
  assert.ok(!f.reconciler.generations.get("%1").hybridDelay);
});

test("server namespace replacement clears pending history and establishes its own baseline", async () => {
  let identity = "original",
    rows = [pane(1)];
  const observer = new Observer({
    cwd: "/unused",
    owner: "owner",
    env: {},
    config: { ...DEFAULTS, socketPath: "/unused" },
    clock: () => 0,
    publish: () => {},
    tmuxFactory: () => ({
      identity: async () => identity,
      inventory: async () => structuredClone(rows),
    }),
  });
  try {
    await observer.scan();
    Object.assign(rows[0].job, { phase: "success", exitCode: 0 });
    await observer.scan();
    assert.equal(observer.slots[0].compressionEligible, false);
    identity = "replacement";
    await observer.scan();
    assert.equal(observer.slots[0].compressionEligible, true);
    assert.ok(!observer.reconciler.generations.get("%1").hybridDelay);
  } finally {
    observer.stop();
  }
});

test("a prepared input whose preflight fails cannot be mistaken for a later custom run", () => {
  const f = fixture(1);
  f.scan();
  f.cycles.input(true, true, false);
  f.cycles.prepare();
  f.success();
  f.scan();
  f.cycles.start();
  f.cycles.message("custom");
  f.finish();
  assert.equal(f.cycles.completed, 0n);
  assert.equal(f.cycle()[0].compressionEligible, true);
});
