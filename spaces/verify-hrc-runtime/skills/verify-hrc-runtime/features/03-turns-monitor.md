# 3. Turns and monitor

Tracked work into a runtime, and every way to watch it: the lifecycle log (`hrcSeq`) and the broker
invocation ledger (invocation-local `seq`). Native code (installed `hrc` = rusthrc): CLI `crates/hrc-cli/src/turn/`,
`crates/hrc-cli/src/monitor/` (spec.rs, wait.rs, engine.rs, state.rs, watch/), `crates/hrc-cli/src/forensics.rs`
(events, transcript, stats), `crates/hrc-store/src/monitor_read.rs`; daemon `crates/hrc-native/src/server/turns/`,
`server/projection/{forensics,transcript}.rs`, `server/projection/projection/{events,context}.rs`. `monitor search`
is the one Bun verb here (`crates/hrc-cli/command-scope.json` `implementation: bun` →
`packages/hrc-cli/src/transcript-search.ts`); its route `POST /v1/transcript-search` is native (server.rs:498,
transcript.rs:470). Docs: `docs/cli-surface.md` (turn, monitor), `docs/monitor-spec.md`.

## Sub-features

- `hrc turn <target> [prompt] [--dry-run] [--wait final] [--timeout D] [--as P] [--queue|--steer|--preempt]`:
  the default door is steer (`POST /v1/submissions/{steer,enqueue,preempt}`, turn/mod.rs:151; a scope with no
  session births through `/v1/messages/turn-handoff`, :308). `--dry-run` prints the plan (`placementResolution`,
  `runtimeIntent`) without dispatching. `--wait final` blocks and prints one JSON with `outcome`, `effectiveDoor`,
  `stage: terminal` and `terminal.finalMessage` (2026-11-02, T-12291: `completed`, `steer`, `TWO`). A `--wait`
  timeout exits 1 `result: wait_timeout`, a failed terminal exits 4 `turn failed: <code>` (source-only, 2026-11-02:
  crates/hrc-cli/src/turn/mod.rs:43-60, :185).
- `hrc turn --attach <target>`: observe the single admitted active run; with none, exit 6, no frame,
  `hrc: turn: no active turn on <t> (no runtime has an active run)` (2026-11-02, T-12291).
- `hrc monitor show [selector] [--json]`: snapshot keys `counts`, `daemon`, `eventLog`, `kind`, `matches`,
  `runtime`, `scope`, `selector`, `session`, `socket`, `tmux` (2026-11-02, T-12291).
- `hrc monitor wait <selector> --until <cond> --timeout D [--json]`: conditions `turn-finished`, `idle`, `busy`,
  `response`, `runtime-dead`. Exit 0 matched, 10 `already_true` at arm, 20 timeout `not_matched`, 2 usage error
  (`error: <msg>`). The rules and strings are crates/hrc-cli/src/monitor/spec.rs:266-302: the three families are
  mutually exclusive (checked first), an exact selector (one target) takes only `--until`, a set-shaped one only
  `--until-any|--until-all`, `--until-all` takes level conditions only (`idle`, `busy`, `runtime-dead`). With no
  condition a blocking wait arms on `turn-finished, runtime-dead` (spec.rs:279). Also 11 `no_session_ever`, 12
  `runtime_death_obstruction`, 13 terminal failure, 21 stalled (`--stall-after`), 22 context changed, 23 monitor
  error, and `--since <seq|duration>` (turn-finished only) fences the edge so an already-finished turn matches
  (source-only, 2026-11-02: monitor/engine.rs:12-21, monitor/wait.rs:177-181).
- `hrc monitor watch [selector] [--last N|--from-seq N] [--follow] [--format compact|…]`: the lifecycle events.
  One `--wait final` turn wrote 17 rows (108..124): `turn.user_prompt`, `submission.admission`, `turn.accepted`,
  `turn.started`, `broker.submission.milestone`, `broker.turn.origin`, `broker.seat.transition`, `turn.message`,
  `turn.completed`, three `runtime.context.updated` (2026-11-02, T-12291, `hrc_events.tsv`). That last follows each
  turn that reports usage (T-10934), fires mid-turn when the stored reading is missing or 30 s old (T-11448,
  projection/projection/context.rs:7) and carries `hrc runtime inspect`'s `.hrc.contextReading`. `runtime.settled`
  is written only when an idle seat clears a stale owner (T-10841); a clean drive has none.
- `hrc monitor events|transcript|stats <runtimeId|invocationId|scope>` (native, `GET /v1/broker-forensics`): the
  invocation ledger (`user.message`, `assistant.message.started|completed`, `usage.updated`, `turn.completed`,
  `admission.*`, `submission.executed`, …), a rendered `<seq> USER|SAYS | text` transcript
  (long turns `… [clipped N chars]`), and `{targetKind, targetId, runtimeIds, invocationIds, eventTypes}` stats
  (2026-11-02, T-12291); stats also emits `turnCount` (source-only, 2026-11-02: crates/hrc-cli/src/forensics.rs:472).
