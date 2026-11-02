# 8. Attach

A human (or ghostmux) joins a live runtime's terminal and leaves it running. A claude seat (`claude-hrcpty`,
which `tabularasa` is) runs under an `hrc-pty` supervisor, so attach means an `hrc-pty attach` client on the
seat's socket, not tmux. Code: native CLI `crates/hrc-cli/src/launch/entry.rs` (attach dispatch: runtimeId
descriptor, `--dry-run`, `run`) and `launch/terminal.rs` (resolve, POST `/v1/runtimes/attach`, Ghostty bind,
spawn the argv and wait); daemon `crates/hrc-native/src/server/projection/surfaces.rs` (POST
`/v1/runtimes/attach`; hrcpty descriptor, tmux `:tui` path), `server/turns/io.rs` (GET `/v1/attach`),
`server/broker/hrcpty.rs` (attach argv, supervisor log path); client and supervisor `crates/hrc-pty/src/attach.rs`,
`serve.rs`. Docs: `docs/cli-surface.md` (run/start/attach), `docs/isolated-daemon-smoke-recipe.md`.

## Sub-features

- `hrc attach <scope>` in a TTY: picks the scope's latest runtime, POSTs `/v1/runtimes/attach` and spawns the
  returned argv, `<release>/bin/hrc-pty attach --socket <run>/bipc/<hash>/hrcpty.sock`, which puts the tty in
  raw mode and relays bytes. The supervisor log `<run>/logs/hrcpty/<rt>.log` records `event client.attached
  {attachId, readOnly: false}`. Leaving = SIGTERM the client (`pgrep -fl 'hrc-pty attach --socket
  <run>/bipc'`): the log adds `client.detached`, `hrc` exits 0 with no banner, the runtime stays `ready`
  (2026-11-02, T-12291).
- `hrc attach <runtimeId>`: prints the attach descriptor JSON (GET `/v1/attach`) and never attaches, TTY or not:
  `{transport: "hrcpty", argv: [<release>/bin/hrc-pty, attach, --socket, <run>/bipc/<hash>/hrcpty.sock],
  bindingFence: {generation, hostSessionId, runtimeId, supervisorPid}}`; no windowId, paneId or `:tui`.
  Concurrent callers each get a whole descriptor (b6468220, T-10760; 2026-11-02, T-12291). Only an id starting
  `rt-` takes this form; any other selector is a scope. The daemon runs a lease liveness reconcile first, which
  can stale a dead seat (source-only, 2026-11-02: `crates/hrc-native/src/server/turns/io.rs:31`).
- `hrc attach <scope> --dry-run [--json]`: the static local plan, `{dryRun, scope, sessionRef, runtimeLookup,
  recovery, action, serverConsulted: false}`; its `recovery` text still says detached OpenAI sessions
  "materialize a fresh tmux runtime". `attach <runtimeId> --dry-run` is a usage error: "attach --dry-run expects
  a scope, not a runtimeId", rc 2 (2026-11-02, T-12291).
- `hrc attach <scope> </dev/null` (no TTY) on an hrcpty seat does **not** fail: the client runs as a read-write
  client with nothing to read and hangs (`timeout 5` → rc 124); when killed it leaves no client behind (a
  `client.attached`/`client.detached` pair ~5 s apart in the supervisor log) (2026-11-02, T-12291).
- `hrc run <target>`: start-or-reattach and attach; interactive only (not driven separately: its attach half is
  this feature, its start half is feature 2).
- tmux seats (codex `harness=codex`, e.g. arris): the argv is `tmux -S <run>/btmux/<driver>--<rt>.sock
  attach-session -t hrc-<driver>-<rt>:tui`, a `tmux detach-client` prints `[detached (from session …)]` and exits
  0, the descriptor fence has windowId/paneId, and a scope with no TTY fails `open terminal failed: not a
  terminal`, rc 2 (source-only, 2026-11-02: `projection/surfaces.rs:143-190`, last driven 2026-10-26, T-11864).

## How to get to it

A live scratch hrcpty runtime (feature 2) and a ghostmux tab that carries the scratch roots:
`ghostmux new --tab --title hv-attach --cwd /tmp/hv/<task> --command "$(hv env <task> | tr '\n' ';') hrc attach <target>" --keep-open --json`.
Read the tab by its id, not its title.

## Driving it

