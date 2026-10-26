# 2. Runtime lifecycle

Births, reads and ends a managed runtime for a scope, and carries its conversation across ends. Code:
`packages/hrc-cli/src/cli/handlers-scope-start.ts`, `handlers-scope-run.ts`, `handlers-runtime.ts`,
`handlers-runtime-inspect.ts`, `handlers-session.ts`, `handlers-restart.ts`, and
`packages/hrc-cli/src/target/live-commands.ts` (send, peek, summon); server `runtime-start-handlers.ts`,
`runtime-control-handlers.ts`, `runtime-list-handlers.ts`, `runtime-inspect-handlers.ts`, `selector-message-handlers/selector-input.ts` (send), `session-resume-continuation.ts`,
`session-restart.ts`. Docs: `docs/cli-surface.md` (run/start/attach),
`docs/target-handles.md`.

## Sub-features

- `hrc start <scope> [-p <prompt>] [--dry-run] [--json]`: births through aspd and the harness broker.
  `--dry-run` prints the selection (harness, model, provenance), the execution recipe (`claude-code`,
  driver `claude-code-tmux`, `harness-broker/0.2`) and the process argv without side effects. The live answer
  stops at `stage: accepted` with `runId`, `runtimeId`, `invocationId` and the `observation` cursors.
- `hrc show <selector> [--json]`: resolves runtime, then host session, then message; prints `kind`. For a
  runtime the fields are top-level (`status`, `transport`, `capture`, `broker`, `presentation`, …).
- `hrc runtime list --json` (an array of non-terminated runtimes), `hrc runtime inspect <id> --json`
  (`{hrc, broker}` authority views; `.hrc.contextReading` `{turnId, usedTokens, windowTokens, model,
  observedAt}` after a turn that reported usage, T-10928, else `null`), `hrc session list --json`.
- `hrc ls <runtimes|sessions|messages> [--json]`: the inventory by noun. The noun is required (exit 2
  without one; the help prints `<noun>`).
- `hrc runtime status <target> [--json]`: lifecycle plus broker capture (`capture.state`, `deferredCount`,
  `blockedUnknown[]` per native type).
- `hrc session resolve --scope <scopeRef> [--json]`: finds the active host session (`found`, `created:
  false`); `--create` makes one (not driven). `hrc session get <hostSessionId> --live --json` joins the
  backing runtimes (`{session, runtimes}`). `hrc session meta get <target> --json`: continuity metadata
  (`{metadata, metadataSources}`, empty on a fresh scope).
- `hrc runtime capture <runtimeId>`: the pane text by runtime id, broker-hosted runtimes included since
  d24cd877 (T-10353). A headless runtime has no pane and refuses (rc 2, source-read).
- `hrc peek <target> [--lines N]`: the live pane tail.
- `hrc send <target> <text> [--no-enter] [--json]`: literal keystrokes into the pane; no envelope or obligation, but a
  submitting send returns a `runId` and its turn is in `hrc_events`. `--no-enter` on a broker-hosted runtime is
  held by the daemon, not typed (Gotchas).
- `hrc summon <target> --json`: ensure-target; on an existing scope it reports `state: bound` and the last
  applied intent without birthing.
- `hrc runtime terminate <id> [--reason R] [--drop-continuation]`: ends the runtime and, by default, keeps
  the continuation.
- `hrc resume <scope> [--no-attach] [-p <prompt>]`: re-births from the stored continuation into a new host
  session and generation (`priorHostSessionId` names the old one).
- `hrc restart <scope> [--force] [--json]` (T-10850, `POST /v1/sessions/restart`): ends the conversation and
  relaunches fresh: archives the host session, births generation+1 with no continuation (`{ok,
  priorHostSessionId, hostSessionId, generation, launch: {status, runtimeId}}`) and terminates the old
  runtime. A busy, starting or unobservable seat is refused with `ok: false`, `code: runtime_busy`
  (`seat is turn-active|starting; not restarted`), rc 1, nothing changed; `--force` skips that check (driven
  2026-10-26). When the inherited intent carries an `initialPrompt`, restart replays it as the new generation's
  first turn and answers only once that turn finishes (c45b450f; source-read: tabularasa's intent has none, so
  nothing was replayed). Not `restartme` (self, after a handoff) and not
  `server restart` (the daemon).
