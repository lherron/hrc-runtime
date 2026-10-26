# 8. Attach

A human (or ghostmux) joins a live runtime's terminal and leaves it running. Code:
`packages/hrc-cli/src/cli/handlers-scope-attach.ts`, `handlers-scope-run.ts`, `runtime-select.ts` (the Ghostty
bind and the tmux exec); server `surface-handlers.ts` (POST `/v1/runtimes/attach`), `server-session-methods.ts`
(GET `/v1/attach`), `tmux-socket.ts`. Docs: `docs/cli-surface.md` (run/start/attach),
`docs/isolated-daemon-smoke-recipe.md` ("Driving viewers and attach in isolation"),
`docs/runbooks/broker-tmux-ghostmux-e2e.md`.

## Sub-features

- `hrc attach <target>` in a TTY: execs `tmux -S <run>/btmux/<driver>--<rt>.sock attach-session -t
  hrc-<driver>-<rt>:tui`. Leaving with a tmux detach prints `[detached (from session …)]` and exits 0; the
  runtime stays `ready`.
- `hrc attach <runtimeId>`: always prints the attach descriptor JSON (`transport`, `argv`, `bindingFence`
  with hostSessionId, runtimeId, generation, windowId, paneId) and never attaches, TTY or not (GET
  `/v1/attach`). Concurrent callers each get their own whole descriptor (b6468220, T-10760). Only an id that
  starts with `rt-` takes this form; any other selector is treated as a scope (source-read). A scope target
  with no TTY still execs tmux: `open terminal failed: not a terminal`, rc 2.
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
(hv run <task> -- hrc attach <runtimeId> </dev/null | jq -c '.bindingFence|keys' & hv run <task> -- hrc attach <runtimeId> </dev/null | jq -c '.bindingFence|keys' & wait)   # both whole
hv run <task> -- hrc attach $T </dev/null; echo "rc=$?"                    # scope, no TTY: rc 2
hv run <task> -- hrc attach $T --dry-run
ghostmux kill-surface -t <id> --force
```

## Gotchas

- **Tmux prefix chords sent through `ghostmux send-keys` don't register.** Detach with `tmux -S <sock>
  detach-client -t <tty>` (from `list-clients`), as the isolated-daemon recipe says.
- **Bound every `tmux -S` with `timeout`** and glob only `btmux/*-rt-*.sock`: the same directory can hold
  `codex-app-server-renderer-control.*.sock`, which is not a tmux server and hangs `tmux -S`.
- `hrc attach --dry-run --json` prints the plan as one JSON object (`dryRun`, `scope`, `sessionRef`,
  `serverConsulted: false`, …); without `--json` it prints the human plan.
- Scope attach binds the Ghostty surface when `GHOSTTY_SURFACE_UUID` is set, which every ghostmux tab sets
  (source-read). `:tui` in the argv holds for a leased-tmux runtime with a tmux-tui presentation, which is
  what a claude birth is.
- The socket name is truncated (`…-rt-fa63c507-774c-45b6-8fc5-9ffb3.sock`) while the session name carries the
  full runtime id; match on the session name.

## Proven when

The ghostmux tab shows the runtime's TUI with the scope's name in its rule, `list-clients` shows exactly one
client, a detach prints `[detached (from session hrc-…-<rt>)]` with exit 0, the runtime is still `ready`
with zero clients, and `attach <runtimeId>` without a TTY prints a descriptor whose `argv` names that socket
and `:tui`.

Driven 2026-10-26 (T-11864 upkeep) on installed 02661aeb, scratch `t-11864` (the resumed generation's
runtime; two concurrent descriptors both whole; scope attach without a TTY rc 2):
`var/wrkq-artifacts/T-11864/08-attach/drive.txt`.
