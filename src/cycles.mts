// @ts-nocheck
// Count completed user requests, not agent-loop restarts or queued messages.
export class ForegroundCycles {
  constructor() {
    this.completed = 0n;
    this.sequence = 0n;
    this.current = null;
  }
  input(user, idle, queued) {
    if (!idle || queued || this.current?.running) return;
    this.current = user
      ? { id: ++this.sequence, prepared: false, started: false, running: false }
      : null;
  }
  prepare() {
    if (this.current && !this.current.running) this.current.prepared = true;
  }
  start() {
    if (this.current?.prepared) this.current.started = true;
    else if (!this.current?.running) this.current = null;
  }
  // Preparation can fail; verify that this run actually delivers a user message.
  message(role) {
    if (!this.current || this.current.running) return;
    if (role === "user" && this.current.prepared && this.current.started) {
      this.current.running = true;
      this.current.prepared = false;
    } else if (role === "custom") this.current = null;
  }
  settle() {
    const cycle = this.current;
    this.current = null;
    if (!cycle?.running) return null;
    this.completed++;
    return cycle.id;
  }
}
