# pi-tmux-monitor

Compact tmux workload awareness for Pi. One character per eligible pane, in pane
creation order; counts or an attention-first partial summary when space is tight.
Use tmux's native **Prefix + s** (`choose-tree -Zs`) for inspection and previews.
The monitor does not launch work, control panes or infer agent activity from
terminal output, CPU use or process names. Launching is a separate helper action.

## Install and load

Requires Node 22.19+, tmux and Pi. The validated baseline is **Pi 1.1.0,
tmux 3.5a, Node 26.10.0, Linux**. Other versions/platforms are not established.

```bash
pi install /absolute/path/to/pi-tmux-monitor
```

This package declares its extension and optional companion skill. For a one-run
trial without installing:

```bash
pi --no-extensions -e /absolute/path/to/pi-tmux-monitor/pi-tmux-monitor.ts
```

Load `pi-footer-compositor` separately for width-aware placement in the footer's
right-hand status group. The monitor uses
`footer-compositor:right:0:tmux-monitor`, preferring a position before higher-order
right statuses such as Git (`10`) and usage (`20`). Ordering is not a survival
guarantee: the compositor allocates space to higher-order right producers first,
so they can reduce the monitor to a partial summary or omit it altogether.

The monitor discovers the compositor's shared dynamic v1 capability through
`footer-compositor:dynamic:*` on Pi's public event bus. No compositor import,
private footer patch or terminal-width estimate is used. Either extension start
order works.

Without an active capability, the same right-side key carries a full count
summary. The compositor places that static text in its right-hand group; without
a compositor, Pi shows it on its ordinary extension-status line. Host clipping
can apply. This fallback **is not width-aware**. `/tmux-monitor` reports
`dynamic-v1` when registered, the status key, and any diagnostics.
An unsupported/custom Pi footer can retain fallback placement even when the
capability is present. The compositor is the only footer owner.

Static fallback publication does not wait for discovery. After the initial tmux
scan finishes, the monitor allows one poll interval for a capability to appear
before warning once about its absence. Successful registration cancels a pending
warning, as does shutdown or reload. Persistent capability loss uses the same
grace period and fallback.

## Read the indicator

| State | Default | Meaning |
|---|---|---|
| idle | `_` | Fresh Pi reporter; run settled |
| active | `A` | Fresh Pi reporter says the workload is doing work |
| running | `R` | Fresh runner confirms liveness; internal activity is unknown |
| success | `+` | Command exited zero |
| failed | `!` | Command failed, or Pi settled with a final error |
| unknown | `?` | Registered work without trustworthy live state |
| unregistered | `:` | Eligible pane without a recognized registration |

Workload kinds (`batch`, `service`, `interactive`) describe launch intent, not
activity. Fresh Pi reporting supplies idle, active or final-error state for any
kind. A successfully settled Pi is idle while it remains alive, including a batch
before wrapper exit; it is not proof of task completion. Without trustworthy
application state, fresh runner liveness yields running for any kind. Pane
presence alone proves none of these states. Manual compaction is active while
running.

Recoverable errors/retries do not immediately mean failure. A final Pi error
persists through heartbeats until the next run. If application reporting goes
stale or disappears, discard its state: a fresh runner can still establish
running; otherwise registered work becomes unknown. Loss of previously confirmed
application reporting appears in diagnostics. A known command exit takes
precedence over application state.

Each live source starts unconfirmed until its sequence advances, independently
of other sources. Without other trustworthy evidence, display **unknown**. With
defaults, confirmation can take one 5-second heartbeat plus a 2-second scan.
Sources become stale after 15 seconds without advancement. Command outcomes do
not expire while the pane remains and no reuse is known. On disconnection, eligible
cached slots remain: live states are unknown, known outcomes remain, and
`/tmux-monitor` reports degraded observation. Cached slots do not prove that panes
still exist. A replacement server starts a new inventory namespace.

## Launch ordinary commands directly

No boxed-tmux skill is required. The stable entry is the package-relative
`scripts/pi-tmux-monitor.mjs`; an npm bin of the same name is optional convenience.
Use `/tmux-monitor` in the launching Pi to obtain its current **session ID**,
ancestry, helper path, socket and runner timing values. A session ID is not a PID,
hostname or tmux session name.

