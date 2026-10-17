import assert from "node:assert/strict";
import { test } from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { Reconciler } from "../src/reconcile.mts";
import { DEFAULTS } from "../src/config.mts";
import { format, fullSummary } from "../src/formatter.mts";
import { renderTable, themedCell } from "../src/tables.mts";
import { statusText } from "../src/commands.mts";
import { job, reporter } from "./fixtures.mjs";
const theme = {
  fg: (fg, text) => `\x1b[${fg === "dim" ? 90 : 32}m${text}\x1b[39m`,
  style: (text) => text,
};
function fixture(activity = "active") {
  const diagnostics = [];
  const r = new Reconciler(15, (...args) => diagnostics.push(args));
  const p = {
    paneId: "%1",
    pid: "10",
    sessions: [],
    job: job(),
    pi: reporter({ kind: "batch", jobId: "j", state: activity }),
  };
  const at = (t) => r.reconcile([p], t)[0];
  assert.equal(at(0).presentationState, "unknown");
  p.job.heartbeatSeq++;
  p.pi.heartbeatSeq++;
  at(1);
  return { r, p, at, diagnostics };
}
for (const activity of ["active", "idle", "failed"]) {
  test(`last-known ${activity} survives independent runner fallback and recovery`, () => {
    const { p, at, diagnostics } = fixture(activity);
    assert.deepEqual(
      [at(2).presentationState, at(2).uncertain],
      [activity, false],
    );
    p.job.heartbeatSeq++;
    at(10);
    let row = at(16);
    assert.deepEqual(
      [row.state, row.presentationState, row.uncertain],
      ["running", activity, true],
    );
    row = at(25);
    assert.deepEqual(
      [row.state, row.presentationState, row.uncertain],
      ["unknown", activity, true],
    );
    assert.equal(diagnostics.length, 1);
    assert.deepEqual(diagnostics[0][1], { notify: false });
    p.job.heartbeatSeq++;
    at(26);
    assert.equal(at(27).presentationState, activity);
    assert.equal(at(27).uncertain, true);
    p.pi.state = "idle";
    p.pi.heartbeatSeq++;
    row = at(28);
    assert.deepEqual(
      [row.state, row.presentationState, row.uncertain],
      ["idle", "idle", false],
    );
    p.job.phase = "success";
    p.job.exitCode = 0;
    row = at(29);
    assert.equal(row.uncertain, false);
    row = at(1000);
    assert.deepEqual(
      [row.state, row.presentationState, row.uncertain],
      ["success", "success", false],
    );
  });
}
test("generic liveness and first discovery do not invent application history", () => {
  const { r, p } = fixture();
  r.reconcile([], 2);
  p.pi = null;
  let row = r.reconcile([p], 3)[0];
  assert.deepEqual([row.presentationState, row.uncertain], ["unknown", true]);
  p.job.heartbeatSeq++;
  row = r.reconcile([p], 4)[0];
  assert.deepEqual([row.presentationState, row.uncertain], ["running", false]);
  row = r.expire([p], 19)[0];
  assert.deepEqual(
    [row.state, row.presentationState, row.uncertain],
    ["unknown", "running", true],
  );
  p.job.heartbeatSeq++;
  row = r.reconcile([p], 20)[0];
  assert.deepEqual([row.presentationState, row.uncertain], ["running", false]);
});
test("history cannot cross jobs, pane replacement, removed registration or namespaces", () => {
  const { r, p, at } = fixture();
  r.disconnect();
  assert.equal(at(2).presentationState, "active");
  p.job = job({ jobId: "next" });
  p.pi = null;
  assert.equal(at(3).presentationState, "unknown");
  p.job.heartbeatSeq++;
  assert.equal(at(4).presentationState, "running");
  p.pid = "20";
  assert.equal(at(5).presentationState, "unknown");
  p.job = null;
  let row = at(6);
  assert.deepEqual(
    [row.state, row.presentationState, row.uncertain],
    ["unregistered", "unregistered", false],
  );
  p.pi = reporter({ jobId: null });
  assert.equal(at(7).presentationState, "unknown");
  p.pi.heartbeatSeq++;
  assert.equal(at(8).presentationState, "idle");
  r.reconcile([], 9);
  assert.equal(at(10).presentationState, "unknown");
  assert.equal(
    new Reconciler(15).reconcile([p], 11)[0].presentationState,
    "unknown",
  );
});
test("uncertainty styles a whole count token and never splits its members", () => {
  const slots = [
    { state: "running", presentationState: "active", uncertain: true },
    { state: "active", presentationState: "active", uncertain: false },
  ];
  const summary = fullSummary(slots, DEFAULTS, theme);
  assert.equal(summary, "\x1b[90mA2\x1b[39m");
  assert.equal(visibleWidth(summary), 2);
  assert.equal(
    stripTerminalSequences(format(slots, DEFAULTS, theme, 2).text),
    "AA",
  );
  assert.ok(format(slots, DEFAULTS, theme, 2).text.startsWith("\x1b[90mA"));
});
test("trusted glyph styling survives wide and narrow tables while metadata stays literal", () => {
  const ctx = { ui: { theme } };
  for (const width of [25, 100]) {
    const text = renderTable(
      ctx,
      ["Glyph", "Label"],
      [[themedCell("A", "dim"), "\x1b[31munsafe"]],
      width,
    );
    assert.ok(text.includes("\x1b[90mA"), text);
    assert.ok(!text.includes("\x1b[31m"), text);
    assert.ok(text.includes("�"));
  }
  const { at } = fixture();
  const row = at(16);
  const text = statusText(
    ctx,
    {
      identity: { version: "0.2.0" },
      config: DEFAULTS,
      slots: [row],
      health: "healthy",
      inventoryAgeMs: 0,
    },
    240,
  );
  assert.ok(text.includes("\x1b[90mA"), text);
  assert.ok(stripTerminalSequences(text).includes("unknown"));
});
