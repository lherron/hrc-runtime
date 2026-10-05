# 2. Runtime lifecycle

Births, reads and ends a managed runtime for a scope, and carries its conversation across ends. Code:
`packages/hrc-cli/src/cli/handlers-scope-start.ts`, `handlers-scope-run.ts`, `handlers-runtime.ts`,
`handlers-runtime-inspect.ts`, `handlers-session.ts`, `handlers-control.ts` (send, peek, summon);
server `runtime-start-handlers.ts`, `runtime-control-handlers.ts`, `runtime-list-handlers.ts`,
`runtime-inspect-handlers.ts`, `session-resume-continuation.ts`. Docs: `docs/cli-surface.md` (run/start/attach),
`docs/target-handles.md`.

## Sub-features

- `hrc start <scope> [-p <prompt>] [--dry-run] [--json]`: births through aspd and the harness broker.
  `--dry-run` prints the selection (harness, model, provenance), the execution recipe (`claude-code`,
  driver `claude-code-tmux`, `harness-broker/0.2`) and the process argv without side effects. The live answer
  stops at `stage: accepted` with `runId`, `runtimeId`, `invocationId` and the `observation` cursors.
- `hrc show <selector> [--json]`: resolves runtime, then host session, then message; prints `kind`.
- `hrc runtime list --json` (an array of non-terminated runtimes), `hrc runtime inspect <id> --json`
  (`{hrc, broker}` authority views), `hrc session list --json`.
- `hrc peek <target> [--lines N]`: the live pane tail.
- `hrc send <target> <text> [--no-enter] [--json]`: literal keystrokes into the pane, outside the ledger.
- `hrc summon <target> --json`: ensure-target; on an existing scope it reports `state: bound` and the last
  applied intent without birthing.
- `hrc runtime terminate <id> [--reason R] [--drop-continuation]`: ends the runtime and, by default, keeps
  the continuation.
- `hrc resume <scope> [--no-attach] [-p <prompt>]`: re-births from the stored continuation into a new host
  session and generation (`priorHostSessionId` names the old one).
- Not driven here: `start --force-restart|--new-session|--no-viewer|--app-server-viewer|--on-conflict`,
  `hrc run` (interactive; feature 8 covers the attach half), `hrc restartme`.

## How to get to it

`hv scratch up --name <task>`, then every verb through `hv run <task> -- hrc …`. Birth the blank agent
`tabularasa@hrc-runtime:<slug>` (claude, opus, no spaces) with a one-word prompt.

## Driving it

```bash
T=tabularasa@hrc-runtime:hvprobe
hv run <task> -- hrc start $T --dry-run --json | head -40
hv run <task> -- hrc start $T -p "Reply with exactly the word OK and nothing else. Do not use any tools." --json
R=<runtimeId from the start output>
hv run <task> -- hrc runtime list --json | jq -c '.[] | {runtimeId,status,transport}'
hv run <task> -- hrc show $T --json | jq -c '{kind, status: .runtime.status}'
hv run <task> -- hrc runtime inspect $R --json | jq -c '{hrc: (.hrc|{status,transport}), broker: (.broker|keys)}'
hv run <task> -- hrc peek $T --lines 15
hv run <task> -- hrc send $T 'Reply with exactly the word SENT and nothing else.' --json
hv run <task> -- hrc summon $T --json | head -20
hv run <task> -- hrc session list --json
hv run <task> -- hrc runtime terminate $R --reason '<task> drive'
hv run <task> -- hrc runtime list --json          # [] once terminated
hv run <task> -- hrc resume $T --no-attach -p 'Which single words did you reply with earlier in this conversation? Answer as a comma-separated list, nothing else. No tools.' --json
hv run <task> -- hrc monitor transcript <new runtimeId> --tail 6   # the recalled words
```

## Gotchas

- **Socket paths must fit 104 bytes.** A scratch root under `~/praesidium/var/state/…` failed the birth with
  `broker_start_failed … btmux/claude-code--rt-…46ffc.sock (File name too long)` (2026-10-05,
  `T-10297/02-runtime-lifecycle/drive.txt`, `serve-long-root.log`). The broker socket name is truncated before
  the error, so the message names a path that never existed. That is why `hv` roots live under `/tmp/hv`.
- **`hrc start --json` is not turn evidence.** It answers `accepted`; read `turn.completed` and the final
  message from feature 3.
- **`hrc runtime list --json` is a bare array**, not `{runtimes: […]}`; `.runtimes` on it is a jq error.
  Terminated runtimes drop out of it, and `hrc show <scope>` then refuses "did not match any runtime among 0
  known candidates".
- **`send --no-enter` is not visible in `peek`.** It answered `delivered: true`, but a `peek` 1 s later showed
  an empty input line; the text was there, and the next `send` submitted `hv-send-marker` + its own text as
  one prompt. Prove an unsubmitted `send` by the next submission, not by `peek`.
- **`send` mints a run.** Its JSON answers `runId` and `status: started` even though the help says it
  bypasses the ledger: there is no envelope or obligation, but the turn it causes is in `hrc_events`.
- `hrc runtime terminate` has no `--json` ("unknown option: --json — did you mean '--reason'?"); it prints
  JSON anyway.
- On a single-node scratch, `target locate` shows `authority: unbound` even with a live runtime (feature 5).

## Proven when

The start's runtime reaches `ready`, `peek` shows the model's one-word answer, `inspect` returns both authority
views, `terminate` answers `ok: true` and `runtime list` empties, and `resume` births a new generation whose
transcript recalls every word the earlier turns produced (`OK, TWO, SENT` on 2026-10-05).

Driven 2026-10-05 (T-10297) on installed 5bdb6c4e, scratch `t-10297`:
`var/wrkq-artifacts/T-10297/02-runtime-lifecycle/drive.txt`, `evidence/t-10297/`.
