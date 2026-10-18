# Development and architecture

This guide is for working on the extension or adapting its display and
launch integrations. For everyday use, start with the [README](../README.md).
For the command-line interface, see [starting monitored tasks](launching.md).

## Source layout

There are three cooperating parts:

- The **observer** reads tmux's pane inventory and status records. It
  decides which panes to show, keeps cached state and updates the footer.
  Observation never starts or controls work.
- The **reporter** runs inside a Pi session and records its activity.
- The **runner** wraps a command started by the launch script, recording
  running reports and its eventual exit status.

The main files are:

| File | Responsibility |
| --- | --- |
| `pi-tmux-monitor.ts` | Pi lifecycle events, commands and launch-context publication |
| `src/tmux.mts` | Bounded tmux calls, local-option reads and guarded writes |
| `src/diagnostics.mts` | Bounded diagnostic storage and fixed runner diagnostic codes |
| `src/protocol.mts` | Validation of versioned status records and lineage |
| `src/observer.mts` | Server selection, inventory, scan age and cached expiry |
| `src/reconcile.mts` | Ownership, freshness and generation-bound presentation/delay history |
| `src/cycles.mts` | Foreground user-request origin and final-return accounting |
| `src/reporter.mts` | This Pi's activity reports |
| `src/runner.mjs` | Command liveness and exit reports |
| `src/helper.mts`, `src/launch.mts` | Public script dispatch/results and workload launch |
| `src/server.mts` | Shared server inspection and owned-session creation |
| `src/formatter.mts`, `src/footer.mts` | Pure indicator formatting and footer integration |
| `src/commands.mts`, `src/tables.mts` | Command views and literal, width-aware tables |
| `src/workspaces.mts` | Display-only default-workspace references and mappings |
| `src/shell.mts`, `src/inspection.mts` | Shell quoting and verified manual attachment hints |
| `src/version.mts` | This installation's version and optional Git identity |

The extension's local imports use `.mts` so Pi's TypeScript loader refreshes
the whole graph on `/reload`. Modules shared with the standalone launch
script retain plain JavaScript syntax. The script registers a load hook
only for this package's `.mts` files, allowing Node to load them without a
compiler or build step, including beneath `node_modules`.

## Status records and state selection

Only command runners write pane-local `@pi-tmux-monitor-job`; only the Pi
reporter writes pane-local `@pi-tmux-monitor-pi`. Each is atomic versioned
JSON, limited to 16 KiB. Session ownership is recorded in session-local
`@pi-tmux-monitor-owner`. Inherited options are not accepted as local
registrations. Read the validators in `src/protocol.mts` for the exact
record formats.

Records contain IDs, ancestry, task kind, phase/state, sequence and exit
status—not prompts, arguments, terminal output, credentials or task results.
Command records may also carry a `diagnostics` array containing unique codes
from `RUNNER_DIAGNOSTICS`, never arbitrary error text. The observer translates
these fixed codes for on-demand diagnostics.
Socket users can forge them; they provide cooperative status evidence,
not authentication or result validation. Launch arguments still pass to
tmux and may be visible through ordinary process/socket access.

Fresh Pi reporting supplies idle, active or final-error state for all
three task kinds. Fresh runner liveness alone supplies running, not idle
or active. A known command exit takes precedence over application state.
Recoverable Pi errors/retries do not immediately mean failure; final error
state persists until the next run. A Pi that has settled successfully is
idle while alive, including batch mode before its wrapper exits.

Each source starts unconfirmed until its sequence advances. Record receive
times, not scan completion time, determine freshness. Reset or stale sources
must not inherit an old source's confirmation. If Pi reporting disappears,
a fresh runner may still establish running; otherwise registered work is
unknown. Losing previously confirmed Pi reporting produces a bounded diagnostic,
not a notification or a claim that the task itself failed.

Snapshots separate current evidence `state` from `presentationState` and
`uncertain`. Generation-bound presentation history lives in the reconciler,
not the formatter. Retain confirmed application state across runner fallback;
only fresh application reporting confirms it again. Generic runner liveness can
confirm running without expecting a Pi reporter. Known exits remain confirmed.
Reset history on workload/pane replacement, removed registration and namespace
changes. Uncertain glyphs and whole count tokens use the current theme's `dim`
foreground. Status glyphs match the footer, while State and diagnostics describe
reconciled evidence.

The observer uses its existing poll timer to expire cached evidence even
while an inventory scan is pending. Expiry does not reread tmux, overlap
scans, renew heartbeat timestamps or add another timer. Changed states
update both width-aware and static footer output.

