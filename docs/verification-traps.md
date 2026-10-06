# Verification traps: commands that answer confidently while checking nothing

Moved from the root `AGENTS.md`; linked from there and from [README.md](README.md).

The failures below all read as a clean result. A probe
that cannot fail is worse than no probe, because it manufactures confidence: on
2026-09-06 the first four turned up in a single day's work, twice producing a
"finding" that did not exist and once nearly stranding a landing. Before citing
any verification, ask what output it would produce if the thing being checked
were absent — if that output is indistinguishable from success, the check is not
one.

- **A missing key is not a null value.** `hrc server status --json` has no
  top-level `runningEqualsInstalled`; it lives at `.release.runningEqualsInstalled`
  and `.api.release.runningEqualsInstalled`. Querying the top level returns
  empty, which reads exactly like the daemon answering `null` — and got reported
  as a health-field bug that did not exist. Name the full path, and treat an
  empty answer as "wrong path" until you have proved the path is right.
- **`_` is a wildcard in SQL `LIKE`.** `LIKE '%submission_…_50%'` matched
  essentially every event on the runtime and returned 110 KB of noise that looked
  like data. Use `json_extract(col, '$.id') = '<literal>'` for an id.
- **A dirty-tree list is a snapshot of a tree several agents are mutating.**
  `just install`'s refusal is the authoritative read AT THE INSTANT IT RAN, and
  the tree moves underneath it — a reverted edit leaves no commit, so
  `git log -1 -- <path>` afterwards cannot see that the file was ever dirty and
  will contradict a correct report. Re-read when you act; never carry a snapshot
  into an attribution about who is holding what.
- **Never integrity-check a `cp` of the live state DB.** `state.sqlite` is
  WAL-mode and the daemon writes continuously, so a plain `cp` (even with the
  `-wal` sidecar) is a TORN copy: `PRAGMA integrity_check` on it returns dozens
  of `wrong # of entries in index` lines that say nothing about the real store.
  Snapshot with `sqlite3 -readonly <db> "VACUUM INTO '<snap>'"`, which is
  consistent and answers `ok`. Use the snapshot for migration dry runs too.
- **A piped `git push` tells you nothing about whether it worked.** `git push |
  tail -3` reports the exit code of `tail`, so a `! [remote rejected] … cannot
  lock ref` scrolls past and any `&& echo PUSHED` still fires. This repo is a
  SHARED worktree with several agents landing at once, so a lost push race is
  routine, not exotic. Capture the status: `git push > /tmp/push.log 2>&1; echo
  $?`, and confirm with `git status -sb` showing no `ahead` — an unpushed commit
  does not exist for anyone else.
- **`runtimes.updated_at` is a heartbeat.** Live runtime rows refresh it every
  ~5 s with no request in flight, so a before/after diff "changes" even when
  nothing touched the runtime. Prove "runtime untouched" by `status`,
  `active_invocation_id`, and `runtime_state_json.broker.brokerPid`.
- **A warmup count hides which brokers failed.** `broker.warmup.complete`
  reporting the same `attached`/`total` after a restart says nothing about
  whether the SAME runtimes are unreachable. Diff the `ipc_unreachable` runtime
  ids against the known set; a new id at an unchanged count is a regression.
- **The start response is not turn evidence.** On the headless route
  `hrc start --wait completed --json` returned `runtime.terminal: null` and no
  `finalMessage` for a turn that completed. Grade a turn from `hrc_events`: the
  final `turn.message` content and a `turn.completed` row for that `run_id`.
