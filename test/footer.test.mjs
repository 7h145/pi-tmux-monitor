import assert from "node:assert/strict";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { access } from "node:fs/promises";
import {
  FooterComponent,
  createEventBus,
  initTheme,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth, stripTerminalSequences } from "@earendil-works/pi-tui";
import { FooterAdapter, STATUS_KEY } from "../src/footer.mjs";
import { DEFAULTS } from "../src/config.mjs";
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
const prefix = "footer-compositor:dynamic-left:";
function harness() {
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
  compositor?.(pi);
  return {
    pi,
    ctx,
    statuses,
    diagnostics,
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
test("missing/old capability retains full static summary; late discovery is retired", () => {
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
  assert.equal(adapter.capability, "dynamic-left-v1");
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
  "actual compositor: both start orders, resize, themes, mixed producers, reload and shutdown",
  { skip: !compositor },
  () => {
    const original = FooterComponent.prototype.render;
    for (const producerFirst of [false, true]) {
      const h = harness();
      let adapter;
      try {
        if (!producerFirst) h.start();
        adapter = new FooterAdapter(h.pi, h.ctx, DEFAULTS, () => {});
        if (producerFirst) h.start();
        assert.equal(adapter.capability, "dynamic-left-v1");
        const slots = [
          ...Array.from({ length: 30 }, () => ({ state: "active" })),
          ...Array.from({ length: 10 }, () => ({ state: "idle" })),
        ];
        adapter.publish(slots);
        h.ctx.ui.setStatus("footer-compositor:left:10:read-only", "(ro)");
        h.ctx.ui.setStatus("footer-compositor:right:20:usage", "C W2%");
        h.ctx.ui.setStatus("ordinary", "ordinary");
        const component = footer(h.statuses);
        for (let width = 0; width <= 140; width++)
          for (const line of component.render(width))
            assert.ok(
              visibleWidth(line) <= width,
              `width ${width}: ${JSON.stringify(line)}`,
            );
        const wide = component.render(140);
        assert.ok(
          stripTerminalSequences(wide[0]).includes(
            "R".repeat(30) + "_".repeat(10),
          ),
        );
        assert.equal(stripTerminalSequences(wide.at(-1)), "ordinary");
        const narrow = stripTerminalSequences(component.render(35)[0]);
        assert.ok(narrow.includes("R30") || narrow.includes("…"), narrow);
        assert.ok(narrow.includes("C W2%"));
        const before = component.render(140)[0];
        h.setColor("35");
        const after = component.render(140)[0];
        assert.notEqual(after, before);
        assert.ok(after.includes("\x1b[35m"));
        const publications = h.publications;
        adapter.publish(slots);
        assert.ok(h.publications > publications);
        h.stop();
        assert.equal(adapter.capability, "missing");
        assert.equal(
          stripTerminalSequences(h.statuses.get(STATUS_KEY)),
          "R30 _10",
        );
        h.start();
        assert.equal(adapter.capability, "dynamic-left-v1");
        adapter.stop();
        h.stop();
        h.invalidate();
        assert.equal(FooterComponent.prototype.render, original);
      } finally {
        adapter?.stop();
        h.stop();
      }
    }
  },
);
