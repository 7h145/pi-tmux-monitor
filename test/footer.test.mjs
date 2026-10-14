import assert from "node:assert/strict";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { readFile } from "node:fs/promises";
import {
  FooterComponent,
  createEventBus,
  initTheme,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth, stripTerminalSequences } from "@earendil-works/pi-tui";
import { FooterAdapter, STATUS_KEY } from "../src/footer.mts";
import { Observer } from "../src/observer.mts";
import { job, reporter } from "./fixtures.mjs";
import { compositorSource } from "./compositor-source.mjs";
import { DEFAULTS } from "../src/config.mts";
import { format, fullSummary } from "../src/formatter.mts";
initTheme("dark", false);
const source = await compositorSource();
const compositor = source
  ? (await import(pathToFileURL(source).href)).default
  : undefined;
if (source && typeof compositor !== "function")
  throw Error("Compositor test dependency must export an extension factory");
const prefix = "footer-compositor:dynamic:";
const example = JSON.parse(
  await readFile(
    new URL("../examples/pi-tmux-monitor.json", import.meta.url),
    "utf8",
  ),
);
const configs = [
  DEFAULTS,
  { ...DEFAULTS, themes: example.themes, activeTheme: "gaudy" },
];
function harness({ trace = false } = {}) {
  const events = createEventBus(),
    handlers = new Map(),
    statuses = new Map(),
    diagnostics = [];
  let color = "32",
    publications = 0,
    active = true;
  const ctx = {
    mode: "tui",
    get ui() {
      assert.ok(active, "retired context");
      return {
        theme: { fg: (_, s) => `\x1b[${color}m${s}\x1b[39m` },
        setStatus: (k, v) => {
          publications++;
          if (v === undefined) statuses.delete(k);
          else statuses.set(k, v);
        },
      };
    },
  };
  const pi = { events, on: (k, h) => handlers.set(k, h) };
  let capability;
  const allocations = [];
  events.on(prefix + "available", (next) => {
    capability = next;
    if (!trace) return;
    const register = next.register;
    next.register = (input) =>
      register({
        ...input,
        render: (budget) => {
          const text = input.render(budget);
          if (input.key === STATUS_KEY) allocations.push({ ...budget, text });
          return text;
        },
      });
  });
  compositor?.(pi);
  return {
    pi,
    ctx,
    statuses,
    diagnostics,
    allocations,
    get capability() {
      return capability;
    },
    start: () => handlers.get("session_start")({}, ctx),
    stop: () => handlers.get("session_shutdown")({}, ctx),
    setColor: (c) => (color = c),
    invalidate: () => (active = false),
    get publications() {
      return publications;
    },
  };
}
function footer(statuses) {
  const model = {
    provider: "test",
    id: "test-model",
    contextWindow: 100000,
    reasoning: true,
  };
  const session = {
    state: { model, thinkingLevel: "medium" },
    model,
    modelRuntime: { isUsingSubscription: () => false },
    sessionManager: {
      getCwd: () => "/workspace",
      getSessionName: () => undefined,
      getEntryCount: () => 0,
      getSessionId: () => "test",
      getLeafId: () => null,
      getEntries: () => [],
    },
    getContextUsage: () => ({ contextWindow: 100000, percent: 0, tokens: 0 }),
  };
  return new FooterComponent(session, {
    getGitBranch: () => null,
    getAvailableProviderCount: () => 1,
    getExtensionStatuses: () => statuses,
  });
}
test("missing/unsupported capability retains full static summary; late discovery is retired", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness(),
    adapter = new FooterAdapter(h.pi, h.ctx, DEFAULTS, (s) =>
      h.diagnostics.push(s),
    );
  adapter.publish(Array.from({ length: 20 }, () => ({ state: "active" })));
  assert.equal(stripTerminalSequences(h.statuses.get(STATUS_KEY)), "A20");
  assert.equal(adapter.capability, "missing");
  assert.equal(h.diagnostics.length, 0);
  adapter.finishStartup();
  t.mock.timers.tick(DEFAULTS.pollIntervalMs);
  assert.equal(h.diagnostics.length, 1);
  adapter.finishStartup();
  t.mock.timers.tick(DEFAULTS.pollIntervalMs);
  assert.equal(h.diagnostics.length, 1);
  let request;
  h.pi.events.on(prefix + "discover", (r) => (request = r));
  adapter.discover();
  h.pi.events.emit(prefix + "available", {
    version: 2,
    instanceId: "wrong",
    register: () => {
      throw Error();
    },
  });
  assert.equal(adapter.capability, "missing");
  adapter.stop();
  h.invalidate();
  request.accept({
    version: 1,
    instanceId: "late",
    register: () => {
      assert.fail("retired registration");
    },
  });
  adapter.publish([]);
  t.mock.timers.tick(DEFAULTS.pollIntervalMs);
  assert.equal(h.diagnostics.length, 1);
  assert.equal(h.statuses.size, 0);
});
test("synthetic capability replacement, stale unavailability and idempotent cleanup", () => {
  const h = harness(),
    adapter = new FooterAdapter(h.pi, h.ctx, DEFAULTS, () => {});
  let removed = 0,
    registered = 0,
    render;
  const cap = (id) => ({
    version: 1,
    instanceId: id,
    register: (r) => {
      registered++;
      render = r.render;
      assert.equal(r.key, STATUS_KEY);
      return () => removed++;
    },
  });
  h.pi.events.emit(prefix + "available", cap("a"));
  h.pi.events.emit(prefix + "available", cap("a"));
  assert.equal(registered, 1);
  h.pi.events.emit(prefix + "available", cap("b"));
  assert.equal(registered, 2);
  assert.equal(removed, 1);
  h.pi.events.emit(prefix + "unavailable", { version: 1, instanceId: "a" });
  assert.equal(adapter.capability, "dynamic-v1");
  adapter.publish([{ state: "failed" }]);
  assert.equal(
    stripTerminalSequences(render({ maxWidth: 1, theme: h.ctx.ui.theme })),
    "!",
  );
  assert.equal(render({ maxWidth: 0, theme: h.ctx.ui.theme }), "");
  h.pi.events.emit(prefix + "unavailable", { version: 1, instanceId: "b" });
  assert.equal(removed, 2);
  assert.equal(adapter.capability, "missing");
  adapter.stop();
  adapter.stop();
  assert.equal(removed, 2);
});
test(
  "actual compositor: right placement, both themes/start orders, mixed dynamic/static producers, resize and cleanup",
  { skip: !compositor },
  (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    assert.equal(STATUS_KEY, "footer-compositor:right:0:tmux-monitor");
    const original = FooterComponent.prototype.render;
    for (const config of configs)
      for (const producerFirst of [false, true]) {
        const h = harness({ trace: true });
        let adapter;
        const disposers = [];
        try {
          if (!producerFirst) h.start();
          adapter = new FooterAdapter(h.pi, h.ctx, config, (message) =>
            h.diagnostics.push(message),
          );
          adapter.finishStartup();
          if (producerFirst) h.start();
          t.mock.timers.tick(config.pollIntervalMs);
          assert.equal(adapter.capability, "dynamic-v1");
          assert.deepEqual(h.diagnostics, []);
          const slots = [
            ...Array.from({ length: 30 }, () => ({ state: "active" })),
            ...Array.from({ length: 10 }, () => ({ state: "idle" })),
          ];
          adapter.publish(slots);
          h.ctx.ui.setStatus("footer-compositor:left:10:read-only", "(ro)");
          h.ctx.ui.setStatus("footer-compositor:right:10:git", "clean");
          h.ctx.ui.setStatus("footer-compositor:right:20:usage", "C W2%");
          h.ctx.ui.setStatus("ordinary", "ordinary");
          const registerPeers = () => {
            for (const [key, text] of [
              ["footer-compositor:left:20:dynamic-left-test", "LD"],
              ["footer-compositor:right:30:dynamic-right-test", "dyn"],
            ]) {
              disposers.push(
                h.capability.register({
                  key,
                  render: ({ maxWidth, theme }) =>
                    maxWidth >= visibleWidth(text)
                      ? theme.fg("accent", text)
                      : "",
                }),
              );
              // The fallback's length must not determine a dynamic budget.
              h.ctx.ui.setStatus(key, "cached fallback ".repeat(20));
            }
          };
          registerPeers();
          const component = footer(h.statuses);
          for (let width = 0; width <= 140; width++)
            for (const line of component.render(width))
              assert.ok(
                visibleWidth(line) <= width,
                `width ${width}: ${JSON.stringify(line)}`,
              );
          const modes = new Set();
          for (const { maxWidth, theme, text } of h.allocations) {
            const expected = format(slots, config, theme, maxWidth);
            assert.equal(text, expected.text);
            assert.ok(visibleWidth(text) <= maxWidth);
            modes.add(expected.mode);
          }
          assert.deepEqual([...modes].sort(), [
            "hidden",
            "partial",
            "strip",
            "summary",
          ]);
          const wide = component.render(140);
          const plain = stripTerminalSequences(wide[0]);
          const strip = stripTerminalSequences(
            format(slots, config, h.ctx.ui.theme, 40).text,
          );
          assert.ok(plain.includes(`(ro) LD`), plain);
          assert.ok(plain.endsWith(`${strip} • clean • C W2% • dyn`), plain);
          assert.ok(plain.indexOf(strip) > plain.indexOf("(ro) LD"));
          assert.equal(stripTerminalSequences(wide.at(-1)), "ordinary");
          const narrow = stripTerminalSequences(component.render(40)[0]);
          assert.ok(
            narrow.includes(config.themes[config.activeTheme].overflow),
            narrow,
          );
          assert.ok(narrow.endsWith(" • clean • C W2% • dyn"), narrow);
          // Higher-order right text survives while the monitor gets zero budget.
          const omitted = stripTerminalSequences(component.render(35)[0]);
          assert.ok(
            !omitted.includes(
              config.themes[config.activeTheme].states.active.glyph,
            ),
            omitted,
          );
          assert.ok(omitted.endsWith("clean • C W2% • dyn"), omitted);
          assert.equal(h.allocations.at(-1).maxWidth, 0);
          const before = component.render(140)[0];
          h.setColor("35");
          const after = component.render(140)[0];
          assert.notEqual(after, before);
          assert.ok(after.includes("\x1b[35m"));
          const publications = h.publications;
          adapter.publish(slots);
          assert.ok(h.publications > publications);
          adapter.publish([]);
          assert.ok(!h.statuses.has(STATUS_KEY));
          const renders = h.allocations.length;
          component.render(140);
          assert.equal(h.allocations.length, renders);
          adapter.publish(slots);
          h.stop();
          assert.equal(adapter.capability, "missing");
          assert.equal(
            h.statuses.get(STATUS_KEY),
            fullSummary(slots, config, h.ctx.ui.theme),
          );
          h.start();
          registerPeers();
          t.mock.timers.tick(config.pollIntervalMs);
          assert.equal(adapter.capability, "dynamic-v1");
          assert.deepEqual(h.diagnostics, []);
          const restarted = stripTerminalSequences(component.render(140)[0]);
          assert.ok(restarted.includes(strip), restarted);
          adapter.stop();
          assert.ok(!h.statuses.has(STATUS_KEY));
          h.stop();
          h.invalidate();
          assert.equal(FooterComponent.prototype.render, original);
        } finally {
          adapter?.stop();
          for (const dispose of disposers) dispose();
          h.stop();
        }
      }
  },
);

