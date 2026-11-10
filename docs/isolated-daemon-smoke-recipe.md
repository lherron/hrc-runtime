# Isolated HRC daemon smoke recipe

Use an isolated daemon when the code under test is not what the shared daemon
runs. The shared daemon and CLI are native Rust (`rusthrc`); see the
[operations runbook](operations-runbook.md) for owner readback and restart
authority. Installation and activation are separate operations. A smoke of unlanded or uninstalled code therefore
needs its own daemon, started from your checkout.

`just env-up` (`scripts/dev-env.sh`) builds the native owner through `rbuild` and provisions a
per-checkout daemon, fixture agent homes, project roots and a private wrkq store.
`eval "$(bash scripts/dev-env.sh env)"` exports its paths; `just env-down` tears it down.
The daemon and its health-check CLI run without Bun on PATH, with inherited harness,
owner endpoints and credentials scrubbed. Its ASPD socket is private and absent; a probe
that births a runtime must supply its own isolated compiler fixture.
The dependency/build phase still uses Bun to build the TypeScript workspace for the
retained SDK, rendering, turn-attention and historical TypeScript test corpus. Native
startup and migration read no TypeScript owner sources.

For installed-release checks, use the verify skill's `hv scratch up --name <task>`.
For native source probes, use `crates/hrc-native/e2e/n2_scratch.py`, which binds the CLI
to the binary under test and passes every root explicitly. Keep scratch state separate
from the evidence artifact directory; never substitute the shared daemon.

## Start an isolated native daemon

Prefer those launchers: they scrub inherited context and own teardown. Native boot
creates and migrates the store before binding. Build through `rbuild`; the native binary
is `crates/target/aarch64-apple-darwin/debug/rusthrc`. The launch command is
`rusthrc server serve`, with private `HRC_RUNTIME_DIR`, `HRC_STATE_DIR`, `HRC_ASPD_SOCKET`,
`ASP_HOME`, `ASP_AGENTS_ROOT`, `HRC_PROJECT_SEARCH_ROOTS`, `HRC_WRKQ_DB` and `WRKQ_DB`.
Never inherit production webhook, peer config, lifecycle credentials or launchd identity.

Do not use `hrc server start --daemon` for isolation: it may kickstart the loaded production job,
ignoring your runtime and state overrides. `just verify` does not boot a daemon itself:
it checks architecture records and Rust crate edges, plus the cargo leg when Rust inputs changed.

## Seed and probe

Let the isolated daemon create a fresh store, then seed only the rows required by the probe. Do not clone the live store with SQLite `.backup`: the T-06440 observer attempt produced a 9.2 GB partial copy and a database-locked failure.

Keep the runtime IDs created by the probe. Run probe commands with the same exported environment variables so they address the isolated socket and store. Use the native binary under test for each command below; bare `hrc` tests the installed native CLI instead.

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

Then stop `server serve` with `Ctrl-C` and remove the isolated runtime/state directories when safe. Disclose any runtime, process, socket, database, or directory debris in the handoff or validation evidence.
