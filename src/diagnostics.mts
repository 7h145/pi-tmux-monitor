// @ts-nocheck
export const RUNNER_DIAGNOSTICS = Object.freeze({
  "server-replaced": "Monitor server replaced; command reporting stopped",
  "write-failed": "Monitor command registration/heartbeat failed",
  "reporter-cleanup-failed": "Monitor reporter cleanup failed",
  "job-cleanup-failed": "Monitor prior-job cleanup failed",
});

export function createDiagnostics(state = { messages: [], seen: new Set() }) {
  const { messages, seen } = state;
  return {
    messages,
    record(message) {
      message = message.slice(0, 320);
      if (seen.has(message) || messages.length >= 16) return;
      seen.add(message);
      messages.push(message);
    },
  };
}

// Reload replaces the module graph, but cleanup diagnostics must remain
// inspectable in the next runtime. Retain data only, not module functions or
// UI, runtime or session objects.
export function processDiagnostics() {
  const key = Symbol.for("pi-tmux-monitor.diagnostics.v1");
  return createDiagnostics(
    (globalThis[key] ??= { messages: [], seen: new Set() }),
  );
}
