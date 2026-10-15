# Starting monitored tasks

The footer can show useful activity only when it has a report to read.
`scripts/pi-tmux-monitor.mjs` starts a program in tmux, associates it with
the Pi conversation that requested it, and reports whether it is running
or has exited. When the program is another Pi, it also loads the extension
so that Pi can report active and idle states.

This guide is for running the script yourself or calling it from your own
tools. If you want Pi to do the launching, the package's
[skill](../skills/pi-tmux-monitor/SKILL.md) contains those instructions.
You do not need another launcher package or the skill loaded to use the
script directly.

## Find the script and current settings

In the Pi conversation that should own the new task, run:

```text
/tmux-monitor diagnostics
```

Copy these fields from its JSON output:

| Field | Why you need it |
| --- | --- |
| `helper` | Full filename of this installation's `scripts/pi-tmux-monitor.mjs` |
| `socket` | Absolute socket path to use for launching |
| `owner` | ID of the current Pi conversation, so its tasks can be identified |
| `ancestors` | JSON array of that conversation's parents, for nested Pi tasks |
| `heartbeatIntervalMs` | How often running tasks should report |
| `tmuxTimeoutMs` | Timeout for each tmux operation |

`owner` is a Pi conversation ID, not a process ID or tmux session name.
Copy `ancestors` unchanged, even when it is not empty. The reported
`socket` is the intended launch path; it does not mean a server exists yet.
A different `observerSocket`, when shown, is where the monitor is currently
looking, not the default destination for new launches.

Run the shell examples from the same project directory as Pi. Set these
variables to your copied values; the paths and ID below are placeholders:

```bash
MONITOR_SCRIPT='/actual/package/path/scripts/pi-tmux-monitor.mjs'
SOCKET='/absolute/project/.agents/run/tmux-socket'
OWNER='current-pi-conversation-id'
ANCESTORS='[]'  # Use [] only if diagnostics actually reports an empty array.
HEARTBEAT_MS=5000
TMUX_TIMEOUT_MS=1000
```

`MONITOR_SCRIPT` contains the entire `helper` value, including the filename.
It may point to a personal/global install or a project-local package. Do
not assume a particular install directory or an executable on `PATH`.
Use the reported timing values rather than these example defaults when
you have configured different ones.

Shell variables do not necessarily survive between agent tool calls. A
tool integration should retain the values and supply them explicitly in
each invocation. Use current diagnostics or the launch context supplied
by Pi, not values left over from an earlier Pi conversation.

## Start an ordinary command

For a small, model-free example:

```bash
node "$MONITOR_SCRIPT" launch \
  --socket "$SOCKET" --cwd "$PWD" --window check \
  --owner "$OWNER" --ancestors-json "$ANCESTORS" \
  --kind batch --label check \
  --heartbeat-interval-ms "$HEARTBEAT_MS" --tmux-timeout-ms "$TMUX_TIMEOUT_MS" -- \
  sleep 10
```

The script creates a new tmux window and starts `sleep 10` in it. It creates
the server and a session for your Pi conversation if needed. There is no
preliminary setup command or extra unused shell window. Later launches
reuse that session, adding a new window rather than replacing existing work.

The command returns after startup is confirmed, not after `sleep` finishes.
The footer can show `R` once running reports are confirmed, then `+` after
successful exit. A Bash shell stays open in the pane so you can inspect
output. It exports `PI_TMUX_MONITOR_EXIT_CODE` with the command's exit code;
interrupts use `128 + signal number`.

Choose `--kind service` for a server or watcher, and `--kind interactive`
for an ordinary interactive program. These describe your intent, not the
program's activity. Without application-specific reporting, all three
kinds show running rather than active or idle while alive.

Arguments after `--` belong to the program. Pass each as a separate,
properly quoted argument. If you need shell operators, invoke a shell
explicitly, for example `-- bash -lc 'npm test && npm run build'`.

### Choose a session explicitly

