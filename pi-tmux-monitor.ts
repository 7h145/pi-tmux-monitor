import {
  getAgentDir,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./src/config.mjs";
import { Reporter } from "./src/reporter.mjs";
import { Observer } from "./src/observer.mjs";
import { FooterAdapter, STATUS_KEY } from "./src/footer.mjs";
import { helperPath } from "./src/launch.mjs";
const BEGIN = "<pi-tmux-monitor-launch-context>",
  END = "</pi-tmux-monitor-launch-context>";
export function replaceContext(existing: string, block: string) {
  return (
    existing
      .replace(
        /<pi-tmux-monitor-launch-context>[\s\S]*?<\/pi-tmux-monitor-launch-context>/g,
        "",
      )
      .trimEnd() +
    "\n\n" +
    BEGIN +
    "\n" +
    block +
    "\n" +
    END
  ).trim();
}
export default function monitor(pi: ExtensionAPI) {
  let runtime: any;
  async function stop(reason: string) {
    const old = runtime;
    runtime = undefined;
    if (!old) return;
    old.retired = true;
    old.observer?.stop();
    old.footer?.stop();
    for (const [key, value] of Object.entries(old.exported ?? {}))
      if (process.env[key] === value) {
        if (old.previous[key] === undefined) delete process.env[key];
        else process.env[key] = old.previous[key];
      }
    await old.reporter?.stop(reason);
  }
  pi.on("session_start", async (_event, ctx) => {
    await stop("reload");
    const current: any = {
      retired: false,
      diagnostics: [],
      seen: new Set(),
      owner: ctx.sessionManager.getSessionId(),
    };
    runtime = current;
    const diagnostic = (message: string) => {
      message = message.slice(0, 320);
      if (
        current.retired ||
        current.seen.has(message) ||
        current.diagnostics.length >= 16
      )
        return;
      current.seen.add(message);
      current.diagnostics.push(message);
      if (ctx.hasUI) ctx.ui.notify(message, "warning");
    };
    current.config = await loadConfig(
      getAgentDir(),
      ctx.cwd,
      ctx.isProjectTrusted(),
      diagnostic,
    );
    if (current.retired) return;
    current.reporter = new Reporter({
      sessionId: current.owner,
      mode: ctx.mode,
      idle: ctx.isIdle(),
      config: current.config,
      diagnostic,
    });
    await current.reporter.start();
    if (current.retired) {
      await current.reporter.stop("reload");
      return;
    }
    current.ancestors = current.reporter.ancestors;
    current.previous = {};
    current.exported = {
      PI_TMUX_MONITOR_OWNER: current.owner,
      PI_TMUX_MONITOR_ANCESTORS: JSON.stringify(current.ancestors),
      PI_TMUX_MONITOR_HELPER: helperPath,
    };
    for (const [key, value] of Object.entries(current.exported)) {
      current.previous[key] = process.env[key];
      process.env[key] = String(value);
    }
    if (ctx.mode === "tui") {
      current.footer = new FooterAdapter(pi, ctx, current.config, diagnostic);
      current.observer = new Observer({
        cwd: ctx.cwd,
        owner: current.owner,
        config: current.config,
        diagnostic,
        publish: (slots: any[]) => current.footer.publish(slots),
      });
      await current.observer.start();
    }
  });
  pi.on("session_shutdown", (event) => stop(event.reason));
  pi.on("agent_start", () => runtime?.reporter?.active());
  pi.on("agent_before_settle", (event) => {
    runtime?.reporter?.beforeSettle(event.outcome);
  });
  pi.on("agent_settled", (event) => runtime?.reporter?.settled(event.aborted));
  pi.on("session_before_compact", () => runtime?.reporter?.compactStart());
  pi.on("session_compact", (_event, ctx) =>
    runtime?.reporter?.compactEnd(ctx.isIdle()),
  );
  pi.on("session_compact_failed", (_event, ctx) =>
    runtime?.reporter?.compactEnd(ctx.isIdle()),
  );
  function context() {
    if (!runtime?.config) return undefined;
    return {
      owner: runtime.owner,
      ancestors: runtime.ancestors ?? [],
      socket:
        runtime.observer?.socket ??
        runtime.config.socketPath ??
        "automatic: project .agents/run/tmux-socket, then inherited TMUX",
      helper: helperPath,
      heartbeatIntervalMs: runtime.config.heartbeatIntervalMs,
      tmuxTimeoutMs: runtime.config.tmuxTimeoutMs,
    };
  }
  pi.on("before_agent_start", (event) => {
    const info = context();
    if (info)
      event.systemPromptOptions.appendSystemPrompt = replaceContext(
        event.systemPromptOptions.appendSystemPrompt ?? "",
        JSON.stringify(info) +
          "\nUse explicit owner, ancestry and timing when invoking the helper from custom shell tools. Do not copy stale TMUX or TMUX_PANE into new panes.",
      );
  });
  pi.registerCommand("tmux-monitor", {
    description: "Show read-only tmux monitor launch context and diagnostics",
    handler: async (_args, ctx) => {
      const info = {
        ...context(),
        scope: runtime?.config?.scope,
        capability: runtime?.footer?.capability ?? "not TUI",
        statusKey: runtime?.footer ? STATUS_KEY : undefined,
        degraded: runtime?.observer?.degraded ?? false,
        slots:
          runtime?.observer?.slots.map((s: any) => ({
            paneId: s.paneId,
            state: s.state,
          })) ?? [],
        diagnostics: runtime?.diagnostics ?? [],
      };
      ctx.ui.notify(JSON.stringify(info, null, 2), "info");
    },
  });
}
