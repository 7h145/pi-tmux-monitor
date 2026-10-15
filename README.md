# pi-tmux-monitor

See the state of your background Pi sessions and commands without switching
between tmux terminals.

- [What this is](#what-this-is)
- [Requirements](#requirements)
- [Installation](#installation)
- [Usage](#usage)
- [Reading the indicator](#reading-the-indicator)
- [Starting tasks from a shell](#starting-tasks-from-a-shell)
- [Configuration](#configuration)
- [Privacy and limits](#privacy-and-limits)
- [Troubleshooting](#troubleshooting)
- [Development](#development)

## What this is

When Pi has tests running in one terminal, a service in another and a second
Pi session working elsewhere, it is easy to lose track of them.
pi-tmux-monitor adds a small indicator to Pi's footer so you can see which
are active, idle, still running or finished. Open its status view when you
need to know which task a symbol belongs to.

A tmux pane is a terminal within a tmux window. The indicator summarizes
the panes you are monitoring, using symbols or counts. Pi sessions running
the extension report their own activity; other commands can report that
they are running or have exited. The monitor does not guess activity from
terminal output, CPU use or process names.

The package includes the Pi extension, a skill that teaches Pi how to start
monitored tasks, and a command-line script for starting them yourself. You
can inspect their terminals with ordinary tmux. Monitoring does not take
control of those terminals or decide whether a task's result is correct.

## Requirements

- Pi, with its interactive terminal UI for the footer and status views.
- Node.js 22.19 or newer.
- tmux, accessible from the environment where Pi runs.
- For commands started through the launch script: Bash, Node and the
  requested program must also be available where the tmux server runs.

Tested on Linux with Pi 1.1.0, tmux 3.5a, and Node 22.19.0 and 26.10.0.
Other Pi/tmux versions and operating systems have not been tested.

## Installation

Install for your Pi sessions:

```sh
pi install git:github.com/7h145/pi-tmux-monitor
```

This is a personal/global install. Add `-l` for a project-local install;
Pi loads project packages only after you trust the project. Run Pi's
**`/reload`** if it is already running.

You can also install a local checkout:

```sh
pi install /absolute/path/to/pi-tmux-monitor
```

To try just the extension from a checkout without installing it:

```sh
pi --no-extensions -e /absolute/path/to/pi-tmux-monitor/pi-tmux-monitor.ts
```

That command loads the checkout's extension explicitly and disables other
discovered extensions. It does not add the checkout's skill; install the
package to load that too. Avoid loading two copies of the extension.
Pi supplies its runtime modules; no build step is needed.

Loading the monitor does not start a tmux server, launch tasks or make
model requests.

## Usage

Start with **`/tmux-monitor`**. It shows the panes included in monitoring,
their locations, labels and current states. An empty list can be normal:
by default, the monitor follows work associated with your current Pi
conversation, not everything on a shared tmux server.

The included skill gives Pi instructions for launching monitored work.
For a small first check, you can ask Pi:

> Run `sleep 10` in tmux using pi-tmux-monitor.

After the task is discovered and its status is confirmed, it can show `R`
for running, then `+` after it exits successfully. Very short commands may
finish before you see the running state. Run **`/tmux-monitor`** again to
find the task's terminal. Starting work through the skill is an ordinary
agent action in response to your request, not something the extension does
on its own.

### Inspect a terminal

Use **`/tmux-monitor help`** for an attachment command and your tmux prefix
keys. When it can identify the right session, help prints a command you
can run in another terminal. If the session is ambiguous or unavailable,
it explains that instead of guessing. It never attaches for you.

Once attached, press **Prefix, then s** to open tmux's session/window tree
with previews. The default is **Ctrl+b, then s**, but your settings may
use another prefix. Input, interrupts and cleanup remain ordinary tmux
operations; check that you are acting on the intended task.

### Check or start the project server

A tmux server keeps terminals alive independently of the client viewing
them. The project's server is normally reached through the socket file
`.agents/run/tmux-socket` in the project directory.

Use **`/tmux-monitor tmux`** to check that server now. Unlike the task list,
this makes a fresh connection check. It reports whether the server is
reachable, absent or could not be inspected, without creating anything.

Use **`/tmux-monitor tmux start`** when you want to start the project
server and open a detached shell session for your current Pi conversation.
Repeated calls reuse that session without replacing its work. The command
prints a manual attachment command; it does not open a client or start a
second Pi. The plain shell can appear as `:` in the indicator.

You do not need to run this before launching a task: the launch script
creates the required session when needed. If startup times out, inspect
the server before trying again—the server or shell session may already
exist.

### Commands

| Command | Shortcut | What it shows or does |
| --- | --- | --- |
| `/tmux-monitor` or `/tmux-monitor status` | `s` | List monitored panes and their states |
| `/tmux-monitor help` | `h` | Commands, current symbols and terminal attachment help |
| `/tmux-monitor config` | `c` | Show the settings currently in use |
| `/tmux-monitor diagnostics` | `d` | Show connection details, launch settings and problems |
| `/tmux-monitor tmux` or `/tmux-monitor tmux status` | `t`, `t s` | Check the project server now |
| `/tmux-monitor tmux start` | `t start` | Start or reuse the project server and shell session |

Shortcuts follow `/tmux-monitor`; for example, `/tmux-monitor h`.
Only `tmux start` creates resources. These commands display notices in Pi;
they do not make model requests or send their output to the agent.

### Optional: a width-aware footer

[pi-footer-compositor](https://github.com/7h145/pi-footer-compositor) can
place the indicator on the right side of Pi's footer and tell it how much
space is available. Load that extension separately if you want the
indicator to fit alongside your other footer information.

With the compositor, you normally see one symbol per pane. When space is
tight, the monitor switches to counts, then to a shorter summary of the
states needing attention. Other footer items can take priority and leave
no room for it.

Without the compositor, the monitor still publishes a count summary on
Pi's extension-status line. This fallback does not know the available
width and may be clipped. A custom footer may also keep the fallback
rather than support the width-aware display.

## Reading the indicator

| Symbol | State | What it means |
| --- | --- | --- |
| `_` | Idle | Pi has finished its current run and is still open |
| `A` | Active | Pi reports that it is doing work, including manual compaction |
| `R` | Running | The command is alive; its internal activity is not known |
| `+` | Success | The command exited with status zero |
| `!` | Failed | The command failed, or Pi finished a run with an error |
| `?` | Unknown | A monitored task has no trustworthy current activity report |
| `:` | Unregistered | The pane is included, but has no recognized task report |

Symbols follow pane creation order, not the order in which tasks became
active. In a count summary, `A3 _5 R+?` means three active, five idle, one
running, one successful and one unknown. An ending `…` means some states
could not fit. Custom themes can change the symbols; help always shows
the mapping currently in use.

A command being alive is not the same as a Pi being active. A service may
show `R` even when it has no requests to handle. Likewise, `_` and `+` do
not mean a delegated task's answer is correct or a service is ready to use.

Reports are checked periodically. With the default settings, a new task
can take about seven seconds to be confirmed; `?` during that time is
normal. If Pi's activity reports stop, a fresh command report can still
show `R`; without either, the task becomes `?`. Reports that have not
advanced for 15 seconds are no longer trusted. If the connection is lost,
cached tasks remain visible: live activity becomes unknown, while known
command exits remain. The status view warns when its last successful scan
is old.

## Starting tasks from a shell

You do not have to ask Pi to launch every command. The package includes
`scripts/pi-tmux-monitor.mjs`, a Node script that starts a program in tmux
and records its running and exit status. This is the **launch script**;
monitoring the footer and starting a program are separate operations.

To find the script in the installation Pi actually loaded, run
**`/tmux-monitor diagnostics`**. Its `helper` field is the full filename,
not a directory. For example, if that field contains
`/opt/pi-packages/pi-tmux-monitor/scripts/pi-tmux-monitor.mjs`, you can run:

```sh
node /opt/pi-packages/pi-tmux-monitor/scripts/pi-tmux-monitor.mjs --help
```

Use your own reported path, not the example path. It works with personal
and project-local installs; the package need not be inside your project.

The [launching guide](docs/launching.md) walks through starting a command
or another Pi session, explains the settings to copy from diagnostics,
and describes the JSON response for scripts that need to find the new
terminal. A second Pi still needs its normal model configuration and
credentials. If you give it a task, it can make model requests just like
any other Pi session.

## Configuration

No configuration file is required. For personal settings, create
`pi-tmux-monitor.json` in Pi's agent directory, normally `~/.pi/agent`.
If `PI_CODING_AGENT_DIR` is set, use that directory instead.

Project settings belong in `.pi/pi-tmux-monitor.json` under the directory
where Pi is working. They apply only after Pi trusts the project and
override personal settings. The monitor does not create these files or
search parent repositories. Run **`/reload`** after editing, then check
**`/tmux-monitor config`** to see what was applied.

### Which panes are shown?

By default, the monitor includes tasks belonging to your current Pi
conversation and its child conversations. Tasks started through the
launch script carry that association. Unrelated terminals are not included
just because their names look familiar or they run on the same machine.
The pane containing the foreground Pi is excluded.

To deliberately watch all other panes on the selected server, use:

```json
{
  "schemaVersion": 1,
  "scope": "server"
}
```

This also shows ordinary tmux panes as `:` when they have no task report.
It does not add activity reporting to those programs.
For finer control, use `scope: "children"`, `ownedSessions`, or
`includeUnregistered: false`, explained in the
[configuration reference](docs/configuration.md).

### Choosing a server and appearance

Without `socketPath`, monitoring first looks for the project socket,
then the server named by the current `TMUX` environment variable. If the
project server becomes available later, monitoring switches to it.
Project-server commands and launches default to the project socket even
when monitoring is temporarily using another server.

You can set `socketPath` explicitly to choose a different server. Once a
project or explicitly selected server is in use, connection failure does
not cause a switch elsewhere. Diagnostics shows where new work will be
launched (`socket`) and, if different, where status is currently read
(`observerSocket`).

The built-in theme is `default`. The
[example configuration](examples/pi-tmux-monitor.json) also defines a
`gaudy` theme with alternative symbols. It is an example
to copy or adapt, not a second built-in theme. See the
[configuration reference](docs/configuration.md) for colors, symbols,
refresh intervals and all defaults.

## Privacy and limits

The monitor does not read conversations, terminal output, task-result files
or credentials, and it makes no model requests or telemetry uploads.
Its tmux status records contain identifiers, labels, task kinds, activity,
sequence numbers and exit status—not prompts or command arguments.
Like ordinary process launches, arguments are still passed to tmux and
can be visible to people with process or socket access.

Access to a tmux socket permits execution in the **server's environment**.
Sharing a socket does not share Node, Pi or package installations. Required
programs and files must be accessible there; a launch failure does not
trigger package installation, path rewriting or a switch to another server.
Do not expose a socket to people or environments you do not trust. Anyone
with socket access can alter the status records, so the indicator is not
proof of who ran a command or whether its result is correct.

The monitor never stops work because it cannot observe it. Terminals
started by the launch script remain available after their commands exit.
If you reuse one manually, it cannot reliably track every shell command
you type; an earlier success or failure can remain visible. A running
indicator is not a health check, and monitoring cannot replace reading
and evaluating the actual result.

## Troubleshooting

Start with **`/tmux-monitor diagnostics`** and **`/tmux-monitor help`**.

- **No tasks appear:** check the selected server and scope. Plain tmux
  terminals are not automatically associated with your Pi conversation.
  Launch monitored tasks or deliberately choose `scope: "server"`.
- **No project server exists:** use `/tmux-monitor tmux start` if you want
  a shell, or launch a task. Viewing status does not create a server.
- **A task shows `?`:** allow time for its first reports. If it stays
  unknown, check diagnostics for lost reporting or connection errors.
- **The indicator is clipped or missing:** check the compositor setup and
  available footer space. `/tmux-monitor` still lists the monitored panes
  even when the footer cannot fit them.
- **A launch failed or timed out:** inspect the selected socket and any
  created terminals before retrying. The task may already be running.
  Check executable and package paths where the server runs.
- **Project settings do not apply:** confirm project trust or start Pi
  with `--approve`, then `/reload`. This extension's JSON file alone
  does not trigger Pi's trust prompt. Invalid settings are rejected with
  a diagnostic rather than partly applied.

## Development

See [development and architecture](docs/development.md) for the source
layout, reporting rules, footer integration, formatter API and test setup.
The [launching guide](docs/launching.md) also covers using the script from
your own tools without loading the skill.

Tests use isolated tmux servers and offline Pi startup, not provider
requests. Live provider-backed behavior and broader platform compatibility
have not been validated. Adapted code and its license are documented in
[third-party notices](THIRD_PARTY_NOTICES.md).