Add `--session NAME` when you deliberately want a dedicated or shared
session. If that session already exists, the script leaves its ownership
unchanged; only the new task is associated with the requesting Pi.
Otherwise a new session receives that association. Without this option,
the script selects the same session as `/tmux-monitor tmux start`.
You do not need to calculate its name.

Session and window names accept letters, digits, `.`, `_` and `-`, up to
128 characters. An optional label accepts up to 128 characters without
control characters. A repeated window name does not replace the old window.

## Start another Pi

Use `pi` instead of `launch` so the new Pi can report its own activity:

```bash
node "$MONITOR_SCRIPT" pi \
  --socket "$SOCKET" --cwd "$PWD" --window review \
  --owner "$OWNER" --ancestors-json "$ANCESTORS" \
  --mode interactive --label review \
  --heartbeat-interval-ms "$HEARTBEAT_MS" --tmux-timeout-ms "$TMUX_TIMEOUT_MS" -- \
  --no-extensions --provider YOUR_PROVIDER --model YOUR_MODEL
```

Replace the provider and model with your intended Pi settings, or omit
those flags to use Pi's normal selection. Choose `--mode batch` for a
one-shot Pi; it adds `--print`. Prompts and other Pi flags are preserved.
Starting Pi with a task may make model requests in the usual way; the
monitor does not authorize or supply the task for you.

The script adds `-e` with this installation's extension filename, even
with `--no-extensions`. It inserts that option before any Pi `--` delimiter
so it is not mistaken for prompt text. The reporter works in print, JSON
and RPC modes too; only the interactive terminal UI shows the footer.

A missing reporter is an error. If you deliberately want to omit Pi's
activity reporting, pass `--uninstrumented` before the script's `--`.
The command still reports running and exit status where possible. This
option does not disable other extensions chosen by your Pi flags and is
never selected automatically after an error.

## Inspect a server or open a shell

You can use the same script without launching a task:

```bash
node "$MONITOR_SCRIPT" inspect --socket "$SOCKET" --cwd "$PWD" \
  --tmux-timeout-ms "$TMUX_TIMEOUT_MS"
```

`inspect` checks the selected server now. It needs no Pi owner and creates
nothing, including directories. It distinguishes a reachable server,
confirmed absence, and failure to inspect.

To start or reuse an ordinary detached shell session for the current Pi:

```bash
node "$MONITOR_SCRIPT" start --socket "$SOCKET" --cwd "$PWD" \
  --owner "$OWNER" --ancestors-json "$ANCESTORS" \
  --tmux-timeout-ms "$TMUX_TIMEOUT_MS"
```

This is the script equivalent of `/tmux-monitor tmux start`. It starts
`/bin/sh`, not another Pi or a dummy monitored command. Reuse requires
matching Pi ownership and ancestry; a conflicting session is left alone.
It returns an attachment command for you to run manually. It does not
attach a client or change existing panes.

## Understand the response

The script prints one JSON object on stdout so a person or calling program
can find the terminal it created. `--help` prints ordinary help text
instead. The script's internal `run` entry is not a public operation.

For `launch`, `pi` and `start`, `state: "ready"` means startup was verified.
For `inspect`, `reachable` means a server was verified and `absent` means
no server is running there. `unavailable` means the operation could not be
completed or verified; read `reason` for the explanation.

The process exits with status 1 for `unavailable`, otherwise 0, including
a confirmed absent server. **For launches, this is not the task's eventual
exit status.** A successful start is also not a service health check or
proof that a task's output is correct.

### Response fields

