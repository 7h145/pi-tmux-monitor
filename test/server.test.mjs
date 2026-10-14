import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdtemp,
  mkdir,
  rm,
  access,
  writeFile,
  stat,
  chmod,
  symlink,
} from "node:fs/promises";
import { join } from "node:path";
import { Tmux } from "../src/tmux.mts";
import { DEFAULTS } from "../src/config.mts";
import { OWNER } from "../src/protocol.mts";
import {
  inspectServer,
  serverCommand,
  workspaceName,
  sessionOwner,
} from "../src/server.mts";
import {
  serverText,
  collectSnapshot,
  commandHelp,
  monitorCommand,
} from "../src/commands.mts";

const ctx = {
  hasUI: true,
  sessionManager: { getSessionId: () => "owner" },
  ui: { theme: { fg: (_, s) => s, style: (s) => s } },
};
async function fixture(fn) {
  const cwd = await mkdtemp("/tmp/monitor-bootstrap-"),
    socket = join(cwd, ".agents/run/tmux-socket");
  const tmux = new Tmux(socket);
  const current = {
    owner: "owner",
    ancestors: ["root"],
    identity: { version: "0.1.1" },
    config: { ...DEFAULTS },
  };
  const command = (start = true, live = () => true, factory) =>
    serverCommand(current, cwd, start, live, factory);
  try {
    await fn({ cwd, socket, tmux, current, command });
  } finally {
    await tmux.call("kill-server").catch(() => {});
    await rm(cwd, { recursive: true, force: true });
  }
}
const absent = async (path) => assert.rejects(access(path), { code: "ENOENT" });

test("server status never bootstraps or creates directories; explicit/project selection ignores inherited/observer sockets", async () =>
  fixture(async ({ cwd, socket, current, command }) => {
    current.observer = { socket: "/inherited-other" };
    const result = await command(false);
    assert.equal(result.state, "absent");
    assert.equal(result.socket, socket);
    assert.equal(result.observerSocket, "/inherited-other");
    await absent(join(cwd, ".agents"));
    current.config.socketPath = join(cwd, "explicit/socket");
    assert.equal((await command(false)).socket, current.config.socketPath);
    await absent(join(cwd, "explicit"));
    const text = serverText(
      ctx,
      collectSnapshot({ ...current, observer: undefined }),
      result,
      false,
    );
    assert.match(text, /tmux-monitor v0.1.1: Tmux server status/);
    assert.match(text, /Observer uses a different socket/);
    assert.match(text, /Nothing was created/);
  }));

test("bootstrap creates a detached owned unregistered shell in cwd and prints a quoted attach command", async () =>
  fixture(async ({ cwd, tmux, current, command }) => {
    const result = await command();
    assert.equal(result.state, "ready", JSON.stringify(result));
    assert.equal(result.workspace, "created");
    assert.equal(result.server, "became reachable");
    assert.equal(result.session.name, workspaceName("owner"));
    assert.match(
      result.attach,
      /^tmux -S '\.agents\/run\/tmux-socket' attach -t '\$\d+'$/,
    );
    const p = (await tmux.inventory())[0];
    assert.equal(p.job, null);
    assert.equal(p.pi, null);
    assert.deepEqual(p.sessions[0].owner, sessionOwner("owner", ["root"]));
    assert.equal(
      await tmux.call(
        "display-message",
        "-p",
        "-t",
        p.paneId,
        "#{pane_current_path}",
      ),
      cwd,
    );
    assert.equal(
      await tmux.call(
        "display-message",
        "-p",
        "-t",
        p.paneId,
        "#{pane_current_command}",
      ),
      "sh",
    );
    assert.equal(
      await tmux.call(
        "display-message",
        "-p",
        "-t",
        result.session.id,
        "#{session_attached}",
      ),
      "0",
    );
    assert.match(
      serverText(ctx, collectSnapshot(current), result, true),
      /Run from the project root/,
    );
  }));

