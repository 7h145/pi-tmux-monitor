import assert from "node:assert/strict";
import { test } from "node:test";
import { createDiagnostics, RUNNER_DIAGNOSTICS } from "../src/diagnostics.mts";
import { parseRecord } from "../src/protocol.mts";
import { job } from "./fixtures.mjs";
import { Observer } from "../src/observer.mts";
import { DEFAULTS } from "../src/config.mts";

test("diagnostic storage stays bounded, truncated and deduplicated without delivery", () => {
  const log = createDiagnostics();
  log.record("x".repeat(500));
  log.record("x".repeat(400));
  for (let i = 0; i < 50; i++) log.record("diagnostic " + i);
  assert.equal(log.messages.length, 16);
  assert.equal(log.messages[0].length, 320);
  assert.equal(new Set(log.messages).size, 16);
});

test("runner diagnostics accept only unique fixed codes, never arbitrary error content", () => {
  const diagnostics = Object.keys(RUNNER_DIAGNOSTICS);
  assert.deepEqual(
    parseRecord(JSON.stringify(job({ diagnostics })), "job", "%1").diagnostics,
    diagnostics,
  );
  for (const invalid of [
    null,
    "write-failed",
    ["raw error text"],
    ["constructor"],
    ["write-failed", "write-failed"],
    Array(100).fill("write-failed"),
  ]) {
    const log = createDiagnostics();
    assert.equal(
      parseRecord(
        JSON.stringify(job({ diagnostics: invalid })),
        "job",
        "%1",
        log.record,
      ),
      null,
    );
    assert.deepEqual(log.messages, ["Rejected invalid monitor metadata"]);
  }
});

test("runner diagnostics reach on-demand observer data without changing terminal outcomes", async () => {
  const log = createDiagnostics();
  const observer = new Observer({
    cwd: "/unused",
    owner: "owner",
    config: { ...DEFAULTS, socketPath: "/unused" },
    diagnostic: log.record,
    publish: () => {},
    tmuxFactory: () => ({
      identity: async () => "server",
      inventory: async () => [
        {
          paneId: "%1",
          pid: "10",
          sessions: [],
          pi: null,
          job: job({
            phase: "failed",
            exitCode: 7,
            diagnostics: ["write-failed"],
          }),
        },
      ],
    }),
  });
  try {
    await observer.scan();
    await observer.scan();
    assert.equal(observer.slots[0].state, "failed");
    assert.equal(observer.slots[0].uncertain, false);
    assert.equal(observer.slots[0].job.exitCode, 7);
    assert.deepEqual(log.messages, [
      "Pane %1: Monitor command registration/heartbeat failed",
    ]);
  } finally {
    observer.stop();
  }
});

test("module reload retains diagnostic data without retaining old module functions", async () => {
  const key = Symbol.for("pi-tmux-monitor.diagnostics.v1"),
    previous = globalThis[key];
  delete globalThis[key];
  try {
    const original = (
      await import("../src/diagnostics.mts")
    ).processDiagnostics();
    original.record("before reload");
    const reloaded = (
      await import("../src/diagnostics.mts?reload")
    ).processDiagnostics();
    assert.notEqual(original.record, reloaded.record);
    assert.equal(original.messages, reloaded.messages);
    assert.deepEqual(reloaded.messages, ["before reload"]);
    reloaded.record("after reload");
    assert.deepEqual(original.messages, ["before reload", "after reload"]);
    assert.deepEqual(Object.keys(globalThis[key]).sort(), ["messages", "seen"]);
  } finally {
    if (previous === undefined) delete globalThis[key];
    else globalThis[key] = previous;
  }
});