| Field | Meaning |
| --- | --- |
| `operation` | `inspect`, `start`, `launch` or `pi` |
| `state` | `reachable`, `absent`, `ready` or `unavailable`, as described above |
| `socket` | Selected absolute socket path; `null` if invalid input prevented resolution. A path alone proves no server exists. |
| `serverIdentity` | Verified server identity, or `null`; use it to detect replacement of a server |
| `session` | Verified session `{id, name}`, or `null` |
| `sessions` | Session IDs and names returned by server inspection, when applicable |
| `windowId`, `paneId`, `panePid` | Verified window, pane and pane process IDs, or `null` where not applicable |
| `jobId` | ID allocated for a managed command, or `null`; not proof of completion |
| `changes` | `server`: `became reachable`/`reused`; `session` and `window`: `created`/`reused`; each may be `null` when unknown or inapplicable |
| `partial` | Creation was attempted and resources or running work may remain |
| `reason` | Bounded explanation of a failure, when present |
| `observed` | Known but unverified IDs after failure; these are not confirmed targets for input or cleanup |
| `attach` | Verified manual attachment command returned by shell startup |

`serverIdentity` is a string of the form
`canonicalSocket:device:inode:serverPid:serverStartTime`. Numeric components
are decimal; the last two are tmux's `pid` and `start_time` formats. Compare
the whole string; the socket path itself may contain colons. Resource IDs
are meaningful only within this server identity, not across server restarts.

### Find the output without acting on the wrong pane

Keep the returned socket, server identity, session, window, pane and pane
process IDs. Before later input, interrupts or cleanup, inspect the server
again and compare its identity. Also check the pane's current coordinates
and process ID, for example after copying `paneId` into `PANE_ID`:

```bash
tmux -S "$SOCKET" display-message -p -t "$PANE_ID" \
  '#{session_id}|#{window_id}|#{pane_id}|#{pane_pid}'
```

Compare all four values with the saved result. Stop if the server or target
changed. Pane IDs alone are not sufficient after server replacement.
Once checked, capture the pane's retained output:

```bash
tmux -S "$SOCKET" capture-pane -t "$PANE_ID" -p -S -120
```

Native tmux input and deliberate cleanup remain available. They are not
performed by the monitor's read-only observation code.

### When startup fails

A timeout or missing confirmation can leave a window and running work
behind. Inspect before retrying; repeating the launch may duplicate the
task. The script does not promise rollback, retry automatically, switch
servers, install runtimes or attach a client.

Temporary startup acknowledgements are private files under the project's
`.agents/run` directory. They contain no command arguments or task results.
The script removes its acknowledgement directory when it returns.

## Execution requirements and defaults

The requesting process needs Node to run the script and tmux to contact
the server. Server-side requirements depend on the operation:

| Operation | What must be available where the server runs |
| --- | --- |
| `inspect` | A compatible reachable tmux server, or a verifiably absent one; no Node/Pi execution there |
| `start` | The working directory and an ordinary POSIX shell (`/bin/sh`); no Pi or command runner |
| `launch` | Working directory, Bash, requested program, Node at the caller's resolved executable path, and this package's helper/runner files |
| `pi` | Command-launch requirements plus Pi and, unless deliberately uninstrumented, the extension's reporter file |

A shared project directory or reachable socket does not establish that
these executables and package paths are accessible. Commands run in the
server's environment, not necessarily the requesting process's. The new
pane must use its actual `TMUX`/`TMUX_PANE`; do not copy stale client values
into it. Missing prerequisites are reported, not repaired automatically.

Without explicit options, the script uses the calling directory, the
project's `.agents/run/tmux-socket`, a 5,000 ms heartbeat and a 1,000 ms tmux
timeout. It does not read monitor configuration files itself. Pass the
resolved values from diagnostics to preserve your trusted configuration.

Explicit `--owner` takes precedence over shell-tool `PI_SESSION_ID`, then
`PI_TMUX_MONITOR_OWNER`. A missing owner is an error except for inspection.
Environment values may be stale in custom tools or the server environment,
so explicit current values are preferred. `--ancestors-json` contains the
owner's parents in root-to-parent order, excluding the owner itself; the
script appends the owner once. Cycles, duplicate IDs and contradictory
chains are rejected. The chain is limited to 64 IDs including that owner,
and 12 KiB of JSON.