test("repeated/reloaded/concurrent bootstrap preserves panes, environment and ownership", async () =>
  fixture(async ({ cwd, tmux, current, command }) => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () => command()),
    );
    for (const r of results) assert.equal(r.state, "ready", JSON.stringify(r));
    assert.equal(results.filter((r) => r.workspace === "created").length, 1);
    assert.equal(new Set(results.map((r) => r.session.id)).size, 1);
    const name = workspaceName("owner"),
      before = await tmux.call(
        "list-panes",
        "-a",
        "-F",
        "#{pane_id}|#{pane_pid}",
      );
    await tmux.call("set-environment", "-g", "MONITOR_EXISTING_ENV", "kept");
    const next = await serverCommand({ ...current }, cwd, true, () => true);
    assert.equal(next.workspace, "reused");
    assert.equal(
      await tmux.call("list-panes", "-a", "-F", "#{pane_id}|#{pane_pid}"),
      before,
    );
    assert.match(
      await tmux.call("show-environment", "-g", "MONITOR_EXISTING_ENV"),
      /kept/,
    );
    current.owner = "replacement";
    const other = await command();
    assert.equal(other.state, "ready");
    assert.notEqual(other.session.name, name);
    assert.equal((await inspectServer(tmux)).sessions.length, 2);
  }));

test("reachable server status lists all sessions, including unowned/shared, and a reachable empty server", async () =>
  fixture(async ({ tmux, socket, command }) => {
    await mkdir(join(socket, ".."), { recursive: true });
    await tmux.call("-f", "/dev/null", "new-session", "-d", "-s", "shared");
    await tmux.call("new-session", "-d", "-s", "unrelated");
    const result = await command(false);
    assert.equal(result.state, "reachable");
    assert.deepEqual(result.sessions.map((s) => s.name).sort(), [
      "shared",
      "unrelated",
    ]);
    assert.ok(result.sessions.every((s) => /^\$\d+$/.test(s.id)));
    await tmux.call("set-option", "-s", "exit-empty", "off");
    await tmux.call("kill-session", "-t", "shared");
    await tmux.call("kill-session", "-t", "unrelated");
    const empty = await command(false);
    assert.equal(empty.state, "reachable", JSON.stringify(empty));
    assert.deepEqual(empty.sessions, []);
  }));

test("bootstrap bypasses default-command and does not alter existing sessions/options", async () =>
  fixture(async ({ tmux, socket, command }) => {
    await mkdir(join(socket, ".."), { recursive: true });
    await tmux.call("-f", "/dev/null", "new-session", "-d", "-s", "shared");
    await tmux.call("set-option", "-g", "default-command", "exit 9");
    const before = await tmux.call(
      "display-message",
      "-p",
      "-t",
      "shared",
      "#{pane_id}|#{pane_pid}",
    );
    const result = await command();
    assert.equal(result.state, "ready", JSON.stringify(result));
    assert.equal(
      await tmux.call("show-options", "-g", "-v", "default-command"),
      "exit 9",
    );
    assert.equal(
      await tmux.call(
        "display-message",
        "-p",
        "-t",
        "shared",
        "#{pane_id}|#{pane_pid}",
      ),
      before,
    );
    assert.equal(await tmux.record("owner", "$0"), null);
  }));

test("unmarked, inherited, foreign and mismatched-ancestry workspaces are conflicts, never adopted", async () => {
  for (const record of [
    null,
    { v: 1, ownerSessionId: "foreign", ancestors: [] },
    sessionOwner("owner", []),
  ])
    await fixture(async ({ tmux, socket, command }) => {
      await mkdir(join(socket, ".."), { recursive: true });
      await tmux.call(
        "-f",
        "/dev/null",
        "new-session",
        "-d",
        "-s",
        workspaceName("owner"),
      );
      if (record) await tmux.write("owner", "$0", record);
      else
        await tmux.call(
          "set-option",
          "-g",
          OWNER,
          JSON.stringify(sessionOwner("owner", ["root"])),
        );
      const before = await tmux.call("show-options", "-t", "$0");
      const pane = await tmux.call(
        "list-panes",
        "-a",
        "-F",
        "#{pane_id}|#{pane_pid}",
      );
      const result = await command();
      assert.equal(result.state, "unavailable");
      assert.match(result.reason, /ownership conflict/);
      assert.equal(result.partial, false);
      assert.equal(await tmux.call("show-options", "-t", "$0"), before);
      assert.equal(
        await tmux.call("list-panes", "-a", "-F", "#{pane_id}|#{pane_pid}"),
        pane,
      );
    });
});

test("bootstrap requires valid owner/ancestry/config before inspection or mutation", async () =>
  fixture(async ({ cwd, current, command }) => {
    for (const ancestors of [undefined, ["owner"], ["root", "root"]]) {
      current.ancestors = ancestors;
      const result = await command(
        true,
        () => true,
        () => assert.fail("must refuse before probing"),
      );
      assert.equal(result.state, "unavailable");
      assert.match(result.reason, /owner\/ancestry/);
    }
    current.config = null;
    assert.match((await command()).reason, /configuration/);
    await absent(join(cwd, ".agents"));
  }));

