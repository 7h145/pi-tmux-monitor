import assert from "node:assert/strict";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { access, readFile } from "node:fs/promises";
import {
  FooterComponent,
  createEventBus,
  initTheme,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth, stripTerminalSequences } from "@earendil-works/pi-tui";
import { FooterAdapter, STATUS_KEY } from "../src/footer.mts";
import { DEFAULTS } from "../src/config.mts";
import { format, fullSummary } from "../src/formatter.mts";
initTheme("dark", false);
const source =
  process.env.PI_MONITOR_COMPOSITOR ??
  "/root/.local/share/pi/agent/packages/git/github.com/7h145/pi-footer-compositor/pi-footer-compositor.ts";
let compositor;
try {
  await access(source);
  compositor = (await import(pathToFileURL(source).href)).default;
} catch (e) {
  if (e.code !== "ENOENT") throw e;
}
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
test("missing/unsupported capability retains full static summary; late discovery is retired", () => {
  const h = harness(),
    adapter = new FooterAdapter(h.pi, h.ctx, DEFAULTS, (s) =>
      h.diagnostics.push(s),
    );
  adapter.publish(Array.from({ length: 20 }, () => ({ state: "active" })));
  assert.equal(stripTerminalSequences(h.statuses.get(STATUS_KEY)), "R20");
  assert.equal(adapter.capability, "missing");
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
  () => {
    assert.equal(STATUS_KEY, "footer-compositor:right:0:tmux-monitor");
    const original = FooterComponent.prototype.render;
    for (const config of configs)
      for (const producerFirst of [false, true]) {
        const h = harness({ trace: true });
        let adapter;
        const disposers = [];
        try {
          if (!producerFirst) h.start();
          adapter = new FooterAdapter(h.pi, h.ctx, config, () => {});
          if (producerFirst) h.start();
          assert.equal(adapter.capability, "dynamic-v1");
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
          assert.equal(adapter.capability, "dynamic-v1");
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
        "R20 C W2%",
      );
      h.start();
      // No dynamic registration: the full summary follows normal static placement.
      const wide = component.render(140);
      assert.equal(wide.length, 2);
      assert.ok(stripTerminalSequences(wide[0]).endsWith("R20 • C W2%"));
      assert.ok(
        !stripTerminalSequences(component.render(22)[0]).includes("R20"),
      );
      h.ctx.ui.setStatus(STATUS_KEY, undefined);
      assert.ok(
        !stripTerminalSequences(component.render(140)[0]).includes("R20"),
      );
    } finally {
      h.stop();
    }
  },
);
