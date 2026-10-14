import assert from "node:assert/strict";
import { test } from "node:test";
import { Observer } from "../src/observer.mts";
import { Tmux } from "../src/tmux.mts";
import { DEFAULTS } from "../src/config.mts";
import {
  collectSnapshot,
  statusText,
  monitorCommand,
} from "../src/commands.mts";
import { job, reporter } from "./fixtures.mjs";

const ctx = {
  hasUI: true,
  sessionManager: { getSessionId: () => "owner" },
  ui: { theme: { style: (s) => s, fg: (_, s) => s } },
};
const pane = (i, j = null, pi = null) => ({
  paneId: `%${i}`,
  pid: `${10 + i}`,
  sessions: [
    {
      id: "$0",
      name: "owned",
      owner: { ownerSessionId: "owner", ancestors: [] },
    },
  ],
  job: j && job({ paneId: `%${i}`, jobId: `j${i}`, ...j }),
  pi:
    pi &&
    reporter({
      paneId: `%${i}`,
      jobId: j ? `j${i}` : null,
      kind: j ? (j.kind ?? "batch") : "interactive",
      ...pi,
    }),
});
function fixture(config = {}) {
  let time = 0,
    identity = "server",
    failing = false,
    reads = 0,
    inventories = 0;
  let rows = [pane(1, {}, { state: "active" })];
  const publications = [],
    diagnostics = [];
  const tmux = {
    identity: async () => {
      reads++;
      if (failing) throw Error("unavailable");
      return identity;
    },
    inventory: async (_diagnostic, clock) => {
      reads++;
      inventories++;
      return structuredClone(rows).map((p) => ({
        ...p,
        observedAt: { job: clock(), pi: clock() },
      }));
    },
  };
  const observer = new Observer({
    cwd: "/work",
    owner: "owner",
    env: {},
    config: { ...DEFAULTS, socketPath: "/socket", ...config },
    clock: () => time,
    tmuxFactory: () => tmux,
    publish: (s) => publications.push(structuredClone(s)),
    diagnostic: (s) => diagnostics.push(s),
  });
  const runtime = { owner: "owner", config: observer.config, observer };
  return {
    observer,
    tmux,
    runtime,
    publications,
    diagnostics,
    set time(t) {
      time = t;
    },
    set identity(s) {
      identity = s;
    },
    set failing(v) {
      failing = v;
    },
    get rows() {
      return rows;
    },
    set rows(v) {
      rows = v;
    },
    get reads() {
      return reads;
    },
    get inventories() {
      return inventories;
    },
    advance() {
      for (const p of rows)
        for (const type of ["job", "pi"]) if (p[type]) p[type].heartbeatSeq++;
    },
    text() {
      return statusText(ctx, collectSnapshot(runtime), 240);
    },
  };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));
function pauseInventory(f) {
  const inventory = f.tmux.inventory;
  let release;
  const pause = new Promise((resolve) => {
    release = resolve;
  });
  f.tmux.inventory = async (...args) => {
    const rows = await inventory(...args);
    await pause;
    return rows;
  };
  return release;
}
async function confirm(f) {
  await f.observer.scan();
  f.time = 5000;
  f.advance();
  await f.observer.scan();
}

test("successful unchanged and empty scans renew inventory age, not source progress", async () => {
  const f = fixture();
  try {
    assert.equal(f.observer.inventoryAge(), null);
    await confirm(f);
    assert.equal(f.observer.slots[0].state, "active");
    f.time = 19999;
    await f.observer.scan();
    assert.equal(f.observer.inventoryAge(), 0);
    assert.equal(f.observer.slots[0].state, "active");
    f.time = 20000;
    await f.observer.scan();
    assert.equal(f.observer.inventoryAge(), 0);
    assert.equal(f.observer.slots[0].state, "unknown");
    assert.equal(f.observer.reconciler.sources.get("%1:pi").time, 5000);
    f.rows = [];
    f.time = 25000;
    await f.observer.scan();
    assert.equal(f.observer.lastSuccessfulScanAt, 25000);
    f.time = 26000;
    assert.equal(f.observer.inventoryAge(), 1000);
    assert.deepEqual(f.observer.slots, []);
    assert.match(f.text(), /No eligible panes\./);
  } finally {
    f.observer.stop();
  }
});

