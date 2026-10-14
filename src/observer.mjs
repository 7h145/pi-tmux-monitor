import { resolve } from "node:path";
import { realpath, readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { Tmux } from "./tmux.mjs";
import { parseTmux } from "./protocol.mjs";
import { Reconciler, eligible } from "./reconcile.mjs";
export async function legacySession(pid = process.pid) {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    return /^\d+$/.test(start) ? `agent-p${pid}-${start}` : null;
  } catch {
    return null;
  }
}
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
    this.reconciler = new Reconciler(config.staleAfterMs);
    this.cache = [];
    this.slots = [];
    this.running = false;
    this.retired = false;
    this.degraded = false;
    this.socket = config.socketPath;
    this.selection = this.socket ? "explicit" : null;
  }
  async select() {
    if (["explicit", "project"].includes(this.selection)) return;
    const project = resolve(this.cwd, ".agents/run/tmux-socket");
    try {
      await this.tmuxFactory(project, this.config.tmuxTimeoutMs).identity();
      if (this.socket !== project) {
        this.cache = [];
        this.slots = [];
        this.identity = undefined;
        this.reconciler = new Reconciler(this.config.staleAfterMs);
      }
      this.socket = project;
      this.selection = "project";
      return;
    } catch {}
    if (!this.socket) {
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
        this.cache = [];
        this.slots = [];
        this.reconciler = new Reconciler(this.config.staleAfterMs);
        this.identity = identity;
      }
      const panes = await tmux.inventory(this.diagnostic);
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
      const legacy = await legacySession();
      if (this.retired) return;
      this.cache = panes.filter((p) =>
        eligible(p, this.owner, this.config, ownPane, legacy),
      );
      this.slots = this.reconciler.reconcile(this.cache, this.clock());
      this.degraded = false;
      this.publish(this.slots);
    } catch {
      if (this.retired) return;
      this.reconciler.disconnect();
      this.degraded = true;
      this.slots = this.reconciler.reconcile(this.cache, this.clock());
      this.diagnostic(
        "Monitor server unavailable; cached inventory may be stale",
      );
      this.publish(this.slots);
    } finally {
      this.running = false;
    }
  }
  async start() {
    await this.scan();
    if (!this.retired)
      this.timer = setInterval(
        () => void this.scan(),
        this.config.pollIntervalMs,
      );
  }
  stop() {
    this.retired = true;
    clearInterval(this.timer);
  }
}
