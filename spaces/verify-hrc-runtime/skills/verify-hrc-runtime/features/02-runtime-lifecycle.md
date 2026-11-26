# 2. Runtime lifecycle

Births, reads and ends a managed runtime for a scope, and carries its conversation across ends. Code: CLI
`crates/hrc-cli/src/launch/entry.rs` and `launch.rs` (start, resume), `preview.rs` (`--dry-run`), `commands.rs`
(show, ls, `runtime list|inspect|status|capture|terminate`, `session resolve|meta get`, peek),
`commands/sessions.rs` (`session list|get`), `commands/messaging.rs` (send, summon, restart); daemon
`crates/hrc-native/src/server.rs` (routes), `server/turns/{control,resume,restart,io,input}.rs` (terminate, resume,
restart, capture, send) and `server/broker/{broker,start,hrcpty}.rs` (births, hrc-pty seats).
`session meta set|clear` and `session retitle` are native (`crates/hrc-cli/src/commands/sessions.rs`). Docs:
`docs/cli-reference.md` (run/start/attach), `docs/target-handles.md`. Seat handoffs and seat work: CLI
`hrc handoff …`, `hrc seat work …` (native; grammar in `crates/hrc-cli/surface.json`), routes `/v1/seat-handoffs…`, `/v1/sessions/work`.

## Sub-features

- `~/.bun/bin/hrc start <scope> [-p <prompt>] [--dry-run] [--json]`: births through aspd and the harness broker. `--dry-run
  --json` is a daemon preview (`POST /v1/previews/run`, no side effects): `{preview: {selection {harness
  claude-hrcpty, model, provenance}, execution {recipeId claude-code, driver claude-code-hrcpty, protocol
  harness-broker/0.2, hosting {executionTransport pty, terminalRequired true, terminalHost hrcpty,
  processExecution supervisor-process}}}}` for tabularasa (model `opus[1m]`, 2026-11-16). The
  live answer is `{sessionRef, hostSessionId, created, runtime, follow}`; `runId`, `runtimeId`, `generation`,
  `startIdentity.invocationId`, `observation` and `stage: accepted` sit under `.runtime`. `--wait
  started|completed` waits past `accepted`; `completed` sends `turnPolicy: guarded` with a 6 h client bound, and an
  unwaited `start -p` turn is open (source-only, 2026-11-16: `crates/hrc-cli/src/launch.rs#execute_start`, 9e2ae5d0).
- `~/.bun/bin/hrc show <selector> [--json]`: resolves runtime, then host session, then message; prints `kind`. For a
  runtime the fields are top-level (`status`, `transport`, …).
- `~/.bun/bin/hrc runtime list --json` (a bare array of non-terminated runtimes; `--all` adds terminated ones), `~/.bun/bin/hrc runtime inspect <id> --json`
  (`{hrc, broker}`; `.hrc.contextReading {turnId, usedTokens, windowTokens, model {id, source}, observedAt}` after
  a turn that reported usage, else `null`), `~/.bun/bin/hrc session list --json`.
- `~/.bun/bin/hrc ls <runtimes|sessions|messages> [--json]`: the inventory by noun; without one, "error: missing required
  argument 'noun'", rc 2 (2026-11-16).
- `~/.bun/bin/hrc runtime status <target> [--json]`: lifecycle plus the broker's capture snapshot (`capture.state`,
  `deferredCount`, `blockedUnknown[]`): `open`, 0, 0 on 2026-11-02; `open`, 0, 1 on 2026-11-09 and 2026-11-16, the one entry
  `{nativeType: "session-owner", family: "diagnostic", loadBearing: false, count: 3, message: "Unknown Claude
  transcript row type: session-owner"}` (Gotchas). On 2026-11-23, two: `session-owner` (3) and `data-flow-records` (4).
- `~/.bun/bin/hrc session resolve --scope <scopeRef> [--json]`: `found`, `created: false`, `generation`, `hostSessionId`;
  `--create` makes one: `--lane lane:probe --create` answered `created: true`, rc 0 on 2026-11-23 (a 500 before
  a7194de1) and stores the continuity under `lane:probe`, which `session get <hostSessionId>` then refuses
  `unknown continuity`, rc 2 (product gap T-14440; `/v1/sessions/by-host/<hsid>` reads it, 200 with identity). `~/.bun/bin/hrc session get <hostSessionId> --live --json`: `{session, runtimes}`.
  `~/.bun/bin/hrc session meta get <target> --json`: `{metadata, metadataSources}`, empty on a fresh scope.