test("inspection distinguishes confirmed absence from missing tools, permissions, timeout and protocol/output failures", async () =>
  fixture(async ({ socket, cwd }) => {
    for (const [error, state, message] of [
      [
        Object.assign(Error(), {
          code: 1,
          stderr: `error connecting to ${socket} (No such file or directory)\n`,
        }),
        "absent",
        null,
      ],
      [
        Object.assign(Error(), { code: "ENOENT", syscall: "spawn tmux" }),
        "unavailable",
        /executable/,
      ],
      [
        Object.assign(Error(), { code: 1, stderr: "permission denied" }),
        "unavailable",
        /Permission/,
      ],
      [
        Object.assign(Error(), { code: null, killed: true }),
        "unavailable",
        /timed out/,
      ],
      [
        Object.assign(Error(), {
          code: 1,
          stderr: "protocol version mismatch",
        }),
        "unavailable",
        /incompatible/,
      ],
      [
        Object.assign(Error(), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }),
        "unavailable",
        /inspection/,
      ],
    ]) {
      const result = await inspectServer({
        socket,
        call: async () => {
          throw error;
        },
      });
      assert.equal(result.state, state);
      if (message) assert.match(result.reason, message);
    }
    for (const raw of [
      "",
      "123:456\nnot-an-id|name",
      "123:456\n$0",
      "123:456\n$0|control\x1b",
    ]) {
      const result = await inspectServer({
        socket,
        call: async () => raw,
        identity: async () => "/ns:123:456",
      });
      assert.equal(result.state, "unavailable");
    }
    await absent(join(cwd, ".agents"));
  }));

test("regular files and broken symlinks at the socket are not replaced by bootstrap", async () =>
  fixture(async ({ socket, command }) => {
    await mkdir(join(socket, ".."), { recursive: true });
    await writeFile(socket, "do not remove");
    assert.equal((await command()).state, "unavailable");
    const { readFile } = await import("node:fs/promises");
    assert.equal(await readFile(socket, "utf8"), "do not remove");
    await rm(socket);
    await symlink("missing", socket);
    assert.equal((await command()).state, "unavailable");
  }));

test("bootstrap preserves existing directory permissions and stops before creation after retirement", async () =>
  fixture(async ({ socket, command, cwd }) => {
    await mkdir(join(socket, ".."), { recursive: true });
    await chmod(join(socket, ".."), 0o700);
    const result = await command();
    assert.equal(result.state, "ready");
    assert.equal((await stat(join(socket, ".."))).mode & 0o777, 0o700);
    let live = true;
    const original = new Tmux(join(cwd, "other/socket"));
    const status = original.call.bind(original);
    original.call = async (...args) => {
      const result = await status(...args).catch((e) => {
        live = false;
        throw e;
      });
      return result;
    };
    const stopped = await command(
      true,
      () => live,
      () => original,
    );
    assert.equal(stopped.state, "unavailable");
    assert.match(stopped.reason, /retired/);
    await absent(join(cwd, "other"));
  }));

test("partial creation/timeout reports remaining resources without rollback or a second creation", async () =>
  fixture(async ({ tmux, command }) => {
    const original = tmux.call.bind(tmux);
    let creations = 0;
    tmux.call = async (...args) => {
      if (args[0] !== "new-session") return original(...args);
      creations++;
      await original(...args);
      throw Object.assign(Error("timeout"), { killed: true });
    };
    const result = await command(
      true,
      () => true,
      () => tmux,
    );
    assert.equal(result.state, "unavailable");
    assert.equal(result.partial, true);
    assert.equal(creations, 1);
    const text = serverText(ctx, { identity: {} }, result, true);
    assert.match(text, /resources may remain/);
    assert.match(text, /No rollback/);
    assert.match(text, /do not retry creation blindly/);
    assert.equal((await inspectServer(tmux)).sessions.length, 1);
  }));

