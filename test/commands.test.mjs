import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import {
  Text,
  visibleWidth,
  stripTerminalSequences,
} from "@earendil-works/pi-tui";
import { DEFAULTS } from "../src/config.mts";
import { STATES, STATE_DEFINITIONS } from "../src/protocol.mts";
import { format } from "../src/formatter.mts";
import { Reconciler } from "../src/reconcile.mts";
import { job, reporter } from "./fixtures.mjs";
import {
  parseCommand,
  collectSnapshot,
  statusText,
  commandHelp,
  monitorCommand,
} from "../src/commands.mts";

const theme = (color) => ({
  fg: (_, text) => `\x1b[${color}m${text}\x1b[39m`,
  style: (text) => `\x1b[1;${color}m${text}\x1b[22;39m`,
});
const ctx = {
  hasUI: true,
  cwd: "/project",
  sessionManager: { getSessionId: () => "owner" },
  ui: { theme: theme(32) },
};
const gaudy = JSON.parse(
  await readFile(
    new URL("../examples/pi-tmux-monitor.json", import.meta.url),
    "utf8",
  ),
);
function current(config = DEFAULTS) {
  return {
    owner: "owner",
    identity: { version: "0.2.0", commit: "abc1234" },
    config,
    ancestors: [],
    observer: {
      identity: "server",
      lastSuccessfulScanAt: 0,
      inventoryAge: () => 0,
      expire: () => {},
      slots: STATES.map((state, i) => ({
        paneId: `%${i}`,
        state,
        windowId: `@${i}`,
        windowIndex: `${i}`,
        paneIndex: "0",
        sessions: [{ id: "$0", name: "owned" }],
        workload: { kind: "batch", label: `work-${i}` },
      })),
    },
    diagnostics: ["bounded diagnostic"],
    footer: { capability: "dynamic-v1" },
  };
}

test("strict command defaults, exact aliases, surrounding whitespace and invalid arguments", () => {
  for (const [args, action] of [
    ["", "status"],
    [" \t\n", "status"],
    ["status", "status"],
    ["s", "status"],
    ["h", "help"],
    ["help", "help"],
    ["c", "config"],
    ["config", "config"],
    ["d", "diagnostics"],
    ["diagnostics", "diagnostics"],
    ...["tmux", "t", "tmux status", "tmux s", "t status", "t s", "t\t s"].map(
      (s) => [s, "server-status"],
    ),
    ["tmux start", "server-start"],
    ["t\nstart", "server-start"],
  ]) {
    assert.equal(parseCommand(args), action);
    assert.equal(parseCommand(` \t${args}\n `), action);
  }
  for (const args of [
    "Status",
    "sta",
    "diag",
    "help extra",
    "s extra",
    "c --json",
    "--help",
    "attach",
    "h\ns",
    "config config",
    "tmux st",
    "t sta",
    "tmux up",
    "tmux stop",
    "t start extra",
    "tmux status extra",
    "tmux start s",
    "t h",
    "Tmux",
    "t S",
    "constructor",
    "__proto__",
  ])
    assert.equal(parseCommand(args), null);
});

test("status rows preserve every full-strip state and snapshot order, not footer aggregation", () => {
  const runtime = current();
  const data = collectSnapshot(runtime);
  const text = stripTerminalSequences(statusText(ctx, data, 240));
  assert.ok(
    text.startsWith("tmux-monitor v0.2.0 (abc1234): 7 monitored panes."),
  );
  assert.equal(
    stripTerminalSequences(format(data.slots, DEFAULTS, ctx.ui.theme, 7).text),
    "_AR+!?:",
  );
  const rows = text
    .split("\n")
    .filter((line) => /^│[^│]*│ %/.test(line))
    .map((line) =>
      line
        .split("│")
        .slice(1, -1)
        .map((cell) => cell.trim()),
    );
  assert.equal(rows.length, 7);
  for (const [i, state] of STATES.entries()) {
    assert.deepEqual(rows[i], [
      DEFAULTS.themes.default.states[state].glyph,
      `%${i}`,
      `owned / @${i} (${i}.0)`,
      `work-${i}`,
      "batch",
      state,
    ]);
  }
  runtime.observer.slots.reverse();
  assert.equal(data.slots[0].paneId, "%0");
});

