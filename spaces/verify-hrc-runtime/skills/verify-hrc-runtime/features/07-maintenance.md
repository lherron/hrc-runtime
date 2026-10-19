# 7. Maintenance

The repair and inspection cellar (`hrc admin --help`) and the scheduled retention job. Code:
`packages/hrc-cli/src/cli/handlers-runtime-sweep.ts`, `handlers-capture.ts`, `run-diagnostics-render.ts`,
and `packages/hrc-cli/src/metrics-report.ts`, `broker-verify/`, `worktree-prune.ts`; server `sweep-*.ts`,
`runtime-prune-handlers.ts` (617c6e39),
`first-turn-*.ts`, `request-metrics.ts`, `asp-toolchain.ts`; `scripts/prune-hrc-event-deltas.ts` and
`launchd/com.praesidium.hrc-prune-deltas.plist`. Docs: `docs/state-retention.md`, `docs/operations-runbook.md`.

## Sub-features

- `hrc admin runs sweep-zombies|reconcile-active [--older-than D] [--dry-run|--yes] [--json]`: one summary
  object (`matched`, `zombied` / `reaped`, `repaired`, `suspect`, `skipped`, `errors`). Since ed974915
  `reconcile-active` also settles accepted submissions that never started (rows with reason
  `unstarted_submission_settled` and a `finalizedRunStatus`; source-read, none on 2026-10-19). `recover-unstarted
  <runId>` withdraws one accepted run's broker submission (not driven: needs a stuck run).
- `hrc admin metrics report [--since D] [--json]`: `commands`, `counters`, `routes`, `slowest`, `largest`,
  `launch`, `diagnostics`, `uncorrelatedServerCount`.
- `hrc runtime sweep [--dry-run|--yes] [--older-than D] [--json]`: liveness-gates aged ready/busy runtimes
  (summary `matched`, `stale`, `terminated`, `skipped`). `hrc runtime prune [--dry-run|--yes] [--status S]
  [--older-than D] [--json]`: deletes orphaned runtime rows (default `stale`, 24h); a dry-run lists each
  match as `status: pruned, reason: dry_run`; a terminated broker runtime whose evidence is still held
  answers `skipped / offline_evidence_held` instead (source-read; `--dispose-retained-evidence` releases it,
  not driven). Only the dry-runs are driven.
- `hrc admin broker-verify run --invocation <id> [--jsonl P] [--json]`: verifies one invocation against its
  ledger and raw mirror (`status: pass`, `ledger.statuses`, `lifecycle[]` broker seq → hrcSeq).
- `hrc admin status --json`: ASP child toolchain selection (`binaries`, `toolchainRootActive`).
- `hrc runtime diagnostics [selector] [--json]`: `first_turn_missing` watchdog trips (read-only).
- `hrc capture status <target> --json`: the broker-authoritative capture state (`open`, `deferredCount`).
  `capture release` and `capture recover` are operator writes (not driven).
- `hrc admin broker-verify candidates <scopeRef> --json`: invocations verifiable against ledger and raw mirror.
- `hrc admin worktrees audit --json`: completed-task linked worktrees (`prune` removes; not driven).
- `scripts/prune-hrc-event-deltas.ts [--db P] [--apply] …`: bounded retention; without `--apply` it reports
  eligible counts per table. It prints one logging-standard line (`{ts, level, component, event:
  "prune.report", data}`; a failure is `event: "prune.failed"`, level `error`, exit 1, on stdout) since
  230189dc. launchd runs it with `--apply --tables runtime_buffers` against the live DB.
- Not HRC's cellar but it terminates HRC runtimes: launchd `com.praesidium.reap-headless-ghostmux` (every
  30 min, `-y`) also reaps paneless ready runtimes idle more than 12 h (54535197, `--source
  reap-paneless-inventory`). A scratch runtime is never old enough; a live runtime that vanished after 12 h
  idle may be this job, not a defect.

## How to get to it

