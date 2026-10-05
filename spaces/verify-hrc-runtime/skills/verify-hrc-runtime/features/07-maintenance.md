# 7. Maintenance

The repair and inspection cellar (`hrc admin --help`) and the scheduled retention job. Code:
`packages/hrc-cli/src/cli/handlers-runtime-sweep.ts`, `handlers-capture.ts`, `metrics-report.ts`,
`broker-verify/`, `worktree-prune.ts`, `run-diagnostics-render.ts`; server `sweep-*.ts`,
`first-turn-*.ts`, `request-metrics.ts`, `asp-toolchain.ts`; `scripts/prune-hrc-event-deltas.ts` and
`launchd/com.praesidium.hrc-prune-deltas.plist`. Docs: `docs/state-retention.md`, `docs/operations-runbook.md`.

## Sub-features

- `hrc admin runs sweep-zombies|reconcile-active [--older-than D] [--dry-run|--yes] [--json]`: one summary
  object (`matched`, `zombied` / `reaped`, `repaired`, `suspect`, `skipped`, `errors`). `recover-unstarted
  <runId>` withdraws one accepted run's broker submission (not driven: needs a stuck run).
- `hrc admin metrics report [--since D] [--json]`: `commands`, `counters`, `routes`, `slowest`, `largest`,
  `launch`, `diagnostics`.
- `hrc admin status --json`: ASP child toolchain selection (`binaries`, `toolchainRootActive`).
- `hrc runtime diagnostics [selector] [--json]`: `first_turn_missing` watchdog trips (read-only).
- `hrc capture status <target> --json`: the broker-authoritative capture state (`open`, `deferredCount`).
  `capture release` and `capture recover` are operator writes (not driven).
- `hrc admin broker-verify candidates <scopeRef> --json`: invocations verifiable against ledger and raw mirror.
- `hrc admin worktrees audit --json`: completed-task linked worktrees (`prune` removes; not driven).
- `scripts/prune-hrc-event-deltas.ts [--db P] [--apply] …`: bounded retention; without `--apply` it reports
  eligible counts per table. launchd runs it with `--apply --tables runtime_buffers` against the live DB.

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
hrc admin worktrees audit --json | jq -c keys
cd ~/praesidium/hrc-runtime && bun scripts/prune-hrc-event-deltas.ts --db /tmp/hv/<task>/state/state.sqlite | jq -c .
launchctl print gui/$(id -u)/com.praesidium.hrc-prune-deltas | grep -E 'state|last exit|runs'
```

## Gotchas

- **`--runtime-buffer-retention-days 0` is refused** ("must be a positive number"), so you cannot make a
  fresh scratch's buffers eligible; a scratch dry-run shows `runtime_buffers.eligibleCount: 0` and every other
  table `skipped` (2026-10-05, `T-10297/07-maintenance/drive.txt`). That proves the path runs, not that it
  deletes.
- **Never point `prune-hrc-event-deltas.ts --apply` at the live DB by hand.** It shares the database with
  the daemon; launchd's paced run is the one writer. `hrc-prune-deltas.err.log` holds three `database is
  locked` lines from 2026-07-26; the job's last exit was 0.
- The dry-run `admin runs` verbs on live answer `matched: 0` in steady state; a non-zero `matched` is the
  signal to look, not to `--yes`.

## Proven when

Each verb answers its documented shape on the scratch (zero matches on a clean scratch), `capture status`
names the scratch runtime with `state: open`, `broker-verify candidates` lists the scratch invocation, and the
prune dry-run reports per-table results with `runtime_buffers` `stopReason: complete`.

Driven 2026-10-05 (T-10297) on installed 5bdb6c4e, scratch `t-10297` and live read-only:
`var/wrkq-artifacts/T-10297/07-maintenance/drive.txt`.
