import { resolve } from "node:path";
import {
  getAgentDir,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { processDiagnostics } from "./src/diagnostics.mts";
import { loadConfig } from "./src/config.mts";
import { Reporter } from "./src/reporter.mts";
import { Observer } from "./src/observer.mts";
import { FooterAdapter } from "./src/footer.mts";
import { helperPath } from "./src/launch.mts";
import { loadInstallationIdentity } from "./src/version.mts";
import { monitorCommand } from "./src/commands.mts";
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
  const diagnostics = processDiagnostics();
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
      diagnostics: diagnostics.messages,
      owner: ctx.sessionManager.getSessionId(),
      cwd: ctx.cwd,
    };
    runtime = current;
    const diagnostic = diagnostics.record;
    current.config = await loadConfig(
      getAgentDir(),
      ctx.cwd,
      ctx.isProjectTrusted(),
      diagnostic,
    );
    if (current.retired) return;
    current.identity = await loadInstallationIdentity();
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
      current.footer.finishStartup();
    }
  });
  pi.on("session_shutdown", (event) => stop(event.reason));
  pi.on("input", (event, ctx) => {
    runtime?.observer?.cycles.input(
      ["interactive", "rpc"].includes(event.source),
      ctx.isIdle(),
      event.streamingBehavior !== undefined,
    );
  });
  pi.on("agent_start", () => {
    runtime?.observer?.cycles.start();
    return runtime?.reporter?.active();
  });
  pi.on("message_start", (event) => {
    runtime?.observer?.cycles.message(event.message.role);
  });
  pi.on("agent_before_settle", (event) => {
    runtime?.reporter?.beforeSettle(event.outcome);
  });
  pi.on("agent_settled", (event) => {
    runtime?.observer?.completeUserCycle();
    return runtime?.reporter?.settled(event.aborted);
  });
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
      socket: resolve(
        runtime.cwd,
        runtime.config.socketPath ?? ".agents/run/tmux-socket",
      ),
      observerSocket: runtime.observer?.socket ?? null,
      helper: helperPath,
      heartbeatIntervalMs: runtime.config.heartbeatIntervalMs,
      tmuxTimeoutMs: runtime.config.tmuxTimeoutMs,
    };
  }
  pi.on("before_agent_start", (event) => {
    runtime?.observer?.cycles.prepare();
    const info = context();
    if (info)
      event.systemPromptOptions.appendSystemPrompt = replaceContext(
        event.systemPromptOptions.appendSystemPrompt ?? "",
        JSON.stringify(info) +
          "\nUse explicit owner, ancestry and timing when invoking the helper from custom shell tools. Do not copy stale TMUX or TMUX_PANE into new panes.",
      );
  });
  pi.registerCommand("tmux-monitor", {
    description:
      "Tmux workload/project server status, startup, help, config and diagnostics",
    handler: monitorCommand(() => runtime, context),
  });
}
