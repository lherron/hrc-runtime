# 3. Turns and monitor

Tracked work into a runtime, and every way to watch it: the lifecycle log (`hrcSeq`) and the broker
invocation ledger (invocation-local `seq`). Code: `packages/hrc-cli/src/turn/` (commands, render-frame,
resolve-intent), `packages/hrc-cli/src/monitor/` and `monitor-*.ts`, `transcript-search.ts`; server
`turn-dispatch-*.ts`, `selector-wait-handlers.ts`, `transcript-index-handlers.ts`. Docs: `docs/cli-surface.md`
(turn, monitor), `docs/monitor-spec.md`.

## Sub-features

- `hrc turn <target> [prompt] [--dry-run] [--wait final] [--timeout D] [--as P] [--queue|--steer|--preempt]`:
  the default door is steer (join the active turn or start one). `--dry-run` prints the dispatch plan
  (placement resolution, runtime intent) without dispatching. `--wait final` blocks and prints one JSON with
  `outcome`, `effectiveDoor` and `terminal.finalMessage`.
- `hrc turn --attach <target>`: observe the single admitted active run; with none, exit 6 and no frame.
- `hrc monitor show [selector] [--json]`: point-in-time snapshot (`counts`, `daemon`, `runtime`, `session`, …).
- `hrc monitor wait <selector> --until <cond> --timeout D [--json]`: conditions `turn-finished`, `idle`,
  `busy`, `response`, `runtime-dead`. Exit 10 = `already_true` at arm; exit 20 = timeout `not_matched`;
  an unknown condition exits 2. `--until-any` / `--until-all` are the set families: an exact selector
  (one target) takes only `--until`, a set-shaped one only `--until-any|--until-all`, `--until-all` takes
  level conditions only (`idle`, `busy`, `runtime-dead`), and mixing families exits 2
  (`packages/hrc-cli/src/monitor/until-args.ts`). With no condition, a blocking wait arms on
  `turn-finished, runtime-dead`.
- `hrc monitor watch [selector] [--last N|--from-seq N] [--follow] [--format compact|…]`: the lifecycle
  events (`broker.submission.milestone`, `turn.user_prompt`, `turn.message`, `turn.completed`,
  `runtime.context.updated`, …). `runtime.context.updated` follows each turn that reports usage (T-10934), and
  also fires mid-turn when the stored reading is missing or 30 s old (T-11448: 13 for 7 `turn.completed` on the
  2026-10-26 scratch), and carries the reading `hrc runtime inspect` shows as `.hrc.contextReading`.
  `runtime.settled` is written only when an idle seat clears a stale owner (T-10841); a clean drive has none.
- `hrc monitor events|transcript|stats <runtimeId|invocationId|scope>`: the invocation ledger (`user.message`,
  `assistant.message.*`, `turn.completed`, `driver.notice`, `capture.warning`), a rendered USER/SAYS/NOTE
  transcript, and per-type counts with `turnCount`.
- `hrc monitor search <query> [--json]`: BM25 over completed turns (`userText`, `finalText`, `score`).
- `hrc monitor session-report --runtime <id> [--json]`: the broker session summary viewer windows print
  (`finalSummary`, `finalSummaryRecovery`); on a ready runtime the summary is `null` with
  `state: terminal_fenced`.

## How to get to it

On a scratch with a live runtime (feature 2): `hv run <task> -- hrc turn …`, `hv run <task> -- hrc monitor …`.
Read-only monitor verbs also work on live (`hrc monitor stats clod@hrc-runtime:<task> --json`).

## Driving it

```bash
T=tabularasa@hrc-runtime:hvprobe; R=<runtimeId>
hv run <task> -- hrc turn $T 'Reply with exactly the word TWO and nothing else. No tools.' --dry-run
hv run <task> -- hrc turn $T 'Reply with exactly the word TWO and nothing else. No tools.' --wait final --timeout 3m --as human:lance
hv run <task> -- hrc monitor show $T --json | jq -c keys
hv run <task> -- hrc monitor wait $T --until idle --timeout 10s --json | tail -1     # exit 10 already_true
hv run <task> -- hrc monitor watch $T --last 10 --format compact
hv run <task> -- hrc monitor events $R --ndjson | jq -c '{seq, type}' | tail -6
hv run <task> -- hrc monitor stats $R --json
hv run <task> -- hrc monitor transcript $R --tail 20
hv run <task> -- hrc monitor search TWO --json | head -c 800
hv run <task> -- hrc turn --attach $T; echo "rc=$?"                                # 6: no active turn
hv run <task> -- hrc monitor wait $T --until bogus --timeout 1s; echo "rc=$?"     # 2
hv run <task> -- hrc monitor wait $T --until-any idle --timeout 1s; echo "rc=$?"  # 2: exact selectors require --until
hv run <task> -- hrc monitor wait $T --until idle --until-any busy --timeout 1s; echo "rc=$?"   # 2: mutually exclusive
hv run <task> -- hrc monitor wait $T tabularasa@hrc-runtime:other --until-all turn-finished --timeout 1s; echo "rc=$?"  # 2: levels only
hv run <task> -- hrc monitor wait $T $T --until-all idle --timeout 5s --json | tail -1                  # 10 already_true; 12 on a resumed scope (T-11869)
hv run <task> -- hrc monitor session-report --runtime $R --json
```

