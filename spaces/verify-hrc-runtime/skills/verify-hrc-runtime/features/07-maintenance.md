# 7. Maintenance

The native repair and inspection cellar (`~/.bun/bin/hrc admin --help`) and the scheduled retention job. Native CLI: `crates/hrc-cli/src/admin.rs` →
`admin/run_repair.rs`, `admin/metrics_report/{mod,report,routes}.rs`, `admin/broker_verify.rs`,
`admin/worktrees.rs`; `local/sweep.rs` (runtime sweep|prune), `local/diagnostics.rs`; `commands.rs` (admin status,
capture status). Daemon `crates/hrc-native/src/server/broker/{sweeps,reconcile,maintenance,seat_retirement,
first_turn}.rs`, `broker/startup/sweeps.rs`, `front/accounting.rs` (request log, metrics file), `server.rs`
(`/v1/status`). The historical Bun prune/repair script is retired (T-13053). Native nightly
retention: `broker/ledger_prune.rs`, `broker/ledger_prune/retention.rs` and
`crates/hrc-store/src/maintenance.rs`. Docs: `docs/state-retention.md`, `docs/operations-runbook.md`.

## Sub-features

- `~/.bun/bin/hrc admin runs sweep-zombies|reconcile-active [--older-than D] [--dry-run|--yes] [--json]`: NDJSON, one line
  per matched row and the summary last (`sweep-zombies`: `matched`, `zombied`, `skipped`, `errors`;
  `reconcile-active`: `matched`, `reaped`, `repaired`, `suspect`, `skipped`, `errors`), so read it with
  `| tail -1`; `--older-than` defaults to 30m. Native `reconcile-active` scans only runs with transport
  `sdk|tmux|headless`, so it never sees an hrcpty run (source-only, 2026-11-02: `broker/reconcile.rs:74,325`).
  Bun only: the accepted-never-started settlement (`unstarted_submission_settled` rows, ed974915) is "not yet
  native" (`broker/reconcile.rs:5-6`).
- `~/.bun/bin/hrc admin metrics report [--since D] [--json]`: `commands`, `counters`, `routes`, `slowest`, `largest`,
  `launch`, `diagnostics`, `uncorrelatedServerCount`. It reads `<state>/metrics/cli-*` and `server-*` files only,
  so its server rows are the Bun era's (source-only, 2026-11-02: `admin/metrics_report/mod.rs:66-72`).
- `~/.bun/bin/hrc admin metrics routes [--since D] [--by route|client|route,client] [--listener main|ingest|peer|registry]
  [--idle] [--json]` (T-11541): read-only rollup of `server-*.ndjson` request records (`count`, `records`,
  `errors`, `errorRate`, `ms.p50|p95|max`, `firstSeen`/`lastSeen`; `client` is the User-Agent `<name>/<version>`).
  **Blind on native:** the daemon writes `rusthrc-server-<day>.ndjson` (`front/accounting.rs:22`) and
  `routes.rs:70` keeps only names starting `server-`, so `--since 1h|24h` answers 0 rows while that day's
  `rusthrc-server` file held 235544 native request lines (2026-11-02); `--since 10d` returned 27 Bun-era rows on
  11-02 and 0 on 2026-11-09, the Bun files having aged out (product gap T-12304, open). `[]` is not "no
  traffic": count the `rusthrc-server` file beside it. `--since` defaults to 7d; `suppressedPoll` is gone from the
  rows and `--idle` (06521944; 0 occurrences, 2026-11-09).
- L3 request line: every listener writes one `component: http`, `event: http.request` line per request with
  `{listener, servedBy, method, route, path, status, durationMs, client, caller, requestId?, remote?, peer?}`
  (`caller` from `x-praesidium-caller`, `unknown`/`invalid` otherwise; last 2000 live lines: `praesidium-kernel:hrc@max3`
  662, `hrc-mail-injector` 582, `unknown` 18, 2026-11-09). Native-only routes are named by path, not `unmatched`
  (0 live `unmatched`; only unserved routes log it). On live
  it lands in `var/logs/hrc-runtime/rusthrc-owner.log` (`hrc-server.log` is the frozen Bun log), on a scratch in
  `serve.log` (148 `servedBy: "native"` lines, 2026-11-02, T-12291). All completed non-stream
  requests write a line; streams log open/close.
  `grep '"event":"http.request"' ~/praesidium/var/logs/hrc-runtime/rusthrc-owner.log | tail`
