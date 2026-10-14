// @ts-nocheck
import { mkdir, stat, lstat, realpath } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { createHash } from "node:crypto";
import { Tmux } from "./tmux.mts";
import { OWNER, lineage } from "./protocol.mts";
import { attachmentCommand, formatLiteral, quote } from "./shell.mts";

export const workspaceName = (owner) =>
  "pi-workspace-" + createHash("sha256").update(owner).digest("hex");
export const sessionName = (name) => name.replaceAll(".", "_");
export function sessionOwner(owner, ancestors) {
  lineage(owner, ancestors);
  return { v: 1, ownerSessionId: owner, ancestors: [...ancestors] };
}
export function sameOwner(record, owner) {
  return (
    record?.ownerSessionId === owner.ownerSessionId &&
    JSON.stringify(record.ancestors) === JSON.stringify(owner.ancestors)
  );
}
export function checkLive(live) {
  if (!live()) throw Error("Pi runtime retired; bootstrap stopped");
}
export async function socketDirectory(socket) {
  await mkdir(dirname(socket), { recursive: true, mode: 0o700 });
}
const reason = (error) => {
  if (error.code === "ENOENT" && error.syscall?.startsWith("spawn"))
    return "Tmux executable is unavailable.";
  if (error.killed || error.code === "ETIMEDOUT")
    return "Tmux check timed out.";
  if (error.code === "EACCES" || /permission denied/i.test(error.stderr ?? ""))
    return "Permission denied inspecting tmux.";
  return "Tmux inspection failed or returned incompatible output.";
};
export async function inspectServer(tmux, recheckAppearance = true) {
  try {
    const raw = await tmux.call(
      "-N",
      "display-message",
      "-p",
      "#{pid}:#{start_time}",
      ";",
      "list-sessions",
      "-F",
      "#{session_id}|#{session_name}",
    );
    const [server, ...rows] = raw.split("\n");
    if (!/^\d+:\d+$/.test(server)) throw Error("Invalid server identity");
    const sessions = rows.filter(Boolean).map((line) => {
      const split = line.indexOf("|"),
        id = line.slice(0, split),
        name = line.slice(split + 1);
      if (split < 0 || !/^\$\d+$/.test(id) || !name || /\p{C}/u.test(name))
        throw Error("Invalid session listing");
      return { id, name };
    });
    const identity = await tmux.identity();
    if (!identity.endsWith(":" + server))
      throw Error("Server changed during inspection");
    return { state: "reachable", identity, sessions };
  } catch (error) {
    if (!error.killed && error.code === 1) {
      const text = (error.stderr ?? "").trim();
      const missing =
        text ===
        `error connecting to ${tmux.socket} (No such file or directory)`;
      const refused =
        text === `error connecting to ${tmux.socket} (Connection refused)` ||
        text === `no server running on ${tmux.socket}`;
      if (missing || refused) {
        try {
          const info = await stat(tmux.socket);
          if (info.isSocket()) {
            if (missing && recheckAppearance) return inspectServer(tmux, false);
            if (refused) return { state: "absent", sessions: [] };
          }
        } catch (fsError) {
          if (fsError.code === "ENOENT") {
            try {
              const appeared = await lstat(tmux.socket);
              if (appeared.isSocket() && recheckAppearance)
                return inspectServer(tmux, false);
            } catch (linkError) {
              if (linkError.code === "ENOENT")
                return { state: "absent", sessions: [] };
            }
          }
        }
      }
    }
    return { state: "unavailable", reason: reason(error), sessions: [] };
  }
}
// Both the helper and workspace bootstrap use the same creation/ownership queue.
// An explicit session target prevents inherited TMUX/PANE from redirecting the
// ownership write. A duplicate/error aborts the group before that write.
export async function createOwnedSession(
  tmux,
  { name, cwd, owner, window, command },
) {
  if (!/^[A-Za-z0-9_.-]{1,128}$/.test(name))
    throw Error("Invalid session name");
  const raw = await tmux.call(
    "new-session",
    "-d",
    "-P",
    "-F",
    "#{session_id}|#{pane_id}",
    "-s",
    name,
    ...(window ? ["-n", window] : []),
    "-c",
    formatLiteral(cwd),
    ...command,
    ";",
    "set-option",
    "-t",
    sessionName(name) + ":",
    OWNER,
    JSON.stringify(owner),
  );
  const match = /^(\$\d+)\|(%\d+)$/.exec(raw);
  if (!match) throw Error("Session creation returned no verified identity");
  return { sessionId: match[1], paneId: match[2] };
}
async function verifyWorkspace(tmux, inspection, session, owner, live) {
  checkLive(live);
  if ((await tmux.identity()) !== inspection.identity)
    throw Error("Tmux server changed during bootstrap");
  checkLive(live);
  const actual = await tmux.call(
    "-N",
    "display-message",
    "-p",
    "-t",
    session.id,
    "#{session_id}|#{session_name}",
  );
  if (actual !== `${session.id}|${session.name}`)
    throw Error("Workspace session identity changed");
  checkLive(live);
  const record = await tmux.record("owner", session.id);
  if (!sameOwner(record, owner))
    throw Error(
      "Workspace name/ownership conflict; existing session was not changed",
    );
  checkLive(live);
  if ((await tmux.identity()) !== inspection.identity)
    throw Error("Tmux server changed during bootstrap");
  checkLive(live);
}
export async function serverCommand(
  current,
  cwd,
  start,
  live,
  factory = (s, t) => new Tmux(s, t),
) {
  if (!current?.config)
    return {
      state: "unavailable",
      reason: "Effective monitor configuration is unavailable.",
      sessions: [],
    };
  const socket = resolve(
    cwd,
    current.config.socketPath ?? ".agents/run/tmux-socket",
  );
  const observerSocket = current.observer?.socket;
  const base = {
    socket,
    observerSocket:
      observerSocket && resolve(cwd, observerSocket) !== socket
        ? observerSocket
        : undefined,
  };
  let owner;
  if (start) {
    try {
      owner = sessionOwner(current.owner, current.ancestors);
    } catch {
      return {
        ...base,
        state: "unavailable",
        reason: "Current Pi owner/ancestry is unavailable or invalid.",
        sessions: [],
      };
    }
  }
  const tmux = factory(socket, current.config.tmuxTimeoutMs);
  const before = await inspectServer(tmux);
  if (!start || before.state === "unavailable") return { ...base, ...before };
  let created = false,
    attempted = false,
    session,
    createdPane;
  try {
    checkLive(live);
    const name = workspaceName(owner.ownerSessionId);
    session = before.sessions.find((s) => s.name === name);
    let after = before;
    if (!session) {
      if (!(await stat(cwd)).isDirectory())
        throw Error("Workspace working directory is unavailable");
      checkLive(live);
      attempted = true;
      await socketDirectory(socket);
      checkLive(live);
      try {
        // Direct argv bypasses default-command. Explicit cd also refuses tmux's
        // fallback directory when ctx.cwd is unavailable on the server.
        const result = await createOwnedSession(tmux, {
          name,
          cwd,
          owner,
          command: ["/bin/sh", "-c", `cd ${quote(cwd)} && exec /bin/sh -i`],
        });
        session = { id: result.sessionId, name };
        createdPane = result.paneId;
        created = true;
      } catch (error) {
        // Another creator may have won. Inspect once, never retry creation.
        if (
          error.killed ||
          error.code !== 1 ||
          (error.stderr ?? "").trim() !== `duplicate session: ${name}`
        )
          throw error;
      }
      checkLive(live);
      after = await inspectServer(tmux);
      if (after.state !== "reachable")
        throw Error("Workspace creation could not be verified");
      if (before.state === "reachable" && before.identity !== after.identity)
        throw Error("Tmux server changed during bootstrap");
      session ??= after.sessions.find((s) => s.name === name);
      if (!session) throw Error("Workspace creation could not be verified");
    }
    if (createdPane) {
      checkLive(live);
      const expectedCwd = await realpath(cwd);
      checkLive(live);
      const pane = await tmux.call(
        "-N",
        "display-message",
        "-p",
        "-t",
        createdPane,
        "#{pane_dead}|#{pane_current_path}",
      );
      if (pane !== `0|${expectedCwd}`)
        throw Error("Created shell or working directory could not be verified");
    }
    await verifyWorkspace(tmux, after, session, owner, live);
    const attach = attachmentCommand(await realpath(socket), cwd, session.id);
    checkLive(live);
    return {
      ...base,
      state: "ready",
      server: before.state === "absent" ? "became reachable" : "reused",
      workspace: created ? "created" : "reused",
      session,
      attach,
    };
  } catch (error) {
    return {
      ...base,
      state: "unavailable",
      reason: error.code ? reason(error) : error.message.slice(0, 240),
      sessions: [],
      partial: attempted,
      session,
    };
  }
}