```bash
HELPER=/absolute/path/to/pi-tmux-monitor/scripts/pi-tmux-monitor.mjs
SOCKET="$PWD/.agents/run/tmux-socket"
mkdir -p "$(dirname "$SOCKET")"

# Replace OWNER and ANCESTORS with the current diagnostic/launch-context values.
OWNER='CURRENT_PI_SESSION_ID'
ANCESTORS='[]'
node "$HELPER" launch \
  --socket "$SOCKET" --session agent-work --window tests \
  --owner "$OWNER" --ancestors-json "$ANCESTORS" \
  --kind batch --label tests --cwd "$PWD" \
  --heartbeat-interval-ms 5000 --tmux-timeout-ms 1000 -- npm test
```

`launch` supports `batch`, `service` and `interactive` commands. Without an
application reporter, fresh runner evidence yields running, not idle or active.
A new session gets ownership context; an existing shared session is never stamped or reassigned.
The helper creates a new window, never kills an existing one, and keeps an
inspectable Bash shell after the command exits. Window and session names use
letters, digits, `.`, `_`, `-` (up to 128 characters). Labels are explicit, optional,
at most 128 characters and cannot contain controls.

Launch returns JSON with `paneId`, `jobId` and `socket` after registration is
confirmed. Its exit status describes **launching**, not the asynchronous command's
result. The runner records the command's exit status (interrupts use `128 + signal`
number); the retained shell exports `PI_TMUX_MONITOR_EXIT_CODE`. Inspect with:

```bash
tmux -S "$SOCKET" list-sessions
tmux -S "$SOCKET" attach -t agent-work
# Inside tmux: Prefix + s (default Prefix is Ctrl+b)
```

Bootstrap/registration failures are visible. A failed confirmation can mean a
pane was created and work is running: inspect it before retrying. The helper
never automatically retries creation. Monitoring failure does not kill work.

## Launch Pi

```bash
node "$HELPER" pi \
  --socket "$SOCKET" --session agent-work --window review \
  --owner "$OWNER" --ancestors-json "$ANCESTORS" \
  --mode interactive --label review \
  --heartbeat-interval-ms 5000 --tmux-timeout-ms 1000 -- \
  --no-extensions --provider PROVIDER --model MODEL
```

Use helper `--mode batch` for one-shot Pi; it adds `--print`. The helper injects
`-e /absolute/package/path/pi-tmux-monitor.ts` before any existing Pi `--`
delimiter. Explicit loading still works with `--no-extensions`. Other Pi flags,
model/provider choices, prompts and argv stay intact. The observer renders only
in TUI mode; the reporter also operates in print, JSON and RPC modes.

Missing reporter paths are errors, not silent fallback. If intentionally launching
without Pi instrumentation, add helper `--uninstrumented` before the helper's
`--`. Command lifecycle registration still applies, but interactive internal state
is unavailable. This does not disable other extensions selected by your Pi flags.

### Context and server environment

Owner precedence: explicit `--owner`, current shell-tool `PI_SESSION_ID`, then
extension `PI_TMUX_MONITOR_OWNER`. Missing owner is an error. Direct/manual or
custom-shell launches should pass **explicit** owner and ancestry: tmux's server
environment or custom shell tools can retain stale Pi variables.

`--ancestors-json` is the launching owner's root-to-parent array, **excluding the
owner itself**. The helper appends that owner once. A child Pi's launch-context
ancestry includes its parents; pass it unchanged when it launches grandchildren.
Cycles, duplicates and contradictory chains are rejected. Lineage is bounded to
64 IDs (including the appended owner) and 12 KiB of JSON. The extension supplies
a bounded launch-context addendum before each run, without requesting another
model turn or inspecting the user prompt. Environment exports are convenient,
not assumed reliable for every shell tool.

Absent explicit directory/timing values, the helper uses the calling directory,
5,000 ms heartbeat and 1,000 ms tmux timeout. It does **not** read monitor JSON or
bypass project trust. Pass the foreground extension's effective timings explicitly
to propagate configuration overrides.

Tmux launches in the **server host's environment**, not necessarily the requesting
container's. Node (at the requesting helper's resolved executable path), Bash,
package/runner/reporter files and Pi must be accessible there. Commands inherit
the new pane's actual `TMUX`/`TMUX_PANE`, not stale client values. The runner passes
explicit job/lineage context; a reporter accepts it only against a matching pane
registration. Server replacement stops old reporters/wrappers from writing into a
reused pane namespace.

A socket grants access to the server's execution environment. An explicit socket
may cross a container boundary. Shared socket access does not establish matching
filesystems or process namespaces. The observer creates no server or host escape
hatch, and does not use local process checks as server-side liveness evidence.

## Scope and configuration

