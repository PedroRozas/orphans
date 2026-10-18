# orphans

The processes Claude Code leaves running, under control.

A session asks Claude to start a dev server, a file watcher or a test runner, and the conversation moves on. The shell that started it is gone, but the process is not: it keeps running after the session ends, sometimes for days, eating CPU and battery and holding ports you need later. `orphans` tracks what each session starts, asks the session itself whether it still needs what it left running, and ends what is left when the session closes.

## Why orphans?

- **Only what Claude started.** Processes are attributed by watching the process table around each `Bash` call, so a process gets tracked because this session started it, never because its name looks familiar. No `pkill -f node`, no guessing, nothing of yours is touched.
- **The session answers, not only you.** Most forgotten processes are forgotten by the model, not by you. When a command leaves one running, the model reads a one-line note on that command's result and ends it with a plain `kill <pid>`, or keeps it on purpose. You get a status line instead of a surprise the next morning.
- **No extra tokens.** The note is attached to a result the model was going to read anyway, once per process, and nothing else goes to the model. There are no extra model calls, no registered tools riding on every request.
- **Costs nothing while idle.** The periodic scan runs only while the session owns processes. With nothing to watch, nothing runs.
- **Survives the session.** A small ledger remembers what each session left alive, so the next session can tell you and end it with one command.
- **Local and inspectable.** No network, no daemon. One `ps` before and after each `Bash` call, `kill` when you or the model ask for it.

It is a safety net for the common case: a background command in a `Bash` call. A process that detaches into its own session or process group (Docker, `pm2`, daemons) is out of its reach; see Limits.

## How it works

1. **Attribution.** Around every `Bash` call the plugin snapshots the process table. A process that appears during the call hanging from PID 1 with the process group of a shell that no longer exists was started by that call and left behind. Its process group is now owned by the session, descendants included.
2. **The question.** Right after that call, the model reads this with the command's result (the person never sees it):

   ```
   orphans: this command left a process running outside the shell:
     43746  node next dev
   If you no longer need it, end it now with `kill 43746`. If you need it for what
   comes next, leave it: you will not be asked again and it ends by itself when the
   session ends.
   ```

   If a process turns up forgotten later (a background shell that ended), the same note goes into the conversation as a hidden row and the model reads it on its next turn. Each process is asked about once.
3. **The status line.** `2 background processes · /orphans` while something owned by this session runs outside a live shell. It is a count, not a warning: the session may still be using them. They only become orphans when the session ends. `/orphans` lists them; `/orphans kill` ends them.
4. **Leftovers.** When a session ends, every process it still owns gets `SIGTERM` (optional). What survives, and what a crashed session left, is written to a ledger; the next session shows a toast and `/orphans` lists and ends them.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install orphans --marketplace PedroRozas/orphans
```

From a shell:

```
claude plugin install orphans --marketplace PedroRozas/orphans
```

## Command

```
/orphans              list this session's background processes and the leftovers of earlier ones
/orphans kill         end all of them (SIGTERM, then SIGKILL after 2 seconds)
/orphans kill <pid>   end one
```

With `language` set to `es` the command is `/huerfanos` and the action word `matar`. Both action words are accepted in either language.

## Options

Set them in the plugin's config menu or under `pluginConfigs.orphans` in your settings.

| Option | Default | Meaning |
| --- | --- | --- |
| `language` | `en` | `en` or `es`: status line, command name, listings and the note the model reads |
| `askSession` | `true` | Ask the model once per process it left running |
| `killAtSessionEnd` | `true` | Send `SIGTERM` to every owned process when the session ends |
| `scanIntervalSeconds` | `30` | How often to rescan while the session owns processes (10 to 600). Nothing runs while it owns none |

## Requirements and assumptions

Supported on **macOS and Linux**. On any other system the plugin says so once at session start and does nothing else.

It needs `ps` (BSD or procps, with `-o lstart=`) and `kill`. `lsof` is optional: with it, processes that belong to another Claude session's background task are left alone.

It relies on three details of how Claude Code runs commands. None is a public API, so a Claude Code release could change them; the tests in `hooks/` pin the formats this plugin understands.

1. Claude's shells are recognised because their command line loads a file under `shell-snapshots/`.
2. Claude's own PID is read as the parent of a child shell the plugin spawns.
3. Another session's background tasks are recognised by their output file path, `<session id>/tasks/<name>.output`.

## Limits

- A process that starts its own session or process group (Docker, `pm2`, `setsid`, daemons that double-fork) is not attributed and is never touched.
- A process started outside a `Bash` tool call (an MCP server, an editor's task) is not tracked.
- Processes are matched by PID and start time, so a reused PID is never mistaken for an old process.

## Development

```
claude plugin validate .
claude plugin test .
tsc -p .
```

MIT License.