test(
  "actual compositor: static count fallback uses the same right key without a registration",
  { skip: !compositor },
  () => {
    const h = harness();
    try {
      const slots = Array.from({ length: 20 }, () => ({ state: "active" }));
      h.ctx.ui.setStatus(
        STATUS_KEY,
        fullSummary(slots, DEFAULTS, h.ctx.ui.theme),
      );
      h.ctx.ui.setStatus("footer-compositor:right:20:usage", "C W2%");
      const component = footer(h.statuses);
      // Without a compositor, it is an ordinary extension-status line.
      assert.equal(
        stripTerminalSequences(component.render(140).at(-1)),
        "A20 C W2%",
      );
      h.start();
      // No dynamic registration: the full summary follows normal static placement.
      const wide = component.render(140);
      assert.equal(wide.length, 2);
      assert.ok(stripTerminalSequences(wide[0]).endsWith("A20 • C W2%"));
      assert.ok(
        !stripTerminalSequences(component.render(22)[0]).includes("A20"),
      );
      h.ctx.ui.setStatus(STATUS_KEY, undefined);
      assert.ok(
        !stripTerminalSequences(component.render(140)[0]).includes("A20"),
      );
    } finally {
      h.stop();
    }
  },
);

function syntheticCapability(instanceId = "synthetic") {
  return { version: 1, instanceId, register: () => () => {} };
}