Optional files, read on session start/reload:

- Global: `getAgentDir()/pi-tmux-monitor.json` (Pi's public resolver; follows
  `PI_CODING_AGENT_DIR`, otherwise `~/.pi/agent`).
- Project: `ctx.cwd/.pi/pi-tmux-monitor.json`, **only if Pi trusts that project**.
  No parent-repository search; no files created automatically. A custom monitor
  JSON alone does not trigger Pi's trust prompt: use `/trust` or explicit approval.

Precedence is defaults < global < trusted project. Objects merge recursively;
arrays/scalars replace. Each invalid file layer is rejected as a whole, preserving
lower valid layers and producing a bounded diagnostic. Unknown active themes
fall back to default. Prototype-mutating keys are rejected.

Socket choice: explicit `socketPath`; reachable project `.agents/run/tmux-socket`;
current `$TMUX`; otherwise none. Automatic discovery retries, and a newly available
project server supersedes inherited tmux. Once project/explicit selection is made,
connection failures do not switch servers. Relative configured paths resolve
against the file defining them. A reporter always uses its own actual tmux server,
even if observation selects another one.

| Setting | Default |
|---|---|
| `schemaVersion` | `1` |
| `scope` | `descendants` |
| `includeUnregistered` | `true` |
| `socketPath` | `null` (automatic) |
| `ownedSessions` | `[]` (literal names assigned to current owner) |
| `pollIntervalMs` | `2000` |
| `heartbeatIntervalMs` | `5000` |
| `staleAfterMs` | `15000` |
| `tmuxTimeoutMs` | `1000` |
| `activeTheme` | `default` |

Intervals are positive integers; stale threshold must cover at least three
heartbeats. `children` selects direct ownership; `descendants` selects direct or
immutable ancestor ownership; `server` selects all candidate panes on that server.
The observer's own pane is excluded. A replacement Pi conversation does not adopt
old workloads; server scope can still show them.

Unregistered panes need independent ownership evidence: dedicated-session context,
`ownedSessions`, or the exact legacy boxed-tmux name derived from this Pi's Linux
PID/start time. An arbitrary `agent-` prefix is not evidence. Spare shells in an
eligible session can legitimately appear as `:`. Registered pane ownership is
authoritative in shared sessions. Linked-window aliases have one slot; numeric
pane IDs determine creation order, not window order or recent activity.

### Named themes

The complete optional example, including **default and gaudy**, is in
[`examples/pi-tmux-monitor.json`](examples/pi-tmux-monitor.json). Only default is
built in; gaudy is a configuration example. Load that example as your optional
file and select `"activeTheme": "gaudy"`, or define your own named theme.

A trusted project can patch a global theme without copying it:

```json
{
  "schemaVersion": 1,
  "activeTheme": "gaudy",
  "themes": { "gaudy": { "states": { "active": { "fg": "warning" } } } }
}
```

Custom themes inherit the hardcoded default state mapping, then their merged
patches. Default itself can be patched. Glyphs, including overflow, must be distinct
single graphemes of one column, nonnumeric, nonwhitespace and free of controls.
Foregrounds are Pi semantic foreground tokens or `null`, not arbitrary RGB/style
syntax. Styles use Pi's current theme; dynamic formatting updates at render time,
static fallback on the next poll.

## Architecture and adaptation

Extension-loaded source modules use `.mts` so Pi's TypeScript loader refreshes the
whole module graph on `/reload`, including edited dependencies. Shared helper
modules retain plain JavaScript syntax. The standalone Node helper uses a scoped
load hook for this package's `.mts` files, so it needs no compiler or build step
and also works when the package is installed beneath `node_modules`.

- `src/tmux.mts` handles bounded tmux operations and local-option discovery.
- `src/protocol.mts` validates bounded versioned JSON metadata.
- `src/observer.mts` selects one server, caches inventory and manages scans.
- `src/reconcile.mts` applies ownership, generation and freshness policy.
- `src/reporter.mts` observes this Pi's lifecycle; `src/runner.mjs` tracks a command.
- `src/formatter.mts` is pure presentation; `src/footer.mts` adapts the compositor.
- `pi-tmux-monitor.ts` wires public Pi lifecycle events and diagnostics.