Scan age has a separate monotonic clock. Successful completed scans,
including empty or unchanged inventories, renew it; failures, pending
scans, cache reads and rendering do not. Status reevaluates cached expiry
without starting or waiting for a scan, and shows an age notice when
`staleAfterMs` is reached. The displayed age is a snapshot, not a live clock.
Retiring a runtime or discarding its server inventory clears the relevant
state and prevents late results from modifying a replacement runtime.

On disconnection, cached eligible panes remain, with live states unknown
and known exits retained. This cache does not prove the panes still exist.
A confirmed replacement server discards the old inventory. Managed reuse
clears old reports; a fresh unrelated Pi reporter or detectable pane-process
replacement invalidates an older outcome. Arbitrary uninstrumented shell
or builtin reuse is not fully observable.

## Footer integration

The actual `pi-footer-compositor` implementation defines the producer API
and layout rules. The monitor discovers its shared dynamic v1 capability
through Pi's `footer-compositor:dynamic:*` event bus. It imports no
compositor module, patches no footer and estimates no budget from terminal
width. Either extension start order is supported.

The status key is `footer-compositor:right:0:tmux-monitor`, before typical
Git (`10`) and usage (`20`) right-side producers. The compositor allocates
space to higher-order right producers first, so ordering is not a guarantee
that the monitor survives. It may receive a smaller budget or none.

Without a usable capability, the same key carries the full count summary.
The compositor can place that static status on the right; without it,
Pi uses its normal extension-status line. Static output is not width-aware
and can be clipped. A custom footer may leave fallback placement even if
the dynamic capability exists. The compositor remains the only footer owner.

Fallback publication is immediate. After initial observation finishes,
the monitor allows one poll interval for capability discovery before one
absence diagnostic. Registration, reload and shutdown cancel pending checks;
persistent capability loss uses the same grace period. Diagnostics reports
`dynamic-v1`, the status key and any problems.

### Replacing the formatter

`format(orderedSlots, resolvedConfig, currentPiTheme, allocatedColumns)`
returns `{ text, mode: 'strip' | 'hybrid' | 'summary' | 'partial' | 'hidden' }`.
Observer snapshots supply `state` (current evidence), `presentationState`
(last-known presentation), `uncertain` and `compressionEligible` (booleans).
For direct formatter inputs, an omitted presentation state uses `state`; omitted
uncertainty defaults to true for an unknown presentation. An omitted compression
flag means eligible; callers with pending outcomes must supply `false`.
Other inventory fields are ignored.

Build the hybrid candidate in creation order: collapse maximal consecutive runs
of at least six compression-eligible success/failed presentation slots into local
summaries. Pending outcomes remain individual and separate runs. Keep all
other slots as individual glyphs. Use the theme's `summarySeparator` between
summaries and adjacent strips, never at the outer edges: `ARR|!2+4|R`. Do this
even when a full per-pane strip would fit. Return `hybrid` if a run qualifies,
otherwise `strip`.

If the candidate exceeds the budget, count the entire set in `summaryOrder`.
Use dense tokens everywhere: `A3_5R+?`, omitting zero counts and singleton numerals.
If the whole summary does not fit, keep the longest prefix of complete tokens in
`partialOrder`, reserving one column for overflow: `!2A20…`. Stop at the first
token that does not fit; never split numbers or skip a higher-priority state.
One column shows only `…`; zero budget or an empty set is hidden. Quiet idle sets
and retained outcomes are not hidden just for being quiet.

Local counts refer only to their grouped slots; whole/partial summaries count
the full set. A token is dim if any member is uncertain. Reporting loss/recovery
alone changes styling, not grouping, token text or width. Actual state/generation
changes and compression-delay expiry may regroup normally.

Measure with Pi TUI's `visibleWidth`, excluding ANSI SGR sequences. Rendering
must be synchronous, single-line, free of I/O and side effects, and no wider
than the allocated budget. Use the passed theme rather than cached ANSI.
Preserve `fullSummary()` for static fallback if replacing the formatter.

### Compression eligibility

The reconciler stores a deadline only for pending outcomes in its existing
pane/generation records. It compares that deadline with one completed-user-cycle
counter. A transient cycle identity excludes the request underway at observation
only if that request actually reaches settlement. Repeated reports and uncertainty
retain the deadline; a confirmed state/generation change replaces it. Initial
inventory outcomes are a baseline, not fresh transitions.

Lifecycle hooks use input origin, message role and final settlement, never prompt
or message content. Prepared inputs must deliver an actual user message in an
agent run before their return can count. This excludes handled/failed preflight
inputs, custom/background turns, queued messages and intermediate loop restarts.
At a counted return, the observer reevaluates cached eligibility and republishes
changed snapshots without inventory I/O or freshness renewal. Counters and
pending history are observer-local, not tmux metadata or conversation entries.

