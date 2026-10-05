# 8. Attach

A human (or ghostmux) joins a live runtime's terminal and leaves it running. Code:
`packages/hrc-cli/src/cli/handlers-scope-attach.ts`, `handlers-scope-run.ts`; server `runtime-io-handlers.ts`
(`/v1/runtimes/attach`), `tmux-socket.ts`. Docs: `docs/cli-surface.md` (run/start/attach),
`docs/isolated-daemon-smoke-recipe.md` ("Driving viewers and attach in isolation"),
`docs/runbooks/broker-tmux-ghostmux-e2e.md`.

## Sub-features

- `hrc attach <target>` in a TTY: execs `tmux -S <run>/btmux/<driver>--<rt>.sock attach-session -t
  hrc-<driver>-<rt>:tui`. Leaving with a tmux detach prints `[detached (from session …)]` and exits 0; the
  runtime stays `ready`.
- `hrc attach <runtimeId>` without a TTY (or from a script): prints the attach descriptor JSON (`transport`,
  `argv`, `bindingFence` with hostSessionId, runtimeId, generation, windowId, paneId) instead of attaching.
- `hrc attach <target> --dry-run`: the local plan (POST `/v1/runtimes/attach`, then exec the argv).
- `hrc run <target>`: start-or-reattach and attach; interactive only (not driven separately: its attach half
  is this feature, its start half is feature 2).

## How to get to it

A live scratch runtime (feature 2) and a ghostmux tab that carries the scratch roots:
`ghostmux new --tab --title hv-attach --cwd /tmp/hv/<task> --command "$(hv env <task> | tr '\n' ';') hrc attach <target>" --keep-open --json`.
Read the tab by its id, not its title: the title changes once `hrc attach` exits.

## Driving it

```bash
T=tabularasa@hrc-runtime:hvprobe
ghostmux new --tab --title hv-attach --cwd /tmp/hv/<task> --command "HRC_RUNTIME_DIR=/tmp/hv/<task>/run HRC_STATE_DIR=/tmp/hv/<task>/state hrc attach $T" --keep-open --json
ghostmux capture-pane -t <id> | tail -12                                    # the claude TUI, scope in the rule
for s in /tmp/hv/<task>/run/btmux/*-rt-*.sock; do timeout 5 tmux -S $s list-clients -F '#{client_tty} #{session_name}'; done
timeout 5 tmux -S <sock> detach-client -t <client tty>
ghostmux capture-pane -t <id> | grep -v '^\s*$' | tail -5                   # [detached …], status 0
hv run <task> -- hrc runtime list --json | jq -c '.[] | {runtimeId,status}'  # still ready
hv run <task> -- hrc attach <runtimeId> </dev/null                         # descriptor JSON
hv run <task> -- hrc attach $T --dry-run
ghostmux kill-surface -t <id> --force
```

## Gotchas

- **Tmux prefix chords sent through `ghostmux send-keys` don't register.** Detach with `tmux -S <sock>
  detach-client -t <tty>` (from `list-clients`), as the isolated-daemon recipe says.
- **Bound every `tmux -S` with `timeout`** and glob only `btmux/*-rt-*.sock`: the same directory can hold
  `codex-app-server-renderer-control.*.sock`, which is not a tmux server and hangs `tmux -S`.
- `hrc attach --dry-run --json` prints the human plan; `--json` changes nothing there (2026-10-05).
- The socket name is truncated (`…-rt-fa63c507-774c-45b6-8fc5-9ffb3.sock`) while the session name carries the
  full runtime id; match on the session name.

## Proven when

The ghostmux tab shows the runtime's TUI with the scope's name in its rule, `list-clients` shows exactly one
client, a detach prints `[detached (from session hrc-…-<rt>)]` with exit 0, the runtime is still `ready`
with zero clients, and `attach <runtimeId>` without a TTY prints a descriptor whose `argv` names that socket
and `:tui`.

Driven 2026-10-05 (T-10297) on installed 5bdb6c4e, scratch `t-10297`:
`var/wrkq-artifacts/T-10297/08-attach/drive.txt`.