## Gotchas

- **`--until turn-finished` armed after the turn has finished waits for the next one.** Armed 1 s after the
  first turn completed, it sat out the full 120 s and exited 20 (`result: timeout`, `outcome: not_matched`),
  while the transcript already showed `SAYS | OK` (2026-10-05, `T-10297/03-turns-monitor/drive.txt`). A
  timeout here is not "the turn never finished". Wait on `idle` (a level: exit 10 `already_true` when it
  already holds) or use `hrc turn --wait final`. Seen again 2026-10-19: armed 1 s after the first turn went
  idle, it matched the *next* turn (a `send`) 77 s later with exit 0 (`T-11363/02-runtime-lifecycle/drive.txt`).
- **Claude births log `capture.warning` rows, and which ones moves with the claude CLI.** `blocked_unknown`,
  `loadBearing: false`. On 2026-10-05 (aspd e5e729af) they were "Unknown Claude attachment type:
  environment|date|…", 8 on a fresh runtime and 0 on a resumed one. On 2026-10-19 (aspd 25445c15) they were
  "Unknown Claude transcript row type: api-request-blob|api-request|api-request-shape", 6 on the fresh
  two-turn runtime and 6 on the resumed one (`T-11363/03-turns-monitor/drive.txt`). On 2026-10-26 (aspd 15dbde97,
  claude 2.1.310) the resumed runtime had 6: 4 `api-request-blob`, 2 `api-request`, no `api-request-shape`.
  `hrc runtime status <id>
  --json` `.capture.blockedUnknown` counts them per native type. The parser is ASP's
  (`agent-spaces/harness/harness-broker/src/drivers/claude-code-tmux/hook-transcript.ts`). They are not a
  turn failure; filter them out before counting warnings, and don't pin a count or a type list.
- **A set-shaped wait on a resumed or restarted scope picks a random generation (product gap T-11869).** Set
  selectors load the scope's sessions `ORDER BY host_session_id` (a random `hsid-<uuid>`) and take the last as
  current. On 2026-10-26, with gen 1 terminated and gen 2 idle, `--until-all idle` armed on the dead gen-1 runtime
  and exited 12 `runtime_death_obstruction` (3 of 3), `--until-any idle` timed out (20) and `--until-any
  runtime-dead` exited 10 on a live seat, while the exact `--until idle` armed on gen 2 and exited 10. On
  2026-10-19 the same drive exited 10 only because that pass's newest hsid sorted last. Read the `monitor.armed`
  members before you trust a set wait's exit code.
- **A bare word is an agent, not a task.** `hrc monitor wait hvprobe …` resolves `agent:hvprobe/lane:main`
  (`unknown session`, rc 2). For a set-shaped selector in a drive, pass two selectors.
- `monitor watch --last 8` now spends a row on `runtime.context.updated` after `turn.completed`; widen
  `--last` if the run's `turn.user_prompt` falls out of the window.
- `monitor show --json` has no top-level `status`; the runtime's status is under `.runtime`.
- `turn --dry-run` resolves locally ("no server state consulted"); it proves the plan, not admission.

## Proven when

`turn --wait final` returns `outcome: completed`, `effectiveDoor: steer` and the expected `finalMessage`;
`monitor watch` shows that run's `turn.user_prompt`, `turn.message`, `turn.completed`; `events`/`stats` count
the turns; `search` finds the prompt; `wait --until idle` exits 10; `turn --attach` with nothing in flight
exits 6; an invalid condition exits 2; `--until-all turn-finished` on a set exits 2 and `--until-all idle`
exits 10 when its armed members are the live runtimes (not on a resumed scope until T-11869 is fixed).

Driven 2026-10-26 (T-11864 upkeep) on installed 02661aeb, aspd 15dbde97, scratch `t-11864` (the turn ran on
the resumed generation 2; seven `turn.completed`, thirteen `runtime.context.updated`, zero `runtime.settled` over
the scratch; `--until-all idle` exited 12 on the dead generation, T-11869):
`var/wrkq-artifacts/T-11864/03-turns-monitor/drive.txt`.
