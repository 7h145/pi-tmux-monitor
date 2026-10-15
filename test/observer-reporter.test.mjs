import assert from "node:assert/strict";
import { test } from "node:test";
import { Observer } from "../src/observer.mts";
import { Reporter } from "../src/reporter.mts";
import { DEFAULTS } from "../src/config.mts";
import { job, reporter } from "./fixtures.mjs";
function memory() {
  const records = new Map(),
    writes = [];
  return {
    records,
    writes,
    ownIdentity: async () => "original-server",
    identity: async () => "original-server",
    call: async () => "$0",
    record: async (type) => records.get(type) ?? null,
    write: async (type, target, r) => {
      const copy = structuredClone(r);
      records.set(type, copy);
      writes.push(copy);
    },
    removeOwned: async (type, target, key, value) => {
      if (records.get(type)?.[key] === value) records.delete(type);
    },
  };
}
test("reporter final boundaries, heartbeat error retention, compaction and reload", async () => {
  const tmux = memory(),
    config = { ...DEFAULTS, heartbeatIntervalMs: 100000 };
  const options = {
    sessionId: "child",
    mode: "rpc",
    idle: true,
    config,
    env: { TMUX: "/socket,1,0", TMUX_PANE: "%1" },
    tmuxFactory: () => tmux,
  };
  const r = new Reporter(options);
  await r.start();
  try {
    const first = tmux.records.get("pi");
    assert.equal(first.kind, "interactive");
    assert.equal(first.state, "idle");
    await r.active();
    assert.equal(tmux.records.get("pi").state, "active");
    r.beforeSettle("error");
    assert.equal(tmux.records.get("pi").state, "active");
    await r.settled();
    assert.equal(tmux.records.get("pi").state, "failed");
    await r.write();
    assert.equal(tmux.records.get("pi").state, "failed");
    await r.compactStart();
    assert.equal(tmux.records.get("pi").state, "active");
    await r.compactEnd(true);
    assert.equal(tmux.records.get("pi").state, "failed");
    await r.stop("reload");
    assert.equal(tmux.records.has("pi"), false);
    const next = new Reporter(options);
    await next.start();
    try {
      assert.equal(next.record.state, "failed");
      assert.equal(next.record.processInstanceId, first.processInstanceId);
      assert.notEqual(next.record.instanceId, first.instanceId);
      await next.active();
      next.beforeSettle("error");
      await next.settled(true);
      assert.equal(next.record.state, "idle");
    } finally {
      await next.stop("quit");
    }
  } finally {
    await r.stop("quit");
  }
});
test("reporter binds only matching explicit job context, follows job kind", async () => {
  const tmux = memory();
  tmux.records.set("job", job({ kind: "service", runtime: "pi" }));
  const env = {
    TMUX: "/a,b,1,0",
    TMUX_PANE: "%1",
    PI_TMUX_MONITOR_JOB_ID: "j",
    PI_TMUX_MONITOR_PARENT: "owner",
    PI_TMUX_MONITOR_ANCESTORS: '["root","owner"]',
  };
  const r = new Reporter({
    sessionId: "child",
    mode: "json",
    idle: true,
    config: DEFAULTS,
    env,
    tmuxFactory: () => tmux,
  });
  await r.start();
  assert.equal(r.record.jobId, "j");
  assert.equal(r.record.kind, "service");
  assert.deepEqual(r.ancestors, ["root", "owner"]);
  tmux.records.set(
    "pi",
    reporter({ instanceId: "replacement", processInstanceId: "new-process" }),
  );
  await r.state("active");
  await r.stop("quit");
  assert.equal(tmux.records.get("pi").instanceId, "replacement");
  const other = new Reporter({
    sessionId: "child2",
    mode: "print",
    idle: true,
    config: DEFAULTS,
    env: { ...env, PI_TMUX_MONITOR_JOB_ID: "old" },
    tmuxFactory: () => tmux,
  });
  await other.start();
  assert.equal(other.record.jobId, null);
  assert.equal(other.record.parentSessionId, null);
  assert.equal(other.record.kind, "batch");
  await other.stop("quit");
});
test("late reporter startup and writes cannot survive retirement", async () => {
  let resolve, release;
  const pause = new Promise((r) => (release = r));
  const tmux = memory();
  const original = tmux.record;
  tmux.record = async (type) => {
    await pause;
    return original(type);
  };
  const r = new Reporter({
    sessionId: "child",
    mode: "tui",
    idle: true,
    config: DEFAULTS,
    env: { TMUX: "/s,1,0", TMUX_PANE: "%1" },
    tmuxFactory: () => tmux,
  });
  const starting = r.start();
  await r.stop("quit");
  release();
  await starting;
  assert.equal(tmux.writes.length, 0);
  assert.equal(r.timer, undefined);
});
test("observer no overlap, first uncertainty, degraded inventory, removal and server replacement", async () => {
  let identity = "server-1",
    time = 0,
    fail = false,
    calls = 0;
  const p = { paneId: "%1", pid: "10", sessions: [], job: job(), pi: null };
  let panes = [p];
  const seen = [];
  const tmux = {
    identity: async () => identity,
    inventory: async () => {
      calls++;
      if (fail) throw Error();
      return structuredClone(panes);
    },
  };
  const o = new Observer({
    cwd: "/work",
    owner: "owner",
    config: { ...DEFAULTS, socketPath: "/explicit" },
    publish: (s) => seen.push(s),
    clock: () => time,
    tmuxFactory: () => tmux,
  });
  await Promise.all([o.scan(), o.scan()]);
  assert.equal(calls, 1);
  assert.equal(o.slots[0].state, "unknown");
  p.job.heartbeatSeq++;
  time = 5000;
  await o.scan();
  assert.equal(o.slots[0].state, "running");
  fail = true;
  await o.scan();
  assert.equal(o.slots[0].state, "unknown");
  assert.equal(o.degraded, true);
  fail = false;
  p.job.phase = "success";
  p.job.exitCode = 0;
  await o.scan();
  fail = true;
  await o.scan();
  assert.equal(o.slots[0].state, "success");
  fail = false;
  identity = "server-2";
  p.job = job();
  await o.scan();
  assert.equal(o.slots[0].state, "unknown");
  panes = [];
  await o.scan();
  assert.deepEqual(o.slots, []);
  o.stop();
  await o.scan();
  assert.equal(calls, 7);
});
test("observer automatic project precedence is sticky after selection", async () => {
  let project = false;
  const o = new Observer({
    cwd: "/work",
    owner: "owner",
    config: DEFAULTS,
    env: { TMUX: "/inherited,1,0" },
    publish: () => {},
    tmuxFactory: (socket) => ({
      identity: async () => {
        if (socket.includes(".agents") && !project) throw Error();
        return socket;
      },
      inventory: async () => [],
    }),
  });
  await o.scan();
  assert.equal(o.socket, "/inherited");
  project = true;
  await o.scan();
  assert.equal(o.socket, "/work/.agents/run/tmux-socket");
  project = false;
  await o.scan();
  assert.equal(o.socket, "/work/.agents/run/tmux-socket");
  assert.equal(o.degraded, true);
  o.stop();
});
test("observer late scan cannot publish after shutdown", async () => {
  let release;
  const pause = new Promise((r) => (release = r));
  const seen = [];
  const o = new Observer({
    cwd: "/work",
    owner: "owner",
    config: { ...DEFAULTS, socketPath: "/s" },
    publish: (x) => seen.push(x),
    tmuxFactory: () => ({
      identity: async () => "s",
      inventory: async () => {
        await pause;
        return [];
      },
    }),
  });
  const scanning = o.scan();
  await new Promise((r) => setImmediate(r));
  o.stop();
  release();
  await scanning;
  assert.deepEqual(seen, []);
});
test("reporter stops reporting to a replaced server without touching newer metadata", async () => {
  const tmux = memory(),
    r = new Reporter({
      sessionId: "child",
      mode: "tui",
      idle: true,
      config: DEFAULTS,
      env: { TMUX: "/s,1,0", TMUX_PANE: "%1" },
      tmuxFactory: () => tmux,
    });
  await r.start();
  tmux.identity = async () => "new-server";
  tmux.records.set("pi", reporter({ instanceId: "new-server-runtime" }));
  await r.active();
  await r.stop("quit");
  assert.equal(tmux.records.get("pi").instanceId, "new-server-runtime");
  assert.equal(r.retired, true);
});