- `hrc monitor search <query> [--json]`: Bun CLI passthrough over the native index; serve.log shows the request as
  `client: hrc-cli/0.1.0` (every native verb is `rusthrc/0.1.0`). Answer `{mode: "discovery", hits: [{turnRowid,
  invocationId, runtimeId, scopeRef, generation, seqFrom, seqTo, terminalStatus, userText, finalText, …}]}`
  (2026-11-02, T-12291). Needs `bun` on PATH and the release's `packages/` tree ("Bun CLI not found in rusthrc
  release" otherwise) (source-only, 2026-11-02: crates/hrc-cli/src/passthrough.rs:73-90).
- `hrc monitor session-report --runtime <id> [--json]`: `{target, runtimeId, scopeLabel, finalSummary,
  finalSummaryRecovery}`; on a ready runtime `finalSummary: null`, `state: terminal_fenced`, "runtime is ready;
  report-only summary recovery skipped" (2026-11-02, T-12291).

## How to get to it

On a native scratch with a live runtime (feature 2): `hv run <task> -- hrc turn …`, `hv run <task> -- hrc monitor …`.
Read-only monitor verbs also work on live (`hrc monitor stats clod@hrc-runtime:<task> --json`).

## Driving it

```bash
T=tabularasa@hrc-runtime:hvprobe; R=<runtimeId>
hv run <task> -- hrc turn $T 'Reply with exactly the word TWO and nothing else. No tools.' --dry-run
HRC_RUNTIME_DIR=/tmp/hv-none HRC_STATE_DIR=/tmp/hv-none-s hrc turn $T x --dry-run >/dev/null 2>&1; echo "rc=$?"   # 1: dry-run needs the daemon
hv run <task> -- hrc turn $T 'Reply with exactly the word TWO and nothing else. No tools.' --wait final --timeout 3m --as human:lance
hv run <task> -- hrc monitor show $T --json | jq -c keys
hv run <task> -- hrc monitor wait $T --until idle --timeout 10s >/dev/null 2>&1; echo "rc=$?"                  # 10 already_true
hv run <task> -- hrc monitor watch $T --last 20 --format compact
hv run <task> -- hrc monitor events $R --ndjson | jq -c '{seq, type}' | tail -6
hv run <task> -- hrc monitor stats $R --json
hv run <task> -- hrc monitor transcript $R --tail 20
hv run <task> -- hrc monitor search TWO --json | head -c 800                     # Bun CLI; grep serve.log for hrc-cli/0.1.0
hv run <task> -- hrc turn --attach $T; echo "rc=$?"                                # 6: no active turn
hv run <task> -- hrc monitor wait $T --until bogus --timeout 1s; echo "rc=$?"     # 2
hv run <task> -- hrc monitor wait $T --until-any idle --timeout 1s; echo "rc=$?"  # 2: exact selectors require --until
hv run <task> -- hrc monitor wait $T --until idle --until-any busy --timeout 1s; echo "rc=$?"   # 2: mutually exclusive
hv run <task> -- hrc monitor wait $T tabularasa@hrc-runtime:other --until-all turn-finished --timeout 1s; echo "rc=$?"  # 2: levels only
hv run <task> -- hrc monitor wait bareword --until idle --timeout 1s; echo "rc=$?"                       # 2: unknown session
hv run <task> -- hrc monitor wait $T $T --until-all idle --timeout 5s --json | tail -1                  # 10; read .members (T-11869)
hv run <task> -- hrc monitor session-report --runtime $R --json
```

## Gotchas

- **`turn --wait final --json` has two output shapes.** On a warm seat it prints the turn-result object
  (`stage: "terminal"`, `.terminal.finalMessage`). On a cold scope (no runtime; the turn births it) it prints
  `render_frame` NDJSON instead (`{"type":"render_frame","phase":"queued"|"final","blocks":[{"t":"markdown",
  "md":"OK"}]}`, two lines) and no `.terminal`, so `jq .terminal.finalMessage` reads `null` for a turn that
  completed (2026-11-02, T-12291 `10-hv-redrive/cold-turn.json`; product task T-12306 item 5). On a cold scope
  read the last frame with `phase == "final"`, or birth with `hrc start` first and grade from the transcript.