- `~/.bun/bin/hrc runtime capture <runtimeId>`: the screen text, rc 0, on an hrcpty seat (substrate capture). A runtime with
  no pane refuses "cannot capture a non-interactive runtime; use the runtime event stream instead" (source-only,
  2026-11-02: `crates/hrc-native/src/server/turns/io.rs#capture`).
- `~/.bun/bin/hrc peek <target> [--lines N]`: the live screen tail; works on hrcpty though its help says "tmux pane".
- `~/.bun/bin/hrc send <target> <text> [--no-enter] [--json]`: literal input; works on hrcpty though its help says "live tmux
  runtime". No envelope or obligation, but a submitting send answers `{delivered, runId, status: started}` and its
  turn is in `hrc_events`. `--no-enter` is held by the daemon, not typed (Gotchas). `--idempotency-key` replays a
  retry (source-only, 2026-11-02: `crates/hrc-native/src/server/turns/input.rs`).
- `~/.bun/bin/hrc summon <target> --json`: ensure-target; on an existing scope `state: bound` and `lastAppliedIntentJson`,
  no birth.
- `~/.bun/bin/hrc runtime terminate <id> [--reason R] [--drop-continuation]`: ends the runtime and keeps an idle hrcpty
  seat's continuation (`droppedContinuation: false`); a seat with an active HRC-launched run drops it by default
  (source-only, 2026-11-16: `crates/hrc-native/src/server/turns/control.rs#terminate_runtime`). The reason is stored but not shown (Gotchas).
  Terminate is idempotent since 2df74cc2: a repeat on a terminated runtime answers the same `ok: true` JSON, rc 0,
  and writes no second `runtime.terminated` (1 row, the first reason, 2026-11-16).
- `~/.bun/bin/hrc resume <scope> [--no-attach] [-p <prompt>]`: re-births from the stored continuation into a new host session
  and generation (`{sessionRef, hostSessionId, priorHostSessionId, continuation, runtime}`).
- `~/.bun/bin/hrc restart <scope> [--force] [--json]` (`POST /v1/sessions/restart`): archives the host session, births
  generation+1 with no continuation (`{ok, priorHostSessionId, hostSessionId, generation, launch: {status,
  runtimeId}}`) and terminates the old runtime. A seat that is not idle is refused `ok: false`, `code:
  runtime_busy` ("seat is turn-active; not restarted" on 2026-11-02), rc 1, nothing changed; a seat it cannot probe is refused
  `seat_unobservable` (source-only, 2026-11-02: `crates/hrc-native/src/server/turns/restart.rs#assert_idle` at 4b31f208);
  `--force` skips the check. Native replays no `initialPrompt` and answers at launch (source-only, 2026-11-02:
  `crates/hrc-native/src/server/broker/broker.rs#prepare_dispatch`, `crates/hrc-native/src/server/turns/restart.rs#rotate_and_launch`); the historical Bun replay is outside the native scratch surface. Not `restartme` and not `server restart`.
  Since 5f13a397 (T-13969) `POST /v1/sessions/restart` also takes `provision: {model?, reasoning_effort?}`, HTTP only
  (`hrc restart` sends none): another key, an effort outside low|medium|high|xhigh or a non-object answers 400
  `malformed_request` and nothing changes; an accepted override answers `summonDirectives` beside `launch`, the
  successor runs that model (`◇ Sonnet` in its TUI) and a later plain `hrc restart` keeps it (2026-11-23,
  `02-runtime-lifecycle/drive-extra.txt`).
- `POST /v1/terminate` with an `x-hrc-lifecycle-*` header checks operator authority: from a caller that is not
  the runtime's seat it answers 403 `server_lifecycle_refused` "only mable@<project>:primary or the runtime's own
  seat may terminate a runtime …" (`refusal: credential_missing`), nothing terminated (2026-11-09, T-12756). The
  CLI's `runtime terminate` sends no lifecycle header, so its drive is unaffected.
