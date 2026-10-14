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
launch enforcement; observation/reporting never spawns work. Explicit
`/tmux-monitor tmux start` may create an owned, detached shell workspace.

## Obtain current launch context

Use the extension's launch-context addendum or ask the user to run `/tmux-monitor diagnostics`.
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

Use `/tmux-monitor tmux` (`t`, `tmux status`, `tmux s`, `t status`, `t s`) for a
fresh read-only server check. It lists all server sessions and creates no resources.
Use `/tmux-monitor tmux start` (`t start`) only on explicit user intent to ensure
an attachable workspace; `start` has no abbreviation. These commands select the
configured socket or project `.agents/run/tmux-socket`, not inherited/default
servers, and show when observation uses a different socket. Bootstrap needs current
Pi owner/ancestry, preserves existing work and refuses ownership conflicts.
It launches only an unregistered shell, not a Pi or job. Run its verified attach
command manually if desired. No shutdown command or automatic bootstrap is provided.

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

Use `--kind service` for dev servers/watchers. Without an application reporter,
fresh runner liveness yields running for any kind, not idle or active. Pane
presence alone is not liveness evidence.
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
# Inside tmux: use the prefix shown by /tmux-monitor help, then s
```

The helper returns the created pane/job identity, not the asynchronous command
result. A retained shell/window preserves output and status; interrupts/failures
become command outcomes. If launch confirmation fails, inspect before retrying:
work may already be running. Never automatically duplicate a failed launch.

`_` idle, `A` active, `R` running, `+` command success, `!` failure, `?` unknown,
`:` eligible unregistered pane. Kinds describe intent, not activity. Fresh Pi
reporting supplies idle/active/final-error state for any kind; even a batch Pi is
idle after settlement and before command exit. Fresh runner liveness alone means
running. A known command exit takes precedence. Each live source needs heartbeat
advancement before it is trusted. Stale or missing application reporting falls
back to running only with fresh runner evidence; otherwise registered work is
unknown. Loss of previously confirmed reporting appears in diagnostics. Idle is
not task completion, and unregistered panes do not become running from existence.

The monitor appears in the compositor's right-hand group, before higher-order statuses when space permits;
those statuses can reduce or omit it on narrow terminals. Without an active
width-aware capability, only a static count summary under the same right-side key
is provided; clipping may occur. Without the compositor, that summary stays on
Pi's ordinary extension-status line. Use `/tmux-monitor diagnostics` for capability, status-key
and degraded diagnostics.

Use bare `/tmux-monitor` or `status` (`s`) for all cached pane rows. `help` (`h`)
shows the active glyph legend and a verified, manually run attachment command;
`config` (`c`) shows effective settings. Commands do not force a scan or control
existing work. Only explicit `tmux start` creates resources. Help does not guess
between multiple owned sessions.

## Adapt boxed-tmux or another launcher

Keep boxed-tmux's shared socket, per-agent sessions, persistent terminal output,
private task directories and its `result.md` then `done` completion protocol.
Replace its new-window/send-keys command launch with the helper invocation, using
the same socket/session and a fresh window name. Do not kill an existing window
merely to reuse its name. Keep its normal inspection and explicit cleanup steps.
The helper never writes completion sentinels or reads task results; zero exit alone
is not delegated-task correctness.

Another launcher can use the same recipes without either skill. Full custom
protocol adaptation is described in `../../README.md` and `../../src/protocol.mts`.
Do not modify installed skills or another product unless separately authorized.

Commands execute where the tmux server runs. Shared socket access is not proof
that Node, Bash, Pi or package paths exist there. Explicit cross-container socket
selection grants access to that server's execution environment; obtain the user's
intended scope rather than creating a host escape hatch.
