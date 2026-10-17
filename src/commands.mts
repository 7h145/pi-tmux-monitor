// @ts-nocheck
// Dispatch and snapshot presentation are separate.
import { STATES, STATE_DEFINITIONS } from "./protocol.mts";
import { installationLabel } from "./version.mts";
import { inspectionHint } from "./inspection.mts";
import { workspaceReferences } from "./workspaces.mts";
import { presentationState } from "./formatter.mts";
import { STATUS_KEY } from "./footer.mts";
import { serverCommand } from "./server.mts";
import {
  renderTable,
  literalCell,
  noticeWidth,
  themedCell,
} from "./tables.mts";

const actions = {
  "": "status",
  s: "status",
  status: "status",
  h: "help",
  help: "help",
  c: "config",
  config: "config",
  d: "diagnostics",
  diagnostics: "diagnostics",
};
export function parseCommand(args) {
  const words = args.trim().split(/\s+/);
  if (words[0] === "tmux" || words[0] === "t") {
    if (
      words.length === 1 ||
      (words.length === 2 && ["status", "s"].includes(words[1]))
    )
      return "server-status";
    if (words.length === 2 && words[1] === "start") return "server-start";
    return null;
  }
  return words.length === 1 && Object.hasOwn(actions, words[0])
    ? actions[words[0]]
    : null;
}
export function collectSnapshot(current) {
  const observer = current?.observer;
  return {
    identity: current?.identity ?? {},
    config: current?.config ?? null,
    slots: structuredClone(observer?.slots ?? []),
    inventoryAgeMs: observer?.inventoryAge() ?? null,
    health: observer?.degraded
      ? "degraded"
      : observer?.lastSuccessfulScanAt != null
        ? "healthy"
        : observer
          ? "unavailable"
          : "not observing",
  };
}

const strong = (ctx, text) =>
  ctx.ui.theme.style(text, { fg: "text", bold: true });
const glyph = (data, state) =>
  data.config?.themes[data.config.activeTheme]?.states[state]?.glyph ??
  "unavailable";

export function statusText(ctx, data, width = noticeWidth()) {
  const count = data.slots.length;
  const { references, mappings } = workspaceReferences(data.slots);
  const lines = [
    `${strong(ctx, `${installationLabel(data.identity)}:`)} ${count} monitored pane${count === 1 ? "" : "s"}.`,
    `Scope: ${data.config?.scope ?? "unavailable"}. Observation: ${data.health}.`,
  ];
  if (data.health === "degraded")
    lines.push(
      "Cached inventory; pane presence and live activity are not confirmed.",
    );
  else if (data.health !== "healthy")
    lines.push(
      "No verified current inventory is available; this is not an empty healthy inventory.",
    );
  if (data.inventoryAgeMs === null)
    lines.push("Cached inventory — no successful scan yet.");
  else if (data.inventoryAgeMs >= data.config?.staleAfterMs)
    lines.push(
      `Cached inventory — last successful scan ${Math.floor(data.inventoryAgeMs / 1000)}s ago.`,
    );
  if (!count && data.health === "healthy") lines.push("No eligible panes.");
  if (count)
    lines.push(
      "",
      renderTable(
        ctx,
        ["Glyph", "Pane", "Location", "Label", "Kind", "State"],
        data.slots.map((p) => [
          themedCell(
            glyph(data, presentationState(p)),
            (p.uncertain ?? p.state === "unknown")
              ? "dim"
              : (data.config?.themes[data.config.activeTheme]?.states[
                  presentationState(p)
                ]?.fg ?? null),
          ),
          p.paneId ?? "unavailable",
          `${p.sessions?.map((s) => references.get(s.name) ?? "unavailable").join(", ") || "unavailable"} / ${p.windowId ?? "unavailable"} (${p.windowIndex ?? "unavailable"}.${p.paneIndex ?? "unavailable"})`,
          p.workload?.label || "unavailable",
          p.workload?.kind ?? "unavailable",
          p.state,
        ]),
        width,
      ),
    );
  if (count && mappings.length)
    lines.push(
      "",
      strong(ctx, "Workspaces:"),
      ...mappings.map(
        ({ reference, name }) =>
          ` [${literalCell(reference)}]: ${literalCell(name)}`,
      ),
    );
  lines.push(
    "",
    `See ${strong(ctx, "/tmux-monitor help")} for commands and terminal inspection.`,
  );
  return lines.join("\n");
}

