import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { access } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { lineage } from "./protocol.mjs";
import { Tmux } from "./tmux.mjs";
export const packageRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);
export const helperPath = resolve(packageRoot, "scripts/pi-tmux-monitor.mjs");
export const reporterPath = resolve(packageRoot, "pi-tmux-monitor.ts");
export const quote = (value) =>
  "'" + String(value).replaceAll("'", "'\\''") + "'";
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
  if (!["launch", "pi"].includes(action))
    throw new Error("Expected launch or pi; see --help");
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
  if (delimiter < 0) throw new Error("Separate command arguments with --");
  const flags = rest.slice(0, delimiter),
    command = rest.slice(delimiter + 1);
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
  const ancestors = lineage(
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
    if (!/^[a-zA-Z0-9_.-]{1,128}$/.test(options[key] ?? ""))
      throw new Error(
        `Required --${key} must be a literal name (letters, digits, . _ -)`,
      );
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
export async function launch(plan) {
  if (plan.runtime === "pi" && !plan.uninstrumented) await access(reporterPath);
  await access(helperPath);
  await access(plan.cwd);
  const tmux = new Tmux(plan.socket, plan.timeout);
  // The envelope is command argv, not shared monitor metadata. Shell quoting
  // keeps it inert; the server, not the requesting client, supplies TMUX/PANE.
  const envelope = Buffer.from(JSON.stringify(plan)).toString("base64url");
  const command =
    [quote(process.execPath), quote(helperPath), "run", quote(envelope)].join(
      " ",
    ) +
    `; code=$?; printf '\\nMonitored command exited %s\\n' "$code"; export PI_TMUX_MONITOR_EXIT_CODE="$code"; exec bash -i`;
  let exists;
  try {
    await tmux.call("has-session", "-t", "=" + plan.session);
    exists = true;
  } catch {
    exists = false;
  }
  const pane = exists
    ? await tmux.call(
        "new-window",
        "-d",
        "-P",
        "-F",
        "#{pane_id}",
        "-t",
        plan.session + ":",
        "-n",
        plan.window,
        "-c",
        plan.cwd,
        command,
      )
    : await tmux.call(
        "new-session",
        "-d",
        "-P",
        "-F",
        "#{pane_id}",
        "-s",
        plan.session,
        "-n",
        plan.window,
        "-c",
        plan.cwd,
        command,
      );
  if (!/^%\d+$/.test(pane))
    throw new Error(
      "Launch returned no pane identity; do not retry automatically",
    );
  if (!exists) {
    try {
      await tmux.write(
        "owner",
        await tmux.call("display-message", "-p", "-t", pane, "#{session_id}"),
        {
          v: 1,
          ownerSessionId: plan.owner,
          ancestors: plan.ancestors.slice(0, -1),
        },
      );
    } catch {
      console.error(
        "Monitor session ownership registration failed; pane may still be running",
      );
    }
  }
  // A bounded startup check reports path/environment failures without retrying
  // creation. It does not wait for command completion or spend model tokens.
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const r = await tmux.record("job", pane);
      if (r?.jobId === plan.jobId)
        return { paneId: pane, jobId: plan.jobId, socket: plan.socket };
    } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(
    `Pane ${pane} created, but registration was not confirmed. Inspect it; do not retry the launch blindly. Server-side Node/package/Pi paths must be accessible.`,
  );
}
