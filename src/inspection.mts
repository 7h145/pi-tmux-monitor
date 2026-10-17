// @ts-nocheck
import { realpath } from "node:fs/promises";
import { Tmux } from "./tmux.mts";
import { attachmentCommand } from "./shell.mts";

const sessionId = (value) => /^\$\d+$/.test(value ?? "");
const plain = (value) =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 4096 &&
  !/\p{C}/u.test(value);
const owned = (session, owner, config) =>
  session.owner
    ? session.owner.ownerSessionId === owner ||
      session.owner.ancestors.includes(owner)
    : config.ownedSessions.includes(session.name);

export function readablePrefix(key) {
  if (key === "None") return null;
  if (!plain(key) || key.length > 128) throw Error("Invalid prefix");
  const modifiers = [];
  while (/^[CMS]-/.test(key)) {
    modifiers.push({ C: "Ctrl", M: "Alt", S: "Shift" }[key[0]]);
    key = key.slice(2);
  }
  if (!key) throw Error("Invalid prefix");
  return [...modifiers, key].join("+");
}

/** Help-only, read-only lookups. Never inventory/attach or modify the server. */
export async function inspectionHint(
  current,
  cwd,
  factory = (socket, timeout) => new Tmux(socket, timeout),
) {
  const unavailable = (reason) => ({ reason, prefixes: null });
  if (!current?.config)
    return unavailable(
      "No verified attachment target; configuration is unavailable.",
    );
  let tmux, target, socket;
  const reporter = current.reporter;
  try {
    if (
      reporter?.tmux &&
      reporter.serverIdentity &&
      sessionId("$" + /,(\d+)$/.exec(reporter.env.TMUX ?? "")?.[1])
    ) {
      tmux = reporter.tmux;
      if ((await tmux.identity()) !== reporter.serverIdentity)
        return unavailable(
          "Foreground tmux server changed; no verified attachment target.",
        );
      target = "$" + /,(\d+)$/.exec(reporter.env.TMUX)[1];
      const panes = await tmux.call(
        "list-panes",
        "-s",
        "-t",
        target,
        "-F",
        "#{pane_id}",
      );
      if (!panes.split("\n").includes(reporter.paneId))
        return unavailable(
          "Foreground tmux session is unavailable; no verified attachment target.",
        );
    } else {
      const observer = current.observer;
      if (!observer?.socket || !observer.identity)
        return unavailable("No verified attachment target is known.");
      const candidates = new Map();
      for (const pane of observer.slots ?? [])
        for (const session of pane.sessions ?? [])
          if (
            sessionId(session.id) &&
            owned(session, current.owner, current.config)
          )
            candidates.set(session.id, session);
      if (candidates.size !== 1)
        return unavailable(
          candidates.size
            ? "Several owned sessions are known; no unambiguous attachment target."
            : "No associated owned session is known; no verified attachment target.",
        );
      tmux = factory(observer.socket, current.config.tmuxTimeoutMs);
      if ((await tmux.identity()) !== observer.identity)
        return unavailable(
          "Observed tmux server changed; no verified attachment target.",
        );
      [target] = candidates.keys();
      const context = await tmux.record("owner", target);
      const name = await tmux.call(
        "display-message",
        "-p",
        "-t",
        target,
        "#{session_name}",
      );
      if (!owned({ name, owner: context }, current.owner, current.config))
        return unavailable(
          "Session ownership changed; no verified attachment target.",
        );
    }
    // Verify an exact session ID, rather than accepting tmux target abbreviations.
    if (
      (await tmux.call(
        "display-message",
        "-p",
        "-t",
        target,
        "#{session_id}",
      )) !== target
    )
      return unavailable("No verified attachment target is available.");
    socket = await realpath(tmux.socket);
    if (!plain(socket))
      return unavailable(
        "The socket path cannot be shown safely on one command line.",
      );
  } catch {
    return unavailable(
      "Tmux inspection is unavailable; no verified attachment target.",
    );
  }
  const command = attachmentCommand(socket, cwd, target);
  let prefixes = null;
  try {
    // Prefixes inherit session/global settings; unlike registrations, use -A.
    const keys = await Promise.all(
      ["prefix", "prefix2"].map((option) =>
        tmux.call("show-options", "-A", "-v", "-t", target, option),
      ),
    );
    prefixes = [...new Set(keys.map(readablePrefix).filter(Boolean))];
  } catch {
    /* Keep the generic hint; never claim a default key was configured. */
  }
  return { command, prefixes };
}
