# State retention

This document is the canonical retention policy for HRC's live `state.sqlite`
database. The observation-table policy was revised on 2026-07-28 after sustained
broker traffic grew the database to 33 GB and synchronous SQLite scans starved
the HRC server main thread.

## Retention policy

Non-delta observation events are **keep-forever**. Rows in `events`,
`hrc_events`, and `broker_invocation_events` have no TTL and are not aged out by
the scheduled job (Lance ruling, 2026-07-28). Only completed-run rows in
`runtime_buffers` expire, on a default 1-day retention period. The launchd job
runs `scripts/prune-hrc-event-deltas.ts` nightly; the filename and job label are
retained for installation compatibility even though the script now enforces
general state retention rather than delta-only retention.

The policy is enforced by the tool, not merely by the launchd arguments. The
script prunes `runtime_buffers` only unless an operator names event tables
explicitly:

- `--tables <a,b|all>` selects which tables to prune; it defaults to
  `runtime_buffers`. `--tables all` is available for deliberate one-off
  maintenance.
- Unselected tables report `stopReason: "skipped"` and delete nothing. Skipping
  is a configuration choice, so it never downgrades the run's overall
  `stopReason`.
- The scheduled plist passes `--tables runtime_buffers` and carries no
  `--event-retention-days`, so a stray edit to the retention window cannot start
  deleting semantic history.

Because there is no bare `--apply` path that deletes event rows, deleting
observation history is always an explicit, auditable operator action.

The retention periods that remain are configuration, not constants:

- `--runtime-buffer-retention-days` /
  `HRC_RUNTIME_BUFFER_RETENTION_DAYS`
- `--event-retention-days` / `HRC_EVENT_RETENTION_DAYS` applies only when event
  tables are explicitly selected.

Because observation history is now unbounded, `hrc monitor transcript`, broker
forensics, capture verification, `/v1/events` replay, and monitor history are no
longer bounded by a retention window. Database growth is instead governed by what
gets written; that is tracked separately from this job.

The prune has SQL-level safety invariants independent of cutoff arithmetic:

- Resume barriers are permanent: `session.continuation_dropped`,
  `context.cleared`, `runtime.terminated`, and
  `broker.continuation.cleared`.
- Rows belonging to nonterminal runs or invocations are never eligible.
- A row for a runtime's current active run is never eligible.
- Runtime buffers remain while their runtime is live, even if the individual
  run has completed.
- Imported federation observations follow the same keep-forever policy as local
  ones. Delivery authority is different: federation outboxes, pending envelopes, and
  unacknowledged deliveries are not observation tables and are never touched by
  this job.

There is no archive migration. Observation history is retained in the live state
database; only `runtime_buffers` rows past their window are deleted.

## Freelist control

The database must use `PRAGMA auto_vacuum=INCREMENTAL` (mode `2`). Installing
the pointer map into an existing database requires one coordinated full
`VACUUM`; it cannot be retrofitted by `incremental_vacuum` alone. The nightly
job fails before deleting anything when the mode is not `INCREMENTAL`, then
runs `PRAGMA incremental_vacuum` after its batched deletes. The reclaim limit is
configurable with `--incremental-vacuum-pages` /
`HRC_INCREMENTAL_VACUUM_PAGES`; `0` (the default) drains the freelist.

Freelist reclaim is chunked, never issued as a single unbounded
`PRAGMA incremental_vacuum`. On 2026-07-28 that unbounded form drained a
4,971,864-page freelist inside one write transaction: measured at about 3.9 ms
per page it held the writer lock for over four hours, every daemon write failed
its 5 s busy timeout, and the daemon eventually crashed. The reclaim now runs in
`--incremental-vacuum-chunk-pages` steps, adapted at runtime toward
`--max-write-hold-millis`, with a yield between each. `--incremental-vacuum-pages`
still selects how much total work to attempt; the deadline decides how much of it
fits tonight.

Full `VACUUM` is deliberately not available through the nightly script. It
requires an offline maintenance window and sufficient disk headroom.

## Writer-lock discipline

The job writes to the same database the daemon is serving from, so it is built
to be interruptible rather than fast. These guards are not tuning knobs of
convenience; they are what makes the job incapable of starving the daemon as the
database grows:

- `--deadline-minutes` (default 30, `HRC_PRUNE_DEADLINE_MINUTES`, `0` disables)
  is a hard wall-clock budget. On expiry the run finishes its current batch,
  reports `deadlineExceeded: true` with a `stopReason` of `deadline`, and exits
  `0`. Partial retention is the designed outcome; the next run resumes.