test("generation reuse does not show the old job label/kind as the new workload", () => {
  const reconcile = new Reconciler({ ...DEFAULTS, staleAfterMs: 15 });
  const p = {
    paneId: "%1",
    pid: "10",
    sessions: [],
    job: job({ phase: "success", exitCode: 0, label: "old job" }),
    pi: reporter(),
  };
  reconcile.reconcile([p], 0);
  p.pi.heartbeatSeq++;
  const slots = reconcile.reconcile([p], 1);
  assert.equal(slots[0].state, "idle");
  assert.equal(slots[0].workload.kind, "interactive");
  assert.equal(slots[0].workload.label, undefined);
  const runtime = current();
  runtime.observer.slots = slots;
  const text = stripTerminalSequences(
    statusText(ctx, collectSnapshot(runtime), 240),
  );
  assert.ok(!text.includes("old job"));
  assert.match(text, /unavailable\s+│ interactive\s+│ idle/);
});

test("human help is focused, themed and uses the active glyphs and shared meanings", () => {
  for (const config of [
    DEFAULTS,
    { ...DEFAULTS, themes: gaudy.themes, activeTheme: "gaudy" },
  ]) {
    const data = collectSnapshot(current(config));
    const inspected = {
      command: "tmux -S '.agents/run/socket' attach -t '$0'",
      prefixes: ["Ctrl+b", "Alt+x"],
    };
    const output = commandHelp(ctx, data, inspected, 140);
    const plain = stripTerminalSequences(output);
    assert.ok(
      plain.startsWith(
        "tmux-monitor v0.2.0 (abc1234): tmux workload awareness.",
      ),
    );
    assert.ok(plain.indexOf("Commands:") < plain.indexOf("States"));
    assert.ok(plain.includes(`active theme ${config.activeTheme}`));
    for (const state of STATES) {
      assert.ok(
        plain.split("\n").some((line) => {
          const cells = line
            .split("│")
            .slice(1, -1)
            .map((cell) => cell.trim());
          return (
            cells[0] === state &&
            cells[1] ===
              config.themes[config.activeTheme].states[state].glyph &&
            cells[2] === STATE_DEFINITIONS[state]
          );
        }),
      );
    }
    assert.ok(
      plain.includes(
        `Run from the project root:\n\n ${inspected.command}\n\nIn tmux:\n • Ctrl+b (or Alt+x), then s opens the session tree and pane previews.\n • Ctrl+b (or Alt+x), then d detaches without ending the session.`,
      ),
    );
    assert.ok(!plain.includes("choose-tree"));
    assert.ok(!plain.includes("Scope:"));
    assert.ok(!plain.includes('"slots"'));
    assert.deepEqual(plain.split("Notes:\n")[1].split("\n"), [
      " • tmux-monitor never controls workloads or attaches to a tmux session.",
      " • Status shows cached data, refreshed automatically in the background.",
      " • Dim glyphs may be last-known or unconfirmed; State reports current evidence.",
    ]);
    assert.notEqual(
      commandHelp({ ...ctx, ui: { theme: theme(35) } }, data, inspected, 140),
      output,
    );
    for (const width of [1, 10, 30, 45, 80, 140]) {
      const rendered = new Text(
        commandHelp(ctx, data, inspected, width),
        0,
        0,
      ).render(width);
      assert.ok(rendered.every((line) => visibleWidth(line) <= width));
    }
  }
});

