// @ts-nocheck
import { RUNNER_DIAGNOSTICS } from "./diagnostics.mts";
import { resolve } from "node:path";
import { realpath } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { Tmux } from "./tmux.mts";
import { parseTmux } from "./protocol.mts";
import { Reconciler, eligible } from "./reconcile.mts";
export class Observer {
  constructor({
    cwd,
    owner,
    config,
    env = process.env,
    publish,
    diagnostic = (_message) => {},
    tmuxFactory = (s, t) => new Tmux(s, t),
    clock = () => performance.now(),
  }) {
    Object.assign(this, {
      cwd,
      owner,
      config,
      env,
      publish,
      diagnostic,
      tmuxFactory,
      clock,
    });
    this.reconciler = new Reconciler(config.staleAfterMs, diagnostic);
    this.cache = [];
    this.slots = [];
    this.running = false;
    this.retired = false;
    this.degraded = false;
    this.lastSuccessfulScanAt = null;
    this.socket = config.socketPath;
    this.selection = this.socket ? "explicit" : null;
  }
  discardInventory() {
    this.cache = [];
    const changed = this.slots.length > 0;
    this.slots = [];
    this.lastSuccessfulScanAt = null;
    this.reconciler = new Reconciler(this.config.staleAfterMs, this.diagnostic);
    if (changed) this.publish(this.slots);
  }
  inventoryAge(now = this.clock()) {
    return this.lastSuccessfulScanAt === null
      ? null
      : now - this.lastSuccessfulScanAt;
  }
  expire(now = this.clock()) {
    if (this.retired) return;
    const slots = this.scoped(this.reconciler.expire(this.cache, now));
    if (
      slots.length !== this.slots.length ||
      slots.some(
        (p, i) =>
          p.paneId !== this.slots[i]?.paneId ||
          p.state !== this.slots[i]?.state ||
          p.presentationState !== this.slots[i]?.presentationState ||
          p.uncertain !== this.slots[i]?.uncertain,
      )
    ) {
      this.slots = slots;
      this.publish(this.slots);
    }
  }
  scoped(panes) {
    return panes.filter((p) =>
      eligible(p, this.owner, this.config, this.ownPane),
    );
  }
  async select() {
    if (["explicit", "project"].includes(this.selection)) return;
    const project = resolve(this.cwd, ".agents/run/tmux-socket");
    try {
      await this.tmuxFactory(project, this.config.tmuxTimeoutMs).identity();
      if (this.retired) return;
      if (this.socket !== project) {
        this.discardInventory();
        this.identity = undefined;
      }
      this.socket = project;
      this.selection = "project";
      return;
    } catch {}
    if (!this.socket && !this.retired) {
      this.socket = parseTmux(this.env.TMUX);
      this.selection = this.socket ? "inherited" : null;
    }
  }
  async scan() {
    if (this.running || this.retired) return;
    this.running = true;
    try {
      await this.select();
      if (!this.socket || this.retired) return;
      const tmux = this.tmuxFactory(this.socket, this.config.tmuxTimeoutMs),
        identity = await tmux.identity();
      if (this.retired) return;
      if (this.identity !== identity) {
        this.discardInventory();
        this.identity = identity;
      }
      const panes = await tmux.inventory(this.diagnostic, this.clock);
      if (this.retired) return;
      let ownPane = null;
      const ownEnvironment = /^(.*),(\d+),(\d+)$/.exec(this.env.TMUX ?? "");
      if (ownEnvironment && identity.split(":").at(-2) === ownEnvironment[2]) {
        try {
          if (
            (await realpath(parseTmux(this.env.TMUX))) ===
            (await realpath(this.socket))
          )
            ownPane = this.env.TMUX_PANE;
        } catch {}
      }
      if (this.retired) return;
      for (const pane of panes)
        for (const code of pane.job?.diagnostics ?? [])
          this.diagnostic(`Pane ${pane.paneId}: ${RUNNER_DIAGNOSTICS[code]}`);
      // Observe every pane before scoping: an out-of-scope pane may be reused
      // by this owner, and confirming that generation needs heartbeat history.
      this.cache = panes;
      this.ownPane = ownPane;
      const completedAt = this.clock();
      this.slots = this.scoped(
        this.reconciler.reconcile(this.cache, completedAt),
      );
      this.lastSuccessfulScanAt = completedAt;
      this.degraded = false;
      this.publish(this.slots);
    } catch {
      if (this.retired) return;
      this.reconciler.disconnect();
      this.degraded = true;
      this.slots = this.scoped(
        this.reconciler.expire(this.cache, this.clock()),
      );
      this.diagnostic(
        "Monitor server unavailable; cached inventory may be stale",
      );
      this.publish(this.slots);
    } finally {
      this.running = false;
    }
  }
  async start() {
    if (this.retired || this.timer !== undefined) return;
    // Start the existing poll timer before awaiting even the initial scan.
    this.timer = setInterval(() => {
      if (this.retired) return;
      this.expire();
      if (!this.running) void this.scan();
    }, this.config.pollIntervalMs);
    await this.scan();
  }
  stop() {
    this.retired = true;
    clearInterval(this.timer);
  }
}