test("status age uses effective millisecond thresholds before rounding, even with no panes", async (t) => {
  t.mock.method(Date, "now", () => 999999999999);
  for (const staleAfterMs of [15000, 3050]) {
    const f = fixture({ staleAfterMs, heartbeatIntervalMs: 1000 });
    try {
      f.rows = [];
      await f.observer.scan();
      f.time = staleAfterMs - 1;
      assert.ok(!f.text().includes("last successful scan"));
      f.time = staleAfterMs;
      assert.ok(
        f
          .text()
          .includes(
            `Cached inventory — last successful scan ${Math.floor(staleAfterMs / 1000)}s ago.`,
          ),
      );
      assert.match(f.text(), /No eligible panes\./);
      const data = collectSnapshot(f.runtime);
      const reads = f.reads;
      f.time = staleAfterMs + 5000;
      t.mock.method(Date, "now", () => -999999999999);
      assert.equal(data.inventoryAgeMs, staleAfterMs);
      assert.equal(
        collectSnapshot(f.runtime).inventoryAgeMs,
        staleAfterMs + 5000,
      );
      statusText(ctx, data);
      assert.equal(f.observer.lastSuccessfulScanAt, 0);
      assert.equal(f.reads, reads);
    } finally {
      f.observer.stop();
    }
  }
});

test("no successful scan is explicit; failure/degraded notices do not wait for the age threshold", async () => {
  const f = fixture();
  try {
    assert.match(f.text(), /Cached inventory — no successful scan yet\./);
    assert.ok(!f.text().includes("No eligible panes."));
    f.failing = true;
    await f.observer.scan();
    assert.equal(f.observer.inventoryAge(), null);
    assert.match(f.text(), /Observation: degraded/);
    assert.match(f.text(), /no successful scan yet/);
    f.failing = false;
    await confirm(f);
    f.time = 5001;
    f.failing = true;
    await f.observer.scan();
    assert.equal(f.observer.slots[0].state, "unknown");
    assert.equal(f.observer.lastSuccessfulScanAt, 5000);
    assert.match(f.text(), /Observation: degraded/);
    assert.ok(!f.text().includes("last successful scan"));
    f.time = 20000;
    assert.match(f.text(), /last successful scan 15s ago/);
  } finally {
    f.observer.stop();
  }
});

test("the existing poll timer runs during the initial pending scan without overlap or a successful age", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const f = fixture();
  const release = pauseInventory(f);
  const starting = f.observer.start();
  try {
    await flush();
    assert.notEqual(f.observer.timer, undefined);
    assert.equal(f.observer.running, true);
    assert.equal(f.observer.inventoryAge(), null);
    assert.equal(collectSnapshot(f.runtime).health, "unavailable");
    const reads = f.reads;
    f.time = 20000;
    t.mock.timers.tick(20000);
    assert.equal(f.reads, reads);
    assert.equal(f.inventories, 1);
    assert.deepEqual(f.publications, []);
    assert.match(f.text(), /no successful scan yet/);
    release();
    await starting;
    assert.equal(f.observer.lastSuccessfulScanAt, 20000);
    assert.equal(f.observer.slots[0].state, "unknown");
  } finally {
    f.observer.stop();
    release();
    await starting;
  }
});

test("poll ticks expire idle/active/Pi failure/running during pending scans, retaining outcomes and shells", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const f = fixture({ pollIntervalMs: 1000 });
  f.rows = [
    pane(1, {}, { state: "idle" }),
    pane(2, {}, { state: "active" }),
    pane(3, {}, { state: "failed" }),
    pane(4, {}),
    pane(5, { phase: "success", exitCode: 0 }),
    pane(6, { phase: "failed", exitCode: 2 }),
    pane(7),
  ];
  let release;
  try {
    await f.observer.start();
    f.time = 5000;
    f.advance();
    await f.observer.scan();
    assert.deepEqual(
      f.observer.slots.map((p) => p.state),
      [
        "idle",
        "active",
        "failed",
        "running",
        "success",
        "failed",
        "unregistered",
      ],
    );
    release = pauseInventory(f);
    const sourceClocks = structuredClone([...f.observer.reconciler.sources]);
    const count = f.publications.length;
    f.time = 6000;
    t.mock.timers.tick(1000);
    await flush();
    assert.equal(f.observer.running, true);
    const reads = f.reads;
    f.time = 19999;
    t.mock.timers.tick(1000);
    assert.equal(f.publications.length, count);
    f.time = 20000;
    t.mock.timers.tick(1000);
    assert.deepEqual(
      f.observer.slots.map((p) => p.state),
      [
        "unknown",
        "unknown",
        "unknown",
        "unknown",
        "success",
        "failed",
        "unregistered",
      ],
    );
    assert.equal(f.publications.length, count + 1);
    assert.equal(f.observer.lastSuccessfulScanAt, 5000);
    assert.deepEqual([...f.observer.reconciler.sources], sourceClocks);
    assert.equal(f.reads, reads);
    f.time = 40000;
    t.mock.timers.tick(1000);
    assert.equal(f.publications.length, count + 1);
    assert.equal(f.reads, reads);
  } finally {
    f.observer.stop();
    release?.();
    await flush();
  }
});

