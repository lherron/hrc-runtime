# 7. Maintenance

The repair and inspection cellar (`hrc admin --help`, which is the Bun CLI's commander help: every bare group
passes through) and the scheduled retention job. Native CLI: `crates/hrc-cli/src/admin.rs` →
`admin/run_repair.rs`, `admin/metrics_report/{mod,report,routes}.rs`, `admin/broker_verify.rs`,
`admin/worktrees.rs`; `local/sweep.rs` (runtime sweep|prune), `local/diagnostics.rs`; `commands.rs` (admin status,
capture status). Daemon `crates/hrc-native/src/server/broker/{sweeps,reconcile,maintenance,seat_retirement,
first_turn}.rs`, `broker/startup/sweeps.rs`, `front/accounting.rs` (request log, metrics file), `server.rs`
(`/v1/status`). Bun only: `packages/hrc-cli/src/broker-verify/` (`run`), `worktree-prune.ts`,
`handlers-capture.ts` (release|recover), `scripts/prune-hrc-event-deltas.ts` and
`launchd/com.praesidium.hrc-prune-deltas.plist`. Docs: `docs/state-retention.md`, `docs/operations-runbook.md`.

## Sub-features

- `hrc admin runs sweep-zombies|reconcile-active [--older-than D] [--dry-run|--yes] [--json]`: NDJSON, one line
  per matched row and the summary last (`sweep-zombies`: `matched`, `zombied`, `skipped`, `errors`;
  `reconcile-active`: `matched`, `reaped`, `repaired`, `suspect`, `skipped`, `errors`), so read it with
  `| tail -1`; `--older-than` defaults to 30m. Native `reconcile-active` scans only runs with transport
  `sdk|tmux|headless`, so it never sees an hrcpty run (source-only, 2026-11-02: `broker/reconcile.rs:74,325`).
  Bun only: the accepted-never-started settlement (`unstarted_submission_settled` rows, ed974915) is "not yet
  native" (`broker/reconcile.rs:5-6`). `recover-unstarted <runId>` is a Bun CLI verb over a native route
  (`broker/recover_unstarted.rs`; not driven: needs a stuck run).
- `hrc admin metrics report [--since D] [--json]`: `commands`, `counters`, `routes`, `slowest`, `largest`,
  `launch`, `diagnostics`, `uncorrelatedServerCount`. It reads `<state>/metrics/cli-*` and `server-*` files only,
  so its server rows are the Bun era's (source-only, 2026-11-02: `admin/metrics_report/mod.rs:66-72`).
- `hrc admin metrics routes [--since D] [--by route|client|route,client] [--listener main|ingest|peer|registry]
  [--idle] [--json]` (T-11541): read-only rollup of `server-*.ndjson` request records (`count`, `records`,
  `errors`, `errorRate`, `ms.p50|p95|max`, `firstSeen`/`lastSeen`; `client` is the User-Agent `<name>/<version>`).
  **Blind on native:** the daemon writes `rusthrc-server-<day>.ndjson` (`front/accounting.rs:22`) and
  `routes.rs:88` keeps only names starting `server-`, so `--since 1h|24h` answers 0 rows while that day's
  `rusthrc-server` file held 235544 native request lines; `--since 10d` returns 27 Bun-era rows (2026-11-02,
  T-12291; product gap filed by T-12291). `[]` is not "no traffic": count the `rusthrc-server` file beside it.
- L3 request line: every listener writes one `component: http`, `event: http.request` line per request with
  `{listener, servedBy, method, route, path, status, durationMs, client, requestId?, remote?, peer?}`; on live
  it lands in `var/logs/hrc-runtime/rusthrc-owner.log` (`hrc-server.log` is the frozen Bun log), on a scratch in
  `serve.log` (148 `servedBy: "native"` lines, 2026-11-02, T-12291). All completed non-stream
  requests write a line; streams log open/close.
  `grep '"event":"http.request"' ~/praesidium/var/logs/hrc-runtime/rusthrc-owner.log | tail`