test("absence grace begins after initialization; a late capability cancels it", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness();
  const adapter = new FooterAdapter(h.pi, h.ctx, DEFAULTS, (message) =>
    h.diagnostics.push(message),
  );
  try {
    adapter.publish([{ state: "idle" }]);
    assert.equal(stripTerminalSequences(h.statuses.get(STATUS_KEY)), "_");
    // Initial observation may wait on tmux before the compositor starts.
    t.mock.timers.tick(DEFAULTS.pollIntervalMs * 10);
    assert.deepEqual(h.diagnostics, []);
    adapter.finishStartup();
    t.mock.timers.tick(DEFAULTS.pollIntervalMs - 1);
    assert.deepEqual(h.diagnostics, []);
    h.pi.events.emit(prefix + "available", syntheticCapability());
    t.mock.timers.tick(DEFAULTS.pollIntervalMs * 2);
    assert.equal(adapter.capability, "dynamic-v1");
    assert.deepEqual(h.diagnostics, []);
  } finally {
    adapter.stop();
  }
});

test("deferred absence check rediscovers a capability without an availability event", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness();
  const adapter = new FooterAdapter(h.pi, h.ctx, DEFAULTS, (message) =>
    h.diagnostics.push(message),
  );
  const unsubscribe = h.pi.events.on(prefix + "discover", (request) =>
    request.accept(syntheticCapability()),
  );
  try {
    adapter.finishStartup();
    t.mock.timers.tick(DEFAULTS.pollIntervalMs);
    assert.equal(adapter.capability, "dynamic-v1");
    assert.deepEqual(h.diagnostics, []);
  } finally {
    adapter.stop();
    unsubscribe();
  }
});