test("Pi expiry falls back to independently fresh runner evidence while inventory I/O is pending", async () => {
  const f = fixture();
  let release, scanning;
  try {
    await confirm(f);
    f.time = 10000;
    f.rows[0].job.heartbeatSeq++;
    await f.observer.scan();
    release = pauseInventory(f);
    scanning = f.observer.scan();
    await flush();
    const reads = f.reads;
    f.time = 20000;
    f.observer.expire();
    assert.equal(f.observer.slots[0].state, "running");
    assert.equal(f.observer.inventoryAge(), 10000);
    assert.ok(!f.text().includes("last successful scan"));
    assert.match(f.diagnostics[0], /No fresh application state/);
    f.time = 25000;
    f.observer.expire();
    assert.equal(f.observer.slots[0].state, "unknown");
    assert.equal(f.reads, reads);
    release();
    await scanning;
    assert.equal(f.observer.slots[0].state, "unknown");
    assert.equal(f.observer.inventoryAge(), 0);
  } finally {
    f.observer.stop();
    release?.();
    await scanning;
  }
});

test("all workload-status forms expire and publish before snapshotting without starting or awaiting I/O", async () => {
  for (const args of ["", "status", "s"]) {
    const f = fixture();
    let release, scanning;
    try {
      await confirm(f);
      release = pauseInventory(f);
      scanning = f.observer.scan();
      await flush();
      f.time = 20000;
      const messages = [],
        publications = f.publications.length,
        reads = f.reads;
      const handler = monitorCommand(
        () => f.runtime,
        () => ({}),
      );
      const handling = handler(args, {
        ...ctx,
        ui: { ...ctx.ui, notify: (s) => messages.push(s) },
      });
      assert.equal(
        messages.length,
        1,
        "status must notify synchronously before any inventory completion",
      );
      assert.match(messages[0], /last successful scan 15s ago/);
      assert.ok(messages[0].includes("?"));
      assert.equal(f.observer.slots[0].state, "unknown");
      assert.equal(f.publications.length, publications + 1);
      assert.equal(f.publications.at(-1)[0].state, "unknown");
      assert.equal(f.observer.lastSuccessfulScanAt, 5000);
      assert.equal(f.reads, reads);
      await handling;
    } finally {
      f.observer.stop();
      release?.();
      await scanning;
    }
  }
});

test("real inventory receive timestamps survive delayed completion and keep independent per-source ages", async () => {
  const f = fixture({ scope: "server" });
  const tmux = new Tmux("/fake");
  tmux.identity = async () => "server";
  tmux.call = async (verb) =>
    verb === "list-panes" ? "%1|$0|11|@0|0|0\n%2|$0|12|@1|1|0" : "owned";
  let next = false,
    entered,
    release;
  const receiving = new Promise((resolve) => {
    entered = resolve;
  });
  const pause = new Promise((resolve) => {
    release = resolve;
  });
  tmux.record = async (type, target) => {
    if (type === "owner") return null;
    if (target === "%2") {
      if (next) {
        entered();
        await pause;
      }
      return null;
    }
    if (next) f.time = type === "job" ? 5000 : 6000;
    return type === "job"
      ? job({ heartbeatSeq: next ? 2 : 1 })
      : reporter({
          jobId: "j",
          kind: "batch",
          state: "active",
          heartbeatSeq: next ? 2 : 1,
        });
  };
  f.observer.tmuxFactory = () => tmux;
  let scanning;
  try {
    await f.observer.scan();
    next = true;
    scanning = f.observer.scan();
    await receiving;
    f.time = 20000;
    f.observer.expire();
    release();
    await scanning;
    assert.equal(f.observer.lastSuccessfulScanAt, 20000);
    assert.deepEqual(f.observer.cache[0].observedAt, { job: 5000, pi: 6000 });
    assert.equal(f.observer.reconciler.sources.get("%1:job").time, 5000);
    assert.equal(f.observer.reconciler.sources.get("%1:pi").time, 6000);
    assert.equal(f.observer.slots[0].state, "active");
    assert.equal(
      f.observer.reconciler.fresh("%1", "job", f.observer.cache[0].job, 20000),
      false,
    );
    f.time = 21000;
    f.observer.expire();
    assert.equal(f.observer.slots[0].state, "unknown");
    assert.equal(f.observer.slots[1].state, "unregistered");
  } finally {
    f.observer.stop();
    release();
    await scanning;
  }
});