## Diagnostic delivery

Background diagnostics are recorded without UI notices, console/stderr output or
conversation entries. The process keeps up to 16 distinct messages of at most
320 characters each, including cleanup problems across extension reloads. The
explicit diagnostics command exposes them. Recording a problem does not change
footer state, cache retention or workload results.

Runner diagnostics travel with its existing job record. Failed writes remain
pending for a later successful write; a lost or replaced server can prevent
transport, just as it can prevent state reporting. There is no filesystem or
notification fallback. Requested command/helper responses, startup failure
acknowledgements and error output still return normally. Child workload stdout,
stderr and exit codes pass through unchanged.

## Commands and integration points

Slash commands accept complete lowercase words, whitespace around/between
them and the aliases listed in the README. `s` means status at either level;
`start` has no abbreviation. `up`, shutdown commands and extra arguments
are rejected. Status uses cached rows with Glyph first, followed by Pane,
Location, Label, Kind and evidence State. It keeps one row per pane; definitions
live in help. Tables stack fields when their headers cannot fit legibly. Glyph
cells preserve trusted theme styling while metadata remains literal. Server
commands make fresh checks.

Generated default workspace names use invocation-local unique hash prefixes,
starting at seven characters, with full-name mappings below the table. The
recognizer accepts `pi-workspace-` followed by a 64-character lowercase hexadecimal
hash; other session names remain literal. Linked-session references are resolved
together, and repeated workspaces have only one mapping.
These references never rename sessions, establish ownership or become targets.
Only full `tmux start` creates resources. No command forces an inventory
scan, modifies settings, requests a model turn or inserts its notice into
the conversation.

Tables use the invocation width and current theme, with literal cells and
labelled fields at narrow widths. Rerun after resizing. Status/help identify
the installed package version and, when available, its own seven-character
Git HEAD. They never borrow a parent/caller repository identity. Missing
Git metadata omits the hash; invalid version metadata uses an unversioned
label.

Help verifies a foreground tmux session first, otherwise one associated
owned session in cached observation. It does not guess on ambiguity. Its
read-only prefix lookup uses the session's effective `prefix` and `prefix2`,
falling back to generic guidance if lookup fails. Help repeats the readable
prefix(es) in separate session-tree (`s`) and detach (`d`) bullets. Disabled
prefixes are omitted; if both are disabled, help explains that these shortcuts
are unavailable. Attachment uses an exact session ID without repeating the long
workspace name. It never attaches.

For integrations that launch work, call the
[documented script](launching.md) with current Pi settings. Its response
identifies the created terminal. Revalidate that server and target before
native tmux input or cleanup; the observer does neither. Keep session
selection, ownership writes, runner heartbeats and reporter loading in the
script rather than copying those implementations into each caller.

## Testing from a checkout

Use the locked Pi 1.1.0 test host to reproduce the SDK dependencies used
in CI without changing your installed Pi:

```bash
npm ci --prefix test/host --ignore-scripts --no-audit --no-fund
npm ci --legacy-peer-deps --ignore-scripts
export PI_MONITOR_HOST_ROOT="$PWD/test/host/node_modules/@earendil-works/pi-coding-agent"
export PATH="$PWD/test/host/node_modules/.bin:$PATH"
node test/setup-peers.mjs
```

The setup script links development types to that host and resolves its TUI
package, including hoisted installs. It refuses to overwrite a different
existing peer link. You can instead set `PI_MONITOR_HOST_ROOT` to another
installed coding-agent package; tests otherwise use the conventional
`/usr/local/lib/node_modules/@earendil-works/pi-coding-agent` host.

Point the real-compositor tests at its actual entry file, then run:

```bash
export PI_MONITOR_COMPOSITOR=/absolute/path/to/pi-footer-compositor/pi-footer-compositor.ts
PI_MONITOR_REQUIRE_COMPOSITOR=1 npm run check
npm pack --dry-run
```

Without the requirement flag, local compositor tests skip only when the
entry is absent. Tests use synthetic Pi events, disposable tmux sockets,
isolated agent directories and offline Pi startup; provider credentials
and model requests are not required. TUI/RPC tests exercise actual startup,
reload, rendering and shutdown, not live provider-backed task quality.

[GitHub Actions](../.github/workflows/ci.yml) tests Linux on Node 22.19.0 and
26.10.0, with tmux, the locked host and a pinned real compositor. A missing
compositor is an error in CI. Broader OS/Pi/tmux compatibility is not implied
by these checks.

Version lookup and themed command notices adapt pi-oaistt code. See
[third-party notices](../THIRD_PARTY_NOTICES.md) for attribution and license.
