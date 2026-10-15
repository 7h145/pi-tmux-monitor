import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, access, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { executeHelper } from "../src/helper.mts";
import { Tmux } from "../src/tmux.mts";
import { eligible } from "../src/reconcile.mts";
import { DEFAULTS } from "../src/config.mts";
async function fixture(fn) {
  const cwd = await mkdtemp("/tmp/monitor-public-"),
    socket = join(cwd, ".agents/run/tmux-socket"),
    tmux = new Tmux(socket);
  const op = (action, args = []) =>
    executeHelper(
      [
        action,
        "--socket",
        socket,
        "--cwd",
        cwd,
        ...(action === "inspect"
          ? []
          : ["--owner", "owner", "--ancestors-json", '["root"]']),
        ...args,
      ],
      {},
      cwd,
    );
  try {
    await fn({ cwd, socket, tmux, op });
  } finally {
    await tmux.call("kill-server").catch(() => {});
    await rm(cwd, { recursive: true, force: true });
  }
}
test("public inspect creates nothing and does not require Pi ownership", () =>
  fixture(async ({ cwd, op }) => {
    const result = await op("inspect");
    assert.equal(result.state, "absent");
    assert.equal(result.serverIdentity, null);
    assert.equal(result.session, null);
    assert.equal(result.partial, false);
    await assert.rejects(access(join(cwd, ".agents")), { code: "ENOENT" });
  }));
test("default launch uses one workload window; workspace start and later launches reuse it", () =>
  fixture(async ({ op, tmux }) => {
    const first = await op("launch", ["--window", "first", "--", "true"]);
    assert.equal(first.state, "ready", JSON.stringify(first));
    assert.match(first.serverIdentity, /\d+:\d+$/);
    assert.match(first.session.id, /^\$/);
    assert.match(first.windowId, /^@/);
    assert.match(first.paneId, /^%/);
    assert.match(first.panePid, /^\d+$/);
    assert.ok(first.jobId);
    assert.equal((await tmux.inventory()).length, 1);
    const shell = await op("start");
    assert.equal(shell.state, "ready");
    assert.equal(shell.session.id, first.session.id);
    assert.equal(shell.changes.session, "reused");
    assert.equal((await tmux.inventory()).length, 1);
    const second = await op("launch", ["--window", "second", "--", "true"]);
    assert.equal(second.state, "ready");
    assert.equal(second.session.id, first.session.id);
    assert.notEqual(second.paneId, first.paneId);
    const inspection = await op("inspect");
    assert.equal(inspection.serverIdentity, first.serverIdentity);
    assert.equal(inspection.sessions.length, 1);
  }));
test("concurrent default launches execute each request once without a spare shell", () =>
  fixture(async ({ cwd, op, tmux }) => {
    const file = join(cwd, "executions");
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        op("launch", [
          "--window",
          "job-" + i,
          "--",
          process.execPath,
          "-e",
          `require('fs').appendFileSync(${JSON.stringify(file)},'x')`,
        ]),
      ),
    );
    results.forEach((r) => assert.equal(r.state, "ready", JSON.stringify(r)));
    assert.equal(new Set(results.map((r) => r.session.id)).size, 1);
    assert.equal(new Set(results.map((r) => r.jobId)).size, 6);
    assert.equal((await tmux.inventory()).length, 6);
    const { readFile } = await import("node:fs/promises");
    assert.equal((await readFile(file, "utf8")).length, 6);
  }));
test("explicit shared session stays unowned; default session collision is refused", () =>
  fixture(async ({ socket, tmux, op }) => {
    await mkdir(join(socket, ".."), { recursive: true });
    await tmux.call("-f", "/dev/null", "new-session", "-d", "-s", "shared");
    const result = await op("launch", [
      "--session",
      "shared",
      "--window",
      "task",
      "--",
      "true",
    ]);
    assert.equal(result.state, "ready");
    assert.equal(await tmux.record("owner", result.session.id), null);
    const { workspaceName } = await import("../src/server.mts");
    await tmux.call("new-session", "-d", "-s", workspaceName("owner"));
    const blocked = await op("launch", ["--window", "task", "--", "true"]);
    assert.equal(blocked.state, "unavailable");
    assert.match(blocked.reason, /conflict/);
    assert.equal(blocked.partial, false);
    assert.equal(blocked.session, null);
  }));
test("ordinary commands need no reporter; missing executable reports known partial resources", () =>
  fixture(async ({ op, tmux }) => {
    const result = await op("launch", [
      "--window",
      "missing",
      "--",
      "/no-such-monitor-command",
    ]);
    assert.equal(result.state, "unavailable");
    assert.equal(result.partial, true);
    assert.equal(result.paneId, null);
    assert.match(result.observed.paneId, /^%/);
    assert.equal((await tmux.inventory()).length, 1);
    assert.match(result.reason, /Server-side/);
  }));
test("public invalid options and missing ownership fail before mutation", () =>
  fixture(async ({ cwd, socket }) => {
    for (const argv of [
      ["start"],
      ["launch", "--window", "a", "--", "true"],
      ["inspect", "--session", "x"],
      ["inspect", "--", "true"],
    ]) {
      const r = await executeHelper(
        [...argv.slice(0, 1), "--socket", socket, ...argv.slice(1)],
        {},
        cwd,
      );
      assert.equal(r.state, "unavailable");
      assert.equal(r.partial, false);
    }
    await assert.rejects(access(join(cwd, ".agents")), { code: "ENOENT" });
  }));