- `hrc runtime sweep [--dry-run|--yes] [--older-than D] [--json]`: liveness-gates aged ready/busy runtimes
  (summary `matched`, `stale`, `terminated`, `skipped`, `errors`). `hrc runtime prune [--dry-run|--yes]
  [--status S] [--older-than D] [--json]`: deletes orphaned runtime rows (default `stale`, 24h); a dry-run lists
  each match as `status: pruned, reason: dry_run`; a broker runtime whose evidence is held answers `skipped /
  offline_evidence_held` (`--dispose-retained-evidence` releases it, not driven). **Neither selects hrcpty
  rows:** `selected()` in `broker/maintenance.rs` admits only `tmux|headless|sdk`, so a terminated hrcpty seat is
  never pruned (2026-11-02, T-12291; product gap filed by T-12291). Dead ready/busy hrcpty seats are staled
  by the daemon's own aging pass instead (source-only, 2026-11-02: `broker/maintenance.rs` `hrcpty_aging`,
  logged as `runtime.hrcpty_aging_complete`).
- `hrc admin broker-verify run --invocation <id> [--jsonl P] [--json]` (Bun passthrough; it opens the store
  itself): verifies one invocation against its ledger and lifecycle projections (`status: pass`, `ok`,
  `ledger.statuses`, `lifecycle[]` broker seq → hrcSeq); exit 1 when `ok` is false.
- `hrc admin status --json`: prints `/v1/status .aspToolchain`. **Vacuous on native:** `server.rs:1023`
  hard-codes `{toolchainRootActive:false, binaries:[]}`, so live answers that although its plist sets
  `HRC_ASP_TOOLCHAIN_ROOT=/Users/lherron/.bun/bin` (2026-11-02, T-12291; product gap filed by T-12291).
- `hrc runtime diagnostics [selector] [--json]`: `first_turn_missing` watchdog trips (read-only).
- `hrc capture status <target> --json`: the broker-authoritative capture state (`open`, `deferredCount`); native
  also projects that state into the DB, so it is a scratch verb (source-only, 2026-11-02:
  `crates/hrc-native/src/server/turns/io.rs:194-197`). `capture release|recover` are Bun CLI writes
  (not driven); native has no `/v1/runtimes/capture/release` route (`route.not_served` in the scratch serve log,
  2026-11-02, T-12291).
- `hrc admin broker-verify candidates <scopeRef> --json`: `{scopeRef, candidates: [{schema, invocationId,
  runtimeId, runId, generation, driver, brokerDriver, state, …}]}`; native reads `state.sqlite` read-only
  directly, no daemon (source-only, 2026-11-02: `admin/broker_verify.rs:54-56`).
- `hrc admin worktrees audit --json` (`mode`, `projectsInspected`, `results`, `summary`): completed-task linked
  worktrees (shells `wrkq` and `git worktree list`: source-only, 2026-11-02: `admin/worktrees.rs:263,392`).
  `worktrees prune` is Bun (not driven).
- `scripts/prune-hrc-event-deltas.ts [--db P] [--apply] …` (Bun, opens the DB itself): bounded retention;
  without `--apply` it reports eligible counts per table as one logging-standard line (`{ts, level, component,
  event: "prune.report", data}`; a failure is `event: "prune.failed"`, level `error`, exit 1, on stdout).
  Default tables `runtime_buffers` and `broker_projection_dispositions` (4b5d322b); the launchd job runs
  `--apply --tables runtime_buffers,broker_projection_dispositions,hrcmail_stop_refusals` against the live,
  now native-owned DB. The retired `events` table still reports `skipped`.
- Not the cellar but they terminate HRC runtimes: launchd `com.praesidium.reap-headless-ghostmux` (every 30 min,
  `-y`) reaps paneless ready runtimes idle more than 12 h (54535197); and native seat retirement (T-12236)
  logs `runtime.seat_retirement_complete` (the scratch's: `skippedByReason: {standing_seat: 1}`, 2026-11-02,
  T-12291). It terminates `task:` seats wrkq calls completed or idle ≥ `HRC_TASK_SEAT_IDLE_HOURS` (4 h) every
  300 s, sparing busy, read-write-attached, primary and standing seats (source-only, 2026-11-02:
  `broker/seat_retirement.rs:1-8,67-68`). A live seat that vanished may be either job.

## How to get to it

Writes and per-scope reads on a native scratch (`hv run <task> -- hrc admin …`); `--dry-run` repairs, reports
and projections on live. The prune script runs from the scratch's release copy against the scratch DB
(`/tmp/hv/<task>/state/state.sqlite`).

## Driving it

