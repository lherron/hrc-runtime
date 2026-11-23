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
  `| tail -1`; `--older-than` defaults to 30m. Native `reconcile-active` reaps only active runs with transport
  `sdk|tmux|headless` (`broker/reconcile.rs:71`); its abandoned pass takes every transport (`:323-325`) and labels
  any non-sdk/headless row, hrcpty included, `transport: "tmux"` (`:58-63`). A non-dry `sweep-zombies` or
  `reconcile-active` first withdraws unwritten broker submissions (`broker.zombie_withdraw`, 98e11490, b386d2e2), and a
  non-dry `reconcile-active` settles dead-broker submissions on its own read connection (`broker.submission.settled`,
  e8adf1dd); a dry-run shows neither (source-only, 2026-11-23; this skill never `--yes`es live).
  Bun only: the accepted-never-started settlement (`unstarted_submission_settled` rows, ed974915) is "not yet
  native" (`broker/reconcile.rs:5-6`).
- `~/.bun/bin/hrc admin metrics report [--since D] [--json]`: `commands`, `counters`, `routes`, `slowest`, `largest`,
  `launch`, `diagnostics`, `uncorrelatedServerCount`. Since fda12fed it reads every dated
  `<writer>-YYYY-MM-DD.ndjson` file (`cli`, `rusthrc-server`, `script`, `server`) and counts the `rusthrc` bin:
  `--since 1h` scanned 3 files and listed 40 `rusthrc …` command rows (2026-11-16; `admin/metrics_report/mod.rs:72-80`).
  The daemon deletes every writer's day files older than 14 d (`front/accounting.rs:175-196`).
- `~/.bun/bin/hrc admin metrics routes [--since D] [--by route|client|route,client] [--listener main|ingest|peer|registry]
  [--idle] [--json]` (T-11541): read-only rollup of `server-*.ndjson` request records (`count`, `records`,
  `errors`, `errorRate`, `ms.p50|p95|max`, `firstSeen`/`lastSeen`; `client` is the User-Agent `<name>/<version>`).
  It reads the native `rusthrc-server-<day>.ndjson` files since fda12fed (T-12304, completed): `--since 1h --by
  client` gave 11 rows from 8316 records, `praesidium-kernel/0.1.0` first with `count` 19185 over `records` 4346
  (2026-11-16). Server records are sampled, so `count` (weighted) exceeds `records` (lines); read `diagnostics
  {filesScanned, recordsScanned}` before trusting an empty answer (it was blind on native, 0 rows, through 2026-11-09). `--since` defaults to 7d; `suppressedPoll` is gone from the
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
  never pruned by them (2026-11-02, T-12291; still on 2026-11-16; product gap T-12303, open). `runtime prune`
  without `--dry-run` or `--yes` refuses "runtime prune requires --yes to mutate when stdout is not a TTY", rc 2.
- `~/.bun/bin/hrc runtime prune-window [--window D] [--max-minutes N] [--dry-run|--yes] [--json]` (5a27be45, T-12855): the
  mark-gated prune the nightly job runs (POST `/v1/runtimes/prune` `markGated: true`), which selects every
  unavailable runtime whatever its transport, hrcpty included. It needs a window (`--window` or the daemon's
  `HRC_RUNTIME_PRUNE_WINDOW`) and the lake's `<state>/prune-mark.json`: on the scratch it answered
  `stopReason: no_window` (`detail.env`), and with `--window 1s` `no_mark` (`detail.path`), rc 0, nothing deleted
  (2026-11-16, `T-13633/09-new-verbs/drive.txt`). A concurrent second call is 409 `prune_in_progress` (source-only). Dead ready/busy hrcpty seats are staled
  by the daemon's own aging pass instead (source-only, 2026-11-02: `broker/maintenance.rs` `hrcpty_aging`,
  logged as `runtime.hrcpty_aging_complete`).
- `~/.bun/bin/hrc admin status --json`: prints `/v1/status .aspToolchain`. **Vacuous on native:** `server.rs:1028`
  hard-codes `{toolchainRootActive:false, binaries:[]}`, so live answers that although its plist sets
  `HRC_ASP_TOOLCHAIN_ROOT=/Users/lherron/.bun/bin` (2026-11-02, still on 2026-11-16; product gap T-12306, open).
- `~/.bun/bin/hrc runtime diagnostics [selector] [--json]`: `first_turn_missing` watchdog trips (read-only).
- `~/.bun/bin/hrc capture status <target> --json`: the broker-authoritative capture state (`open`, `deferredCount`); native
  also projects that state into the DB, so it is a scratch verb (source-only, 2026-11-02:
  `crates/hrc-native/src/server/turns/io.rs:197-198`).