Writes and per-scope reads on a scratch (`hv run <task> -- hrc admin …`); `--dry-run` repairs, reports and
projections on live. The prune script runs from the canonical checkout against a scratch DB
(`/tmp/hv/<task>/state/state.sqlite`).

## Driving it

```bash
T=tabularasa@hrc-runtime:hvprobe
hv run <task> -- hrc admin runs sweep-zombies --dry-run --json
hv run <task> -- hrc admin runs reconcile-active --dry-run --json
hrc admin runs sweep-zombies --dry-run --json                 # live, read-only
hrc admin metrics report --since 1h --json | jq -c keys
hrc admin status --json | jq -c keys
hrc runtime diagnostics --json | jq -c '(.trips // .) | length'
hv run <task> -- hrc capture status $T --json
hv run <task> -- hrc admin broker-verify candidates agent:tabularasa:project:hrc-runtime:task:hvprobe --json | head -c 600
hv run <task> -- hrc admin broker-verify run --invocation <invocationId> --json | jq -c '{status, ok, ledger}'
hv run <task> -- hrc runtime sweep --dry-run --json
hv run <task> -- hrc runtime prune --dry-run --older-than 1s --status terminated --json   # lists the terminated runtime
hrc runtime sweep --dry-run --json | tail -1                  # live, read-only
hrc admin worktrees audit --json | jq -c keys
cd ~/praesidium/hrc-runtime && bun scripts/prune-hrc-event-deltas.ts --db /tmp/hv/<task>/state/state.sqlite | jq -c '{event, stop: .data.stopReason, tables: (.data.tables|map_values(.stopReason))}'
launchctl print gui/$(id -u)/com.praesidium.hrc-prune-deltas | grep -E 'state|last exit|runs'
grep -c '"event":"prune.failed"' ~/praesidium/var/logs/hrc-runtime/hrc-prune-deltas.log   # 0 in steady state
```

## Gotchas

- **`--runtime-buffer-retention-days 0` is refused** ("must be a positive number"), so you cannot make a
  fresh scratch's buffers eligible; a scratch dry-run shows `runtime_buffers.eligibleCount: 0` and every other
  table `skipped` (2026-10-05, `T-10297/07-maintenance/drive.txt`). That proves the path runs, not that it
  deletes.
- **Never point `prune-hrc-event-deltas.ts --apply` at the live DB by hand.** It shares the database with
  the daemon; launchd's paced run is the one writer. Look for failures as `prune.failed` lines in
  `var/logs/hrc-runtime/hrc-prune-deltas.log`: the `hrc-prune-deltas.err.log` beside it is 0 bytes since
  T-10854. The three `database is locked` lines from 2026-07-26 are in the old `var/logs/hrc-prune-deltas.err.log`;
  on 2026-10-19 there were 0 `prune.failed` lines and the job's last exit was 0. The new log's first line is
  old-format (its `.data` is null).
- The dry-run `admin runs` verbs on live answer `matched: 0` in steady state; a non-zero `matched` is the
  signal to look, not to `--yes`. On 2026-10-05 `reconcile-active` matched one: a run on
  `clod@wrkq:T-10327` with `reason: run_abandoned_by_runtime` while its runtime was `ready` with no
  `activeRunId` (`T-10350/07-maintenance/drive.txt`). Left for the owner; this skill never `--yes`es live.

## Proven when

Each verb answers its documented shape on the scratch (zero matches on a clean scratch), `capture status`
names the scratch runtime with `state: open`, `broker-verify candidates` lists the scratch invocation and
`broker-verify run` passes it, and the
prune dry-run reports per-table results with `runtime_buffers` `stopReason: complete`.

Driven 2026-10-19 (T-11363 upkeep) on installed d8451409, scratch `t-11363` and live read-only (the
terminated generation-1 runtime listed `pruned / dry_run`; live `runtime sweep` matched 24, skipped 24):
`var/wrkq-artifacts/T-11363/07-maintenance/drive.txt`.
