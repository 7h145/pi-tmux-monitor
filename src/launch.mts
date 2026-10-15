// @ts-nocheck
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { lineage } from "./protocol.mts";
import { Tmux } from "./tmux.mts";
import { quote, formatLiteral } from "./shell.mts";
import {
  inspectServer,
  socketDirectory,
  createOwnedSession,
  sessionOwner,
  sessionName,
  workspaceName,
  verifyWorkspace,
  verifyTarget,
} from "./server.mts";
export const packageRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);
export const helperPath = resolve(packageRoot, "scripts/pi-tmux-monitor.mjs");
export const reporterPath = resolve(packageRoot, "pi-tmux-monitor.ts");

export function piArgs(
  args,
  mode,
  uninstrumented = false,
  path = reporterPath,
) {
  const index = args.indexOf("--"),
    split = index < 0 ? args.length : index;
  const prefix = args.slice(0, split),
    suffix = args.slice(split);
  return [
    ...prefix,
    ...(mode === "batch" &&
    !prefix.includes("-p") &&
    !prefix.includes("--print")
      ? ["--print"]
      : []),
    ...(uninstrumented ? [] : ["-e", path]),
    ...suffix,
  ];
}
export function parseCLI(argv, env = process.env, cwd = process.cwd()) {
  const [action, ...rest] = argv;
  if (!["launch", "pi", "inspect", "start"].includes(action))
    throw new Error("Expected inspect, start, launch or pi; see --help");
  const options = Object.create(null),
    known = [
      "socket",
      "session",
      "window",
      "owner",
      "kind",
      "mode",
      "label",
      "ancestors-json",
      "cwd",
      "heartbeat-interval-ms",
      "tmux-timeout-ms",
    ];
  const delimiter = rest.indexOf("--");
  if (delimiter < 0 && ["launch", "pi"].includes(action))
    throw new Error("Separate command arguments with --");
  const flags = delimiter < 0 ? rest : rest.slice(0, delimiter),
    command = delimiter < 0 ? [] : rest.slice(delimiter + 1);
  for (let i = 0; i < flags.length; i++) {
    const key = flags[i].replace(/^--/, "");
    if (flags[i] === "--uninstrumented") {
      options.uninstrumented = true;
      continue;
    }
    if (
      !flags[i].startsWith("--") ||
      !known.includes(key) ||
      i + 1 >= flags.length ||
      Object.hasOwn(options, key)
    )
      throw new Error("Invalid or duplicate helper option");
    options[key] = flags[++i];
  }
  const owner = options.owner ?? env.PI_SESSION_ID ?? env.PI_TMUX_MONITOR_OWNER;
  const ancestors =
    action === "inspect"
      ? []
      : lineage(
          owner,
          JSON.parse(
            options["ancestors-json"] ?? env.PI_TMUX_MONITOR_ANCESTORS ?? "[]",
          ),
        );
  const socket = resolve(
    cwd,
    options.socket ?? resolve(cwd, ".agents/run/tmux-socket"),
  );
  for (const key of ["session", "window"])
    if (
      ((key === "window" && ["launch", "pi"].includes(action)) ||
        options[key] !== undefined) &&
      !/^[a-zA-Z0-9_.-]{1,128}$/.test(options[key] ?? "")
    )
      throw new Error(
        `Required --${key} must be a literal name (letters, digits, . _ -)`,
      );
  if (
    ["inspect", "start"].includes(action) &&
    (command.length ||
      Object.keys(options).some(
        (k) =>
          ![
            "socket",
            "owner",
            "ancestors-json",
            "cwd",
            "tmux-timeout-ms",
          ].includes(k),
      ))
  )
    throw Error("Unexpected setup argument");
  const kind =
    action === "pi"
      ? { interactive: "interactive", batch: "batch" }[
          options.mode ?? "interactive"
        ]
      : (options.kind ?? "batch");
  if (!["batch", "service", "interactive"].includes(kind))
    throw new Error("Invalid workload kind/mode");
  if (action === "launch" && !command.length)
    throw new Error("Missing command");
  if (
    options.label !== undefined &&
    ([...options.label].length > 128 || /\p{C}/u.test(options.label))
  )
    throw new Error("Invalid label");
  const heartbeat = Number(options["heartbeat-interval-ms"] ?? 5000),
    timeout = Number(options["tmux-timeout-ms"] ?? 1000);
  if (
    ![heartbeat, timeout].every(
      (n) => Number.isSafeInteger(n) && n > 0 && n <= 2147483647,
    )
  )
    throw new Error("Invalid timing");
  return {
    action,
    socket,
    session: options.session,
    window: options.window,
    owner,
    ancestors,
    kind,
    runtime: action === "pi" ? "pi" : "command",
    label: options.label,
    cwd: resolve(cwd, options.cwd ?? "."),
    heartbeat,
    timeout,
    jobId: randomUUID(),
    argv:
      action === "pi"
        ? ["pi", ...piArgs(command, kind, options.uninstrumented)]
        : command,
    uninstrumented: !!options.uninstrumented,
  };
}
export async function launch(plan, factory = (s, t) => new Tmux(s, t)) {
  if (plan.runtime === "pi" && !plan.uninstrumented) await access(reporterPath);
  await access(helperPath);
  await access(plan.cwd);
  const tmux = factory(plan.socket, plan.timeout);
  let before,
    session,
    pane,
    target,
    attempted = false,
    created = false,
    ackDir;
  try {
    before = await inspectServer(tmux);
    if (before.state === "unavailable") throw Error(before.reason);
    const name = plan.session ?? workspaceName(plan.owner);
    const owner = sessionOwner(plan.owner, plan.ancestors.slice(0, -1));
    session = before.sessions.find((s) => s.name === sessionName(name));
    if (session && !plan.session)
      await verifyWorkspace(tmux, before, session, owner, () => true);
    await socketDirectory(plan.socket);
    const artifacts = resolve(plan.cwd, ".agents/run");
    await mkdir(artifacts, { recursive: true, mode: 0o700 });
    ackDir = await mkdtemp(resolve(artifacts, "monitor-launch-"));
    plan.ackPath = resolve(ackDir, "startup.json");
    const envelope = Buffer.from(JSON.stringify(plan)).toString("base64url");
    const command =
      [quote(process.execPath), quote(helperPath), "run", quote(envelope)].join(
        " ",
      ) +
      `; code=$?; printf '\nMonitored command exited %s\n' "$code"; export PI_TMUX_MONITOR_EXIT_CODE="$code"; exec bash -i`;
    if (!session) {
      attempted = true;
      try {
        const made = await createOwnedSession(tmux, {
          name,
          cwd: plan.cwd,
          window: plan.window,
          owner,
          command: [command],
        });
        session = { id: made.sessionId, name: sessionName(name) };
        pane = made.paneId;
        created = true;
      } catch (error) {
        // A proven duplicate means this queue did not execute the workload.
        // All other uncertain results must stop, never repeat creation.
        if (
          error.killed ||
          error.code !== 1 ||
          (error.stderr ?? "").trim() !==
            `duplicate session: ${sessionName(name)}`
        )
          throw error;
        const raced = await inspectServer(tmux);
        if (raced.state !== "reachable")
          throw Error("Concurrent session creation could not be inspected");
        session = raced.sessions.find((s) => s.name === sessionName(name));
        if (!session) throw Error("Concurrent session identity unavailable");
        if (!plan.session)
          await verifyWorkspace(tmux, raced, session, owner, () => true);
        if (before.state === "reachable" && before.identity !== raced.identity)
          throw Error("Server changed during concurrent launch");
        before = raced;
      }
    }
    if (!pane) {
      if ((await tmux.identity()) !== before.identity)
        throw Error("Server changed before launch");
      attempted = true;
      pane = await tmux.call(
        "-N",
        "new-window",
        "-d",
        "-P",
        "-F",
        "#{pane_id}",
        "-t",
        session.id + ":",
        "-n",
        plan.window,
        "-c",
        formatLiteral(plan.cwd),
        command,
      );
    }
    const after = await inspectServer(tmux);
    if (
      after.state !== "reachable" ||
      (before.state === "reachable" && before.identity !== after.identity)
    )
      throw Error("Server changed during launch");
    target = await verifyTarget(tmux, after.identity, pane, session.id);
    if (!plan.session)
      await verifyWorkspace(tmux, after, session, owner, () => true);
    for (let attempt = 0; attempt < 40; attempt++) {
      let ack;
      try {
        ack = JSON.parse(await readFile(plan.ackPath, "utf8"));
      } catch {}
      if (ack?.state === "unavailable") throw Error(ack.reason);
      if (ack?.state === "ready") {
        const record = await tmux.record("job", pane);
        if (record?.jobId === plan.jobId) {
          const confirmed = await verifyTarget(
            tmux,
            after.identity,
            pane,
            session.id,
          );
          if (
            confirmed.windowId !== target.windowId ||
            confirmed.panePid !== target.panePid
          )
            throw Error("Launch target changed before startup confirmation");
          return {
            ...confirmed,
            state: "ready",
            jobId: plan.jobId,
            socket: plan.socket,
            server: before.state === "absent" ? "became reachable" : "reused",
            workspace: created ? "created" : "reused",
            windowAction: "created",
          };
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw Error(
      "Startup was not confirmed; server-side Node/package/executable paths may be unavailable",
    );
  } catch (error) {
    const reason = error.code
      ? "Tmux launch failed or timed out; inspect before retrying"
      : error.message.slice(0, 320);
    throw Object.assign(Error(reason), {
      result: {
        ...target,
        socket: plan.socket,
        session,
        paneId: pane,
        jobId: plan.jobId,
        partial: attempted,
        reason,
        state: "unavailable",
      },
    });
  } finally {
    if (ackDir)
      await rm(ackDir, { recursive: true, force: true }).catch(() => {});
  }
}
