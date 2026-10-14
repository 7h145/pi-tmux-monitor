import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join, relative } from "node:path";
import { Tmux } from "../src/tmux.mts";
import { DEFAULTS } from "../src/config.mts";
import { inspectionHint, readablePrefix } from "../src/inspection.mts";
import { quote } from "../src/shell.mts";
async function fixture(fn) {
  const root = await mkdtemp("/tmp/monitor-inspection-");
  const cwd = join(root, "project's root");
  await mkdir(join(cwd, ".agents/run"), { recursive: true });
  const tmux = new Tmux(join(cwd, ".agents/run/socket"), 1000);
  try {
    await tmux.call(
      "-f",
      "/dev/null",
      "new-session",
      "-d",
      "-s",
      "owner's session",
    );
    await tmux.write("owner", "$0", {
      v: 1,
      ownerSessionId: "owner",
      ancestors: [],
    });
    const identity = await tmux.identity();
    const slots = await tmux.inventory();
    const current = {
      owner: "owner",
      config: DEFAULTS,
      observer: { socket: tmux.socket, identity, slots },
    };
    await fn({ root, cwd, tmux, current, identity });
  } finally {
    await tmux.call("kill-server").catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
}

test("prefix notation, disabled and duplicate keys are not invented defaults", () => {
  assert.equal(readablePrefix("C-b"), "Ctrl+b");
  assert.equal(readablePrefix("M-x"), "Alt+x");
  assert.equal(readablePrefix("C-M-S-F2"), "Ctrl+Alt+Shift+F2");
  assert.equal(readablePrefix("None"), null);
  assert.throws(() => readablePrefix("\x1b[31m"));
});

test("outside tmux: exact owned-session verification, relative path, quoting and effective prefixes", async () =>
  fixture(async ({ cwd, tmux, current }) => {
    assert.ok(
      (await inspectionHint(current, cwd, () => tmux)).hint.startsWith(
        "In tmux: Ctrl+b, then s",
      ),
    );
    await tmux.call("set-option", "-g", "prefix", "C-b");
    await tmux.call("set-option", "-t", "$0", "prefix", "C-c");
    await tmux.call("set-option", "-t", "$0", "prefix2", "M-x");
    const calls = [],
      call = tmux.call.bind(tmux);
    tmux.call = (...args) => {
      calls.push(args);
      return call(...args);
    };
    const result = await inspectionHint(current, cwd, () => tmux);
    assert.equal(result.command, `tmux -S '.agents/run/socket' attach -t '$0'`);
    assert.equal(
      result.hint,
      "In tmux: Ctrl+c (or Alt+x), then s opens the session tree and pane previews.",
    );
    assert.ok(
      calls.every((args) =>
        ["display-message", "show-options"].includes(args[0]),
      ),
    );
    const fromParent = await inspectionHint(
      current,
      join(cwd, ".."),
      () => tmux,
    );
    assert.equal(
      fromParent.command,
      `tmux -S ${quote(relative(join(cwd, ".."), tmux.socket))} attach -t '$0'`,
    );
    assert.ok(fromParent.command.includes("'\\''"));
    await tmux.call("set-option", "-t", "$0", "prefix2", "C-c");
    assert.ok(
      !(await inspectionHint(current, cwd, () => tmux)).hint.includes("or"),
    );
    await tmux.call("set-option", "-t", "$0", "prefix", "None");
    await tmux.call("set-option", "-t", "$0", "prefix2", "None");
    assert.equal(
      (await inspectionHint(current, cwd, () => tmux)).hint,
      "Both tmux prefixes are disabled; Prefix+s is unavailable.",
    );
  }));

test("foreground session takes precedence, including linked-window aliases and another observer namespace", async () =>
  fixture(async ({ cwd, tmux, current, identity }) => {
    await tmux.call("new-session", "-d", "-s", "second");
    await tmux.call("link-window", "-s", "$0:0", "-t", "$1:1");
    const pid = identity.split(":").at(-2);
    current.reporter = {
      tmux,
      serverIdentity: identity,
      paneId: "%0",
      env: { TMUX: `${tmux.socket},${pid},1` },
    };
    current.observer = { socket: "/other", identity: "other", slots: [] };
    const result = await inspectionHint(current, cwd, () =>
      assert.fail("must prefer foreground"),
    );
    assert.ok(result.command.endsWith("attach -t '$1'"));
    current.reporter.paneId = "%999";
    assert.equal((await inspectionHint(current, cwd)).command, undefined);
    current.reporter.serverIdentity = "replaced";
    assert.equal((await inspectionHint(current, cwd)).command, undefined);
  }));

test("absent, ambiguous and changed session ownership yield no fabricated target", async () =>
  fixture(async ({ cwd, tmux, current }) => {
    assert.equal((await inspectionHint(undefined, cwd)).command, undefined);
    const noSlots = {
      ...current,
      observer: { ...current.observer, slots: [] },
    };
    const unavailable = await inspectionHint(noSlots, cwd);
    assert.ok(unavailable.reason.includes("No associated"));
    assert.equal(unavailable.hint, undefined);
    await tmux.call("new-session", "-d", "-s", "another");
    await tmux.write("owner", "$1", {
      v: 1,
      ownerSessionId: "owner",
      ancestors: [],
    });
    current.observer.slots = await tmux.inventory();
    assert.ok(
      (await inspectionHint(current, cwd)).reason.includes("Several owned"),
    );
    current.observer.slots = current.observer.slots.filter((p) =>
      p.sessions.some((s) => s.id === "$0"),
    );
    await tmux.write("owner", "$0", {
      v: 1,
      ownerSessionId: "different",
      ancestors: [],
    });
    assert.ok(
      (await inspectionHint(current, cwd)).reason.includes("ownership changed"),
    );
    await tmux.call("set-option", "-u", "-t", "$0", "@pi-tmux-monitor-owner");
    current.config = { ...DEFAULTS, ownedSessions: ["owner's session"] };
    current.observer.slots = (await tmux.inventory()).filter((p) =>
      p.sessions.some((s) => s.id === "$0"),
    );
    assert.ok((await inspectionHint(current, cwd)).command);
    current.observer.identity = "different server";
    assert.equal((await inspectionHint(current, cwd)).command, undefined);
  }));

test("prefix lookup failure retains a verified attachment command with only a generic hint", async () =>
  fixture(async ({ cwd, tmux, current }) => {
    const call = tmux.call.bind(tmux);
    tmux.call = (...args) =>
      args.at(-1) === "prefix2"
        ? Promise.reject(Error("timeout"))
        : call(...args);
    const result = await inspectionHint(current, cwd, () => tmux);
    assert.ok(result.command);
    assert.equal(
      result.hint,
      "In tmux: Prefix+s opens the session tree and pane previews.",
    );
  }));
