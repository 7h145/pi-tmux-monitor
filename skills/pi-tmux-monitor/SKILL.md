---
name: pi-tmux-monitor
description: >-
  Register tmux commands and Pi subagents for truthful footer monitoring. Use when
  launching batch work, services or interactive Pi in tmux, directly or alongside
  boxed-tmux, and when adapting another tmux launcher to the monitor.
compatibility: Requires Node 22.19+, tmux and Pi; validated on Linux with Pi 1.1.0 and tmux 3.5a.
---

# Monitored tmux launches

The helper is `../../scripts/pi-tmux-monitor.mjs` relative to this skill directory.
Resolve that to an absolute path. Do not assume a globally installed executable.
The package extension is `../../pi-tmux-monitor.ts`. The skill is guidance, not
launch enforcement; the extension observes/reports and does not spawn work.

## Obtain current launch context

Use the extension's launch-context addendum or ask the user to run `/tmux-monitor`.
Obtain **current** owner session ID, ancestry, socket, helper path and runner timing
values. Do not invent an owner from a PID or reuse another conversation's ID.
Pass these explicitly when custom shell tools do not inherit fresh Pi context.
`PI_SESSION_ID` or `PI_TMUX_MONITOR_OWNER` may be useful only when freshness is known.
Tmux server environment can retain old IDs.

The ancestry JSON is the launching owner's root-to-parent array, excluding that
owner. For a background Pi launching its children, pass its current diagnostic
ancestry unchanged; the helper appends its owner once. Cycles/duplicates fail.
Do not copy the launching process's `TMUX`/`TMUX_PANE` into a new pane.

Select one socket, normally `$PWD/.agents/run/tmux-socket`. The helper can start a
new dedicated session or create a window in an existing session. Create the socket's
parent directory if needed. The observer alone never starts a server.

## Ordinary command recipe

Replace the variables with resolved/current values. Timings below illustrate the
defaults; use the extension's effective values when configuration overrides them.

```bash
HELPER=/absolute/package/path/scripts/pi-tmux-monitor.mjs
SOCKET=/absolute/project/path/.agents/run/tmux-socket
OWNER=CURRENT_PI_SESSION_ID
ANCESTORS='[]'
mkdir -p "$(dirname "$SOCKET")"
node "$HELPER" launch \
  --socket "$SOCKET" --session agent-name --window tests \
  --owner "$OWNER" --ancestors-json "$ANCESTORS" \
  --cwd "$PWD" --kind batch --label tests \
  --heartbeat-interval-ms 5000 --tmux-timeout-ms 1000 -- npm test
```

Use `--kind service` for dev servers/watchers. Generic interactive applications
without a reporter remain unknown; do not describe process presence as idle/active.
Arguments after `--` are literal command argv. For shell syntax, use an explicit
shell, for example `-- bash -lc 'npm test && npm run build'`; do not flatten arbitrary
argv into unquoted shell text.

## Pi recipe

```bash
node "$HELPER" pi \
  --socket "$SOCKET" --session agent-name --window review \
  --owner "$OWNER" --ancestors-json "$ANCESTORS" \
  --cwd "$PWD" --mode interactive --label review \
  --heartbeat-interval-ms 5000 --tmux-timeout-ms 1000 -- \
  --no-extensions --provider PROVIDER --model MODEL
```

Keep the user's flags, prompt, model choice and exit intent. Use helper
`--mode batch` for one-shot work. The helper resolves and explicitly loads this
package's reporter even with `--no-extensions`, and injects options before a Pi
`--` delimiter. It does not choose a model or make a model call by itself. Missing
reporter paths are errors. Use `--uninstrumented` only when that loss is explicitly
intended; command lifecycle remains registered where possible.

## Inspect and interpret

```bash
tmux -S "$SOCKET" list-sessions
tmux -S "$SOCKET" attach -t agent-name
# Inside tmux: Prefix + s, or tmux command prompt: choose-tree -Zs
```

The helper returns the created pane/job identity, not the asynchronous command
result. A retained shell/window preserves output and status; interrupts/failures
become command outcomes. If launch confirmation fails, inspect before retrying:
work may already be running. Never automatically duplicate a failed launch.

`_` idle, `R` active/batch, `S` service, `+` command success, `!` failure, `?` unknown,
`:` eligible unregistered pane. Live discovery is initially unknown until a
heartbeat advances. Stale/missing instrumentation reduces certainty. Settled
interactive Pi is idle, not completed task work. Without width-aware compositor
support, only a static count summary is provided; clipping may occur. Use
`/tmux-monitor` for capability/degraded diagnostics.

## Adapt boxed-tmux or another launcher

Keep boxed-tmux's shared socket, per-agent sessions, persistent terminal output,
private task directories and its `result.md` then `done` completion protocol.
Replace its new-window/send-keys command launch with the helper invocation, using
the same socket/session and a fresh window name. Do not kill an existing window
merely to reuse its name. Keep its normal inspection and explicit cleanup steps.
The helper never writes completion sentinels or reads task results; zero exit alone
is not delegated-task correctness.

Another launcher can use the same recipes without either skill. Full custom
protocol adaptation is described in `../../README.md` and `../../src/protocol.mjs`.
Do not modify installed skills or another product unless separately authorized.

Commands execute where the tmux server runs. Shared socket access is not proof
that Node, Bash, Pi or package paths exist there. Explicit cross-container socket
selection grants access to that server's execution environment; obtain the user's
intended scope rather than creating a host escape hatch.
