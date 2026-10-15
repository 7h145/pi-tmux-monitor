// @ts-nocheck
export const JOB = "@pi-tmux-monitor-job";
export const PI = "@pi-tmux-monitor-pi";
export const OWNER = "@pi-tmux-monitor-owner";
export const STATE_DEFINITIONS = {
  idle: "Fresh application reporting says settled, waiting for work",
  active: "Fresh application reporting says the workload is doing work",
  running: "Workload is known alive; internal activity is unavailable",
  success:
    "Monitored command exited successfully; not proof of task correctness",
  failed: "Known command failure or final Pi-run error",
  unknown: "Registered workload without a trustworthy state",
  unregistered: "Eligible pane without a recognized monitor registration",
};
export const STATES = Object.keys(STATE_DEFINITIONS);
const kinds = ["batch", "service", "interactive"];
export const id = (x) =>
  typeof x === "string" &&
  x.length > 0 &&
  x.length <= 256 &&
  !/[\p{C}\s]/u.test(x);
export function lineage(owner, ancestors, includesOwner = false) {
  if (
    !id(owner) ||
    !Array.isArray(ancestors) ||
    ancestors.length > 64 ||
    !ancestors.every(id) ||
    new Set(ancestors).size !== ancestors.length
  )
    throw new Error("Invalid ownership lineage");
  if (includesOwner ? ancestors.at(-1) !== owner : ancestors.includes(owner))
    throw new Error("Contradictory ownership lineage");
  const chain = includesOwner ? [...ancestors] : [...ancestors, owner];
  if (chain.length > 64 || Buffer.byteLength(JSON.stringify(chain)) > 12 * 1024)
    throw new Error("Ownership lineage exceeds bounds");
  return chain;
}
// Keep printed option values valid JSON across tmux builds and client locales.
// Unicode escapes preserve text without exposing dollars to output escaping.
export function serializeRecord(record) {
  const raw = JSON.stringify(record).replace(
    /[\u007f-\uffff$]/g,
    (character) =>
      "\\u" + character.charCodeAt(0).toString(16).padStart(4, "0"),
  );
  if (Buffer.byteLength(raw) > 16384)
    throw new Error("Monitor record exceeds limit");
  return raw;
}
export function parseRecord(raw, type, paneId, diagnostic = (_message) => {}) {
  if (!raw) return null;
  try {
    if (Buffer.byteLength(raw) > 16384) throw 0;
    const r = JSON.parse(raw);
    if (!r || Array.isArray(r) || r.v !== 1) throw 0;
    if (type === "owner") {
      lineage(r.ownerSessionId, r.ancestors);
      return r;
    }
    if (
      r.paneId !== paneId ||
      !/^%\d+$/.test(r.paneId) ||
      !kinds.includes(r.kind) ||
      !Number.isSafeInteger(r.heartbeatSeq) ||
      r.heartbeatSeq < 0
    )
      throw 0;
    if (type === "job") {
      if (!id(r.jobId) || !["command", "pi"].includes(r.runtime)) throw 0;
      lineage(r.ownerSessionId, r.ancestors, true);
      if (
        r.label !== undefined &&
        (typeof r.label !== "string" ||
          [...r.label].length > 128 ||
          /\p{C}/u.test(r.label))
      )
        throw 0;
      if (
        r.phase !== undefined &&
        !["running", "success", "failed"].includes(r.phase)
      )
        throw 0;
      if (r.phase === "running" && r.exitCode !== null) throw 0;
      if (
        ["success", "failed"].includes(r.phase) &&
        (!Number.isSafeInteger(r.exitCode) ||
          r.exitCode < 0 ||
          (r.phase === "success") !== (r.exitCode === 0))
      )
        throw 0;
      if (r.signal !== undefined && !/^SIG[A-Z0-9]{1,16}$/.test(r.signal))
        throw 0;
    } else {
      if (
        ![r.instanceId, r.processInstanceId, r.sessionId].every(id) ||
        !(r.jobId === null || id(r.jobId))
      )
        throw 0;
      if (r.parentSessionId === null) {
        if (!Array.isArray(r.ancestors) || r.ancestors.length) throw 0;
      } else lineage(r.parentSessionId, r.ancestors, true);
      if (r.ancestors.includes(r.sessionId)) throw 0;
      if (
        r.state !== undefined &&
        !["idle", "active", "failed"].includes(r.state)
      )
        throw 0;
    }
    return r;
  } catch {
    diagnostic("Rejected invalid monitor metadata");
    return null;
  }
}
export function parseTmux(value) {
  const match = /^(.*),(\d+),(\d+)$/.exec(value ?? "");
  return match ? match[1] : null;
}
export function matches(job, reporter) {
  return (
    !!job &&
    !!reporter &&
    reporter.jobId === job.jobId &&
    reporter.parentSessionId === job.ownerSessionId &&
    JSON.stringify(reporter.ancestors) === JSON.stringify(job.ancestors) &&
    reporter.kind === job.kind
  );
}