test("observer exposes application reporter loss without inferring activity or failure", async () => {
  let time = 0;
  const diagnostics = [];
  const p = {
    paneId: "%1",
    pid: "10",
    sessions: [],
    job: job({ kind: "interactive", runtime: "pi" }),
    pi: reporter({ jobId: "j" }),
  };
  const o = new Observer({
    cwd: "/work",
    owner: "owner",
    config: { ...DEFAULTS, socketPath: "/explicit" },
    publish: () => {},
    diagnostic: (message) => diagnostics.push(message),
    clock: () => time,
    tmuxFactory: () => ({
      identity: async () => "server",
      inventory: async () => [structuredClone(p)],
    }),
  });
  try {
    await o.scan();
    p.job.heartbeatSeq++;
    p.pi.heartbeatSeq++;
    time = 5000;
    await o.scan();
    assert.equal(o.slots[0].state, "idle");
    p.pi = null;
    time = 5100;
    await o.scan();
    assert.equal(o.slots[0].state, "running");
    assert.equal(diagnostics.length, 1);
    assert.match(diagnostics[0], /No fresh application state for pane %1/);
    await o.scan();
    assert.equal(diagnostics.length, 1);
    time = 20000;
    await o.scan();
    assert.equal(o.slots[0].state, "unknown");
    p.job.phase = "success";
    p.job.exitCode = 0;
    await o.scan();
    assert.equal(o.slots[0].state, "success");
    assert.equal(diagnostics.length, 1);
  } finally {
    o.stop();
  }
});