Only runners write `@pi-tmux-monitor-job`; only this Pi reporter writes
`@pi-tmux-monitor-pi`. Both are pane-local atomic JSON, maximum 16 KiB. Session
ownership is explicitly session-local `@pi-tmux-monitor-owner`. Inherited options
are never accepted as pane registrations. Records contain IDs, lineage, kind,
state/phase, sequence and exit status, not prompts, argv, terminal output,
credentials or task results. Socket users can forge them: this is evidence, not
an authentication or correctness guarantee. Like ordinary process launches,
command argv is passed to the server and can be visible to socket/process users;
only the monitor status records omit it.

### Replace the formatter

`format(orderedSlots, resolvedConfig, currentPiTheme, allocatedColumns)` returns
`{ text, mode: 'strip' | 'summary' | 'partial' | 'hidden' }`. Slots expose `state`;
other inventory fields are ignored. Config supplies effective theme, `summaryOrder`
and `partialOrder` (each lists all seven states exactly once).

The strip exactly fitting its budget is retained. Otherwise count the **whole**
set, omit zeros and omit `1` for singleton counts, combining singleton runs:
`A3 _5 R+?`. If that cannot fit, retain the longest attention-first prefix of
complete count tokens with one reserved omission column, e.g. `!2 A20…`. Stop at
the first token that cannot fit; never split a number or skip to lower-priority
categories. At one column the partial display is `…`; empty/zero-budget is hidden.
All-idle sets and retained outcomes are not hidden just for being quiet.

Output visible width must not exceed the allocated budget, measured with Pi TUI's
`visibleWidth`, excluding ANSI SGR bytes. The renderer must be synchronous,
single-line, side-effect-free and perform no I/O. Replace this function/modes
without changing observation or state meanings. Preserve `fullSummary()` for the
unbounded static fallback. Styling must use the theme argument, never cached ANSI.

### Other launch solutions and boxed-tmux

Another tmux launcher can simply invoke this helper with its socket, session,
window, current owner/ancestry and timings. It does not need either skill. For a
custom wrapper, adopt the pane-local protocol and explicit job context from the
source modules, allocate a new job ID for each launch, increment sequence on
heartbeat/state change, and retain terminal outcomes. Do not recursively evaluate
JSON as tmux formats or overwrite newer generations during cleanup.

The companion [`skills/pi-tmux-monitor/SKILL.md`](skills/pi-tmux-monitor/SKILL.md)
gives helper-relative recipes. For boxed-tmux, keep its shared project socket,
agent sessions, persistent output and result/done protocol, replacing only command
launches with helper recipes. **Installed boxed-tmux copies are not modified by
this package.** Exit zero is command success, not delegated-task correctness. If
a task uses `result.md` followed by `done`, that protocol remains authoritative;
the monitor neither reads nor creates those files.

## Limits and development

Arbitrary shell/builtin reuse is not fully observable without cooperation. Managed
launches clear prior-generation metadata; confirmed new self-reporting Pi and
observable pane-process replacement invalidate old outcomes. Do not treat a
retained result as proof that every later uninstrumented shell action was tracked.
Very short live records may disappear before heartbeat confirmation. A running
indicator is not a health check. Observer failures never stop workloads.

No automatic model calls, conversation inspection, credentials collection or
usage telemetry are implemented. Validation uses synthetic Pi events, isolated
tmux sockets and Pi startup/help only, not provider calls or delegated-task results.
Actual-compositor tests use its implementation and Pi's real FooterComponent;
synthetic capability tests separately exercise failure/replacement cases.
Regular/default and fullscreen/gaudy right-side TUI placement with mixed
static/dynamic producers, theme changes, resizing, reload and shutdown have also
been checked on the baseline.

From a source checkout:

```bash
npm test
npm pack --dry-run
```

Tests use host-provided Pi packages rather than duplicate runtime copies. Set
`PI_MONITOR_HOST_ROOT` to the installed coding-agent package directory if it is not
`/usr/local/lib/node_modules/@earendil-works/pi-coding-agent`. Set
`PI_MONITOR_COMPOSITOR` to its actual `.ts` entry to run the real integration check;
that check is explicitly skipped when the source is unavailable. Runtime peers
remain supplied by Pi. To type-check without installing duplicate runtime peers:

```bash
npm ci --legacy-peer-deps
HOST=/absolute/path/to/installed/pi-coding-agent
mkdir -p node_modules/@earendil-works
ln -s "$HOST" node_modules/@earendil-works/pi-coding-agent
ln -s "$HOST/node_modules/@earendil-works/pi-tui" node_modules/@earendil-works/pi-tui
npm run check
```

Adjust the TUI link to your host's actual package location if its dependencies
are arranged differently. Broader compatibility and live provider-backed runs have
not been validated.