test("tables escape labels/glyphs and mark missing identity, configuration and inventory", () => {
  const runtime = current();
  runtime.observer.slots = [
    {
      paneId: "%1",
      state: "unregistered",
      workload: { label: "pipe|*<x>`\n\x1b[31m" },
    },
  ];
  const text = stripTerminalSequences(
    statusText(ctx, collectSnapshot(runtime), 240),
  );
  assert.ok(text.includes("pipe|*<x>`��[31m"));
  assert.ok(text.includes("unavailable"));
  assert.ok(!text.includes("\x1b"));
  assert.equal(
    text.split("\n").filter((line) => /^│[^│]*│ %/.test(line)).length,
    1,
  );
  for (const [observer, expected] of [
    [
      { identity: "server", lastSuccessfulScanAt: 0, slots: [] },
      "No eligible panes.",
    ],
    [{ slots: [] }, "not an empty healthy inventory"],
    [{ degraded: true, slots: [] }, "Cached inventory"],
  ]) {
    runtime.observer = {
      ...observer,
      inventoryAge: () => (observer.lastSuccessfulScanAt == null ? null : 0),
    };
    assert.ok(
      stripTerminalSequences(
        statusText(ctx, collectSnapshot(runtime), 240),
      ).includes(expected),
    );
  }
  const data = collectSnapshot(undefined);
  const help = stripTerminalSequences(
    commandHelp(ctx, data, { reason: "No target", prefixes: null }),
  );
  assert.ok(help.includes("active configuration unavailable"));
  assert.ok(help.includes("Terminal inspection:\nNo target\n\nIn tmux:"));
  assert.ok(!help.includes("Prefix+s"));
  assert.ok(help.includes("Prefix, then s"));
  assert.ok(help.includes("Prefix, then d"));
  assert.ok(help.startsWith("tmux-monitor:"));
  assert.ok(!help.includes(" v"));
});

test("one read-only output per command, config/diagnostics separation, no forced scan", async () => {
  let runtime = current(),
    inspections = 0;
  runtime.observer.scan = () => assert.fail("command must not scan");
  const messages = [];
  const commandCtx = {
    ...ctx,
    ui: { ...ctx.ui, notify: (text, type) => messages.push({ text, type }) },
  };
  const handler = monitorCommand(
    () => runtime,
    () => ({
      owner: "owner",
      ancestors: [],
      helper: "/helper",
      socket: "/socket",
    }),
    async () => {
      inspections++;
      return { reason: "No target", prefixes: null };
    },
  );
  for (const args of [
    "",
    "s",
    "status",
    "h",
    "help",
    "c",
    "config",
    "d",
    "diagnostics",
  ]) {
    const before = messages.length;
    await handler(args, commandCtx);
    assert.equal(messages.length, before + 1);
    assert.equal(messages.at(-1).type, "info");
    if (["", "s", "status", "h", "help"].includes(args)) {
      const plain = stripTerminalSequences(messages.at(-1).text);
      assert.ok(plain.includes("┌") && plain.includes("└"));
      assert.ok(!plain.includes("| --- |"));
      assert.ok(!plain.includes("\\_"));
    }
    if (["c", "config"].includes(args))
      assert.deepEqual(JSON.parse(messages.at(-1).text), DEFAULTS);
    if (["d", "diagnostics"].includes(args)) {
      const data = JSON.parse(messages.at(-1).text);
      assert.equal(data.owner, "owner");
      assert.equal(data.slots.length, 7);
      assert.equal(data.schemaVersion, undefined);
      assert.equal(data.statusKey, "footer-compositor:right:0:tmux-monitor");
    }
  }
  assert.equal(inspections, 2);
  await handler("help extra", commandCtx);
  assert.equal(messages.at(-1).type, "error");
  assert.ok(messages.at(-1).text.includes("/tmux-monitor help"));
});

