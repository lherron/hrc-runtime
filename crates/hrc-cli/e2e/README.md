# CLI workflow tests

The landing gate (`just cargo-check`) starts `differential.py`, which actually
runs `status.py`, `metrics.py`, `passthrough.py`, `daemon_entrypoints.py` and
`client_errors.py`. Coverage-obligation names in differential's report do not
mean those other scripts ran. `metrics_isolation.py` is a shared helper.

`just e2e-native-full` is the separate post-push native workflow set; it does
not imply the remaining CLI qualification corpus ran. The scripts below stay
manual because they require explicitly owned seats, paired captures, private
ledger/daemon environments or model calls. Supply their `--help` inputs on
fresh disposable roots; never point a mutating qualification at a live seat.
Keep `copied_release.py`, `n5b_common.py`, `turn_protocol.py` and
`turn_validation.py`: they are shared helpers rather than independent scripts.

T-11945 comment C-32046 records the pre-deletion triage and its evidence.

| Script | Product claim / reason | Verdict |
| --- | --- | --- |
| `continuity.py` | Bun creates real continuity and metadata via public APIs. Both CLI binaries (requires explicit scratch/capture inputs; retained qualification) | keep-manual |
| `controls.py` | Real owned-seat control commands. No production roots or foreign mutations. (requires explicit scratch/capture inputs; retained qualification) | keep-manual |
| `launch.py` | Managed launch grammar and previews against an explicit scratch daemon. (requires explicit scratch/capture inputs; retained qualification) | keep-manual |
| `n5b_admin.py` | admin metrics/runs/broker-verify/events-drain/worktrees-audit: Bun oracle vs rusthrc. (requires explicit scratch/capture inputs; retained qualification) | keep-manual |
| `n5b_local.py` | server subscribers, server tmux status, runtime diagnostics/sweep/prune, (requires explicit scratch/capture inputs; retained qualification) | keep-manual |
| `n5b_monitor_pty.py` | monitor output under a real PTY: TTY format defaults, chalk color, width. (requires explicit scratch/capture inputs; retained qualification) | keep-manual |
| `n5b_monitor_reads.py` | monitor events/transcript/stats/show/session-report against a real owned seat. (requires explicit scratch/capture inputs; retained qualification) | keep-manual |
| `n5b_monitor_wait.py` | monitor wait (and blocking watch) against a real owned seat, at arm and live. (requires explicit scratch/capture inputs; retained qualification) | keep-manual |
| `n5b_monitor_watch.py` | monitor watch against a real owned seat: replay, conditions, follow, live. (requires explicit scratch/capture inputs; retained qualification) | keep-manual |
| `restart.py` | Restart parity on disposable scratch scopes, never an existing agent seat. (requires explicit scratch/capture inputs; retained qualification) | keep-manual |
| `restartme.py` | Self-restart parity on an owned runtime and isolated wrkq authority. (requires explicit scratch/capture inputs; retained qualification) | keep-manual |
| `resume.py` | Continuation resume plans/refusals on an owned scratch project. (requires explicit scratch/capture inputs; retained qualification) | keep-manual |
| `runtime.py` | Read-only differential commands against an explicitly provisioned real seat. (requires explicit scratch/capture inputs; retained qualification) | keep-manual |
| `send.py` | Literal send against owned disposable brokers, with no model dispatch. (requires explicit scratch/capture inputs; retained qualification) | keep-manual |
| `server_lifecycle.py` | Native lifecycle refusal parity on an owned daemon. (requires explicit scratch/capture inputs; retained qualification) | keep-manual |
| `server_start.py` | Start with real owned daemon processes and a controlled launchctl boundary. (requires explicit scratch/capture inputs; retained qualification) | keep-manual |
| `summon.py` | Strict target materialization, on unique scratch project/scopes only. (requires explicit scratch/capture inputs; retained qualification) | keep-manual |
| `targets.py` | Read-only placement and pane commands on a real owned seat. Verify scope (requires explicit scratch/capture inputs; retained qualification) | keep-manual |
| `turn_live.py` | Real model qualification on an explicitly owned daemon and scratch project. (requires explicit scratch/capture inputs; retained qualification) | keep-manual |
