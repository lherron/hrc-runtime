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
  events (`broker.submission.milestone`, `turn.user_prompt`, `turn.message`, `turn.completed`, …).
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
hv run <task> -- hrc monitor watch $T --last 8 --format compact
hv run <task> -- hrc monitor events $R --ndjson | jq -c '{seq, type}' | tail -6
hv run <task> -- hrc monitor stats $R --json
hv run <task> -- hrc monitor transcript $R --tail 20
hv run <task> -- hrc monitor search TWO --json | head -c 800
hv run <task> -- hrc turn --attach $T; echo "rc=$?"                                # 6: no active turn
hv run <task> -- hrc monitor wait $T --until bogus --timeout 1s; echo "rc=$?"     # 2
hv run <task> -- hrc monitor wait $T --until-any idle --timeout 1s; echo "rc=$?"  # 2: exact selectors require --until
hv run <task> -- hrc monitor wait $T --until idle --until-any busy --timeout 1s; echo "rc=$?"   # 2: mutually exclusive
hv run <task> -- hrc monitor session-report --runtime $R --json
```

## Gotchas

- **`--until turn-finished` armed after the turn has finished waits for the next one.** Armed 1 s after the
  first turn completed, it sat out the full 120 s and exited 20 (`result: timeout`, `outcome: not_matched`),
  while the transcript already showed `SAYS | OK` (2026-10-05, `T-10297/03-turns-monitor/drive.txt`). A
  timeout here is not "the turn never finished". Wait on `idle` (a level: exit 10 `already_true` when it
  already holds) or use `hrc turn --wait final`.
- **A fresh claude birth logs `capture.warning` rows; a resumed one logged none.** `blocked_unknown`,
  "Unknown Claude attachment type: environment|date|model|instructions|credential_org|prompt_snapshot|
  session_context", `loadBearing: false`: 8 on a freshly started two-turn runtime (all stamped in its first
  turn), 0 on the resumed generation's two turns (2026-10-05, aspd e5e729af,
  `T-10350/03-turns-monitor/drive.txt`). `hrc runtime status <id> --json` `.capture.blockedUnknown` counts them
  per native type. The parser is ASP's
  (`agent-spaces/harness/harness-broker/src/drivers/claude-code-tmux/hook-transcript.ts`). They are not a
  turn failure; filter them out before counting warnings, and don't expect them on every runtime.
- `monitor show --json` has no top-level `status`; the runtime's status is under `.runtime`.
- `turn --dry-run` resolves locally ("no server state consulted"); it proves the plan, not admission.

## Proven when

`turn --wait final` returns `outcome: completed`, `effectiveDoor: steer` and the expected `finalMessage`;
`monitor watch` shows that run's `turn.user_prompt`, `turn.message`, `turn.completed`; `events`/`stats` count
the turns; `search` finds the prompt; `wait --until idle` exits 10; `turn --attach` with nothing in flight
exits 6; an invalid condition exits 2.

Driven 2026-10-05 (T-10350 upkeep) on installed 5bdb6c4e, aspd e5e729af, scratch `t-10350` (the turn ran on
the resumed generation 2): `var/wrkq-artifacts/T-10350/03-turns-monitor/drive.txt`.
