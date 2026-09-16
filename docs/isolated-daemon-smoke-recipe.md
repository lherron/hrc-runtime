# Isolated HRC daemon smoke recipe

Use an isolated daemon only when both of these are true:

- the shared daemon predates your commit, so its loaded worktree TypeScript is stale relative to the code under test; and
- a peer runtime is busy, so you cannot safely restart the shared daemon.

Otherwise, prefer restarting the shared daemon.

## Start the isolated daemon

Choose a unique root for the task or run. Export the same values in the shell that starts the server and in every shell that runs a probe:

```bash
export HRC_RUNTIME_DIR="/tmp/hrc-isolated-T-XXXXX/run"
export HRC_STATE_DIR="/tmp/hrc-isolated-T-XXXXX/state"
export HRC_HEADLESS_CODEX_BROKER_ENABLED=1
hrc server serve
```

`HRC_RUNTIME_DIR` overrides the runtime root, `HRC_STATE_DIR` overrides the state directory, and `HRC_HEADLESS_CODEX_BROKER_ENABLED` enables the headless Codex broker. `hrc server serve` is the bare foreground server process and inherits these overrides from your shell.

Do not use `hrc server start --daemon` for isolation. The start path delegates to launchd when its service is loaded, and the launchd-supervised daemon has a fixed environment: it ignores your runtime and state overrides, so isolation silently does not take effect. `hrc server start --foreground` still uses the start and launchd-probing path; use bare `hrc server serve` for a throwaway isolated instance.

## Seed and probe

Let the isolated daemon create a fresh store, then seed only the rows required by the probe. Do not clone the live store with SQLite `.backup`: the T-06440 observer attempt produced a 9.2 GB partial copy and a database-locked failure.

Keep the runtime IDs created by the probe. Run probe commands with the same three exported environment variables so they address the isolated socket and store.

### Driving viewers and attach in isolation

- `hrc attach <scope>` resolves the scope's project root; an isolated pilot
  project has no wrkq registration, so run it with
  `ASP_PROJECT_ROOT_OVERRIDE=<project root>`. `hrc attach <rt-id>` prints the
  attach descriptor JSON instead of attaching.
- Tmux prefix chords sent through `ghostmux send-keys` do not register as a
  prefix. Detach a client with `tmux -S <btmux sock> detach-client -t <client tty>`
  (`list-clients -F '#{client_tty}'`).
- When enumerating broker tmux servers, glob `run/btmux/*-rt-*.sock` and bound
  each call with `timeout`. The same directory holds
  `codex-app-server-renderer-control.*.sock`, which is not a tmux server; `tmux -S`
  against it hangs.
- A worker's renderer is a separate pane process; prove which release it came
  from with `ps` on the `:tui` pane pid (`libexec/harness-broker renderer`).

## Tear down

Before stopping the foreground server, terminate every probe runtime you spawned:

```bash
hrc runtime terminate <runtimeId>
```

Then stop `hrc server serve` with `Ctrl-C` and remove the isolated runtime/state directories when safe. Disclose any runtime, process, socket, database, or directory debris in the handoff or validation evidence.