- `~/.bun/bin/hrc handoff create --scope <seat> -t <title> --body-file <f>` → `{id H-…, state pending, etag 1}`;
  `handoff list [--scope] [--all]`, `handoff get <id>`, `handoff acknowledge <id> --if-match <etag> --note <n>`
  (`--note` is required, rc 2 without; a stale etag is `[handoff_stale]`, rc 1). `seat work get <scope>` →
  `{kind, work {kind none|task}, workEtag}`; `seat work set <scope> --task T|--workstream W|--none --if-match <n>`,
  stale etag `[stale_seat_work] work etag changed`, rc 1. Each write lands as `session.handoff.changed` /
  `session.work.changed` in `hrc_events` (2026-11-09, `T-12756/02-runtime-lifecycle/drive-handoff-seat.txt`).
- A start or turn on a host session a rotation retired is refused 409 `stale_context` (`reason:
  host_session_retired`), and a resume whose harness differs from the carried continuation 409
  `continuation_harness_mismatch` (source-only, 2026-11-09: 846648d8, `crates/hrc-native/src/server/broker/broker.rs#require_active_host`,
  `crates/hrc-native/src/server/broker/compile.rs#continuation_gate`; the CLI's `send`/`turn` take no `host:` selector to reach it).
- `~/.bun/bin/hrc seat screen <scope> [--lane L] [--styled]`: JSON lines `{text, cursor, cols, rows, screen}` of the seat's
  current screen, a read-only alternative to `peek` that ends on close (`timeout 4` → rc 124 after one line on
  2026-11-16); an unknown seat is `unknown_seat (HTTP 409)`, rc 2 (`T-13633/09-new-verbs/drive.txt`).
- `~/.bun/bin/hrc session annotation list|put|delete|act <target>`: seat and generation annotations (`--ns`, `--kind`,
  `--id`, `--subject seat|generation`, `--expect-*` fences). `list` on a fresh scope answered `{annotations: []}`,
  rc 0 (2026-11-16); the writes are not driven.
- New birth refusals (source-only, 2026-11-16): `cwd_missing` (`crates/hrc-native/src/server/broker/compile.rs#require_cwd`), aspd errors as 422
  `aspd_refused` / `aspd_compile_rejected` (7c58dede). Live task births get `SCRATCH=var/scratch/<project>/<task>`;
  an hv scratch birth gets none (its root is not named `hrc`, `crates/hrc-native/src/server/broker/dispatch_env.rs#scratch_dir`).
- Not driven here: `start --force-restart|--new-session|--no-viewer|--app-server-viewer|--on-conflict`,
  `~/.bun/bin/hrc run` (feature 8 covers attach), `~/.bun/bin/hrc restartme`, `session rotate`, `session drop-continuation`, `runtime
  interrupt`, and the native metadata writes `session meta set|clear`, `session retitle`.

## How to get to it

`hv scratch up --name <task>` (native by default), then every verb through `hv run <task> -- ~/.bun/bin/hrc …`. Birth the
blank agent `tabularasa@hrc-runtime:<slug>` (claude via `claude-hrcpty`, no spaces) with a one-word prompt.

## Driving it

```bash
T=tabularasa@hrc-runtime:hvprobe
hv run <task> -- ~/.bun/bin/hrc start $T --dry-run --json | jq -c '{h: .preview.selection.harness, ex: .preview.execution|{recipeId,driver,protocol,hosting}}'
hv run <task> -- ~/.bun/bin/hrc start $T -p "Reply with exactly the word OK and nothing else. Do not use any tools." --json
R=<.runtime.runtimeId from the start output>
hv run <task> -- ~/.bun/bin/hrc runtime list --json | jq -c '.[] | {runtimeId,status,transport}'   # ready, hrcpty
hv run <task> -- ~/.bun/bin/hrc show $T --json | jq -c '{kind, status, transport}'
hv run <task> -- ~/.bun/bin/hrc runtime inspect $R --json | jq -c '{hrc: (.hrc|{status,transport}), broker: (.broker|keys)}'
hv run <task> -- ~/.bun/bin/hrc peek $T --lines 15
hv run <task> -- ~/.bun/bin/hrc ls runtimes --json | jq -c '.[] | {runtimeId,status,transport}'
hv run <task> -- ~/.bun/bin/hrc runtime status $T --json | jq -c '{status, capture: (.capture|{state, deferredCount, n: (.blockedUnknown|length)})}'
hv run <task> -- ~/.bun/bin/hrc session resolve --scope agent:tabularasa:project:hrc-runtime:task:hvprobe --json | jq -c '{found, created, generation, hostSessionId}'
hv run <task> -- ~/.bun/bin/hrc session get <hostSessionId> --live --json | jq -c keys
hv run <task> -- ~/.bun/bin/hrc session meta get $T --json
hv run <task> -- ~/.bun/bin/hrc send $T 'Reply with exactly the word SENT and nothing else.' --json
hv run <task> -- ~/.bun/bin/hrc monitor transcript $R --tail 4                  # wait for 'SAYS | SENT'
hv run <task> -- ~/.bun/bin/hrc summon $T --json | head -20
hv run <task> -- ~/.bun/bin/hrc session list --json
hv run <task> -- ~/.bun/bin/hrc runtime terminate $R --reason '<task> drive'
hv run <task> -- ~/.bun/bin/hrc runtime list --json          # [] once terminated
sqlite3 -readonly /tmp/hv/<task>/state/state.sqlite "select event_kind, payload_json from hrc_events where runtime_id='$R' and event_kind='runtime.terminated'"   # the reason (Gotchas)
hv run <task> -- ~/.bun/bin/hrc resume $T --no-attach -p 'Which single words did you reply with earlier in this conversation? Answer as a comma-separated list, nothing else. No tools.' --json | jq -c '{rt: .runtime.runtimeId, gen: .runtime.generation, prior: .priorHostSessionId}'
hv run <task> -- ~/.bun/bin/hrc monitor transcript <new runtimeId> --tail 6   # OK, SENT
hv run <task> -- ~/.bun/bin/hrc runtime capture <new runtimeId> | tail -8         # the screen, rc 0
hv run <task> -- ~/.bun/bin/hrc runtime inspect <new runtimeId> --json | jq -c '.hrc | {status, transport, contextReading}'
hv run <task> -- ~/.bun/bin/hrc restart $T --json                                 # generation+1, launch.status started
until hv run <task> -- ~/.bun/bin/hrc peek $T --lines 12 | grep -q 'bypass permissions'; do sleep 1; done   # TUI up first (T-11870)
hv run <task> -- ~/.bun/bin/hrc turn $T 'Which single words did you reply with earlier in this conversation? Answer as a comma-separated list, or NONE if there were none. No tools.' --wait final --timeout 3m --json | jq -c '{generation, final: .terminal.finalMessage}'   # NONE
hv run <task> -- ~/.bun/bin/hrc send $T 'Write the numbers from 1 to 300 as English words, one per line. No tools.' --json | jq -c .status
for i in $(seq 10); do s=$(hv run <task> -- ~/.bun/bin/hrc runtime list --json | jq -r '.[0].status'); echo "t+$i $s"; [ "$s" = busy ] && break; sleep 1; done   # gate on busy (Gotchas)
hv run <task> -- ~/.bun/bin/hrc restart $T --json; echo "rc=$?"                   # runtime_busy, rc 1
```

## Gotchas

- **A long root fails each birth on native, not the boot.** The broker's sockets must fit 104 bytes; native checks
  at birth ("broker socket path too long", an internal error; `<runtime>/btmux/<12>-<32>.sock` is root+57 bytes)
  (source-only, 2026-11-16: `crates/hrc-native/src/server/broker/broker.rs#launch`). Historical Bun behavior (outside the native scratch surface):
  the boot refusal "runtime root socket path too long" since 955416e9 (T-10330), which `hv scratch up` reports
  as `daemon_exited` (2026-10-19, `T-11363`). That is why `hv` roots live under `/tmp/hv`.
- **`~/.bun/bin/hrc start --json` is not turn evidence.** It answers `stage: accepted`; read `turn.completed` and the final
  message (feature 3). A `monitor wait --until turn-finished` armed after the turn had already finished waited
  out its 120 s and answered `result: timeout`, `exitCode: 20` (2026-11-02).
- **`~/.bun/bin/hrc start --json` answers `transport: headless`** at accept; the hosted runtime is `hrcpty` for tabularasa
  (`runtime list`, `show`, `inspect`; it was `tmux` on the Bun daemon). Read the transport after the birth.
- **`~/.bun/bin/hrc runtime list --json` is a bare array**, not `{runtimes: […]}`. Terminated runtimes drop out of it, and
  `~/.bun/bin/hrc show <scope>` then refuses "did not match any runtime among 0 known candidates", rc 2.
- **`terminate --reason` is stored but not surfaced.** The reason lands in `runtime_state_json.terminationReason`
  (1f63a58b; `crates/hrc-native/src/server/turns/control.rs#terminate_runtime`) and in the `runtime.terminated` event payload, but `~/.bun/bin/hrc runtime inspect` shows neither
  (`.hrc.terminationReason` null, no path holds the string) (2026-11-02; product task filed by T-12291). Read it
  from `hrc_events`.
- **`runtime.terminated` says `transport: "sdk"` for an hrcpty runtime** (`audit_transport`,
  `crates/hrc-native/src/server/turns/control.rs#interrupt`, maps anything not `headless` to `sdk`) (2026-11-02;
  product task T-12306; still `sdk` on 2026-11-16). Don't grade the transport from that event.
- **A restart right after `send` can race the busy check.** After `send`, `runtime list` stays `ready` ~1 s
  before `busy`. `send`, `sleep 3`, `restart` restarted (generation 4) instead of refusing; polling saw `ready` at
  t+1 and `busy` at t+2, and the restart then refused `runtime_busy`, rc 1 (2026-11-02). Gate on `status ==
  busy` before testing the refusal.
- **`send --no-enter` is not visible in `peek`, by design.** The daemon holds the text in memory (event
  `target.literal-input`, `delivery: broker-buffered-literal`, no `runId`) and prepends it to the next `send` that
  presses enter; a daemon restart drops it (2026-10-05 on Bun, `T-10331/item5/repro.txt`; same on native,
  source-only, 2026-11-02: `server/turns/input.rs`). Prove an unsubmitted `send` by the next submission.
- **`restart` and `resume` differ by the continuation.** Resume's generation 2 recalled `OK, SENT`; a restarted
  generation answered `NONE` to the same question (2026-10-19, 2026-10-26 on Bun; 2026-11-02 on native).
- **Wait for the TUI before the post-restart turn (T-11870).** On Bun a turn 0.2 s after `restart` returned was
  admitted but never typed into the booting claude TUI; the seat stayed `starting` for minutes and later restarts
  refused `runtime_busy: seat is starting` until `--force` (2 of 3 tries, 2026-10-26). No commit names T-11870.
  On native the `bypass permissions` peek passed at once (waited=1) and the turn answered `NONE` (2026-11-02);
  that drive waits first, so it neither reproduces nor clears the wedge: T-11870 stays open, uncertified on native.
- **`monitor wait --until idle` right after `send` races the send.** Armed 0 s after `send` returned, it answered
  `already_true` from the previous idle (2026-10-05). Confirm a send by its `SAYS` line or `turn.completed`.
- **`blockedUnknown` can hold a Claude row type HRC doesn't know yet.** On 2026-11-09 and 2026-11-16 every claude-hrcpty seat
  reported `session-owner` (`family: diagnostic`, `loadBearing: false`, count 4, then 3; on 2026-11-23 also
  `data-flow-records`, count 4): drift in the claude CLI's
  transcript, not HRC. `capture.state` stayed `open`; it is not a capture failure unless `loadBearing` is true.
- `~/.bun/bin/hrc runtime terminate` always prints its result as JSON; `--json` changes nothing.
- On a single-node scratch, `target locate` shows `authority: unbound` even with a live runtime (feature 5).

## Proven when

The start's runtime reaches `ready` on `hrcpty`, `peek` shows the model's one-word answer, `inspect` returns both
authority views, `terminate` answers `ok: true` and `runtime list` empties, and `resume` births a new generation
whose transcript recalls `OK, SENT`; `restart` births generation+1 that answers `NONE`, and a seat gated on
`busy` is refused `runtime_busy`, rc 1.

Driven 2026-11-23 (T-14430 upkeep) on a native scratch (rusthrc, release-20261122204127910-10417, 4b31f208):
generations 1–3 (`OK`, `SENT`, resume `OK, SENT`, restart `NONE`), `runtime_busy` rc 1 at t+2, the idempotent
terminate, the restart `provision` override (generations 4–5 on sonnet), the prefixed-lane resolve (T-14440),
the sweep-summary by-host read, plus the handoff and seat-work verbs; evidence
`~/praesidium/var/wrkq-artifacts/T-14430/{02-runtime-lifecycle,evidence/t-14430}`. Not driven: the 403 lifecycle refusal (unchanged code).