test("persistent capability loss warns once and keeps the same static fallback", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness();
  const adapter = new FooterAdapter(h.pi, h.ctx, DEFAULTS, (message) =>
    h.diagnostics.push(message),
  );
  try {
    h.pi.events.emit(prefix + "available", syntheticCapability("a"));
    adapter.finishStartup();
    adapter.publish([{ state: "running" }]);
    h.pi.events.emit(prefix + "unavailable", { version: 1, instanceId: "a" });
    assert.equal(adapter.capability, "missing");
    assert.equal(stripTerminalSequences(h.statuses.get(STATUS_KEY)), "R");
    assert.deepEqual(h.diagnostics, []);
    t.mock.timers.tick(DEFAULTS.pollIntervalMs);
    assert.equal(h.diagnostics.length, 1);
    h.pi.events.emit(prefix + "available", syntheticCapability("b"));
    h.pi.events.emit(prefix + "unavailable", { version: 1, instanceId: "b" });
    t.mock.timers.tick(DEFAULTS.pollIntervalMs * 2);
    assert.equal(h.diagnostics.length, 1);
  } finally {
    adapter.stop();
  }
});

test("shutdown cancels an absence check without touching a retired context", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness();
  const adapter = new FooterAdapter(h.pi, h.ctx, DEFAULTS, (message) =>
    h.diagnostics.push(message),
  );
  adapter.finishStartup();
  adapter.publish([{ state: "failed" }]);
  adapter.stop();
  adapter.stop();
  h.invalidate();
  adapter.finishStartup();
  t.mock.timers.tick(DEFAULTS.pollIntervalMs * 2);
  assert.deepEqual(h.diagnostics, []);
  assert.equal(h.statuses.size, 0);
});

for (const dynamic of [false, true])
  test(
    `${dynamic ? "actual compositor" : "static fallback"}: pending-scan expiry republishes and updates the rendered footer`,
    { skip: dynamic && !compositor },
    async (t) => {
      t.mock.timers.enable({ apis: ["setInterval"] });
      const h = harness();
      const adapter = new FooterAdapter(h.pi, h.ctx, DEFAULTS, (s) =>
        h.diagnostics.push(s),
      );
      let time = 0,
        waiting = false,
        release,
        entered,
        calls = 0;
      const pause = new Promise((resolve) => {
        release = resolve;
      });
      const receiving = new Promise((resolve) => {
        entered = resolve;
      });
      const p = {
        paneId: "%1",
        pid: "10",
        sessions: [],
        job: job(),
        pi: reporter({ jobId: "j", kind: "batch", state: "active" }),
      };
      const observer = new Observer({
        cwd: "/work",
        owner: "owner",
        env: {},
        config: { ...DEFAULTS, socketPath: "/socket" },
        clock: () => time,
        publish: (slots) => adapter.publish(slots),
        tmuxFactory: () => ({
          identity: async () => {
            calls++;
            return "server";
          },
          inventory: async (_diagnostic, clock) => {
            calls++;
            const rows = [
              {
                ...structuredClone(p),
                observedAt: { job: clock(), pi: clock() },
              },
            ];
            if (waiting) {
              entered();
              await pause;
            }
            return rows;
          },
        }),
      });
      let scanning;
      try {
        if (dynamic) h.start();
        await observer.start();
        time = 5000;
        p.job.heartbeatSeq++;
        p.pi.heartbeatSeq++;
        await observer.scan();
        const component = footer(h.statuses);
        const line = () =>
          stripTerminalSequences(component.render(140)[dynamic ? 0 : 2]);
        assert.ok(line().endsWith("A"));
        waiting = true;
        scanning = observer.scan();
        await receiving;
        const publications = h.publications,
          queries = calls;
        time = 20000;
        t.mock.timers.tick(DEFAULTS.pollIntervalMs);
        assert.equal(h.publications, publications + 1);
        assert.equal(calls, queries);
        assert.equal(stripTerminalSequences(h.statuses.get(STATUS_KEY)), "?");
        assert.ok(line().endsWith("?"));
        assert.equal(observer.lastSuccessfulScanAt, 5000);
        const count = h.publications;
        observer.stop();
        adapter.stop();
        h.invalidate();
        release();
        await scanning;
        assert.equal(h.publications, count + 1); // Only the explicit adapter cleanup.
        assert.equal(observer.lastSuccessfulScanAt, 5000);
        assert.deepEqual(h.diagnostics, []);
      } finally {
        observer.stop();
        adapter.stop();
        release();
        await scanning;
        if (dynamic) h.stop();
      }
    },
  );