- `~/.bun/bin/hrc runtime sweep [--dry-run|--yes] [--older-than D] [--json]`: liveness-gates aged ready/busy runtimes
  (summary `matched`, `stale`, `terminated`, `skipped`, `errors`). `~/.bun/bin/hrc runtime prune [--dry-run|--yes]
  [--status S] [--older-than D] [--json]`: deletes orphaned runtime rows (default `stale`, 24h); a dry-run lists
  each match as `status: pruned, reason: dry_run`; a broker runtime whose evidence is held answers `skipped /
  offline_evidence_held` (`--dispose-retained-evidence` releases it, not driven). **Neither selects hrcpty
  rows:** `selected()` in `broker/maintenance.rs` admits only `tmux|headless|sdk`, so a terminated hrcpty seat is
  never pruned (2026-11-02, T-12291; product gap filed by T-12291). Dead ready/busy hrcpty seats are staled
  by the daemon's own aging pass instead (source-only, 2026-11-02: `broker/maintenance.rs` `hrcpty_aging`,
  logged as `runtime.hrcpty_aging_complete`).
- `~/.bun/bin/hrc admin status --json`: prints `/v1/status .aspToolchain`. **Vacuous on native:** `server.rs:1061`
  hard-codes `{toolchainRootActive:false, binaries:[]}`, so live answers that although its plist sets
  `HRC_ASP_TOOLCHAIN_ROOT=/Users/lherron/.bun/bin` (2026-11-02, still on 2026-11-09; product gap T-12306, open).
- `~/.bun/bin/hrc runtime diagnostics [selector] [--json]`: `first_turn_missing` watchdog trips (read-only).
- `~/.bun/bin/hrc capture status <target> --json`: the broker-authoritative capture state (`open`, `deferredCount`); native
  also projects that state into the DB, so it is a scratch verb (source-only, 2026-11-02:
  `crates/hrc-native/src/server/turns/io.rs:194-197`).
- `~/.bun/bin/hrc admin broker-verify candidates <scopeRef> --json`: `{scopeRef, candidates: [{schema, invocationId,
  runtimeId, runId, generation, driver, brokerDriver, state, …}]}`; native reads `state.sqlite` read-only
  directly, no daemon (source-only, 2026-11-02: `admin/broker_verify.rs:54-56`).
- `~/.bun/bin/hrc admin worktrees audit --json` (`mode`, `projectsInspected`, `results`, `summary`): completed-task linked
  worktrees (shells the bare name `wrkq` and `git worktree list`: `admin/worktrees.rs:263,277,392`).
  **Fails in a prae seat**, whose PATH has no `wrkq`: "wrkq projects failed: spawnSync wrkq ENOENT", rc 1; with
  `PATH=$HOME/.local/bin:$PATH` it answered `summary {matched 9, wouldPrune 1}` (2026-11-09; product gap
  T-12759). `worktrees prune` is Bun (not driven).
- Nightly retention is native (`ledger_prune/retention.rs`): backups, three metadata
  tables, first-turn bundles, mark-gated runtime prune, PASSIVE checkpoint and
  incremental vacuum.
  The 04:00–04:25 local schedule produces `retention.report` and `prune.report`.
  The historical Bun script keeps only `--strip-envelope-payloads` and
  `--restub-tool-results`, required by analytics integration tests; bare `--apply`
  is refused before opening a database. Neither operation is scheduled.
- Not the cellar but they terminate HRC runtimes: launchd `com.praesidium.reap-headless-ghostmux` (every 30 min,
  `-y`) reaps paneless ready runtimes idle more than 12 h (54535197); and native seat retirement (T-12236)
  logs `runtime.seat_retirement_complete` (the scratch's: `skippedByReason: {standing_seat: 1}`, 2026-11-02,
  T-12291). It terminates `task:` seats wrkq calls completed or idle ≥ `HRC_TASK_SEAT_IDLE_HOURS` (4 h) every
  300 s, sparing busy, read-write-attached, primary and standing seats (source-only, 2026-11-02:
  `broker/seat_retirement.rs:1-8,67-68`). A live seat that vanished may be either job.

## How to get to it

Writes and per-scope reads on a native scratch (`hv run <task> -- ~/.bun/bin/hrc admin …`); `--dry-run` repairs, reports
and projections on live. The prune script runs from the scratch's release copy against the scratch DB
(`/tmp/hv/<task>/state/state.sqlite`).

## Driving it