- Not driven here: `start --force-restart|--new-session|--no-viewer|--app-server-viewer|--on-conflict`,
  `hrc run` (interactive; feature 8 covers the attach half), `hrc restartme`, and the continuity writes
  `session rotate`, `session meta set|clear`, `session retitle` (deprecated alias), `session
  drop-continuation`, `runtime send` (run input) and `runtime interrupt`.

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
hv run <task> -- hrc show $T --json | jq -c '{kind, status, transport}'
hv run <task> -- hrc runtime inspect $R --json | jq -c '{hrc: (.hrc|{status,transport}), broker: (.broker|keys)}'
hv run <task> -- hrc peek $T --lines 15
hv run <task> -- hrc ls runtimes --json | jq -c '.[] | {runtimeId,status,transport}'
hv run <task> -- hrc runtime status $T --json | jq -c '{status, capture: (.capture|{state, deferredCount, n: (.blockedUnknown|length)})}'
hv run <task> -- hrc session resolve --scope agent:tabularasa:project:hrc-runtime:task:hvprobe --json | jq -c '{found, created, generation}'
hv run <task> -- hrc session get <hostSessionId> --live --json | jq -c keys
hv run <task> -- hrc session meta get $T --json
hv run <task> -- hrc send $T 'Reply with exactly the word SENT and nothing else.' --json
hv run <task> -- hrc monitor transcript $R --tail 4                  # wait for 'SAYS | SENT' (Gotchas)
hv run <task> -- hrc summon $T --json | head -20
hv run <task> -- hrc session list --json
hv run <task> -- hrc runtime terminate $R --reason '<task> drive'
hv run <task> -- hrc runtime list --json          # [] once terminated
hv run <task> -- hrc resume $T --no-attach -p 'Which single words did you reply with earlier in this conversation? Answer as a comma-separated list, nothing else. No tools.' --json
hv run <task> -- hrc monitor transcript <new runtimeId> --tail 6   # the recalled words
hv run <task> -- hrc runtime capture <new runtimeId> | tail -8         # the pane, rc 0
hv run <task> -- hrc runtime inspect <new runtimeId> --json | jq -c '.hrc | {status, contextReading}'
hv run <task> -- hrc restart $T --json                                 # generation+1, launch.started
until hv run <task> -- hrc peek $T --lines 12 | grep -q 'bypass permissions'; do sleep 1; done   # TUI up first (Gotchas, T-11870)
hv run <task> -- hrc turn $T 'Which single words did you reply with earlier in this conversation? Answer as a comma-separated list, or NONE if there were none. No tools.' --wait final --timeout 3m --json | jq -c '{generation, final: .terminal.finalMessage}'   # NONE
hv run <task> -- hrc send $T 'Count slowly from 1 to 40, one number per line. No tools.' --json; sleep 3
hv run <task> -- hrc restart $T --json; echo "rc=$?"                   # runtime_busy, rc 1
```

## Gotchas

- **Socket paths must fit 104 bytes, and the daemon now checks at boot.** Since 955416e9 (T-10330) a root
  whose worst-case btmux socket can't fit refuses to start: "runtime root socket path too long: the
  worst-case btmux socket path …/run/btmux/codex-app-se-rt-0000….sock is 148 bytes; … at most 103" in
  `serve.log`; `hv scratch up` refuses `daemon_exited` with that line (~13 s; it waited out 30 s for
  `not_ready` before T-11363) (2026-10-19, an 84-byte `HV_HOME`, `T-11363/evidence/lr/serve.log`,
  `10-hv-fix/drive.txt`). Before it, the birth failed with a truncated path that never existed
  (T-10297). That is why `hv` roots live under `/tmp/hv`.
- **`hrc start --json` is not turn evidence.** It answers `accepted`; read `turn.completed` and the final
  message from feature 3.
- **`hrc runtime list --json` is a bare array**, not `{runtimes: […]}`; `.runtimes` on it is a jq error.
  Terminated runtimes drop out of it, and `hrc show <scope>` then refuses "did not match any runtime among 0
  known candidates".
- **`send --no-enter` is not visible in `peek`, by design.** On a broker-hosted runtime the daemon buffers the
  text in memory (`pendingBrokerLiteralInputs`, event `target.literal-input` with `delivery:
  broker-buffered-literal`, no `runId`) and prepends it to the next `send` that presses enter. A direct `tmux
  capture-pane` of the tui pane is empty too, at +0 to +4 s, so it is not a peek timing artifact; a daemon
  restart drops the held text (2026-10-05, `T-10331/item5/repro.txt`). Prove an unsubmitted `send` by the
  next submission, not by `peek`.
- **`send` mints a run.** A submitting send answers `runId` and `status: started`: there is no envelope or
  obligation, but the turn it causes is in `hrc_events`. Still true after e822f2a9 (2026-10-19), which only
  drops the run from turns the broker takes with no HRC dispatch (typed in the pane).
- **`restart` and `resume` differ by the continuation.** On 2026-10-19 and 2026-10-26 resume's generation 2
  recalled `OK, SENT`; a restarted generation answered `NONE` to the same question
  (`T-11864/02-runtime-lifecycle/drive.txt`).
- **A turn sent the instant `restart` returns can wedge the new seat (product gap T-11870).** `restart` answers
  once the broker binds; a turn 0.2 s later was admitted (`idle -> starting`, `submission-steer-admitted`) but
  never typed into the still-booting claude TUI. The seat stayed `starting` for more than 4 min
  (`broker.seat.stalled`, then `broker.dispatch_authority.disagreement`), `turn --wait final` timed out, and every
  later `restart` refused `runtime_busy: seat is starting` until `--force` (2 of 3 back-to-back tries on
  2026-10-26; waiting for the TUI's status line first passed). Wait for the pane before the post-restart turn.
- `hrc runtime capture` refused every broker-hosted runtime on 5bdb6c4e (`expected.windowName: main`,
  `observed: tui`; T-10353). d24cd877 ended it: rc 0 with the pane on 2026-10-19.
- **`hrc start --json` answers `transport: headless`** at `stage: accepted`; the runtime is `tmux` once it is
  hosted (`runtime list`, `inspect`). Read the transport after the birth, not from the start answer.
- **`monitor wait --until idle` right after `send` races the send.** Armed 0 s after `send` returned, it
  answered `already_true` from the previous idle (`went idle 21:07:28`) before the sent turn went busy
  (2026-10-05). Confirm a send by its `SAYS` line in the transcript or `turn.completed` for its `runId`.
- `hrc runtime terminate` always prints its result as JSON; `--json` is accepted and changes nothing.
- On a single-node scratch, `target locate` shows `authority: unbound` even with a live runtime (feature 5).

## Proven when

The start's runtime reaches `ready`, `peek` shows the model's one-word answer, `inspect` returns both authority
views, `terminate` answers `ok: true` and `runtime list` empties, and `resume` births a new generation whose
transcript recalls every word the earlier turns produced (`OK, SENT` after a start and a send on
2026-10-05, 2026-10-19 and 2026-10-26; the `TWO` turn of feature 3 now runs on the resumed generation); `restart`
births generation+1 that recalls nothing (`NONE`) and refuses a busy seat with `runtime_busy`.

Driven 2026-10-26 (T-11864 upkeep) on installed 02661aeb, aspd 15dbde97, claude 2.1.310, scratch `t-11864`
(resume recalled `OK, SENT`; restarted gen 4 answered `NONE`; gens 3 and 5 wedged, T-11870; `runtime_busy` on a
`starting` and a `turn-active` seat): `var/wrkq-artifacts/T-11864/02-runtime-lifecycle/drive.txt`,
`evidence/t-11864/`.