test("retirement during creation leaves old ownership intact and performs no later bootstrap queries or UI", async () =>
  fixture(async ({ tmux, current, cwd }) => {
    let release,
      entered,
      live = true,
      calls = 0;
    const pause = new Promise((r) => {
        release = r;
      }),
      creating = new Promise((r) => {
        entered = r;
      });
    const original = tmux.call.bind(tmux);
    tmux.call = async (...args) => {
      calls++;
      const result = await original(...args);
      if (args[0] === "new-session") {
        entered();
        await pause;
      }
      return result;
    };
    const starting = serverCommand(
      current,
      cwd,
      true,
      () => live,
      () => tmux,
    );
    try {
      await creating;
      live = false;
      const count = calls;
      release();
      await starting;
      assert.equal(calls, count);
      assert.deepEqual(
        await tmux.record("owner", "$0"),
        sessionOwner("owner", ["root"]),
      );
    } finally {
      release();
      await starting;
    }
  }));

test("server formatting bounds/sanitizes output and help clearly groups read-only status versus start", () => {
  const current = { identity: { version: "0.1.1" }, config: DEFAULTS };
  const text = serverText(
    ctx,
    collectSnapshot(current),
    {
      state: "reachable",
      socket: "/x\nsecret",
      sessions: Array.from({ length: 300 }, (_, i) => ({
        id: `$${i}`,
        name: `name-${i}`,
      })),
    },
    false,
    120,
  );
  assert.ok(!text.includes("/x\nsecret"));
  assert.match(text, /44 additional sessions omitted/);
  const help = commandHelp(
    ctx,
    collectSnapshot(current),
    { reason: "No target" },
    140,
  );
  assert.match(help, /Workload inspection:/);
  assert.match(help, /Tmux server:/);
  assert.match(help, /tmux \(t\)/);
  assert.match(help, /tmux s \/ t s/);
  assert.match(help, /only mutating command; no shorthand/);
});

test("server command dispatch remains focused, uses a fresh check and suppresses late replacement results", async () => {
  let current = {
    owner: "owner",
    config: DEFAULTS,
    identity: { version: "0.1.1" },
    ancestors: [],
  };
  const notices = [],
    calls = [];
  const handler = monitorCommand(
    () => current,
    () => ({}),
    () => assert.fail("server commands must not inspect help"),
    async (_current, cwd, start) => {
      calls.push({ cwd, start });
      return { state: "absent", sessions: [], socket: "/socket" };
    },
  );
  const commandCtx = {
    ...ctx,
    cwd: "/cwd",
    ui: { ...ctx.ui, notify: (s) => notices.push(s) },
  };
  for (const args of [
    "tmux",
    "t",
    "tmux status",
    "t s",
    "tmux start",
    "t start",
  ]) {
    await handler(args, commandCtx);
    assert.equal(notices.length, calls.length);
  }
  assert.deepEqual(
    calls.map((c) => c.start),
    [false, false, false, false, true, true],
  );
  let release;
  const late = monitorCommand(
    () => current,
    () => ({}),
    undefined,
    () =>
      new Promise((r) => {
        release = r;
      }),
  );
  let active = true;
  const working = late("t start", {
    ...commandCtx,
    get ui() {
      assert.ok(active, "retired UI must not be read");
      return commandCtx.ui;
    },
  });
  active = false;
  const count = notices.length;
  current = { ...current, owner: "replacement" };
  release({ state: "absent", sessions: [], socket: "/socket" });
  await working;
  assert.equal(notices.length, count);
});

test("missing tmux executable and real client timeout refuse bootstrap without creating directories", async () =>
  fixture(async ({ cwd, current, command }) => {
    const path = process.env.PATH;
    const bin = join(cwd, "bin");
    await mkdir(bin);
    current.config = { ...DEFAULTS, tmuxTimeoutMs: 50 };
    try {
      process.env.PATH = bin;
      const missing = await command();
      assert.equal(missing.state, "unavailable");
      assert.match(missing.reason, /executable/);
      await absent(join(cwd, ".agents"));
      await writeFile(
        join(bin, "tmux"),
        `#!${process.execPath}\nsetTimeout(()=>{},1000);`,
      );
      await chmod(join(bin, "tmux"), 0o755);
      const timeout = await command();
      assert.equal(timeout.state, "unavailable");
      assert.match(timeout.reason, /timed out/);
      await absent(join(cwd, ".agents"));
    } finally {
      process.env.PATH = path;
    }
  }));