test("names and local PIDs provide no raw ownership; explicit scope still works", () => {
  const p = {
    paneId: "%1",
    job: null,
    pi: null,
    sessions: [{ name: `agent-p${process.pid}-123`, owner: null }],
  };
  assert.equal(eligible(p, "owner", DEFAULTS, null), false);
  assert.equal(
    eligible(p, "owner", { ...DEFAULTS, scope: "server" }, null),
    true,
  );
  assert.equal(
    eligible(
      p,
      "owner",
      { ...DEFAULTS, ownedSessions: [p.sessions[0].name] },
      null,
    ),
    true,
  );
});

test("server tools are operation-specific: missing Pi does not block managed commands or workspace", () =>
  fixture(async ({ op, tmux, socket, cwd }) => {
    await mkdir(join(socket, ".."), { recursive: true });
    await tmux.call("-f", "/dev/null", "new-session", "-d", "-s", "plain");
    await tmux.call("set-environment", "-g", "PATH", "/usr/bin:/bin");
    const shell = await op("start");
    assert.equal(shell.state, "ready", JSON.stringify(shell));
    const restricted = join(cwd, "restricted-env");
    await writeFile(restricted, "export PATH=/usr/bin:/bin\n");
    await tmux.call("set-option", "-g", "default-shell", "/bin/bash");
    await tmux.call("set-environment", "-g", "BASH_ENV", restricted);
    const ordinary = await op("launch", [
      "--window",
      "command",
      "--",
      "/bin/true",
    ]);
    assert.equal(ordinary.state, "ready", JSON.stringify(ordinary));
    const pi = await op("pi", [
      "--window",
      "no-pi",
      "--uninstrumented",
      "--",
      "--help",
    ]);
    assert.equal(pi.state, "unavailable");
    assert.match(pi.reason, /Server-side/);
    assert.equal(pi.partial, true);
  }));
test("missing server-side helper execution is a bounded partial failure, not a raw retry", () =>
  fixture(async ({ op, tmux, socket, cwd }) => {
    await mkdir(join(socket, ".."), { recursive: true });
    await tmux.call("-f", "/dev/null", "new-session", "-d", "-s", "plain");
    // BASH_ENV runs before the requested helper command in the new window shell.
    const stop = join(cwd, "stop");
    await writeFile(stop, "exec /bin/bash -i\n");
    await tmux.call("set-environment", "-g", "BASH_ENV", stop);
    const result = await op("launch", ["--window", "stopped", "--", "true"]);
    assert.equal(result.state, "unavailable");
    assert.equal(result.partial, true);
    assert.equal(result.paneId, null);
    assert.match(result.reason, /Startup was not confirmed/);
    assert.match(result.observed.paneId, /^%\d+$/);
    assert.match(result.observed.panePid, /^\d+$/);
    assert.equal(
      (await tmux.call("list-panes", "-a", "-F", "#{pane_id}")).split("\n")
        .length,
      2,
    );
  }));
test("retired target verification stops before subsequent queries", async () => {
  const { verifyTarget } = await import("../src/server.mts");
  let live = true,
    calls = 0;
  await assert.rejects(
    verifyTarget(
      {
        identity: async () => {
          live = false;
          return "same";
        },
        call: async () => {
          calls++;
        },
      },
      "same",
      "%1",
      "$1",
      () => live,
    ),
    /retired/,
  );
  assert.equal(calls, 0);
});
test("retirement between local option listing and read is ordinary record absence", async () => {
  const t = new Tmux("/not-used");
  let calls = 0;
  t.call = async () =>
    ++calls === 1
      ? "@pi-tmux-monitor-pi value"
      : Promise.reject(
          Object.assign(Error(), {
            code: 1,
            stderr: "invalid option: @pi-tmux-monitor-pi\n",
          }),
        );
  assert.equal(await t.record("pi", "%1"), null);
});

for (const inheritedAncestors of ["[]", '["unrelated-owner"]']) {
  test(`startup acknowledgement rejects a changed target with inherited ancestry ${inheritedAncestors}`, () =>
    fixture(async ({ cwd, socket }) => {
      const { parseCLI, launch } = await import("../src/launch.mts");
      const { workspaceName, sessionOwner } = await import("../src/server.mts");
      const plan = parseCLI(
        [
          "launch",
          "--owner",
          "owner",
          "--ancestors-json",
          "[]",
          "--socket",
          socket,
          "--cwd",
          cwd,
          "--window",
          "work",
          "--",
          "true",
        ],
        { ...process.env, PI_TMUX_MONITOR_ANCESTORS: inheritedAncestors },
      );
      assert.deepEqual(plan.ancestors, ["owner"]);
      let made = false,
        reads = 0;
      const tmux = {
        identity: async () => "socket:10:20",
        record: async (kind) =>
          kind === "owner"
            ? sessionOwner(plan.owner, [])
            : { jobId: plan.jobId },
        call: async (...args) => {
          if (args[0] === "new-session") {
            made = true;
            await writeFile(plan.ackPath, JSON.stringify({ state: "ready" }));
            return "$1|%1";
          }
          const format = args.at(-1);
          if (args.includes("list-sessions"))
            return "10:20" + (made ? "\n$1|" + workspaceName(plan.owner) : "");
          if (format === "#{session_id}|#{session_name}")
            return "$1|" + workspaceName(plan.owner);
          if (format === "#{session_id}|#{window_id}|#{pane_id}|#{pane_pid}")
            return ++reads === 1 ? "$1|@1|%1|100" : "$1|@2|%1|200";
          if (format === "#{session_name}") return workspaceName(plan.owner);
          throw Error("Unexpected tmux query");
        },
      };
      await assert.rejects(
        launch(plan, () => tmux),
        (e) =>
          e.result.partial && /target changed before startup/.test(e.message),
      );
    }));
}
