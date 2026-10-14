// @ts-nocheck
import { matches } from "./protocol.mts";
export class Reconciler {
  constructor(staleAfterMs, diagnostic = (_message) => {}) {
    this.staleAfterMs = staleAfterMs;
    this.diagnostic = diagnostic;
    this.sources = new Map();
    this.generations = new Map();
  }
  fresh(pane, type, r, now) {
    if (!r) return false;
    const key = pane + ":" + type;
    const identity =
      type === "job"
        ? r.jobId
        : [r.instanceId, r.processInstanceId, r.sessionId, r.jobId].join(":");
    let old = this.sources.get(key);
    if (!old || old.identity !== identity)
      old = { identity, seq: r.heartbeatSeq, advanced: false, time: now };
    else if (r.heartbeatSeq > old.seq) {
      old.seq = r.heartbeatSeq;
      old.time = now;
      old.advanced = true;
    } else if (r.heartbeatSeq < old.seq) {
      old.seq = r.heartbeatSeq;
      old.advanced = false;
      old.time = now;
    }
    this.sources.set(key, old);
    return old.advanced && now - old.time < this.staleAfterMs;
  }
  disconnect() {
    for (const r of this.sources.values()) r.advanced = false;
  }
  reconcile(panes, now) {
    const present = new Set(panes.map((p) => p.paneId));
    for (const k of this.generations.keys())
      if (!present.has(k)) {
        this.generations.delete(k);
        this.sources.delete(k + ":job");
        this.sources.delete(k + ":pi");
      }
    return panes.map((p) => {
      const j = p.job,
        r = p.pi;
      const jf = this.fresh(p.paneId, "job", j, now),
        rf = this.fresh(p.paneId, "pi", r, now);
      let g = this.generations.get(p.paneId);
      if (!g) g = { pid: p.pid, invalidJobs: new Set() };
      if (g.pid !== p.pid) {
        if (j) g.invalidJobs.add(j.jobId);
        g.pid = p.pid;
      }
      // An unattached fresh Pi is evidence of cooperative pane reuse, not a
      // leftover reporter for an older helper job. Never revive invalid outcomes.
      if (rf && r.jobId === null && j) g.invalidJobs.add(j.jobId);
      this.generations.set(p.paneId, g);
      const compatible = matches(j, r),
        validJob = j && !g.invalidJobs.has(j.jobId);
      const applicationState =
        rf &&
        (validJob ? compatible : !j || r.jobId === null) &&
        ["idle", "active", "failed"].includes(r.state);
      const ended = validJob && ["success", "failed"].includes(j.phase);
      const generation = validJob
        ? "job:" + j.jobId
        : r && (!j || r.jobId === null)
          ? "pi:" + r.processInstanceId + ":" + r.sessionId
          : null;
      // Confirm reporting before expecting it, so generic and intentionally
      // uninstrumented commands do not produce missing-reporter diagnostics.
      if (g.generation !== generation) {
        g.generation = generation;
        g.sawApplication = false;
        g.reporterLost = false;
      }
      if (applicationState) {
        g.sawApplication = true;
        g.reporterLost = false;
      } else if (!ended && generation && g.sawApplication && !g.reporterLost) {
        g.reporterLost = true;
        this.diagnostic(
          `No fresh application state for pane ${p.paneId}; internal activity is unknown`,
        );
      }
      let state = "unknown";
      if (!j && !r) state = "unregistered";
      else if (ended) state = j.phase;
      else if (applicationState) state = r.state;
      else if (validJob && jf && j.phase === "running") state = "running";
      return { ...p, state };
    });
  }
}
export function eligible(p, owner, config, ownPane, legacySession = null) {
  if (p.paneId === ownPane) return false;
  if (!config.includeUnregistered && !p.job && !p.pi) return false;
  if (config.scope === "server") return true;
  const inScope = (direct, ancestors = []) =>
    direct === owner ||
    (config.scope === "descendants" && ancestors.includes(owner));
  // Registered ownership is authoritative, even in a differently owned session.
  if (p.job) return inScope(p.job.ownerSessionId, p.job.ancestors);
  if (p.pi?.parentSessionId)
    return inScope(p.pi.parentSessionId, p.pi.ancestors);
  return p.sessions.some((s) =>
    s.owner
      ? inScope(s.owner.ownerSessionId, s.owner.ancestors)
      : config.ownedSessions.includes(s.name) || s.name === legacySession,
  );
}
