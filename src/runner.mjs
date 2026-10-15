import { spawn } from "node:child_process";
import { constants } from "node:os";
import { access, stat, writeFile, rename } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { resolve, delimiter } from "node:path";
import { Tmux } from "./tmux.mts";
import { parseTmux } from "./protocol.mts";
import { reporterPath } from "./launch.mts";
export async function run(plan, env = process.env) {
  const socket = parseTmux(env.TMUX),
    pane = env.TMUX_PANE;
  if (!socket || !/^%\d+$/.test(pane ?? ""))
    throw new Error("Runner requires its actual tmux pane environment");
  const tmux = new Tmux(socket, plan.timeout);
  const serverIdentity = await tmux.ownIdentity(env.TMUX);
  const record = {
    v: 1,
    paneId: pane,
    jobId: plan.jobId,
    ownerSessionId: plan.owner,
    ancestors: plan.ancestors,
    kind: plan.kind,
    runtime: plan.runtime,
    ...(plan.label !== undefined ? { label: plan.label } : {}),
    phase: "running",
    heartbeatSeq: 0,
    exitCode: null,
  };
  let queue = Promise.resolve(),
    lost = false,
    stopped = false;
  const write = () => {
    const snapshot = { ...record, heartbeatSeq: ++record.heartbeatSeq };
    queue = queue
      .then(async () => {
        if (lost) return;
        if ((await tmux.identity()) !== serverIdentity) {
          lost = true;
          console.error("Monitor server replaced; command reporting stopped");
          return;
        }
        const current = await tmux.record("job", pane);
        if (current && current.jobId !== plan.jobId) {
          lost = true;
          return;
        }
        await tmux.write("job", pane, snapshot, {
          serverIdentity,
          allowAbsent: !current,
        });
      })
      .catch(() =>
        console.error("Monitor command registration/heartbeat failed"),
      );
    return queue;
  };
  // Managed launch clears the prior reporter before recording this generation.
  const old = await tmux.record("pi", pane).catch(() => null);
  if (old)
    await tmux
      .removeOwned("pi", pane, "instanceId", old.instanceId)
      .catch(() => console.error("Monitor reporter cleanup failed"));
  const previous = await tmux.record("job", pane).catch(() => null);
  if (previous)
    await tmux
      .removeOwned("job", pane, "jobId", previous.jobId)
      .catch(() => console.error("Monitor prior-job cleanup failed"));
  await write();
  const acknowledge = async (state, reason) => {
    if (!plan.ackPath) return;
    try {
      await writeFile(
        plan.ackPath + ".tmp",
        JSON.stringify({ state, reason }),
        { mode: 0o600 },
      );
      await rename(plan.ackPath + ".tmp", plan.ackPath);
    } catch {
      /* A timed-out caller may already have retired its acknowledgement. */
    }
  };
  async function executable(name) {
    const candidates = name.includes("/")
      ? [resolve(plan.cwd, name)]
      : (env.PATH ?? "")
          .split(delimiter)
          .map((dir) => resolve(dir || plan.cwd, name));
    for (const path of candidates)
      try {
        await access(path, fsConstants.X_OK);
        if ((await stat(path)).isFile()) return;
      } catch {}
    throw Error(
      "Requested executable or retained Bash shell is unavailable on the server",
    );
  }
  try {
    if (!(await stat(plan.cwd)).isDirectory())
      throw Error("Working directory unavailable on the server");
    await executable("bash");
    await executable(plan.argv[0]);
    if (plan.runtime === "pi" && !plan.uninstrumented)
      await access(reporterPath);
  } catch {
    const reason =
      "Server-side working directory, executable, Bash or required Pi reporter is unavailable";
    record.phase = "failed";
    record.exitCode = 127;
    await write();
    await acknowledge("unavailable", reason);
    console.error(reason);
    return 127;
  }
  const childEnv = {
    ...env,
    PI_TMUX_MONITOR_JOB_ID: plan.jobId,
    PI_TMUX_MONITOR_PARENT: plan.owner,
    PI_TMUX_MONITOR_ANCESTORS: JSON.stringify(plan.ancestors),
  };
  // Never propagate the launching Pi's owner/session as the new Pi's identity.
  delete childEnv.PI_SESSION_ID;
  delete childEnv.PI_TMUX_MONITOR_OWNER;
  const child = spawn(plan.argv[0], plan.argv.slice(1), {
    cwd: plan.cwd,
    env: childEnv,
    stdio: "inherit",
  });
  let pending = false;
  const timer = setInterval(() => {
    if (!pending && !stopped) {
      pending = true;
      void write().finally(() => (pending = false));
    }
  }, plan.heartbeat);
  const handlers = new Map(
    ["SIGINT", "SIGTERM", "SIGHUP"].map((signal) => [
      signal,
      () => child.kill(signal),
    ]),
  );
  for (const [signal, handler] of handlers) process.on(signal, handler);
  const result = await new Promise((resolve) => {
    child.once("spawn", () => {
      void acknowledge("ready");
    });
    child.once("error", () => {
      void acknowledge(
        "unavailable",
        "Requested executable could not start on the server",
      );
      console.error("Monitored command could not start");
      resolve({ code: 127, signal: null });
    });
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  stopped = true;
  clearInterval(timer);
  for (const [signal, handler] of handlers) process.off(signal, handler);
  const code = result.code ?? 128 + (constants.signals[result.signal] ?? 1);
  record.phase = code === 0 ? "success" : "failed";
  record.exitCode = code;
  if (result.signal) record.signal = result.signal;
  await write();
  return code;
}