test("an advanced heartbeat already stale at delayed completion never receives a new lifetime", async () => {
  const f = fixture();
  let release, scanning;
  try {
    await confirm(f);
    f.time = 10000;
    f.advance();
    release = pauseInventory(f);
    scanning = f.observer.scan();
    await flush();
    f.time = 25000;
    f.observer.expire();
    release();
    await scanning;
    assert.equal(f.observer.slots[0].state, "unknown");
    assert.equal(f.observer.inventoryAge(), 0);
    assert.equal(f.observer.reconciler.sources.get("%1:pi").time, 10000);
    f.time = 25001;
    await f.observer.scan();
    assert.equal(f.observer.slots[0].state, "unknown");
    f.advance();
    await f.observer.scan();
    assert.equal(f.observer.slots[0].state, "active");
  } finally {
    f.observer.stop();
    release?.();
    await scanning;
  }
});

test("replacement server discards inventory and age before its pending scan completes", async () => {
  const f = fixture();
  let release, scanning;
  try {
    await confirm(f);
    f.identity = "replacement";
    release = pauseInventory(f);
    scanning = f.observer.scan();
    await flush();
    assert.equal(f.observer.inventoryAge(), null);
    assert.equal(collectSnapshot(f.runtime).health, "unavailable");
    assert.deepEqual(f.observer.cache, []);
    assert.deepEqual(f.observer.slots, []);
    assert.deepEqual(f.publications.at(-1), []);
    assert.match(f.text(), /no successful scan yet/);
    f.time = 40000;
    release();
    await scanning;
    assert.equal(f.observer.inventoryAge(), 0);
    assert.equal(f.observer.slots[0].state, "unknown");
  } finally {
    f.observer.stop();
    release?.();
    await scanning;
  }
});

test("project socket promotion clears scan age; late selector/scan results cannot update retired runtimes", async () => {
  const f = fixture({ socketPath: null });
  let project = false;
  f.observer.env = { TMUX: "/inherited,1,0" };
  f.observer.tmuxFactory = (s) => ({
    ...f.tmux,
    identity: async () => {
      if (s.includes(".agents") && !project) throw Error();
      return s;
    },
  });
  let release, scanning;
  try {
    await confirm(f);
    project = true;
    release = pauseInventory(f);
    scanning = f.observer.scan();
    await flush();
    assert.equal(f.observer.socket, "/work/.agents/run/tmux-socket");
    assert.equal(f.observer.inventoryAge(), null);
    f.observer.stop();
    const count = f.publications.length;
    const replacement = fixture();
    await replacement.observer.scan();
    f.time = 50000;
    release();
    await scanning;
    assert.equal(f.observer.lastSuccessfulScanAt, null);
    assert.equal(f.publications.length, count);
    assert.equal(replacement.observer.lastSuccessfulScanAt, 0);
    replacement.observer.stop();
  } finally {
    f.observer.stop();
    release?.();
    await scanning;
  }
});

test("retiring during initial socket selection leaves its cache namespace and clock untouched", async () => {
  const f = fixture({ socketPath: null });
  let release, entered;
  const pause = new Promise((resolve) => {
    release = resolve;
  });
  const selecting = new Promise((resolve) => {
    entered = resolve;
  });
  f.observer.tmuxFactory = () => ({
    identity: async () => {
      entered();
      await pause;
      return "server";
    },
  });
  const scanning = f.observer.scan();
  try {
    await selecting;
    f.observer.stop();
    release();
    await scanning;
    assert.equal(f.observer.socket, null);
    assert.equal(f.observer.selection, null);
    assert.equal(f.observer.lastSuccessfulScanAt, null);
    assert.deepEqual(f.publications, []);
  } finally {
    f.observer.stop();
    release();
    await scanning;
  }
});

test("cached reevaluation cannot confirm initial or reset heartbeats", async () => {
  const f = fixture();
  try {
    await f.observer.scan();
    const source = structuredClone([...f.observer.reconciler.sources]);
    f.time = 5000;
    f.observer.expire();
    assert.equal(f.observer.slots[0].state, "unknown");
    assert.deepEqual([...f.observer.reconciler.sources], source);
    f.advance();
    await f.observer.scan();
    assert.equal(f.observer.slots[0].state, "active");
    // A sequence reset in an actual inventory must become unconfirmed again.
    f.rows[0].job.heartbeatSeq = 0;
    f.rows[0].pi.heartbeatSeq = 0;
    f.time = 6000;
    await f.observer.scan();
    const reset = structuredClone([...f.observer.reconciler.sources]);
    f.time = 20000;
    f.observer.expire();
    assert.equal(f.observer.slots[0].state, "unknown");
    assert.deepEqual([...f.observer.reconciler.sources], reset);
    f.advance();
    await f.observer.scan();
    assert.equal(f.observer.slots[0].state, "active");
  } finally {
    f.observer.stop();
  }
});