export function commandHelp(ctx, data, inspection, width = noticeWidth()) {
  const command = (syntax, description) =>
    `  ${strong(ctx, syntax)}${" ".repeat(Math.max(2, 34 - syntax.length))}${description}`;
  const prefixes = inspection.prefixes;
  const prefix = prefixes?.length
    ? `${prefixes[0]}${prefixes[1] ? ` (or ${prefixes[1]})` : ""}`
    : "Prefix";
  const shortcuts =
    prefixes?.length === 0
      ? [
          "Both tmux prefixes are disabled; these prefix-key shortcuts are unavailable.",
        ]
      : [
          ` • ${prefix}, then s opens the session tree and pane previews.`,
          ` • ${prefix}, then d detaches without ending the session.`,
        ];
  return [
    `${strong(ctx, `${installationLabel(data.identity)}:`)} tmux workload awareness.`,
    "",
    "Inspect workload states and the project server; start it explicitly.",
    "",
    strong(ctx, "Commands:"),
    strong(ctx, "Workload inspection:"),
    command("/tmux-monitor status (s)", "Show every monitored pane (default)"),
    command(
      "/tmux-monitor help (h)",
      "Show commands, states and inspection hint",
    ),
    command("/tmux-monitor config (c)", "Show effective configuration as JSON"),
    command(
      "/tmux-monitor diagnostics (d)",
      "Show launch context and runtime health as JSON",
    ),
    "",
    strong(ctx, "Tmux server:"),
    command("/tmux-monitor tmux (t)", "Check the project server (read-only)"),
    command("/tmux-monitor tmux status (s)", "Same server check; tmux s / t s"),
    command("/tmux-monitor tmux start", "Start/reuse the project server"),
    "  Also: t start. Start is the only mutating command; no shorthand.",
    "",
    strong(
      ctx,
      data.config
        ? `States — active theme ${literalCell(data.config.activeTheme)}:`
        : "States — active configuration unavailable:",
    ),
    renderTable(
      ctx,
      ["State", "Glyph", "Meaning"],
      STATES.map((state) => [
        state,
        glyph(data, state),
        STATE_DEFINITIONS[state],
      ]),
      width,
    ),
    "",
    strong(ctx, "Terminal inspection:"),
    ...(inspection.command
      ? ["Run from the project root:", "", ` ${inspection.command}`]
      : [inspection.reason]),
    "",
    strong(ctx, "In tmux:"),
    ...shortcuts,
    "",
    strong(ctx, "Notes:"),
    " • tmux-monitor never controls workloads or attaches to a tmux session.",
    " • Status shows cached data, refreshed automatically in the background.",
    " • Dim glyphs may be last-known or unconfirmed; State reports current evidence.",
  ].join("\n");
}

export function serverText(ctx, data, result, start, width = noticeWidth()) {
  const lines = [
    `${strong(ctx, `${installationLabel(data.identity)}:`)} ${start ? "Tmux project server startup" : "Tmux server status"}.`,
  ];
  if (result.socket) lines.push(`Target socket: ${literalCell(result.socket)}`);
  if (result.observerSocket)
    lines.push(
      `Observer uses a different socket: ${literalCell(result.observerSocket)}`,
    );
  if (result.state === "ready")
    lines.push(
      `Server: ${result.server}. Workspace: ${result.workspace}.`,
      `Session: ${result.session.id} (${literalCell(result.session.name)}).`,
      "",
      "Run from the project root:",
      "",
      ` ${result.attach}`,
    );
  else if (result.state === "reachable") {
    lines.push("Server: reachable.");
    const sessions = result.sessions.slice(0, 256);
    if (sessions.length)
      lines.push(
        "",
        renderTable(
          ctx,
          ["Session", "Name"],
          sessions.map((s) => [s.id, s.name]),
          width,
        ),
      );
    else lines.push("No sessions.");
    if (result.sessions.length > sessions.length)
      lines.push(
        `${result.sessions.length - sessions.length} additional sessions omitted.`,
      );
  } else if (result.state === "absent")
    lines.push("Server: absent. Nothing was created.");
  else {
    lines.push(`Server/workspace unavailable: ${literalCell(result.reason)}`);
    if (result.session)
      lines.push(
        `Last observed session: ${result.session.id} (${literalCell(result.session.name)}).`,
      );
    if (result.partial)
      lines.push(
        "Creation was attempted; resources may remain. No rollback was performed.",
        "Inspect the target socket before retrying; do not retry creation blindly.",
      );
  }
  return lines.join("\n");
}

export function diagnosticData(current, context, data) {
  return {
    ...context,
    scope: data.config?.scope,
    capability: current?.footer?.capability ?? "not TUI",
    statusKey: current?.footer ? STATUS_KEY : undefined,
    degraded: current?.observer?.degraded ?? false,
    observation: data.health,
    slots: data.slots.map((p) => ({
      paneId: p.paneId,
      state: p.state,
      presentationState: presentationState(p),
      uncertain: p.uncertain ?? p.state === "unknown",
    })),
    diagnostics: [...(current?.diagnostics ?? [])],
  };
}

export function monitorCommand(
  getCurrent,
  getContext,
  inspect = inspectionHint,
  server = serverCommand,
) {
  return async (args, ctx) => {
    const action = parseCommand(args);
    if (!action) {
      if (ctx.hasUI)
        ctx.ui.notify(
          "Unknown or extra arguments. Use /tmux-monitor help.",
          "error",
        );
      return;
    }
    if (!ctx.hasUI) return;
    const current = getCurrent();
    const owner = current?.owner;
    const live = () =>
      getCurrent() === current &&
      !current?.retired &&
      (!current ||
        (current.owner === owner &&
          ctx.sessionManager.getSessionId() === owner));
    if (!live()) return;
    if (action === "status") current?.observer?.expire();
    const data = collectSnapshot(current);
    let text;
    if (action === "server-status" || action === "server-start") {
      const result = await server(
        current,
        ctx.cwd,
        action === "server-start",
        live,
      );
      if (!live() || !ctx.hasUI) return;
      text = serverText(ctx, data, result, action === "server-start");
    } else if (action === "config")
      text = JSON.stringify(
        data.config ?? { error: "Effective monitor configuration unavailable" },
        null,
        2,
      );
    else if (action === "diagnostics")
      text = JSON.stringify(
        diagnosticData(current, getContext(), data),
        null,
        2,
      );
    else if (action === "status") text = statusText(ctx, data);
    else {
      const inspection = await inspect(current, ctx.cwd);
      if (!live() || !ctx.hasUI) return;
      text = commandHelp(ctx, data, inspection);
    }
    if (!live() || !ctx.hasUI) return;
    // One focused notice, never a model message or appended conversation entry.
    ctx.ui.notify(
      ["status", "help", "server-status", "server-start"].includes(action)
        ? ctx.ui.theme.fg("muted", text)
        : text,
      "info",
    );
  };
}
