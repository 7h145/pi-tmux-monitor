// @ts-nocheck
import { randomUUID } from "node:crypto";
import { Tmux } from "./tmux.mts";
import { parseTmux, matches } from "./protocol.mts";
const key = Symbol.for("pi-tmux-monitor.process.v1");
const processState = (globalThis[key] ??= { id: randomUUID(), last: null });
export class Reporter {
  constructor({
    sessionId,
    mode,
    idle,
    config,
    env = process.env,
    diagnostic = (_message) => {},
    tmuxFactory = (s, t) => new Tmux(s, t),
  }) {
    Object.assign(this, {
      sessionId,
      mode,
      idle,
      config,
      env,
      diagnostic,
      tmuxFactory,
    });
    this.retired = false;
    this.queue = Promise.resolve();
    this.ancestors = [];
    this.outcome = "completed";
  }
  async start() {
    const socket = parseTmux(this.env.TMUX),
      paneId = this.env.TMUX_PANE;
    if (!socket || !/^%\d+$/.test(paneId ?? "")) return;
    this.tmux = this.tmuxFactory(socket, this.config.tmuxTimeoutMs);
    this.paneId = paneId;
    try {
      this.serverIdentity = await this.tmux.ownIdentity(this.env.TMUX);
      const job = await this.tmux.record("job", paneId),
        prior = await this.tmux.record("pi", paneId);
      this.predecessor = prior?.instanceId;
      if (this.retired) return;
      let bound = null;
      try {
        const candidate = {
          jobId: this.env.PI_TMUX_MONITOR_JOB_ID,
          parentSessionId: this.env.PI_TMUX_MONITOR_PARENT,
          ancestors: JSON.parse(this.env.PI_TMUX_MONITOR_ANCESTORS ?? "[]"),
          kind: job?.kind,
        };
        if (matches(job, candidate) && job.phase === "running") bound = job;
      } catch {}
      let parentSessionId = bound?.ownerSessionId ?? null,
        ancestors = bound?.ancestors ?? [];
      if (!bound) {
        const sid = await this.tmux.call(
          "display-message",
          "-p",
          "-t",
          paneId,
          "#{session_id}",
        );
        const context = await this.tmux.record("owner", sid);
        if (context) {
          parentSessionId = context.ownerSessionId;
          ancestors = [...context.ancestors, parentSessionId];
        }
      }
      if (ancestors.includes(this.sessionId)) {
        parentSessionId = null;
        ancestors = [];
        this.diagnostic("Ignored cyclic reporter lineage");
      }
      if (this.retired) return;
      this.ancestors = [...ancestors];
      this.record = {
        v: 1,
        paneId,
        instanceId: randomUUID(),
        processInstanceId: processState.id,
        sessionId: this.sessionId,
        kind:
          bound?.kind ??
          (["print", "json"].includes(this.mode) ? "batch" : "interactive"),
        jobId: bound?.jobId ?? null,
        parentSessionId,
        ancestors,
        state: this.idle ? "idle" : "active",
        heartbeatSeq: 0,
      };
      const old = prior ?? processState.last;
      if (
        old?.processInstanceId === processState.id &&
        old.sessionId === this.sessionId &&
        old.jobId === this.record.jobId &&
        old.paneId === paneId &&
        ["idle", "active", "failed"].includes(old.state)
      )
        this.record.state = old.state;
      await this.write();
      if (!this.retired)
        this.timer = setInterval(() => {
          if (!this.pending) {
            this.pending = true;
            void this.write().finally(() => (this.pending = false));
          }
        }, this.config.heartbeatIntervalMs);
    } catch {
      this.diagnostic("Pi reporter could not register with its tmux server");
    }
  }
  write() {
    if (!this.record || this.retired) return Promise.resolve();
    const snapshot = {
      ...this.record,
      heartbeatSeq: ++this.record.heartbeatSeq,
    };
    this.queue = this.queue
      .then(async () => {
        if (this.retired) return;
        if ((await this.tmux.identity()) !== this.serverIdentity) {
          this.retired = true;
          clearInterval(this.timer);
          this.diagnostic("Pi reporter server was replaced; reporting stopped");
          return;
        }
        const current = await this.tmux.record("pi", this.paneId);
        if (this.retired) return;
        if (
          current &&
          current.instanceId !== snapshot.instanceId &&
          current.instanceId !== this.predecessor
        ) {
          this.retired = true;
          clearInterval(this.timer);
          return;
        }
        if (snapshot.jobId) {
          const job = await this.tmux.record("job", this.paneId);
          if (
            !matches(job, snapshot) ||
            job.phase !== "running" ||
            this.retired
          )
            return;
        }
        await this.tmux.write("pi", this.paneId, snapshot, {
          serverIdentity: this.serverIdentity,
          expectedIds: this.predecessor ? [this.predecessor] : [],
          allowAbsent: !current,
        });
        this.predecessor = undefined;
        processState.last = snapshot;
      })
      .catch(() => this.diagnostic("Pi reporter metadata write failed"));
    return this.queue;
  }
  state(value) {
    if (this.record && !this.retired) this.record.state = value;
    return this.write();
  }
  active() {
    this.outcome = "completed";
    return this.state("active");
  }
  beforeSettle(outcome) {
    this.outcome = outcome;
  }
  settled(aborted = false) {
    return this.state(!aborted && this.outcome === "error" ? "failed" : "idle");
  }
  compactStart() {
    this.beforeCompact = this.record?.state;
    return this.state("active");
  }
  compactEnd(idle) {
    return this.state(
      idle ? (this.beforeCompact === "failed" ? "failed" : "idle") : "active",
    );
  }
  async stop(reason) {
    this.retired = true;
    clearInterval(this.timer);
    await this.queue;
    if (this.record) {
      if (
        reason !== "reload" &&
        processState.last?.instanceId === this.record.instanceId
      )
        processState.last = null;
      try {
        if ((await this.tmux.identity()) === this.serverIdentity)
          await this.tmux.removeOwned(
            "pi",
            this.paneId,
            "instanceId",
            this.record.instanceId,
          );
      } catch {
        this.diagnostic("Pi reporter cleanup failed");
      }
    }
  }
}
