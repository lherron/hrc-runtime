# State retention

This document is the canonical retention policy for HRC's live `state.sqlite`
database. The policy, including registry-row retention, was ruled on 2026-07-18.

## Retention policy

Delta events have a 7-day retention period. The enforcement vehicle is the
honest prune script delivered by T-06453 in commit `b1cbccc`. The scheduled
nightly job and one-time backlog prune are delivered separately by T-06554,
not by this documentation task.

All other history must keep forever. Non-delta event kinds, including
`hrc_events`, finals, and messages, are not pruned. There is no archive migration;
this history stays in the live state db.

Before any bulk prune, take a full backup of `state.sqlite`. If the disk cannot
fit a full backup, defer the prune and surface that deferral; never perform the
bulk prune without its backup. Rolling nightly increments are exempt from this
precondition under C-10736.

The command split from T-06500 is intentional:

- `sweep` marks live runtimes stale and never deletes rows.
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
and non-delta history remains subject to the keep-forever policy. Its foreign
read paths are primary-key lookups, indexed joins, or tiny scans, so no missing
index matters at this row count:

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