test("same-object owner replacement invalidates the captured bootstrap context", async () => {
  const current = { owner: "owner", config: DEFAULTS, ancestors: [] };
  let live,
    release,
    session = "owner";
  const notices = [];
  const handler = monitorCommand(
    () => current,
    () => ({}),
    undefined,
    async (_r, _cwd, _start, check) => {
      live = check;
      await new Promise((r) => {
        release = r;
      });
      return { state: "absent", sessions: [] };
    },
  );
  const starting = handler("t start", {
    ...ctx,
    sessionManager: { getSessionId: () => session },
    ui: { ...ctx.ui, notify: (s) => notices.push(s) },
  });
  current.owner = session = "replacement";
  assert.equal(live(), false);
  release();
  await starting;
  assert.deepEqual(notices, []);
});

test("server/session identity changes before verification cannot claim bootstrap success", async () =>
  fixture(async ({ tmux, command }) => {
    await command();
    const identity = tmux.identity.bind(tmux);
    let reads = 0;
    tmux.identity = async () =>
      ++reads === 1 ? identity() : "replaced-server";
    const result = await command(
      true,
      () => true,
      () => tmux,
    );
    assert.equal(result.state, "unavailable");
    assert.match(result.reason, /server changed/);
  }));

test("foreground TMUX/PANE cannot redirect creation ownership into an existing session", async () =>
  fixture(async ({ tmux, socket, command }) => {
    await mkdir(join(socket, ".."), { recursive: true });
    await tmux.call("-f", "/dev/null", "new-session", "-d", "-s", "shared");
    const saved = { TMUX: process.env.TMUX, TMUX_PANE: process.env.TMUX_PANE };
    try {
      process.env.TMUX = `${socket},${await tmux.call("display-message", "-p", "#{pid}")},0`;
      process.env.TMUX_PANE = "%0";
      const result = await command();
      assert.equal(result.state, "ready", JSON.stringify(result));
      assert.equal(await tmux.record("owner", "$0"), null);
      assert.deepEqual(
        await tmux.record("owner", result.session.id),
        sessionOwner("owner", ["root"]),
      );
    } finally {
      for (const [key, value] of Object.entries(saved))
        value === undefined
          ? delete process.env[key]
          : (process.env[key] = value);
    }
  }));

test("confirmed stale socket is recovered only by tmux's own startup coordination", async () =>
  fixture(async ({ socket, tmux, command }) => {
    const { createServer } = await import("node:net");
    const { rename } = await import("node:fs/promises");
    const { once } = await import("node:events");
    await mkdir(join(socket, ".."), { recursive: true });
    const listener = createServer();
    listener.listen(socket);
    await once(listener, "listening");
    await rename(socket, socket + ".stale");
    await new Promise((resolve) => listener.close(resolve));
    await rename(socket + ".stale", socket);
    assert.equal((await inspectServer(tmux)).state, "absent");
    const result = await command();
    assert.equal(result.state, "ready", JSON.stringify(result));
  }));

test("workspace cwd/socket with quotes and tmux format syntax stay literal and copyable", async () =>
  fixture(async ({ cwd, current }) => {
    const project = join(cwd, "quote ' #{pid}");
    await mkdir(project);
    const socket = join(project, ".agents/run/tmux-socket"),
      tmux = new Tmux(socket);
    try {
      const result = await serverCommand(current, project, true, () => true);
      assert.equal(result.state, "ready", JSON.stringify(result));
      assert.equal(
        await tmux.call(
          "display-message",
          "-p",
          "-t",
          result.session.id,
          "#{pane_current_path}",
        ),
        project,
      );
      assert.match(
        result.attach,
        /^tmux -S '\.agents\/run\/tmux-socket' attach -t '\$\d+'$/,
      );
      current.config.socketPath = socket;
      const parent = await serverCommand(current, cwd, true, () => true);
      assert.match(parent.attach, /'\\''/);
      assert.ok(parent.attach.includes("#{pid}"));
    } finally {
      await tmux.call("kill-server").catch(() => {});
    }
  }));

test("a created shell with an unverified directory or dead pane is a partial result, not success", async () => {
  for (const state of ["1|/dead", "0|/wrong-directory"])
    await fixture(async ({ tmux, command }) => {
      const call = tmux.call.bind(tmux);
      tmux.call = async (...args) =>
        args.includes("#{pane_dead}|#{pane_current_path}")
          ? state
          : call(...args);
      const result = await command(
        true,
        () => true,
        () => tmux,
      );
      assert.equal(result.state, "unavailable");
      assert.equal(result.partial, true);
      assert.match(result.reason, /shell or working directory/);
      assert.equal((await inspectServer(tmux)).sessions.length, 1);
    });
});