- `--pace-millis` (default 250) is the minimum yield between write steps. Each
  step actually yields for at least as long as it just held the lock, capped at
  five seconds, so the daemon always gets a window inside its own busy timeout.
- `--max-write-hold-millis` (default 500) is the target ceiling for one write
  step and drives the vacuum and batch size adaptation.
- `--max-duty-cycle` (default 0.25) bounds the share of wall-clock time the job
  may hold the writer lock, by yielding several times longer than each hold.
  Bounding a single hold is not sufficient on its own: the daemon has write
  paths that surface `SQLITE_BUSY` immediately instead of waiting out their 5 s
  busy timeout, so what those paths actually see is the probability of finding
  the lock held. A 25% duty cycle keeps that probability low; the reported
  `heldMillis` versus `pausedMillis` shows what a run actually achieved.
- `--busy-max-retries` (default 8) backs off exponentially on `SQLITE_BUSY`
  instead of spinning. Exhausting the ladder is not a failure: the phase stops
  with `stopReason: "busy"` and the run still exits `0`.

Deletes run before reclaim, so a tight budget always spends itself on retention
first and leaves free pages for the following night.

Counting eligible rows is a full predicate scan per table. It is the point of a
report run and pure overhead under `--apply`, so `--apply` skips it by default;
`--count-eligible` forces it and `--no-count-eligible` suppresses it. When the
counts are skipped, `eligibleCount` and `remainingEligibleCount` report `null`
rather than a fabricated `0` — a paced or deadline-bounded run genuinely does not
know what it left behind.

Before any bulk prune, take a full backup of `state.sqlite`. If the disk cannot
fit a full backup, defer the prune and surface that deferral; never perform the
bulk prune without its backup. Rolling nightly increments are exempt from this
precondition under C-10736.

The command split from T-06500 is intentional:

- The daemon liveness-gates aged tmux `ready` rows on its 300-second
  maintenance cadence and marks only fully abandoned rows `stale`. The stage
  uses the resolved stale-generation threshold (24 hours by default),
  explicitly skips `busy`/owned/live/ambiguous rows, and never deletes.
- Manual `runtime sweep` uses the same liveness gate and resolved default age
  boundary; its filters remain available for operator-directed aging.
- `runtime prune` reaps rows, defaults to `stale`, and is gated per T-05441.

`runtime prune` is the only stale-row-reaping surface.

## Registry-row retention — keep forever

Terminated `runtimes` rows are keep-forever history: no TTL and no pruning, ever.
Lance's 2026-07-18 ruling is recorded in T-06531 comment C-10793.

Federation binding-registry retirement rows and node-local epoch fences are
also keep-forever authority. They have no TTL: expiring either would turn an
ever-born identity back into a virgin namespace and permit an epoch-1
collision. A later active epoch makes an older local fence inert, but does not
delete it because registry recovery consumes the fence as reconstruction
evidence.

The controlling reason is resume-path integrity. Terminated rows anchor the
`scope_ref` → `host_session_id` → `harness_session_json` chain used by
`--resume`; deleting them could orphan resumable state. The table is tiny, so
there is no scale pressure that outweighs that risk.

## Index adequacy

The C-10743 audit measured 8571 `runtimes` rows on 2026-07-18 (about 8.5k):
terminated 7079 / stale 1381 / dead 72 / ready 37 / busy 2. This is a tiny table,
and registry history remains subject to the keep-forever policy. Its foreign read
paths are primary-key lookups, indexed joins, or tiny scans, so no missing index
matters at this row count:

- `hrc-cli/src/cli-runtime.ts` (`listInFlightWork`) filters
  `rt.status = 'busy'`, which selected about two rows at audit time, and joins
  runs through `active_run_id`; `idx_runtimes_active_run_id` covers that join.
- `hrc-capture-verifier/src/sqlite.ts` joins `runtimes` on `runtime_id` (PK).
- ACP disposition confirmed by inspecting
  `agent-control-plane/packages/acp-server/src/real-launcher.ts` on 2026-07-18:
  the live-runtime read near line 887 issues `SELECT runtime_id, status FROM runtimes`
  and filters on `host_session_id`, covered by
  `idx_runtimes_host_session_id`, before applying the transport and tmux filters
  to that host session's small result set. The lookup near line 340 in the
  current checkout is actually against `launches`, not `runtimes`; it filters
  `host_session_id` and `runtime_id`, covered by the corresponding
  `idx_launches_host_session_id` and `idx_launches_runtime_id` indexes. Thus the
  current ACP read paths do not justify a new `runtimes` index.
