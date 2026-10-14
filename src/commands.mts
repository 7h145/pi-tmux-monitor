// @ts-nocheck
/**
 * Themed notice/status/help layout adapted from pi-oaistt src/extension.ts
 * (4fc2923), by thias and OpenAI Codex (gpt-6.1-sol), MIT licensed.
 * See THIRD_PARTY_NOTICES.md. Dispatch and snapshot presentation are separate.
 */
import { STATES, STATE_DEFINITIONS } from "./protocol.mts";
import { installationLabel } from "./version.mts";
import { inspectionHint } from "./inspection.mts";
import { STATUS_KEY } from "./footer.mts";
import { renderTable, literalCell, noticeWidth } from "./tables.mts";

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
  const value = args.trim();
  return Object.hasOwn(actions, value) ? actions[value] : null;
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
        ["Pane", "Location", "Label", "Kind", "State", "Glyph", "Meaning"],
        data.slots.map((p) => [
          p.paneId ?? "unavailable",
          `${p.sessions?.map((s) => s.name ?? "unavailable").join(", ") || "unavailable"} / ${p.windowId ?? "unavailable"} (${p.windowIndex ?? "unavailable"}.${p.paneIndex ?? "unavailable"})`,
          p.workload?.label || "unavailable",
          p.workload?.kind ?? "unavailable",
          p.state,
          glyph(data, p.state),
          STATE_DEFINITIONS[p.state] ?? "unavailable",
        ]),
        width,
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
  return [
    `${strong(ctx, `${installationLabel(data.identity)}:`)} tmux workload awareness.`,
    "",
    "Inspect cached workload states without changing work or configuration.",
    "",
    strong(ctx, "Commands:"),
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
      ? [
          "Run from the project root:",
          "",
          ` ${inspection.command}`,
          "",
          inspection.hint,
        ]
      : [inspection.reason]),
    "",
    strong(ctx, "Notes:"),
    " • tmux-monitor never controls workloads or attaches to a tmux session.",
    " • Status shows cached data, refreshed automatically in the background.",
  ].join("\n");
}

export function diagnosticData(current, context, data) {
  return {
    ...context,
    scope: data.config?.scope,
    capability: current?.footer?.capability ?? "not TUI",
    statusKey: current?.footer ? STATUS_KEY : undefined,
    degraded: current?.observer?.degraded ?? false,
    observation: data.health,
    slots: data.slots.map((p) => ({ paneId: p.paneId, state: p.state })),
    diagnostics: [...(current?.diagnostics ?? [])],
  };
}

export function monitorCommand(
  getCurrent,
  getContext,
  inspect = inspectionHint,
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
    const live = () =>
      getCurrent() === current &&
      !current?.retired &&
      (!current || ctx.sessionManager.getSessionId() === current.owner);
    if (!live()) return;
    if (action === "status") current?.observer?.expire();
    const data = collectSnapshot(current);
    let text;
    if (action === "config")
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
    else text = commandHelp(ctx, data, await inspect(current, ctx.cwd));
    if (!live() || !ctx.hasUI) return;
    // One focused notice, never a model message or appended conversation entry.
    ctx.ui.notify(
      action === "status" || action === "help"
        ? ctx.ui.theme.fg("muted", text)
        : text,
      "info",
    );
  };
}