test("a late help lookup cannot notify a retired or replaced runtime", async () => {
  let runtime = current(),
    release;
  const messages = [];
  const handler = monitorCommand(
    () => runtime,
    () => ({}),
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const working = handler("help", {
    ...ctx,
    ui: { ...ctx.ui, notify: (text) => messages.push(text) },
  });
  runtime.retired = true;
  runtime = current();
  release({ reason: "No target", prefixes: null });
  await working;
  assert.deepEqual(messages, []);
});

test("status has Glyph first without repeated meanings, while retaining every hybrid-group member", () => {
  const runtime = current();
  runtime.observer.slots = Array.from({ length: 6 }, (_, i) => ({
    ...runtime.observer.slots[0],
    paneId: `%${i}`,
    state: "success",
  }));
  const data = collectSnapshot(runtime);
  assert.equal(format(data.slots, DEFAULTS, ctx.ui.theme, 100).mode, "hybrid");
  const text = stripTerminalSequences(statusText(ctx, data, 240));
  assert.ok(text.includes("│ Glyph"), text);
  assert.equal(
    text.split("\n").filter((line) => /^│[^│]*│ %/.test(line)).length,
    6,
  );
  assert.ok(!text.includes("Meaning"));
  for (const definition of Object.values(STATE_DEFINITIONS))
    assert.ok(!text.includes(definition));
  for (const width of [40, 45]) {
    const stacked = stripTerminalSequences(statusText(ctx, data, width));
    const fields = [
      "Glyph:",
      "Pane:",
      "Location:",
      "Label:",
      "Kind:",
      "State:",
    ];
    assert.ok(
      fields.every(
        (f, i) =>
          i === 0 || stacked.indexOf(f) > stacked.indexOf(fields[i - 1]),
      ),
    );
    assert.equal(
      stacked.split("\n").filter((line) => line.startsWith("Glyph:")).length,
      6,
    );
  }
});
test("row glyphs follow last-known presentation while State stays truthful", () => {
  const runtime = current();
  runtime.observer.slots = [
    {
      ...runtime.observer.slots[0],
      state: "running",
      presentationState: "active",
      uncertain: true,
    },
  ];
  const text = stripTerminalSequences(
    statusText(ctx, collectSnapshot(runtime), 240),
  );
  const row = text.split("\n").find((line) => /^│[^│]*│ %/.test(line));
  const cells = row
    .split("│")
    .slice(1, -1)
    .map((s) => s.trim());
  assert.deepEqual(cells, [
    "A",
    "%0",
    "owned / @0 (0.0)",
    "work-0",
    "batch",
    "running",
  ]);
});

test("help repeats configured prefixes for inspection/detach and handles unknown or disabled keys", () => {
  const data = collectSnapshot(current());
  for (const [prefixes, prefix] of [
    [["Ctrl+c", "Alt+x"], "Ctrl+c (or Alt+x)"],
    [["Alt+x"], "Alt+x"],
    [null, "Prefix"],
  ]) {
    const text = stripTerminalSequences(
      commandHelp(ctx, data, {
        command: "tmux -S '.agents/run/socket' attach -t '$17'",
        prefixes,
      }),
    );
    assert.ok(
      text.includes(
        ` • ${prefix}, then s opens the session tree and pane previews.`,
      ),
    );
    assert.ok(
      text.includes(
        ` • ${prefix}, then d detaches without ending the session.`,
      ),
    );
    assert.ok(text.includes("attach -t '$17'"));
    assert.ok(!text.includes("pi-workspace-"));
    assert.ok(!text.includes("Prefix+:") && !text.includes("choose-tree"));
    if (!prefixes) assert.ok(!text.includes("Ctrl+b"));
  }
  const disabled = stripTerminalSequences(
    commandHelp(ctx, data, { reason: "No target", prefixes: [] }),
  );
  assert.ok(disabled.includes("Both tmux prefixes are disabled"));
  assert.ok(!disabled.includes("then s") && !disabled.includes("then d"));
});