```bash
T=tabularasa@hrc-runtime:hvprobe
hv run <task> -- hrc admin runs sweep-zombies --dry-run --json | tail -1
hv run <task> -- hrc admin runs reconcile-active --dry-run --json | tail -1
hrc admin runs sweep-zombies --dry-run --json | tail -1       # live, read-only
hrc admin metrics report --since 1h --json | jq -c keys
hrc admin metrics routes --since 1h --by client --json | jq -c '[.rows[]? | {client, count}]'   # [] on native
ls ~/praesidium/var/state/hrc/metrics/ | sed -E 's/-[0-9].*//' | sort | uniq -c   # rusthrc-server files exist
hrc admin status --json | jq -c .                              # {"toolchainRootActive":false,"binaries":[]}
hrc runtime diagnostics --json | jq -c '(.trips // .) | length'
hv run <task> -- hrc capture status $T --json
hv run <task> -- hrc admin broker-verify candidates agent:tabularasa:project:hrc-runtime:task:hvprobe --json | head -c 700
hv run <task> -- hrc admin broker-verify run --invocation <invocationId> --json | jq -c '{status, ok, ledger}'
hv run <task> -- hrc runtime sweep --dry-run --json | tail -1
hv run <task> -- hrc runtime prune --dry-run --older-than 1s --status terminated --json   # 0: hrcpty never selected
sqlite3 -readonly /tmp/hv/<task>/state/state.sqlite "select runtime_id, transport, status from runtimes where status='terminated'"   # the control
hrc runtime sweep --dry-run --json | tail -1                  # live, read-only
hrc admin worktrees audit --json | jq -c keys
cd /tmp/hv/<task>/release && bun scripts/prune-hrc-event-deltas.ts --db /tmp/hv/<task>/state/state.sqlite | jq -c '{event, stop: .data.stopReason, tables: (.data.tables|map_values(.stopReason))}'
launchctl print gui/$(id -u)/com.praesidium.hrc-prune-deltas | grep -E 'state|last exit|runs'
grep -c '"event":"prune.failed"' ~/praesidium/var/logs/hrc-runtime/hrc-prune-deltas.log   # 0 (grep exits 1)
```

## Gotchas

- **`runtime prune` matching 0 on a scratch proves nothing about hrcpty.** Show the control: on 2026-11-02 the
  scratch held 3 hrcpty runtimes terminated more than 1 s earlier and `--older-than 1s --status terminated`
  matched 0 (T-12291). Before native, the same drive listed the terminated runtime `pruned / dry_run`.
- **`--runtime-buffer-retention-days 0` is refused** ("must be a positive number"), so a fresh scratch's
  buffers are never eligible: the dry-run proves the path runs (`runtime_buffers`,
  `broker_projection_dispositions` `complete`, the rest `skipped`), not that it deletes (2026-10-05, T-10297).
- **Never point `prune-hrc-event-deltas.ts --apply` at the live DB by hand.** It shares the database with the
  native daemon; launchd's paced run is the one extra writer. Look for failures as `prune.failed` lines in
  `var/logs/hrc-runtime/hrc-prune-deltas.log` (`hrc-prune-deltas.err.log` beside it is 0 bytes since T-10854);
  on 2026-11-02 there were 0 and the job's last exit was 0 (T-12291). The log's first line is old-format
  (`.data` null).
- The dry-run `admin runs` verbs on live answer `matched: 0` in steady state; a non-zero `matched` is the signal
  to look, not to `--yes` (2026-10-05 `reconcile-active` matched a `run_abandoned_by_runtime` run on
  `clod@wrkq:T-10327`, T-10350). With hrcpty seats invisible to `reconcile-active`, zero says nothing about them.
  This skill never `--yes`es live.

## Proven when

Each verb answers its documented shape on the scratch (zero matches on a clean scratch), `capture status`
names the scratch runtime with `state: open`, `broker-verify candidates` lists the scratch invocation and
`broker-verify run` passes it, the prune dry-run reports `runtime_buffers` and `broker_projection_dispositions`
`stopReason: complete`, and the three product gaps (routes blind, status vacuous, hrcpty never pruned) still
reproduce or are gone with a commit to cite.

Driven 2026-11-02 (T-12291 upkeep) on a native scratch (rusthrc, release-20261102082222127-69529, 9861ae0e)
and live read-only (scratch `admin runs` and `runtime sweep|prune` dry-runs all 0; live `sweep-zombies` 0,
live `runtime sweep` matched 23 skipped 23; diagnostics 50 trips live; capture `open`/0; `broker-verify run`
passed 30 applied events; launchd prune last exit 0, `prune.failed` 0): evidence
`~/praesidium/var/wrkq-artifacts/T-12291/{07-maintenance,08-attach,evidence/t-12291}`.