- `~/.bun/bin/hrc admin broker-verify candidates <scopeRef> --json`: `{scopeRef, candidates: [{schema, invocationId,
  runtimeId, runId, generation, driver, brokerDriver, state, …}]}`; native reads `state.sqlite` read-only
  directly, no daemon (source-only, 2026-11-02: `admin/broker_verify.rs:54-56`).
- `~/.bun/bin/hrc admin worktrees audit --json` (`mode`, `projectsInspected`, `results`, `summary`): completed-task linked
  worktrees. It calls `~/.local/bin/wrkq` by path since 6cf48b52 (T-12759, completed; `admin/worktrees.rs:258-261`),
  so it works in a prae seat and even with `PATH=/usr/bin:/bin`: `mode dry-run`, `summary {matched 9, wouldPrune 2,
  skipped 7}`, rc 0 (2026-11-16; it failed `spawnSync wrkq ENOENT` through 2026-11-09). `worktrees prune` (native)
  is not driven.
- Nightly retention is native (`ledger_prune/retention.rs`): backups, three metadata
  tables, first-turn bundles, mark-gated runtime prune, PASSIVE checkpoint and
  incremental vacuum.
  The 04:00–04:25 local schedule produces `retention.report` and `prune.report` (component `maintenance`), one
  each per night at 10:00–10:01Z: 2026-11-12..15 all `stopReason: complete`, retention `pagesReturned 20000`,
  `maxWriteHoldMs` 61–77, prune `eligible` = `deleted` 35–158, `window 14d`. The live log rotates, so read the
  `rusthrc-owner.log.*.gz` siblings: the current file starts after the last run and holds neither line
  (2026-11-16, `T-13633/07-maintenance/drive-extra.txt`). 2026-11-18..22 were all `complete` too, prune `deleted`
  9–145 with `maxWriteHoldMs` 81–740 and retention `maxWriteHoldMs` 53–612 (T-14430). The daemon's session sweep logs
  `session.retention_sweep_complete` (off with `HRC_SESSION_RETENTION_SWEEP_ENABLED=0`).
