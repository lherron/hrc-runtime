# State retention

This document is the canonical retention policy for HRC's live `state.sqlite`
database. The observation-table policy was revised on 2026-07-28 after sustained
broker traffic grew the database to 33 GB and synchronous SQLite scans starved
the HRC server main thread, and again on 2026-11-09 when the lake took over
history older than 14 days.

## Retention policy

HRC keeps a bounded operational window; the lake (hrc-analytics) holds
everything older, and HRC deletes a row only once the lake has taken it (Lance
rulings, 2026-11-09). The event ledgers `hrc_events` and
`broker_invocation_events` are pruned to a **14-day hot window**: a terminal
runtime untouched for 14 days is deleted with its whole cascade, ledger rows
included, but only behind the lake's verified prune mark. This revises the
2026-07-28 keep-forever ruling for those two tables. History older than the
window is read from the lake through its query server on svc; HRC has no
transcript router to it, and lake-only reads beyond the window are accepted
(Lance, 2026-11-09). The mechanism is the
[mark-gated runtime prune](#mark-gated-runtime-prune-14-day-window) below.

What stays keep-forever: `events`, `hrc_events` rows with no runtime (session,
input, context, server and store history), and every session-level and
collaboration table named below. The daemon's 04:00 node-local maintenance task
(T-13046) performs, in order: backup aging, the three metadata tables,
first-turn diagnostic bundle aging, mark-gated runtime prune, a PASSIVE WAL
checkpoint, then incremental vacuum. All phases share the 04:25 deadline. Metadata retention and vacuum run
with no prune window and no mark. The retired Bun LaunchAgent is removed during
deployment only after the new daemon's sourceCommit and running release are
verified; installation alone does not retire it.

`runtime_buffers` uses a 1-day cutoff, terminal runs (`completed`, `failed`,
`cancelled`, `zombie`) and terminal runtimes (`terminated`, `dead`, `stale`,
`crashed`) with no active run. Dispositions retain their 14-day committed-prefix
rule below. Stop refusals use the 14-day exactly-terminated rule below.

The daemon emits one `maintenance` / `retention.report` line with rows deleted
per table, backups removed, first-turn bundle counts/errors, pages returned,
largest write hold, elapsed time and stop reason. The mark-gated phase retains
its separate `prune.report` line. `ledger_prune/retention.rs` defines `PACE`
(250 ms), `MAX_WRITE_HOLD` (500 ms), `MAX_DUTY_CYCLE` (0.25), `VACUUM_PAGES`
(20,000), and `VACUUM_CHUNK` (100). Candidate discovery runs as a read, then a
bounded integer key set is rechecked under the writer. SQL that exhausts its
write budget is interrupted and rolled back before retrying smaller batches;
SQLite commit/fsync and rollback cannot be preempted by the VM progress handler.
Pacing releases the owner mutex between steps. Vacuum always has an explicit
page argument and never returns more than its nightly budget.

The historical Bun entry point now requires `--strip-envelope-payloads` or
`--restub-tool-results`, for hrc-analytics integration callers. It cannot perform
nightly retention, delta backlog deletion or historical tool-result spilling.

Once a node has a prune window, `hrc monitor transcript`, broker forensics,
capture verification, `/v1/events` replay, transcript search, prior-session
recap and seat stats reach back only as far as the window for
runtime-owned history. None of them says that anything older is missing; that
history is in the lake.

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

There is no archive migration. The daemon deletes aged `runtime_buffers`,
expired disposition metadata and stop-refusal counters; runtime-owned ledger history leaves HRC only
through the mark-gated prune.

## Mark-gated runtime prune (14-day window)

The HRC daemon prunes runtimes itself, as a scheduled maintenance task inside
the owning process (T-12855; contract: hrc-analytics `docs/prune-contract.md`,
approved 2026-11-09). There is no second writer and no separate job.

**Window.** `HRC_RUNTIME_PRUNE_WINDOW` in the daemon's environment, a duration
such as `14d`. This is the node's retention setting. Unset, the mark-gated phase deletes
no runtimes and reports `stopReason: "no_window"`; a node gets its window only after
its first prune has been run by hand and the lake's next reconcile has been
read.

**The mark.** After each verified nightly reconcile the lake writes
`prune-mark.json` beside `state.sqlite` (by temporary file and rename). It names
HRC's ledger incarnation, the reconcile's start time (`reconciled_at`) and two
anchors: one `hrc_events` row and one `broker_invocation_events` row, each a
primary key and its creation timestamp as stored. HRC trusts nothing else about
the lake and never checks the mark's age; an old mark only deletes less.

**What is deleted.** A runtime, with the full cascade of
`prune_runtime_manifest` (fifteen tables, `runtimes` last), when all hold:

1. the mark's incarnation equals `hrc_event_ledger_metadata`'s, and both anchor
   rows exist at their keys with exactly the mark's creation timestamps
   (compared as strings);
2. its status is `terminated`, `dead`, `stale`, `crashed` or `detached`;
3. `runtimes.updated_at` is older than the window and earlier than
   `reconciled_at`;
4. its highest `hrc_seq` and highest broker event id are strictly below the
   anchor keys, so the runtime owning an anchor row never qualifies;
5. none of the native prune's guards refuses it: an external lifecycle owner,
   held offline evidence, a live lease, tmux session or broker pid, an active
   run, an unsettled absorbed submission.

With no file, an unreadable one, an unknown `version`, a missing anchor, a
different incarnation or a mismatched anchor row, nothing is deleted.

**Schedule and write discipline.** 04:00 node-local, hard stop by 04:25 (the
lake's reconcile starts at 04:30), resuming the next night. Candidates are read
in pages by runtime id; eligible runtimes are deleted in batches of one
transaction each (all fifteen tables or none). The first batch is one runtime;
each later one is sized from the last batch's cost per runtime to hold the
store about 250 ms, at most 16 runtimes, with a pause between batches. One
runtime is the floor, so a runtime with a very large ledger holds longer;
`maxWriteHoldMs` reports the longest hold.

**Report.** Every run, scheduled or by hand, logs one `prune.report` line
(component `maintenance`): `trigger`, `dryRun`, `window`, the `mark` it read
(`reconciledAt`, `incarnation`, anchor keys) or `detail` saying why none,
`eligible`, `deleted`, `remaining`, `skipped` by reason, `rowsDeleted` per table
(`wouldDelete` on a dry run), `batches`, `maxWriteHoldMs`, `elapsedMs` and
`stopReason`: `complete`, `deadline`, `no_window`, `window_invalid`, `no_mark`,
`mark_unreadable`, `mark_version_unknown`, `incarnation_mismatch`,
`anchor_mismatch`, `shutdown` or `error`.

**By hand.** `hrc runtime prune-window [--window 14d] [--max-minutes 25]
[--dry-run | --yes] [--json]` runs the same selection on demand. Without
`--yes` it is a dry run. `--json` adds the deleted runtime ids and each skipped
runtime with its reason. A node's first prune runs this way; it frees far more
than a nightly run and is followed once by a full `VACUUM` in a planned
restart.

**What the prune relies on.** A ledger row's `ts` (`hrc_events`) or `time`
(`broker_invocation_events`) is never rewritten after insert, both ledgers stay
`AUTOINCREMENT` with `sqlite_sequence` never lowered, and the ledger
incarnation is minted once per database. A change to any of these breaks the
anchor check.

**Restoring `state.sqlite`.** Whoever restores `state.sqlite`, from any backup,
deletes `prune-mark.json` beside it in the same step. A mark left over from
before the restore can authorize one prune before the lake has seen the
restored store (Lance ruling, 2026-11-09: that window stays unsupported, and
removing the mark is part of a restore). The lake writes a fresh mark after its
next reconcile.

## Pre-activate store backups

`hrc-owner.sh activate --expect-commit` writes a full copy of the store to
`backups/pre-activate-<UTC stamp>-<pid>.sqlite` beside `state.sqlite` (2–25 GiB)
and deletes older ones. The daemon ages out what remains first in each nightly maintenance run, so a
node with no activation for weeks still gets the space back (T-12695, T-13046).

A backup goes when it is at least 7 days old, measured from the later of its
filename stamp and its mtime, and the store has moved past it. Each run reports the removed count as `backupsRemoved` in `retention.report`.
The following conditions keep a backup:

| reason | meaning |
|---|---|
| `inside-window` | Under 7 days old |
| `unreadable-name` | The name has no stamp, so its age is unknown |
| `rollback` | The store's `hrc_migrations` is not a strict superset of the backup's |
| `backup-unreadable`, `store-unreadable` | That comparison could not be made |

`rollback` is the check that no rollback has used the backup. HRC has no rollback
command to record one. Activation refuses to run without pending migrations, so
a successful one always leaves the store strictly ahead of its backup. Restoring
the backup puts the two level, as does a migration that failed after the backup,
and the file then stays until the next activation replaces it. Restoring a
backup over `state.sqlite` includes deleting `prune-mark.json` beside it in the
same step (see the mark-gated prune above).

## Staged owner releases

`hrc-owner.sh stage` prunes `var/hrc-owner/hrc-runtime-releases` as its last step
(T-12695). It keeps current, the newest 5, the release the running daemon reports
and any release a live process holds or was started from. A holder probe that
fails, or a daemon status with no answer, deletes nothing, and a prune failure
never fails the stage. The next stage tries again. `--dry-run` deletes nothing.

## Broker projection dispositions — terminal committed prefix

`broker_projection_dispositions` is deduplication metadata, not an event ledger.
The nightly batcher deletes an owning invocation's rows only when its state is
`exited`, `failed`, or `disposed`, its `updated_at` is more than **14 days** old,
and the row's `seq <= last_projected_seq`. The terminal projection sets
`updated_at`; later invocation updates conservatively delay expiration. An
unknown or invalid timestamp and every nonterminal state fail closed. Rows
without an owning invocation are eligible immediately. Ledger-inclusive runtime
prune deletes dispositions before deleting their invocation, in one transaction;
ordinary runtime prune retains both.

The durable per-invocation contiguous cursor survives compaction. An old replay
below it falls through the mapper's existing skip branch without duplicating
canonical events. Above-cursor islands remain authoritative regardless of age,
because retained-evidence recovery can repair gaps indefinitely. T-10632's
seven-day revivable hold bound does **not** expire incomplete outcome holds.
The 14-day terminal window is the approved two-times margin over that hold
bound; safety for indefinitely held evidence comes from the cursor condition.
Full-envelope divergence detection for replay against an invocation more than
14 days terminal is explicitly unsupported for the compacted prefix.

This phase uses the daemon's read-discovery, bounded-key writer recheck,
deadline, pacing and duty-cycle controls. Backup-free deletion is authorized
for this metadata table (T-11700); ledger deletion still requires the lake mark.

## Collaboration state — keep forever

The collaboration tables are also explicit **keep-forever** state. They are not
an accidental omission from maintenance, and they were not the source of the
prior multi-gigabyte observation-ledger growth:

- `messages` is the canonical local message and deduplication ledger. Startup
  replays it into collective-history observation so the crash gap between the
  bilateral message transaction and archive derivation is recoverable.
- `collective_history_messages` and `collective_history_observations` are the
  authority's canonical history and provenance. Delivered rows in
  `collective_history_replications` are durable checkpoints; deleting them
  would make every restart replay the corresponding local message.
- Retained `hrcmail_*` tables are durable local execution or recovery state around
  the wrkq-owned collaboration ledger: delivery intents and expiries,
  presentation receipts, birth refusals, seat hints, failure notices,
  ingress receipts, federated origins, and legacy envelope records.

Except for the terminated-runtime stop counters below, none has a TTL or standing
delete path. A future deletion policy requires its
own approved terminality and replay-fence contract; row age alone is not
authority to discard collaboration state. On the 2026-09-01 hrcdev store these
surfaces were small: 501 `messages`, 501 delivered replication checkpoints, no
collective-history message/observation rows, and only tens of populated hrcmail
execution rows in a 484 MiB database.

### Small-table retention limits (2026-10-23)

`collective_history_replications`: retain pending rows and delivered fingerprints.
`CollectiveHistoryCoordinator.start` re-enqueues all local messages; `enqueue`
needs the delivered fingerprint to suppress retransmission on every restart.
Read-only counts: max3 22,191 (all delivered), svc 0; the queue is source-local, not svc-only.

`roster_claims`: retain all 487 max3 rows, including archived successors.
`replayRecordedClaim` uses any-age keys to reject conflicting or superseded
claims; expiry would turn an old retry into a new claim-and-start operation.

`participant_address_reservations`: retain all 114 max3 rows (all held).
Reservations survive host retirement by design: TX-E transfers the same held
reservation to the successor. Release requires an explicit attributed operation;
retirement or age alone cannot free the address.

### Stop-refusal counters — 14 days, terminated runtimes only

`hrcmail_stop_refusals` held 357 rows on max3 on 2026-10-23. The Stop gate
(`stop-gate-handlers.ts` → `mailStopRefusals.evaluate`) reads these counters to
preserve per-obligation and runtime-lifetime refusal caps. A live runtime can
need its oldest counter indefinitely; row age alone cannot reset those caps.
Once the runtime is `terminated`, retain a 14-day diagnostic grace period on
**the refusal's `updated_at`**, then delete it. This grace is conservative
operational retention; terminality is what ends the live decision horizon.

The daemon includes this table on every node. The strict cutoff excludes exactly
14-day-old counters, invalid dates, missing runtimes, and every status other
than `terminated` (including `ready`, `busy`, `stale` and `crashed`).
Candidate discovery and the bounded-key DELETE both check status and age.
The metadata phase retains the runtime row; the separate mark-gated cascade
may subsequently prune it under the lake contract.

## Runtime artifact directories — `first_turn_missing` bundles

`first_turn_missing` diagnostic bundles (T-07235) are the first artifact class
HRC writes to its own filesystem on its own initiative, so they need a policy of
their own: no existing pass covered runtime artifact directories. Each bundle is
a directory keyed by the trip event id, under
`<runtimeRoot>/artifacts/<runtimeId>/first-turn-missing/<tripEventId>/`, holding
`manifest.json` and (when captured) `pane.txt`.

The nightly job prunes them as a step after the table retention, so a tight
wall-clock budget still spends itself on row retention first. Three rules, all
keyed off durable rows rather than filesystem guesses:

- keep at most `BUNDLE_KEEP` (3) bundles per `(runtimeId, generation)`;
- delete bundles older than `BUNDLE_DAYS` (14);
- remove orphan directories: a bundle directory with no linking
  `first_turn_missing.diagnostics` event, older than the 5 s assembly budget.
  That window is exactly the write-before-link crash gap — the directory is
  written first, then the linking event publishes the pointer.

Deleting a bundle removes the directory, the `runtime_artifacts` row through
a bounded owner transaction, and the `bundle_dir` pointer on the watch row. Deleting a bundle never
deletes the trip: the durable `first_turn_missing` event and its
`runtime_first_turn_watch` row are observation history and follow the
runtime-history policy above. A missing bundle degrades diagnosis, never detection.

## Freelist control

The database must use `PRAGMA auto_vacuum=INCREMENTAL` (mode `2`). New database
files select that mode before migrations create the first table, so they are
born with the required pointer map and their first scheduled prune can apply.
Installing the pointer map into an existing mode-0 database still requires one
coordinated full `VACUUM`; it cannot be retrofitted by `incremental_vacuum`
alone. The daemon refuses the three-table deletion and vacuum phases unless
mode is `INCREMENTAL`. Bundle aging shares that prerequisite; backup aging
runs first and independently.

Freelist reclaim is chunked: `VACUUM_CHUNK` is 100 and `VACUUM_PAGES` is 20,000.
The explicit page argument is always positive and bounded by the remaining
nightly budget. Full `VACUUM` requires an offline operator window. On 2026-07-28
an unbounded incremental vacuum held the writer for over four hours; neither
form is available in the scheduled task.

## Writer-lock discipline

The daemon is the sole nightly writer. Its metadata writes use `MAX_WRITE_HOLD`
(500 ms), `PACE` (250 ms), and `MAX_DUTY_CYCLE` (0.25). SQL execution is
interrupted at the smaller of the hold budget and remaining deadline, with
rollback on interruption. SQLite commit/fsync and rollback cannot be preempted
by its VM progress handler. The SQLite busy timeout is temporarily zero during
a maintenance write; a busy writer is yielded to rather than waited on. Failed
delete batches shrink toward one row; a failed single row ends that phase and
is reported, leaving it for the next night. The store mutex is released before
sleeping for at least the larger of 250 ms and three times the measured hold.
The sleep is capped by the 04:25 deadline.

Discovery is a separate read, with the night's deadline on its VM execution.
The DELETE receives only the adaptive-batch integer key set, searches by primary
key, and rechecks the full eligibility predicate under the writer. No write
begins after an expensive discovery has exhausted the deadline. Deletes precede
reclaim, so a tight night leaves free pages for reuse and the following night.
The PASSIVE checkpoint runs outside a transaction with the same owner admission,
hold measurement and pacing; it never waits for readers/writers. Its I/O, like
commit/fsync, cannot be preempted by the VM progress handler. `checkpointed`
records completion of that attempt, including a partial PASSIVE checkpoint.
The report counts actual deleted rows; it does not perform full-table eligible
or remaining scans.

Before any bulk prune, take a full backup of `state.sqlite`. If the disk cannot
fit a full backup, defer the prune and surface that deferral; never perform the
bulk prune without its backup. Rolling nightly increments are exempt from this
precondition under C-10736. The mark-gated runtime prune is exempt too, by
hand or nightly: the lake's verified mark replaces the pre-prune snapshot
(Lance ruling, 2026-11-09), because a row is deleted only once the lake holds
it.

The command split from T-06500 is intentional:

- The daemon liveness-gates aged tmux `ready` rows on its 300-second
  maintenance cadence and marks only fully abandoned rows `stale`. The stage
  uses the resolved stale-generation threshold (24 hours by default),
  explicitly skips `busy`/owned/live/ambiguous rows, and never deletes.
- Manual `runtime sweep` uses the same liveness gate and resolved default age
  boundary; its filters remain available for operator-directed aging.
- `runtime prune` reaps rows, defaults to `stale`, and is gated per T-05441.
- `runtime prune-window` (and its nightly task) deletes terminal runtimes past
  the window with their ledgers, only behind the lake's prune mark (above).
- The T-07598 one-off mneme burst cleanup is an explicit exception: `hrc admin
  runtime prune --runtime-ids-file <file> --include-ledgers --yes` deletes the
  selected runtimes' keep-forever ledgers only after an all-or-nothing orphan
  gate and exact three-scope allow-list check. It is not a standing retention
  policy or timer.

`runtime prune` is the only stale-row-reaping surface outside the mark-gated
prune.

## Registry-row retention

Terminated `runtimes` rows were keep-forever history under Lance's 2026-07-18
ruling (T-06531 comment C-10793). Since 2026-11-09 the mark-gated prune deletes
them with their cascade once they are past the window and the lake holds them;
the fenced T-07598 manifest cleanup is the other named exception.

Federation node-local retirement fences are also keep-forever authority. They
have no TTL: the ordered retirement operation deletes the shared active binding
only after the old-home fence is durable, and expiring that fence could restore
authority on the old home.

The original reason was resume-path integrity. The resume chain
`scope_ref` → `host_session_id` → `continuation_json` is read from the
`sessions` row, which no prune touches, so a seat whose every runtime has been
pruned is still summoned and resumes (prune contract gate 5).

## Session retention — keep forever, project narrowly

`sessions` rows are keep-forever, the same class as terminated `runtimes` rows
above and non-delta observation events. **No path deletes a session row**, and
that is a binding condition of the policy, not an implementation detail: Lance
ruled on it on 2026-08-25 (T-07575) in these words — *"as long as we never
delete."* Retention for sessions is therefore applied to **projection breadth**,
never to storage.

The defect that produced this section (T-07575): nothing retired a session at
all. `sessions` was absent from this document and from `RETENTION_TABLES`, so
the nightly job never touched it; the one archival mechanism that existed
(`POST /v1/sessions/archive-abandoned`) had no caller anywhere in either repo.
Four months of accumulation left 8,319 rows on the primary host, of which 5,807
still claimed `status: 'active'` while 28 held a live runtime. Every unscoped
consumer paid for all of it — `hrc list sessions` was 33 MB, and ACP's
`/v1/mobile/dashboard` served that scan verbatim to HRCMac.

### The bounded default projection

An unscoped `GET /v1/sessions` returns sessions whose `updated_at` falls inside
`HRC_SESSION_PROJECTION_DAYS` (default 7), **plus** every session holding a
`ready` or `busy` runtime regardless of age. The second arm matters: being live
is the strongest possible reason to be listed, so a long-running session that
has been quietly busy past the window never falls out of the default view.

Four doors widen or narrow that read, and each is explicit:

- `?scopeRef=` — **never bounded**. A scoped read returns every generation of
  that scope, always. This is the documented path to history, and it is what
  session resolution and resume use.
- `?all=true` — take the whole store. Only the affirmative spellings (`1`,
  `true`, `yes`) widen; a bare `?all` leaves the bound in place, because
  returning 8k rows on a typo is the failure this parameter exists to prevent.
- `?updatedSince=<iso8601>` — caller-chosen window. An unparseable value is
  rejected rather than silently replaced with the default.
- `?status=` and `?limit=` — narrow further; they never widen.

**The bound is never silent.** Every response carries `X-Hrc-Session-Total`,
`X-Hrc-Session-Returned` and `X-Hrc-Session-Withheld`. `hrc list sessions`
prints the withheld count and names the flags that reach past it; `--all` and
`--since` widen the server read, not only the render window.

Resolution paths opt out explicitly. `fetchSelectorSnapshot` passes
`all: true`, because a selector for a scope idle longer than the window must
still resolve: a bounded *view* must never become a lost *capability*.

### The idle-archive sweep

hrc-server runs the archival pass on its own daily timer
(`HRC_SESSION_RETENTION_SWEEP_ENABLED=0` disables it), through the internal
`archiveIdleSessions` function. The unused HTTP trigger was retired in T-11569.
It writes `sessions.status` and nothing else — it never deletes a row and never touches `continuation_json`.

A non-primary `active` session is archived when all of the following hold:

- it carries a continuation key;
- no runtime of its owns a non-terminal status;
- its last activity — the later of `sessions.updated_at` and its runtimes'
  `last_activity_at` — is older than `HRC_SESSION_IDLE_ARCHIVE_DAYS`
  (default 7).

Liveness wins over age, and an unparseable timestamp fails closed rather than
reading as infinitely old.

The continuation-key condition is load-bearing, and it is the one place where
archival could stop being a view change. `toTargetState` reports an archived
session **with** a key as `dormant`, which is accurate; without one it reports
`broken`, and `handleListTargets` drops it from `--includeDormant` listings
outright. Archiving a keyless session would therefore remove it from target
listings — a capability change, which the standing rule that archived is a view
filter and never a resume gate forbids. Keyless idle sessions stay `active` and
stay listed; the projection window already keeps them out of unscoped reads on
age, which is the actual defect.

### Task-seat retirement (T-12236)

Every 300 s (the first pass 300 s after boot, once brokers have reattached)
rusthrc retires live task seats. A `ready` runtime whose scope names a wrkq
task (`task:T-<digits>`) is terminated when that task is `completed`
(`wrkq.task.show`), or when its `last_activity_at` is older than
`HRC_TASK_SEAT_IDLE_HOURS` (default 4) whatever the task's state. There is no
other switch.

It never touches `task:primary`, named standing seats (`rca`, `minisvc`,
`primary-*`, …), app scopes, external lifecycle owners, a seat that is busy or
has an active run, a nonterminal run or a protected input, or an hrcpty seat
with a read-write client attached. The seat is first moved `ready` →
`stopping` by a compare-and-set, so a turn admitted after the scan wins.

Retirement is `hrc runtime terminate --no-drop-continuation`: the
`runtime.terminated` event carries `reason` (`task_completed` | `idle_ttl`),
`source: hrc-seat-retirement` and `droppedContinuation: false`; the session
stays `active` with its continuation, so the next message resumes the same
conversation in a new runtime. Each retirement logs `runtime.seat_retired`;
each pass logs `runtime.seat_retirement_complete` with `scanned`, `retired`,
`retiredByTrigger` and `skippedByReason`.

### hrcpty aging (T-12236)

The 300 s aging pass (`HRC_TMUX_AGING_ENABLED`) also judges `ready` hrcpty
seats, with no age cutoff, because the supervisor's own answer is the probe: a
seat whose hrc-pty supervisor is gone, whose broker exited, or (Claude seats
only — a Codex seat's pty child is a TUI respawned on attach) whose pty child
exited goes `stale` through the lease liveness path, which also ends what is
left of the lease. A supervisor that runs but does not answer is left alone.
Each pass logs `runtime.hrcpty_aging_complete`.

## Index adequacy

The C-10743 audit measured 8571 `runtimes` rows on 2026-07-18 (about 8.5k):
terminated 7079 / stale 1381 / dead 72 / ready 37 / busy 2. This is a tiny table. Its foreign read
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
  to that host session's small result set. The obsolete launch-record lookup
  was removed in T-10146; current ACP read paths do not justify a new
  `runtimes` index.

## Retired permission audit (T-11713)

Migration `0127_permission_audit_removal` drops the write-only
`permission_decisions` table and all its indexes. Its rows have no retention
requirement after Lance’s 2026-10-24 ruling. Broker policy still decides
permissions; HRC retains `permission.*` observations in `broker_invocation_events`,
`hrc_events`, and transcripts under the existing event retention rules. HRC has
no production caller of `invocation.permission.respond`.
