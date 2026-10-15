---
name: pi-tmux-monitor
description: >-
  Launch commands and Pi subagents with ownership and lifecycle reporting in tmux.
  Use for monitored batch work, services or interactive Pi, interpreting footer
  states, and locating their terminal output.
compatibility: Node 22.19+, tmux and Bash; Pi for Pi workloads. Validated on Linux with Pi 1.1.0 and tmux 3.5a.
---

# Monitored tmux launches

Resolve `../../scripts/pi-tmux-monitor.mjs` relative to this skill directory.
Use the actual installed package, whether global or project-local; do not assume
an executable is globally on PATH. The software also works without this skill.

## Current context

Use the current launch-context addendum or `/tmux-monitor diagnostics` for owner,
ancestry, helper, resolved launch socket and effective runner timings. The
observer may use a different socket; do not substitute it for the launch target.
The target path does not imply that a server exists. Pass explicit fresh values
in custom shell tools; server environment variables may be stale.

An owner is the current Pi session ID, not a PID or tmux name. Ancestry excludes
that owner; pass it unchanged when a child Pi launches its children. The helper
appends the owner once and rejects duplicate/cyclic chains. Do not copy client
`TMUX`/`TMUX_PANE` into new panes.

## Launch

Substitute current values. Defaults below illustrate timings; use the effective
values from context. Arguments after `--` are literal argv; invoke an explicit
shell for shell syntax.

```bash
node /absolute/installed/package/scripts/pi-tmux-monitor.mjs launch \
  --socket /absolute/project/.agents/run/tmux-socket \
  --owner CURRENT_PI_SESSION_ID --ancestors-json '[]' \
  --window tests --cwd /absolute/project --kind batch --label tests \
  --heartbeat-interval-ms 5000 --tmux-timeout-ms 1000 -- npm test
```

Omit `--session` to use the owner's default session, creating it with the first
workload and no spare shell. `--session NAME` explicitly selects a dedicated or
shared session; existing shared ownership is never reassigned. Use `--kind service`
for dev servers/watchers, or `interactive` for ordinary interactive programs.

```bash
node /absolute/installed/package/scripts/pi-tmux-monitor.mjs pi \
  --socket /absolute/project/.agents/run/tmux-socket \
  --owner CURRENT_PI_SESSION_ID --ancestors-json '[]' \
  --window review --cwd /absolute/project --mode interactive \
  --heartbeat-interval-ms 5000 --tmux-timeout-ms 1000 -- \
  --no-extensions --provider PROVIDER --model MODEL
```

Preserve the user's flags, literal prompt, model/provider and exit intent. Batch
mode adds `--print`. The helper loads its resolved reporter explicitly even with
`--no-extensions`, before a Pi `--` delimiter. `--uninstrumented` is an explicit
loss of Pi reporting, not automatic recovery; command lifecycle still applies.

## Inspection and startup results

The public helper also provides `inspect --socket PATH --cwd DIR` (read-only)
and `start --socket PATH --cwd DIR --owner ID --ancestors-json JSON` (explicit
shell workspace). Start and default launches share session selection. Neither
inspection nor loading/polling creates resources. A start creates only an
unregistered shell, not a Pi, job or fake heartbeat.

Each operation returns JSON. See [the launch script response reference](../../docs/launching.md#response-fields)
for states, verified identities and partial failures. Retain socket, serverIdentity,
session, windowId, paneId, panePid and jobId where provided. `observed` IDs in an
unavailable result are not verified targets. Failed confirmation may leave running
work: inspect before retrying, never duplicate automatically. Launch acknowledgement
is not application readiness or task correctness. Output remains in a retained shell.

Recheck the server identity with public `inspect`, and compare the intended
session/window/pane/PID before using a saved target. Then capture output using the
returned socket and verified pane, not a guessed name:

```bash
tmux -S /absolute/returned/socket capture-pane -t '%VERIFIED_PANE_NUMBER' -p -S -80
```

Use `/tmux-monitor help` for a verified manual attach hint and effective prefix,
then Prefix+s for native inspection. Native input, interrupts and deliberate
cleanup remain possible separately; verify targets first. The observer is read-only.

## Interpret states

`_` idle, `A` active, `R` running, `+` command success, `!` failure, `?` unknown,
`:` eligible unregistered pane. Themes may change glyphs; help shows active values.
Fresh application reporting supplies idle/active/final-error state for any kind.
Fresh runner liveness alone means running; missing trustworthy evidence means
unknown. Known exits take precedence. Idle is not task completion, and pane existence does
not establish running or idle. Loss of confirmed reporting appears in diagnostics.

Commands execute in the tmux server's environment. The cwd, Node/Bash, helper files
and requested executable must be usable there; Pi reporting additionally needs Pi
and the reporter. A reachable socket or caller installation proves none of this.
Do not provision tools, rewrite paths or switch execution environments after failure.
