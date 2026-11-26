# 3. Turns and monitor

Tracked work into a runtime, and every way to watch it: the lifecycle log (`hrcSeq`) and the broker
invocation ledger (invocation-local `seq`). Native code (installed `hrc` = rusthrc): CLI `crates/hrc-cli/src/turn/`,
`crates/hrc-cli/src/monitor/` (spec.rs, wait.rs, engine.rs, state.rs, watch/), `crates/hrc-cli/src/forensics.rs`
(events, transcript, stats), `crates/hrc-store/src/monitor_read.rs`; daemon `crates/hrc-native/src/server/turns/`,
`server/projection/{forensics,transcript}.rs`, `server/projection/projection/{events,context}.rs`. `monitor search`
is native (`crates/hrc-cli/src/monitor/search.rs`, with the FTS index in
`crates/hrc-store/src/transcript_index.rs`) and always asks the daemon (`POST /v1/transcript-search`,
`server/projection/transcript.rs`, search.rs:279); the `hrc index status|rebuild` group and its
`/v1/transcript-index/*` routes are gone (f682cba8; `unknown command: index`, 404, 2026-11-16). Docs: `docs/cli-reference.md` (turn, monitor), `docs/monitor-spec.md`.

## Sub-features

- `~/.bun/bin/hrc turn <target> [prompt] [--dry-run] [--wait final] [--timeout D] [--as P] [--queue|--steer|--preempt]`:
  the default door is steer (`POST /v1/submissions/{steer,enqueue,preempt}`, turn/mod.rs:151; a scope with no
  session births through `/v1/messages/turn-handoff`, :322; a session with no applied runtime intent falls through
  to the same birth after its steer is refused `missing_runtime_intent`, notice "the session has no applied runtime
  intent; birthing it with the resolved intent", :274-284, ac0783f8, source-only). `--wait` takes only `final`
  ("unsupported --wait mode for turn", rc 2) and defaults to `--timeout 45m`; `--queue|--preempt --wait` add
  `turnPolicy: guarded` (source-only, 2026-11-16: turn/options.rs:151-173, mod.rs:244-247). `--dry-run` prints the plan (`placementResolution`,
  `runtimeIntent`) without dispatching. `--wait final` blocks and prints one JSON with `outcome`, `effectiveDoor`,
  `stage: terminal` and `terminal.finalMessage` (2026-11-02, T-12291: `completed`, `steer`, `TWO`). A `--wait`
  timeout exits 1 `result: wait_timeout`, a failed terminal exits 4 `turn failed: <code>` (source-only, 2026-11-02:
  crates/hrc-cli/src/turn/mod.rs:43-60, :185).
- `~/.bun/bin/hrc turn --attach <target>`: observe the single admitted active run; with none, exit 6, no frame,
  `hrc: turn: no active turn on <t> (no runtime has an active run)` (2026-11-02, T-12291).
- `~/.bun/bin/hrc monitor show [selector] [--json]`: snapshot keys `counts`, `daemon`, `eventLog`, `kind`, `matches`,
  `runtime`, `scope`, `selector`, `session`, `socket`, `tmux` (2026-11-02, T-12291).
- `~/.bun/bin/hrc monitor wait <selector> --until <cond> --timeout D [--json]`: conditions `turn-finished`, `idle`, `busy`,
  `response`, `runtime-dead`. Exit 0 matched, 10 `already_true` at arm, 20 timeout `not_matched`, 2 usage error
  (`error: <msg>`). The rules and strings are crates/hrc-cli/src/monitor/spec.rs:266-302: the three families are
  mutually exclusive (checked first), an exact selector (one target) takes only `--until`, a set-shaped one only
  `--until-any|--until-all`, `--until-all` takes level conditions only (`idle`, `busy`, `runtime-dead`). With no
  condition a blocking wait arms on `turn-finished, runtime-dead` (spec.rs:279). Also 11 `no_session_ever`, 12
  `runtime_death_obstruction`, 13 terminal failure, 21 stalled (`--stall-after`), 22 context changed, 23 monitor
  error, and `--since <seq|duration>` (turn-finished only) fences the edge so an already-finished turn matches
  (source-only, 2026-11-02: monitor/engine.rs:10-20, monitor/wait.rs:177-181). Since f748a301 `wait` and `watch
  --until` wake from `GET /v1/events/bounded-stream?follow=true` instead of polling the store; a stream that ends
  exits 23 "monitor event stream ended" (source-only, 2026-11-09: monitor/live.rs:27-108). Armed before a turn,
  `--until turn-finished` exited 0 `phase: after-arm` and the scratch logged `bounded-stream` requests (2026-11-09,
  `T-12756/03-turns-monitor/drive-extra.txt`).
- `~/.bun/bin/hrc monitor watch [selector] [--last N|--from-seq N] [--follow] [--format compact|…]`: the lifecycle events.
  One `--wait final` turn wrote 17 rows (108..124): `turn.user_prompt`, `submission.admission`, `turn.accepted`,
  `turn.started`, `broker.submission.milestone`, `broker.turn.origin`, `broker.seat.transition`, `turn.message`,
  `turn.completed`, three `runtime.context.updated` (2026-11-02, T-12291, `hrc_events.tsv`). That last follows each
  turn that reports usage (T-10934), fires mid-turn when the stored reading is missing or 30 s old (T-11448,
  projection/projection/context.rs:7) and carries `~/.bun/bin/hrc runtime inspect`'s `.hrc.contextReading`. `runtime.settled`
  is written only when an idle seat clears a stale owner (T-10841); a clean drive has none.
- `~/.bun/bin/hrc monitor events|transcript|stats <runtimeId|invocationId|scope>` (native; events and transcript read
  `GET /v1/broker-forensics`, stats reads `GET /v1/broker-stats` since 2c947087, counted by the daemon): the
  invocation ledger (`user.message`, `assistant.message.started|completed`, `usage.updated`, `turn.completed`,
  `admission.*`, `submission.executed`, …), a rendered `<seq> USER|SAYS | text` transcript
  (since fc533b42 also `TURN FAILED <code> | …`, `FAILED <tool> <code> | …` and `ERROR | …`: live `rt-c61ab0aa`,
  cody@arris:T-13710, seq 3875–3877 on 2026-11-23)
  (long turns `… [clipped N chars]`), and `{targetKind, targetId, runtimeIds, invocationIds, eventTypes}` stats
  (2026-11-02, T-12291); stats also emits `turnCount`, `toolCallCount`, `perTurn[]` (2026-11-09, T-12756).
- A cold-scope turn (no session; births through `/v1/messages/turn-handoff`) writes one `message.response`
  lifecycle row; a warm steer writes none (1 vs 0 on 2026-11-09, `T-12756/03-turns-monitor/drive-extra.txt`).
- `~/.bun/bin/hrc monitor search <query> [--json]`: native FTS search through the daemon (no local path; it needs a
  socket). Answer `{mode: "discovery", hits: [{turnRowid, invocationId, runtimeId, agent, project, task,
  scopeRef, generation, seqFrom, seqTo, terminalStatus, userText, finalText, snippet, score, …}], index}`
  (2026-11-16). Listed under `hrc monitor --help`, no longer in the agent-view top-level help.
  It needs neither Bun on PATH nor the retained CLI package (T-13053, T-13058).
- `~/.bun/bin/hrc monitor session-report --runtime <id> [--json]`: `{target, runtimeId, scopeLabel, finalSummary,
  finalSummaryRecovery}`; on a ready runtime `finalSummary: null`, `state: terminal_fenced`, "runtime is ready;
  report-only summary recovery skipped" (2026-11-02, T-12291).

## How to get to it

On a native scratch with a live runtime (feature 2): `hv run <task> -- ~/.bun/bin/hrc turn …`, `hv run <task> -- ~/.bun/bin/hrc monitor …`.
Read-only monitor verbs also work on live (`~/.bun/bin/hrc monitor stats clod@hrc-runtime:<task> --json`).

## Driving it

```bash
T=tabularasa@hrc-runtime:hvprobe; R=<runtimeId>
hv run <task> -- ~/.bun/bin/hrc turn $T 'Reply with exactly the word TWO and nothing else. No tools.' --dry-run
HRC_RUNTIME_DIR=/tmp/hv-none HRC_STATE_DIR=/tmp/hv-none-s ~/.bun/bin/hrc turn $T x --dry-run >/dev/null 2>&1; echo "rc=$?"   # 1: dry-run needs the daemon
hv run <task> -- ~/.bun/bin/hrc turn $T 'Reply with exactly the word TWO and nothing else. No tools.' --wait final --timeout 3m --as human:lance
hv run <task> -- ~/.bun/bin/hrc monitor show $T --json | jq -c keys
hv run <task> -- ~/.bun/bin/hrc monitor wait $T --until idle --timeout 10s >/dev/null 2>&1; echo "rc=$?"                  # 10 already_true
hv run <task> -- ~/.bun/bin/hrc monitor watch $T --last 20 --format compact
hv run <task> -- ~/.bun/bin/hrc monitor events $R --ndjson | jq -c '{seq, type}' | tail -6
hv run <task> -- ~/.bun/bin/hrc monitor stats $R --json
hv run <task> -- ~/.bun/bin/hrc monitor transcript $R --tail 20
hv run <task> -- ~/.bun/bin/hrc monitor search TWO --json | head -c 800                     # native FTS search
hv run <task> -- ~/.bun/bin/hrc turn --attach $T; echo "rc=$?"                                # 6: no active turn
hv run <task> -- ~/.bun/bin/hrc monitor wait $T --until bogus --timeout 1s; echo "rc=$?"     # 2
hv run <task> -- ~/.bun/bin/hrc monitor wait $T --until-any idle --timeout 1s; echo "rc=$?"  # 2: exact selectors require --until
hv run <task> -- ~/.bun/bin/hrc monitor wait $T --until idle --until-any busy --timeout 1s; echo "rc=$?"   # 2: mutually exclusive
hv run <task> -- ~/.bun/bin/hrc monitor wait $T tabularasa@hrc-runtime:other --until-all turn-finished --timeout 1s; echo "rc=$?"  # 2: levels only
hv run <task> -- ~/.bun/bin/hrc monitor wait bareword --until idle --timeout 1s; echo "rc=$?"                       # 2: unknown session
hv run <task> -- ~/.bun/bin/hrc monitor wait $T $T --until-all idle --timeout 5s --json | tail -1                  # 10; read .members (T-11869)
hv run <task> -- ~/.bun/bin/hrc monitor session-report --runtime $R --json
```

## Gotchas

- **`turn --wait final --json` has two output shapes.** On a warm seat it prints the turn-result object
  (`stage: "terminal"`, `.terminal.finalMessage`). On a cold scope (no runtime; the turn births it) it prints
  `render_frame` NDJSON instead (`{"type":"render_frame","phase":"queued"|"final","blocks":[{"t":"markdown",
  "md":"OK"}]}`, two lines) and no `.terminal`, so `jq .terminal.finalMessage` reads `null` for a turn that
  completed (2026-11-02, T-12291 `10-hv-redrive/cold-turn.json`; product task T-12306 item 5; same two frames on
  2026-11-16). On a cold scope
  read the last frame with `phase == "final"` (`hrc turn` births a cold scope on its message; no separate start is needed).
- **`--until turn-finished` armed after the turn has finished waits for the next one.** On 2026-11-02 it armed
  4 s after the seat went idle, sat out 120 s and ended `result: timeout`, `outcome: not_matched`, `exitCode: 20`
  (`T-12291/02-runtime-lifecycle/drive.txt`; same on 2026-10-05, T-10297; on 2026-10-19 a late arm matched the
  *next* turn, T-11363). A timeout here is not "the turn never finished". Wait on `idle` (exit 10 when it holds),
  use `~/.bun/bin/hrc turn --wait final`, or arm with `--since` (source-only, above).
- **`turn --dry-run` consults the daemon, whatever its note says.** It prints `"note": "local plan preview — no
  server state consulted, nothing dispatched"` (turn/mod.rs:76), but with no daemon it fails `HRC daemon socket
  not found at …/hrc.sock` rc 1, and on the scratch it POSTed `/v1/placements/resolve` and
  `/v1/declarations/resolve` (serve.log 08:48:32.67; 2026-11-02, T-12291). It proves the plan (daemon + aspd),
  not admission.
- **The turn response's `transport` is not the seat's.** `--wait final` answered `transport: headless` for a
  runtime whose `~/.bun/bin/hrc runtime list --json` row says `hrcpty` (2026-11-02, T-12291, `evidence/t-12291/runtimes.json`).
  Read transport from the runtime row.
- **A set-shaped wait on a resumed scope may arm on the wrong generation (product gap T-11869, still in the native
  port).** Set selectors load every session of the scope `ORDER BY host_session_id` (a random `hsid-<uuid>`) and
  take the last as current (source-only, 2026-11-02: crates/hrc-store/src/monitor_read.rs:299,
  crates/hrc-cli/src/monitor/engine.rs:~100-105). On 2026-10-26 (Bun) `--until-all idle` armed on dead gen 1 and
  exited 12. On 2026-11-02 `$T $T --until-all idle` exited 10 on the live gen-4 runtime 5 of 5, but the live
  hsid (`c83f…`) sorted last of four, so that is no discriminator: T-11869 is neither reproduced nor cleared.
  Same on 2026-11-09: exit 10 on live gen 3, whose hsid `cf55…` sorted last of three (`aa36…`, `39aa…`), and on
  2026-11-16: live gen 3 `f550…` sorted last of `383c…`, `6ade…`. **Reproduced 2026-11-23 (T-14430):** dead gen 2
  `dbbd…` sorted last of `3b36…` and live gen 3 `8757…`, and `$T $T --until-all idle` armed only that terminated
  runtime: `runtime_death_obstruction`, exit 12, while the exact `--until idle` armed live gen 3 and exited 10.
  Read the `monitor.armed` members before you trust a set wait's exit code.
- **HRC mints the submissionId (91cd6b3d, T-13704).** A send's or turn's run carries `hrc-<uuid>` in
  `runs.minted_submission_id` and in `turn --wait final --json`'s `submissionId` (4 of 6 scratch runs on 2026-11-23;
  the launch-prompt runs of `start -p` and `resume -p` keep the broker's `human_submission_…` id and a null column).
  The `submission.admission` event's payload doesn't carry it. A broker that refuses the id is sent the submission
  again without one and serve.log logs `broker.submission_id_unsupported` (0 lines on 2026-11-23; source-only, 8f801493).
  Also source-only (they need a broker fault rig): a terminal wait returns when HRC fails the run itself (307a737b),
  and a lost submission fails its run as `submission_lost`, not `runtime_unavailable` (bb728784).
- **A bare word is an agent, not a task.** `~/.bun/bin/hrc monitor wait bareword …` resolves `agent:bareword/lane:main`:
  `error: unknown session "agent:bareword/lane:main"`, rc 2 (2026-11-02, T-12291). For a set-shaped selector
  in a drive, pass two selectors. Still so after the selector grammar moved onto `hrc_common::scope` (6c630307;
  2026-11-16).
- **`monitor watch --last 10` misses the turn's `turn.user_prompt`.** One turn writes 17 rows; `--last 10`
  started at `turn.started` (2026-11-02, T-12291). Use `--last 20` or `--from-seq` from `observation.lifecycle.fromSeq`.
- **The monitor CLI reads the store directly.** `show`, `wait`, `watch` open the dialed daemon's `/v1/status`
  `dbPath` read-only (source-only, 2026-11-02: crates/hrc-cli/src/monitor/state.rs:832-833) and, for `wait`/`watch
  --until`, follow the daemon's bounded stream; a CLI without the scratch's `HRC_RUNTIME_DIR` reads the live
  ledger. Use `hv run`.
- **Claude births log `capture.warning` rows (`blocked_unknown`, `loadBearing: false`), and which ones moves with
  the claude CLI** ("Unknown Claude attachment type: …" on 2026-10-05, "Unknown Claude transcript row type:
  api-request-blob|api-request|…" on 2026-10-19 and 10-26). The parser is ASP's (`agent-spaces/harness/
  harness-broker/src/drivers/claude-code-tmux/hook-transcript.ts`). Count them from `monitor stats --json`
  `.eventTypes["capture.warning"]` (4 on 2026-11-09, 3 on 2026-11-16) or `~/.bun/bin/hrc runtime status --json` / `capture status`
  `.capture.blockedUnknown[]` (`session-owner` on 2026-11-09; feature 2). Not a turn failure; don't pin a count or a
  type list.
- `monitor show --json` has no top-level `status`; the runtime's status is under `.runtime`.

## Proven when

`turn --wait final` returns `outcome: completed`, `effectiveDoor: steer` and the expected `finalMessage`;
`monitor watch` shows that run's `turn.user_prompt`, `turn.message`, `turn.completed`; `events`/`stats` count
the turns; `search` finds the prompt; `wait --until idle` exits 10;
`turn --attach` with nothing in flight exits 6; an invalid condition exits 2; `--until-all turn-finished` on a set
exits 2 and `--until-all idle` exits 10 when its armed members are the live runtimes (on a resumed scope, while T-11869 is
open, it exits 12 `runtime_death_obstruction` whenever a dead generation's hsid sorts last: read `monitor.armed`).

Driven 2026-11-23 (T-14430 upkeep) on a native scratch (rusthrc, release-20261122204127910-10417, 4b31f208),
scratch `t-14430` (turn on restarted generation 3, hrcpty; six `turn.completed` over the scratch; the set wait
reproduced T-11869, exit 12 on dead gen 2) and live read-only for the failed-turn transcript:
`~/praesidium/var/wrkq-artifacts/T-14430/{03-turns-monitor,04-http-api,evidence/t-14430}`. Not driven this pass: the armed `turn-finished` wait
and a cold-scope turn (unchanged code since T-13633).