- Not the cellar but they terminate HRC runtimes: launchd `com.praesidium.reap-headless-ghostmux` (every 30 min,
  `-y`) reaps paneless ready runtimes idle more than 12 h (54535197); and native seat retirement (T-12236)
  logs `runtime.seat_retirement_complete` (the scratch's: `skippedByReason: {standing_seat: 2}`; live: `{attached_client
  12, busy 3, not_due 7, standing_seat 63}`, 2026-11-16). It terminates `task:` seats wrkq calls completed or idle ≥
  `HRC_TASK_SEAT_IDLE_HOURS` (4 h) every 300 s, sparing busy, read-write-attached, primary and standing seats,
  except `foundry`'s `primary`, which retires after 60 min idle since 95bc9188 (T-13432) (source-only, 2026-11-16:
  `broker/seat_retirement.rs:1-24,91-98`). A live seat that vanished may be either job.

## How to get to it

Writes and per-scope reads on a native scratch (`hv run <task> -- ~/.bun/bin/hrc admin …`); `--dry-run` repairs, reports
and projections on live. The Bun prune script is retired (888278a0); the scratch's mark-gated prune is
`runtime prune-window`.

## Driving it

```bash
T=tabularasa@hrc-runtime:hvprobe
hv run <task> -- ~/.bun/bin/hrc admin runs sweep-zombies --dry-run --json | tail -1
hv run <task> -- ~/.bun/bin/hrc admin runs reconcile-active --dry-run --json | tail -1
~/.bun/bin/hrc admin runs sweep-zombies --dry-run --json | tail -1       # live, read-only
~/.bun/bin/hrc admin metrics report --since 1h --json | jq -c keys
~/.bun/bin/hrc admin metrics routes --since 1h --by client --json | jq -c '{diag: .diagnostics, top: [.rows[:3][]? | {client, count, records}]}'   # native rows since fda12fed
ls ~/praesidium/var/state/hrc/metrics/ | sed -E 's/-[0-9].*//' | sort | uniq -c   # rusthrc-server files exist
~/.bun/bin/hrc admin status --json | jq -c .                              # {"toolchainRootActive":false,"binaries":[]}
~/.bun/bin/hrc runtime diagnostics --json | jq -c '(.trips // .) | length'
hv run <task> -- ~/.bun/bin/hrc capture status $T --json
hv run <task> -- ~/.bun/bin/hrc admin broker-verify candidates agent:tabularasa:project:hrc-runtime:task:hvprobe --json | head -c 700
hv run <task> -- ~/.bun/bin/hrc runtime sweep --dry-run --json | tail -1
hv run <task> -- ~/.bun/bin/hrc runtime prune --dry-run --older-than 1s --status terminated --json   # 0: hrcpty never selected
sqlite3 -readonly /tmp/hv/<task>/state/state.sqlite "select runtime_id, transport, status from runtimes where status='terminated'"   # the control
~/.bun/bin/hrc runtime sweep --dry-run --json | tail -1                  # live, read-only
hv run <task> -- ~/.bun/bin/hrc runtime prune-window --dry-run --json; hv run <task> -- ~/.bun/bin/hrc runtime prune-window --window 1s --dry-run --json   # no_window, no_mark
~/.bun/bin/hrc admin worktrees audit --json | jq -c keys
# Native C1b acceptance, offline copied store only (not in verify gate):
python3 crates/hrc-native/e2e/nightly_retention.py --binary <built-rusthrc> --source <offline-state.sqlite> --out <artifact-dir>/retention
# After operator deployment, inspect the actual owner log for both nightly reports:
for f in $(ls -tr ~/praesidium/var/logs/hrc-runtime/rusthrc-owner.log.*.gz); do gzcat $f | rg '"event":"(retention|prune).report"'; done   # rotated logs
```

## Gotchas

- **`runtime prune` matching 0 on a scratch proves nothing about hrcpty.** Show the control: on 2026-11-02 the
  scratch held 3 hrcpty runtimes terminated more than 1 s earlier and `--older-than 1s --status terminated`
  matched 0 (T-12291). Before native, the same drive listed the terminated runtime `pruned / dry_run`.
- **C1b is daemon-owned (T-13046).** At 04:00 local it ages backups, deletes eligible
  buffers/dispositions/stop counters, ages first-turn bundles, runs the mark-gated prune,
  then returns at most 20,000 free pages in chunks of at most 100. Every phase shares
  the 04:25 deadline. No window/no mark skips only the ledger prune; require both
  `retention.report` and `prune.report`, and check largest write hold (retention's `MAX_WRITE_HOLD` 500 ms; the
  prune's batches aim at ~250 ms but one runtime is the floor, so its `maxWriteHoldMs` can exceed both by design:
  418, 863, 200 and 1114 ms on 2026-11-12..15, `docs/state-retention.md`), deleted
  counts and pages returned. A fresh store with no eligible rows proves only scheduling.
  Use the keep-manual real-store differential for deletion evidence, with APFS clones
  under /tmp and relocated absolute paths. The old LaunchAgent is retired only after
  deploy readback proves the new running sourceCommit; `just install` alone does not
  activate this change or retire a job. This skill never alters installed jobs.
- **The native CLI no longer panics when a pipe reader closes early** (36e30532; T-12760 completed). Live
  `runtime list --json` (1.8 MB) piped to `head -c 5` exits 0 with no panic text (2026-11-23); through 2026-11-16 it
  printed `panicked at hrc-cli/src/metrics.rs:106:10: write stdout: … Broken pipe` and exited 1. A check needs
  output bigger than the 64 KB pipe buffer: a 39 KB `monitor events` piped to `head -c 200` passes either way.
- The dry-run `admin runs` verbs on live answer `matched: 0` in steady state; a non-zero `matched` is the signal
  to look, not to `--yes` (2026-10-05 `reconcile-active` matched a `run_abandoned_by_runtime` run on
  `clod@wrkq:T-10327`, T-10350). With hrcpty active runs outside `reconcile-active`'s reap, zero says little about them.
  This skill never `--yes`es live.

## Proven when

Each verb answers its documented shape on the scratch (zero matches on a clean scratch), `capture status`
names the scratch runtime with `state: open`, `broker-verify candidates` lists each scratch invocation,
`runtime prune-window` stops at `no_window`/`no_mark` on the scratch, the rotated live log holds a `complete`
`retention.report` and `prune.report` per night, and the open product gaps (status vacuous T-12306, `runtime
prune|sweep` skip hrcpty T-12303) still reproduce or are gone with a commit to cite (the broken-pipe panic
T-12760 is gone since 36e30532).

Driven 2026-11-23 (T-14430 upkeep) on a native scratch (rusthrc, release-20261122204127910-10417, 4b31f208)
and live read-only (scratch `admin runs` and `runtime sweep|prune` dry-runs all 0 with 2 terminated hrcpty rows as
the control; live `sweep-zombies` 0, live `runtime sweep` matched 4 skipped 4; diagnostics 11 trips live; five
nights of `complete` nightly reports; T-12306 and T-12303 still open, T-12760 fixed): evidence
`~/praesidium/var/wrkq-artifacts/T-14430/{07-maintenance,03-turns-monitor,evidence/t-14430}`.
