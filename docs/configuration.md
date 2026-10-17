# Configuration reference

The monitor works without a configuration file. Use one when you want to
choose a tmux server, change which tasks appear, or adjust the display.
This page lists the settings and explains how personal and project
configuration combine.

## Files and reload

Personal settings are read from `pi-tmux-monitor.json` in Pi's agent
directory: `PI_CODING_AGENT_DIR` when set, otherwise `~/.pi/agent`.
Project settings are read from `.pi/pi-tmux-monitor.json` under Pi's
current working directory, only when Pi trusts that project.

Neither file is created automatically. Parent repositories are not
searched. Use Pi's `/reload` after edits, then `/tmux-monitor config` to
inspect the resolved settings. Already-running command wrappers keep the
timing values supplied when they were launched; future launches should
receive the updated values from diagnostics.

If only the monitor's JSON file is present, Pi may not prompt for project
trust; grant trust or start Pi with `--approve` before expecting project
overrides to apply.

Settings are combined in this order: built-in defaults, personal settings,
trusted project settings. Objects merge recursively; arrays and scalar
values replace the lower layer. You can therefore change one theme symbol
without copying the whole theme, but a replacement order array must list
all states.

A malformed or unsupported file is rejected as a whole, with a diagnostic;
valid lower layers remain in use. Unknown keys, invalid values and keys
that could modify JavaScript prototypes are rejected. If `activeTheme`
does not name a defined theme, the monitor uses `default` and reports it.

## Settings

Times are positive integer milliseconds, up to 2,147,483,647.
`staleAfterMs` must cover at least three heartbeat intervals.

| Setting | Default | Meaning |
| --- | --- | --- |
| `schemaVersion` | `1` | Required schema version when specified |
| `scope` | `"descendants"` | Which Pi conversations' tasks are included; see below |
| `includeUnregistered` | `true` | Include otherwise eligible panes without a job or Pi report |
| `socketPath` | `null` | Explicit socket path, or automatic observation when null |
| `ownedSessions` | `[]` | Literal tmux session names whose unregistered panes should count as this Pi's work |
| `pollIntervalMs` | `2000` | Interval between inventory polls and cached-state expiry checks |
| `heartbeatIntervalMs` | `5000` | Interval between reports from a running command or Pi |
| `staleAfterMs` | `15000` | How long a source may go without an advancing report before it is no longer trusted; also the old-scan notice threshold |
| `tmuxTimeoutMs` | `1000` | Timeout for each tmux operation, not the entire inventory scan |
| `activeTheme` | `"default"` | Display theme name |
| `summaryOrder` | failed, active, idle, running, success, unknown, unregistered | State order in a complete count summary |
| `partialOrder` | failed, active, unknown, unregistered, running, idle, success | Priority when only part of the count summary fits |
| `themes` | Built-in `default` theme | Named symbol/color definitions |

The [example configuration](../examples/pi-tmux-monitor.json) contains all
settings, the built-in theme, and an optional `gaudy` theme to copy or adapt.
Only `default` is built in. Both order arrays must contain all seven state
names exactly once.

### Scope and ownership

The monitor associates a task with the Pi conversation that launched it.
The task's recorded parents allow a foreground Pi to follow work started
by its children too.

- `children`: tasks owned directly by the current Pi conversation.
- `descendants`: those tasks plus tasks owned by its child conversations,
  however deeply nested.
- `server`: all candidate panes on the selected server, regardless of owner.

The foreground Pi's own pane is excluded in all scopes. Registered task
ownership takes precedence over session ownership, so a shared tmux
session can contain tasks from different Pi conversations.

For an unregistered pane, the monitor needs either recorded session
ownership or an explicit `ownedSessions` entry to include it in an
owner-based scope. Names, local process IDs and process start times are
not ownership evidence. `ownedSessions` is a deliberate monitoring choice:
it does not write ownership records, adopt registered tasks from another
Pi, or add instrumentation. Server scope can show raw panes without
ownership evidence; their presence alone does not establish activity.

A new Pi conversation does not adopt the old conversation's tasks. Server
scope can still show them. Linked tmux windows are deduplicated so a pane
has one indicator, in numeric pane-ID creation order.

### Choosing a socket

For observation, selection is:

1. An explicit `socketPath`, if set.
2. A reachable project `.agents/run/tmux-socket`.
3. The current `TMUX` environment's server.
4. No server, if none of those is available.

Automatic selection keeps checking for the project server and switches to
it if it appears. After selecting a project or explicit server, failures
do not switch observation elsewhere. A relative configured path resolves
from the directory containing the configuration file, not from an
assumed project root.

Project-server commands and the launch context instead use the explicit
configured path, or the project socket by default. Diagnostics distinguishes
that launch destination from a different observation socket. A Pi reporter
always writes to its own actual tmux server, even when observation is
configured to look elsewhere.

### Themes

Each theme defines `overflow` (default `…`), `summarySeparator` (default `|`)
and a `states` object. The separator marks local summary boundaries, not omission. Each state
has a `glyph` and `fg` color. For example, this changes only the active
symbol's color in the built-in theme:

```json
{
  "schemaVersion": 1,
  "themes": {
    "default": {
      "states": {
        "active": { "fg": "warning" }
      }
    }
  }
}
```

New named themes inherit the built-in default mapping before applying
their own settings. Personal/project patches to the same theme merge.
Set `activeTheme` to a name you have defined; merely choosing `gaudy`
without adding its definition does not enable the example theme.

All symbols, including overflow and the summary separator, must be distinct
within the theme. Each
must be one grapheme occupying one terminal column, not a number,
whitespace or a control character. `fg` is a semantic Pi theme color such
as `accent`, `warning`, `success` or `dim`, or `null` for no foreground
styling—not an RGB value or ANSI escape string. See
[`src/config.mts`](../src/config.mts) for the accepted Pi color tokens.

The display uses Pi's current theme colors. Width-aware rendering picks
up theme changes at render time; static fallback text updates on the next
poll.