```bash
T=tabularasa@hrc-runtime:hvprobe
hv run <task> -- ~/.bun/bin/hrc admin runs sweep-zombies --dry-run --json | tail -1
hv run <task> -- ~/.bun/bin/hrc admin runs reconcile-active --dry-run --json | tail -1
~/.bun/bin/hrc admin runs sweep-zombies --dry-run --json | tail -1       # live, read-only
~/.bun/bin/hrc admin metrics report --since 1h --json | jq -c keys
~/.bun/bin/hrc admin metrics routes --since 1h --by client --json | jq -c '[.rows[]? | {client, count}]'   # [] on native
ls ~/praesidium/var/state/hrc/metrics/ | sed -E 's/-[0-9].*//' | sort | uniq -c   # rusthrc-server files exist
~/.bun/bin/hrc admin status --json | jq -c .                              # {"toolchainRootActive":false,"binaries":[]}
~/.bun/bin/hrc runtime diagnostics --json | jq -c '(.trips // .) | length'
hv run <task> -- ~/.bun/bin/hrc capture status $T --json
hv run <task> -- ~/.bun/bin/hrc admin broker-verify candidates agent:tabularasa:project:hrc-runtime:task:hvprobe --json | head -c 700
hv run <task> -- ~/.bun/bin/hrc runtime sweep --dry-run --json | tail -1
hv run <task> -- ~/.bun/bin/hrc runtime prune --dry-run --older-than 1s --status terminated --json   # 0: hrcpty never selected
sqlite3 -readonly /tmp/hv/<task>/state/state.sqlite "select runtime_id, transport, status from runtimes where status='terminated'"   # the control
~/.bun/bin/hrc runtime sweep --dry-run --json | tail -1                  # live, read-only
~/.bun/bin/hrc admin worktrees audit --json | jq -c keys
# Native C1b acceptance, offline copied store only (not in verify gate):
python3 crates/hrc-native/e2e/nightly_retention.py --binary <built-rusthrc> --source <offline-state.sqlite> --out <artifact-dir>/retention
# After operator deployment, inspect the actual owner log for both nightly reports:
rg '"event":"(retention|prune).report"' ~/praesidium/var/logs/hrc-runtime/rusthrc-owner.log
```

## Gotchas

- **`runtime prune` matching 0 on a scratch proves nothing about hrcpty.** Show the control: on 2026-11-02 the
  scratch held 3 hrcpty runtimes terminated more than 1 s earlier and `--older-than 1s --status terminated`
  matched 0 (T-12291). Before native, the same drive listed the terminated runtime `pruned / dry_run`.
- **C1b is daemon-owned (T-13046).** At 04:00 local it ages backups, deletes eligible
  buffers/dispositions/stop counters, ages first-turn bundles, runs the mark-gated prune,
  then returns at most 20,000 free pages in chunks of at most 100. Every phase shares
  the 04:25 deadline. No window/no mark skips only the ledger prune; require both
  `retention.report` and `prune.report`, and check largest write hold (500 ms), deleted
  counts and pages returned. A fresh store with no eligible rows proves only scheduling.
  Use the keep-manual real-store differential for deletion evidence, with APFS clones
  under /tmp and relocated absolute paths. The old LaunchAgent is retired only after
  deploy readback proves the new running sourceCommit; `just install` alone does not
  activate this change or retire a job. This skill never alters installed jobs.
- **The native CLI panics when a pipe reader closes early.** `hrc runtime list --all-nodes --json | head -c 20`
  printed `panicked at hrc-cli/src/metrics.rs:106:10: write stdout: … Broken pipe` and exited 1 (2026-11-09;
  product gap T-12760). Write to a file and read that, or ignore the panic text after `| head`.
- The dry-run `admin runs` verbs on live answer `matched: 0` in steady state; a non-zero `matched` is the signal
  to look, not to `--yes` (2026-10-05 `reconcile-active` matched a `run_abandoned_by_runtime` run on
  `clod@wrkq:T-10327`, T-10350). With hrcpty seats invisible to `reconcile-active`, zero says nothing about them.
  This skill never `--yes`es live.

## Proven when

Each verb answers its documented shape on the scratch (zero matches on a clean scratch), `capture status`
names the scratch runtime with `state: open`, `broker-verify candidates` lists the scratch invocation and
`stopReason: complete`, and the product gaps (routes blind T-12304, status vacuous T-12306, hrcpty never pruned
T-12303, worktrees audit off PATH T-12759) still reproduce or are gone with a commit to cite.

Driven 2026-11-09 (T-12756 upkeep) on a native scratch (rusthrc, release-20261108171912823-43877, 846648d8)
and live read-only (scratch `admin runs` and `runtime sweep|prune` dry-runs all 0 with 2 terminated hrcpty rows as
the control; live `sweep-zombies` 0, live `runtime sweep` matched 18 skipped 18; diagnostics 50 trips live;
`prune.failed` 0): evidence `~/praesidium/var/wrkq-artifacts/T-12756/{07-maintenance,09-product,evidence/t-12756}`.