- **`--until turn-finished` armed after the turn has finished waits for the next one.** On 2026-11-02 it armed
  4 s after the seat went idle, sat out 120 s and ended `result: timeout`, `outcome: not_matched`, `exitCode: 20`
  (`T-12291/02-runtime-lifecycle/drive.txt`; same on 2026-10-05, T-10297; on 2026-10-19 a late arm matched the
  *next* turn, T-11363). A timeout here is not "the turn never finished". Wait on `idle` (exit 10 when it holds),
  use `hrc turn --wait final`, or arm with `--since` (source-only, above).
- **`turn --dry-run` consults the daemon, whatever its note says.** It prints `"note": "local plan preview — no
  server state consulted, nothing dispatched"` (turn/mod.rs:76), but with no daemon it fails `HRC daemon socket
  not found at …/hrc.sock` rc 1, and on the scratch it POSTed `/v1/placements/resolve` and
  `/v1/declarations/resolve` (serve.log 08:48:32.67; 2026-11-02, T-12291). It proves the plan (daemon + aspd),
  not admission.
- **The turn response's `transport` is not the seat's.** `--wait final` answered `transport: headless` for a
  runtime whose `hrc runtime list --json` row says `hrcpty` (2026-11-02, T-12291, `evidence/t-12291/runtimes.json`).
  Read transport from the runtime row.
- **A set-shaped wait on a resumed scope may arm on the wrong generation (product gap T-11869, still in the native
  port).** Set selectors load every session of the scope `ORDER BY host_session_id` (a random `hsid-<uuid>`) and
  take the last as current (source-only, 2026-11-02: crates/hrc-store/src/monitor_read.rs:299,
  crates/hrc-cli/src/monitor/engine.rs:103-108). On 2026-10-26 (Bun) `--until-all idle` armed on dead gen 1 and
  exited 12. On 2026-11-02 `$T $T --until-all idle` exited 10 on the live gen-4 runtime 5 of 5, but the live
  hsid (`c83f…`) sorted last of four, so that is no discriminator: T-11869 is neither reproduced nor cleared.
  Read the `monitor.armed` members before you trust a set wait's exit code.
- **A bare word is an agent, not a task.** `hrc monitor wait bareword …` resolves `agent:bareword/lane:main`:
  `error: unknown session "agent:bareword/lane:main"`, rc 2 (2026-11-02, T-12291). For a set-shaped selector
  in a drive, pass two selectors.
- **`monitor watch --last 10` misses the turn's `turn.user_prompt`.** One turn writes 17 rows; `--last 10`
  started at `turn.started` (2026-11-02, T-12291). Use `--last 20` or `--from-seq` from `observation.lifecycle.fromSeq`.
- **The monitor CLI reads the store directly.** `show`, `wait`, `watch` open the dialed daemon's `/v1/status`
  `dbPath` read-only (source-only, 2026-11-02: crates/hrc-cli/src/monitor/state.rs:826-829); a CLI without the
  scratch's `HRC_RUNTIME_DIR` reads the live ledger. Use `hv run`.
- **Claude births log `capture.warning` rows (`blocked_unknown`, `loadBearing: false`), and which ones moves with
  the claude CLI** ("Unknown Claude attachment type: …" on 2026-10-05, "Unknown Claude transcript row type:
  api-request-blob|api-request|…" on 2026-10-19 and 10-26). The parser is ASP's (`agent-spaces/harness/
  harness-broker/src/drivers/claude-code-tmux/hook-transcript.ts`). Count them from `monitor stats --json`
  `.eventTypes["capture.warning"]`; the old `hrc runtime status` `.capture.blockedUnknown` is not in crates/
  (source-only, 2026-11-02: grep). Not a turn failure; don't pin a count or a type list.
- `monitor show --json` has no top-level `status`; the runtime's status is under `.runtime`.

## Proven when

`turn --wait final` returns `outcome: completed`, `effectiveDoor: steer` and the expected `finalMessage`;
`monitor watch` shows that run's `turn.user_prompt`, `turn.message`, `turn.completed`; `events`/`stats` count
the turns; `search` (the Bun CLI, `hrc-cli/0.1.0` in serve.log) finds the prompt; `wait --until idle` exits 10;
`turn --attach` with nothing in flight exits 6; an invalid condition exits 2; `--until-all turn-finished` on a set
exits 2 and `--until-all idle` exits 10 when its armed members are the live runtimes (on a resumed scope only
once T-11869 is fixed or the live hsid is shown not to sort last).

Driven 2026-11-02 (T-12291) on a native scratch (rusthrc, release-20261102082222127-69529, 9861ae0e), scratch
`t-12291` (the turn ran on resumed generation 4, hrcpty; seven `turn.completed`, thirteen
`runtime.context.updated`, zero `runtime.settled` over the scratch; the set wait was no T-11869 discriminator):
`~/praesidium/var/wrkq-artifacts/T-12291/{03-turns-monitor,04-http-api,evidence/t-12291}`.
