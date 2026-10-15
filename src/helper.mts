// @ts-nocheck
import { parseCLI, launch } from "./launch.mts";
import { serverCommand } from "./server.mts";

// Failed observations are separate from verified current target fields.
export function publicResult(operation, result) {
  const verified = result.state !== "unavailable";
  return {
    operation,
    state: result.state,
    socket: result.socket ?? null,
    serverIdentity: verified ? (result.serverIdentity ?? null) : null,
    session: verified ? (result.session ?? null) : null,
    windowId: verified ? (result.windowId ?? null) : null,
    paneId: verified ? (result.paneId ?? null) : null,
    panePid: verified ? (result.panePid ?? null) : null,
    jobId: result.jobId ?? null,
    changes: {
      server: result.server ?? null,
      session: result.workspace ?? null,
      window: result.windowAction ?? null,
    },
    partial: !!result.partial,
    ...(result.reason ? { reason: result.reason.slice(0, 320) } : {}),
    ...(result.sessions ? { sessions: result.sessions } : {}),
    ...(result.attach ? { attach: result.attach } : {}),
    ...(!verified
      ? {
          observed: {
            serverIdentity: result.serverIdentity ?? null,
            session: result.session ?? null,
            paneId: result.paneId ?? null,
            windowId: result.windowId ?? null,
            panePid: result.panePid ?? null,
          },
        }
      : {}),
  };
}
export async function executeHelper(
  argv,
  env = process.env,
  cwd = process.cwd(),
) {
  const operation = argv[0];
  let plan;
  try {
    plan = parseCLI(argv, env, cwd);
    const result = ["inspect", "start"].includes(operation)
      ? await serverCommand(
          {
            owner: plan.owner,
            ancestors: plan.ancestors.slice(0, -1),
            config: { socketPath: plan.socket, tmuxTimeoutMs: plan.timeout },
          },
          plan.cwd,
          operation === "start",
          () => true,
        )
      : await launch(plan);
    return publicResult(operation, result);
  } catch (error) {
    return publicResult(
      operation,
      error.result ?? {
        state: "unavailable",
        socket: plan?.socket,
        reason: error.code
          ? "Operation prerequisites or tmux execution are unavailable"
          : error.message,
        partial: false,
      },
    );
  }
}