for (const scope of ["children", "descendants"]) {
  test(`pane reuse scopes the current Pi generation in ${scope}, including reporter loss`, async () => {
    let time = 0,
      fail = false;
    const p = {
      paneId: "%1",
      pid: "10",
      sessions: [
        { name: "shared", owner: { ownerSessionId: "B", ancestors: [] } },
      ],
      job: job({
        jobId: "old-A",
        ownerSessionId: "A",
        ancestors: ["A"],
        phase: "success",
        exitCode: 0,
      }),
      pi: reporter({
        parentSessionId: "B",
        ancestors: ["B"],
        sessionId: "child-B",
      }),
    };
    const observers = Object.fromEntries(
      ["A", "B"].map((owner) => [
        owner,
        new Observer({
          cwd: "/work",
          owner,
          config: { ...DEFAULTS, scope, socketPath: "/explicit" },
          env: {},
          publish: () => {},
          clock: () => time,
          tmuxFactory: () => ({
            identity: async () => "server",
            inventory: async () => {
              if (fail) throw Error("disconnected");
              return [structuredClone(p)];
            },
          }),
        }),
      ]),
    );
    const scan = () =>
      Promise.all(Object.values(observers).map((o) => o.scan()));
    const assertCurrent = (state) => {
      assert.deepEqual(observers.A.slots, []);
      assert.equal(observers.B.slots.length, 1);
      assert.equal(observers.B.slots[0].state, state);
      assert.equal(observers.B.slots[0].workload.parentSessionId, "B");
    };
    try {
      await scan();
      assert.equal(observers.A.slots[0].state, "success");
      assert.deepEqual(observers.B.slots, []);
      time = 100;
      p.pi.heartbeatSeq++;
      await scan();
      assertCurrent("idle");
      time += DEFAULTS.staleAfterMs;
      for (const o of Object.values(observers)) o.expire();
      assertCurrent("unknown");
      p.pi.heartbeatSeq++;
      await scan();
      assertCurrent("idle");
      fail = true;
      await scan();
      assertCurrent("unknown");
      fail = false;
      p.pi = null;
      await scan();
      assertCurrent("unknown");
      // Session evidence must not take over from confirmed workload ownership.
      p.sessions[0].owner.ownerSessionId = "A";
      p.job.heartbeatSeq++;
      await scan();
      assertCurrent("unknown");
      p.job = job({ jobId: "new-A" });
      p.job.ownerSessionId = "A";
      p.job.ancestors = ["A"];
      await scan();
      assert.equal(observers.A.slots[0].workload.jobId, "new-A");
      assert.deepEqual(observers.B.slots, []);
    } finally {
      for (const o of Object.values(observers)) o.stop();
    }
  });

  test(`live job ownership survives stale and fresh mismatched reporters in ${scope}`, async () => {
    let time = 0;
    const p = {
      paneId: "%1",
      pid: "10",
      sessions: [],
      job: job({ ownerSessionId: "A", ancestors: ["A"] }),
      pi: reporter({ parentSessionId: "B", ancestors: ["B"] }),
    };
    const observers = ["A", "B"].map(
      (owner) =>
        new Observer({
          cwd: "/work",
          owner,
          config: { ...DEFAULTS, scope, socketPath: "/explicit" },
          env: {},
          publish: () => {},
          clock: () => time,
          tmuxFactory: () => ({
            identity: async () => "server",
            inventory: async () => [structuredClone(p)],
          }),
        }),
    );
    const scan = () => Promise.all(observers.map((o) => o.scan()));
    try {
      await scan();
      p.job.heartbeatSeq++;
      time = 100;
      await scan();
      assert.equal(observers[0].slots[0].state, "running");
      assert.deepEqual(observers[1].slots, []);
      p.pi.heartbeatSeq++;
      time++;
      await scan();
      assert.equal(observers[0].slots[0].state, "running");
      assert.deepEqual(observers[1].slots, []);
      p.pi.jobId = "different-job";
      p.pi.heartbeatSeq++;
      await scan();
      p.pi.heartbeatSeq++;
      await scan();
      assert.equal(observers[0].slots[0].state, "running");
      assert.deepEqual(observers[1].slots, []);
    } finally {
      for (const o of observers) o.stop();
    }
  });
}
