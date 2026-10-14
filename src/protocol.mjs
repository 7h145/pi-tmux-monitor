export const JOB = "@pi-tmux-monitor-job";
export const PI = "@pi-tmux-monitor-pi";
export const OWNER = "@pi-tmux-monitor-owner";
export const STATES = [
  "idle",
  "active",
  "service",
  "success",
  "failed",
  "unknown",
  "unregistered",
];
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