```bash
T=tabularasa@hrc-runtime:hvprobe; R=/tmp/hv/<task>/run
hv run <task> -- hrc runtime list --json | jq -c '.[]|{runtimeId,transport,status}'   # transport "hrcpty"
hv run <task> -- hrc attach <rt> </dev/null | jq -c '{transport,argv,f:(.bindingFence|keys)}'
(hv run <task> -- hrc attach <rt> </dev/null | jq -c '.bindingFence|keys' & hv run <task> -- hrc attach <rt> </dev/null | jq -c '.bindingFence|keys' & wait)   # both whole
hv run <task> -- hrc attach $T --dry-run --json; hv run <task> -- hrc attach <rt> --dry-run; echo rc=$?   # plan; rc 2
ghostmux new --tab --title hv-attach --cwd /tmp/hv/<task> --command "HRC_RUNTIME_DIR=$R HRC_STATE_DIR=/tmp/hv/<task>/state hrc attach $T; echo hrc-exit=\$?" --keep-open --json
ghostmux capture-pane -t <id> | grep -v '^\s*$' | tail -8                 # the claude TUI, scope in the rule
pgrep -fl "hrc-pty attach --socket $R/bipc"                               # the one client pid
kill -TERM <pid>; sleep 2; ghostmux capture-pane -t <id> | grep -v '^\s*$' | tail -3   # status 0, no banner
grep -hE 'client\.(attached|detached)' $R/logs/hrcpty/<rt>.log | tail -2  # attached, then detached
hv run <task> -- hrc runtime list --json | jq -c '.[]|select(.runtimeId=="<rt>")|.status'   # "ready"
timeout 5 env HRC_RUNTIME_DIR=$R HRC_STATE_DIR=/tmp/hv/<task>/state hrc attach $T </dev/null >/dev/null; echo rc=$?   # 124
pgrep -fl "hrc-pty attach --socket $R/bipc" || echo 'no attach client left'
ghostmux kill-surface -t <id> --force
```

## Gotchas

- **There is no detach key.** The client passes every byte raw, so a ghostmux `send-keys` ^C interrupts claude
  and ^D reaches it (source-only, 2026-11-02: `crates/hrc-pty/src/attach.rs`, raw mode). Detach by SIGTERM to the
  `hrc-pty attach` pid; never send control chords to an attached tab.
- **A no-TTY scope attach hangs, it does not fail.** Always `</dev/null` and `timeout`; the old "rc 2" check is
  tmux-only. While it hangs it is a read-write client.
- **A read-write client changes the seat** (source-only, 2026-11-02: `broker/seat_retirement.rs:67-68`,
  `crates/hrc-pty/src/serve.rs:772-788`): seat retirement skips it while attached, and typed keystrokes hold
  back queued broker input until the human is idle. Attach to a live seat only read-only
  (`hrc-pty attach --read-only --socket …`), never through `hrc attach`; take descriptors (`hrc attach <rt>`,
  which can write) on a scratch.
- Scope attach binds the Ghostty surface when `GHOSTTY_SURFACE_UUID` is set, which every ghostmux tab sets
  (source-only, 2026-11-02: `launch/terminal.rs:112-135`).
- tmux seats only: bound every `tmux -S` with `timeout` and glob only `btmux/*-rt-*.sock`
  (`codex-app-server-renderer-control.*.sock` is not tmux and hangs it); the socket name is truncated, the
  session name carries the full runtime id (source-only, 2026-11-02: `broker/startup/sweeps.rs:253`; last driven
  2026-10-26, T-11864).

## Proven when

The ghostmux tab shows the claude TUI with the scope's name in its rule, the supervisor log has one
`client.attached` (`readOnly: false`) and `pgrep` one client, a SIGTERM to it adds `client.detached`, `hrc`
exits 0 with no banner and the runtime is still `ready`; `attach <runtimeId>` without a TTY prints an hrcpty
descriptor whose `argv` is `hrc-pty attach --socket <run>/bipc/…/hrcpty.sock` and whose fence has the four
keys, twice concurrently; `--dry-run` on a runtimeId is rc 2; a no-TTY scope attach times out (124) and leaves
no client.

Driven 2026-11-02 (T-12291 upkeep) on a native scratch (rusthrc, release-20261102082222127-69529, 9861ae0e),
tabularasa `claude-hrcpty` runtime `rt-d625b7c6`: evidence
`~/praesidium/var/wrkq-artifacts/T-12291/{07-maintenance,08-attach,evidence/t-12291}` (supervisor log
`evidence/t-12291/rt-d625b7c6-a148-4cf2-9355-4929dc5b016f.log`).
