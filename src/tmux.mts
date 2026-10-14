// @ts-nocheck
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpath, stat } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { JOB, PI, OWNER, parseRecord } from "./protocol.mts";
const exec = promisify(execFile);
export class Tmux {
  constructor(socket, timeout = 1000) {
    this.socket = socket;
    this.timeout = timeout;
  }
  async call(...args) {
    const { stdout } = await exec("tmux", ["-S", this.socket, ...args], {
      timeout: this.timeout,
      maxBuffer: 4 * 1024 * 1024,
      encoding: "utf8",
    });
    return stdout.replace(/\n$/, "");
  }
  async identity() {
    const [path, s, server] = await Promise.all([
      realpath(this.socket),
      stat(this.socket),
      this.call("display-message", "-p", "#{pid}:#{start_time}"),
    ]);
    return `${path}:${s.dev}:${s.ino}:${server}`;
  }
  async ownIdentity(tmuxEnvironment) {
    const match = /^(.*),(\d+),(\d+)$/.exec(tmuxEnvironment ?? "");
    const identity = await this.identity();
    if (!match || identity.split(":").at(-2) !== match[2])
      throw new Error("Tmux server environment no longer matches this process");
    return identity;
  }
  async record(type, target, diagnostic = (_message) => {}) {
    const option = { job: JOB, pi: PI, owner: OWNER }[type];
    const scope = type === "owner" ? [] : ["-p"];
    const local = await this.call("show-options", ...scope, "-t", target);
    // No -A: names present here are local, not format-lookup inheritance.
    if (!local.split("\n").some((line) => line.startsWith(option + " ")))
      return null;
    return parseRecord(
      await this.call("show-options", ...scope, "-v", "-t", target, option),
      type,
      target,
      diagnostic,
    );
  }
  async write(type, target, record, guard = undefined) {
    const option = { job: JOB, pi: PI, owner: OWNER }[type];
    const raw = JSON.stringify(record);
    if (Buffer.byteLength(raw) > 16384)
      throw new Error("Monitor record exceeds limit");
    if (guard && type !== "owner") {
      const pid = guard.serverIdentity.split(":").at(-2);
      const start = guard.serverIdentity.split(":").at(-1);
      const key = type === "job" ? "jobId" : "instanceId";
      const allowed = [record[key], ...(guard.expectedIds ?? [])];
      if (
        !/^\d+$/.test(pid) ||
        !/^\d+$/.test(start) ||
        !/^%\d+$/.test(target) ||
        !allowed.every((value) => /^[A-Za-z0-9_.-]{1,256}$/.test(value))
      )
        throw new Error("Invalid guarded write identity");
      const patterns = allowed.map(
        (value) => `#{m:*"${key}":"${value}"*,#{${option}}}`,
      );
      const owned = patterns.reduce((a, b) => `#{||:${a},${b}}`);
      const server = `#{&&:#{==:#{pid},${pid}},#{==:#{start_time},${start}}}`;
      const condition = guard.allowAbsent ? server : `#{&&:${server},${owned}}`;
      const literal = "'" + raw.replaceAll("'", "'\\''") + "'";
      await this.call(
        "if-shell",
        "-F",
        "-t",
        target,
        condition,
        `set-option -p -t ${target} ${option} ${literal}`,
      );
      return;
    }
    await this.call(
      "set-option",
      ...(type === "owner" ? [] : ["-p"]),
      "-t",
      target,
      option,
      raw,
    );
  }
  async removeOwned(type, target, key, value) {
    if (
      !["job", "pi"].includes(type) ||
      key !== { job: "jobId", pi: "instanceId" }[type] ||
      !/^%\d+$/.test(target) ||
      !/^[A-Za-z0-9_.-]{1,256}$/.test(value)
    )
      return;
    const r = await this.record(type, target);
    if (r?.[key] !== value) return;
    const option = { job: JOB, pi: PI }[type];
    // Evaluate and delete in one synchronous tmux command queue. Only the
    // validated identifier enters this pattern, never JSON/labels/argv. A
    // newer writer between the read and this command therefore survives.
    const condition = `#{m:*"${key}":"${value}"*,#{${option}}}`;
    await this.call(
      "if-shell",
      "-F",
      "-t",
      target,
      condition,
      `set-option -p -u -t ${target} ${option}`,
    );
  }
  async inventory(
    diagnostic = (_message) => {},
    clock = () => performance.now(),
  ) {
    const rows = await this.call(
      "list-panes",
      "-a",
      "-F",
      "#{pane_id}|#{session_id}|#{pane_pid}|#{window_id}|#{window_index}|#{pane_index}",
    );
    const sessions = new Map(),
      panes = new Map();
    for (const line of rows.split("\n")) {
      const [paneId, sessionId, pid, windowId, windowIndex, paneIndex] =
        line.split("|");
      if (!/^%\d+$/.test(paneId) || !/^\$\d+$/.test(sessionId)) continue;
      if (!sessions.has(sessionId)) sessions.set(sessionId, null);
      if (!panes.has(paneId))
        panes.set(paneId, {
          paneId,
          pid,
          windowId,
          windowIndex,
          paneIndex,
          sessionIds: [],
        });
      panes.get(paneId).sessionIds.push(sessionId);
    }
    for (const sid of sessions.keys())
      sessions.set(sid, {
        id: sid,
        name: await this.call(
          "display-message",
          "-p",
          "-t",
          sid,
          "#{session_name}",
        ),
        owner: await this.record("owner", sid, diagnostic),
      });
    // Sequential, bounded operations; no per-pane process flood or overlapping scan.
    for (const pane of panes.values()) {
      pane.sessions = pane.sessionIds.map((s) => sessions.get(s));
      pane.observedAt = {};
      pane.job = await this.record("job", pane.paneId, diagnostic);
      pane.observedAt.job = clock();
      pane.pi = await this.record("pi", pane.paneId, diagnostic);
      pane.observedAt.pi = clock();
    }
    return [...panes.values()].sort(
      (a, b) => Number(a.paneId.slice(1)) - Number(b.paneId.slice(1)),
    );
  }
}
