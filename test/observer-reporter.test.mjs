import assert from "node:assert/strict";
import { test } from "node:test";
import { Observer, legacySession } from "../src/observer.mts";
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
  assert.equal(o.slots[0].state, "active");
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
test("observer late scan cannot publish after shutdown; legacy is exact process identity", async () => {
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
  assert.match(
    await legacySession(),
    new RegExp(`^agent-p${process.pid}-\\d+$`),
  );
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
