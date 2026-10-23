# Mandatory P0 assertion observations

Every row is mandatory. `validate_case_observations` runs on raw artifacts during
execution and again during comparison; profile predicates supplement these
validators and cannot replace them. Missing observations are nonpassing.
`summary.json` reports overall checks as well as case assertions: a label alone
is not qualification. Full source inventory coverage remains distinct.

| Case / named assertions | Concrete observation and discriminating refusal |
| --- | --- |
| identity: installed-identity, owner-paths, effective-destinations, bun-alone | Real CLI envelope and HTTP status, exact roots/socket, foreground owner PID/argv, ASP declaration release and resolved scratch roots, both authority locators/token-file identities, peer config, scratch process inventory with no Rust execution owner. Required status field/type or installed tuple missing fails. Source surface always remains GAP. |
| cold: scope-lane-generation-runtime, two-real-identities, two-final-messages, two-completed | Actual resolve/start/invoke responses, projected lifecycle SQL and raw broker envelope/event SQL. Two distinct nonempty turn+invocation identities, exactly fenced final OK and terminal for each runtime/scope/lane/generation. Legacy messages join only inside terminal fences to matching raw broker message/terminal identity. No requirement for a run row on an ordinary broker turn. Empty/one-turn/missing-identity controls fail. |
| lifecycle: pty-attached, pty-detached | Controlling PTY child actually appears in the scratch tmux list-clients with exact PID, tty, target session/window while alive. Explicit detach exits 0; client disappears; child exits 0 and same runtime remains alive. Error-output/nonexistent-target control fails. |
| lifecycle: restart-generation, resume-final, terminated-substrate | Restart response advances expected generation; successor terminal observed by host fence. Resume-continuation and start responses plus actual successful terminal; terminate response and exact born runtime process/substrate absence. Restart mutates last, after independent reads/streams. Timeout cannot stand in for completion. |
| finite: nonempty-state, full-short-page | Actual public page responses: nonempty full limit=1 page with scan below head, a short ordered unique page reaching head. Duplicate pages or missing scan/head fields fail. |
| finite: holes-spill-highwater, cursor-mismatch | Canonical Bun store seed after real turns: append oversized tool result with actual runtime ID, delete an interior and highest sequence. Readonly global highwater/row holes/blob count; deleted IDs absent while head remains; public page retains the canonical spill descriptor and bounded stub for a result larger than 512 KiB. Wrong incarnation returns exact cursor_invalid refusal. Fixture data is explicitly marked and never counted as model turns. |
| streams: replay-live, ordered-unique, abort-timeout | Real NDJSON ready frame with incarnation and replay head; parsed unique ordered event sequences include replay <=head and a later real terminal >head under the same incarnation. Follower closes and joins under bounded deadline, preserving errors/timing. Arbitrary output, empty/replay-only or duplicates fail. |
| errors: malformed-uri-json, missing-field, wrong-method, unknown-route, retired-callbacks | Exact malformed JSON bytes, missing-field request, wrong method, unknown path, all five launch callbacks and hook ingress returning 410. Raw status/error bodies retained. |
| direct: cli-help-alias, monitor-show-watch-wait, json-ndjson-exits | Real CLI command argv/exit/stdout/stderr for help and monitor show/watch/wait. Watch must emit nonempty parsed NDJSON objects. A successful show cannot prove wait. Command aliases/options separately covered by frozen executable Commander inventory. |
| direct: run-bearing-export-annotation, export-readback, sdk-real-read | Supported invoke creates an actual HRC run ID; annotate and export use that same run ID and exact correlation attemptRef is read back. Installed SDK HrcClient health through scratch socket returns ok:true. Empty/wrong-run exports fail. |
| wrkq: isolated-real-publication | Real scratch authority DB project_events readback: server and session/turn facts, correct node attributes, distinct nonempty idempotency keys. Ordinary remote client bootstrap prerequisites retained. No fixture post counts as publication. |
| wrkq: two-cursor-owners | Readonly wrkq_ledger_cursors snapshots before cold birth and after workload. Both exact stream names present; session-project-events advances while server-project-events retains its separately acknowledged server highwater. Node label without both snapshots fails. Both tails separately inventoried with their own retry/progress semantics. |
| wrkq: unavailability | A separate admitted foreground HRC owner with both locators explicitly rpc://127.0.0.1:1 actually emits server_project_event.post_failed for server.started while its server cursor remains zero below the source event. Capture real process/DB/log and completed owned-process teardown. HRC may become ready; readiness is not successful publication. CLI connection refusal is corroboration only. Cold local initialization refusal is a separate setup observation. Successful lifecycle/publication uses the working scratch authority. |
| fallback: fallback-tuple, bun-alone-repeat, measured-latency-resource | Matching explicit status release/paths before and after 35 timed real finite requests, RSS/CPU observation, source/process proof for Bun owner. Samples are reported as observations, never release thresholds. |
| jobs: inventory-closure, explicit-downstream-gaps | Executed extractor equals frozen source/hash/schema registrations with no unresolved or duplicate identity. Every obligation has a case and downstream owner; this proves inventory completeness only. |
| jobs: startup-stop-effects | Real foreground JSON log includes start-ready and broker-warmup; same scratch DB includes actual server.started and completed server.stopped with PID attribution from setup stop/start. Startup alone fails. Operator teardown retains final stop evidence and process/socket/publication-child cleanup. |

Negative checker controls run without a daemon; their claim is checker-control
and cannot certify these workflows. Real profile artifacts preserve exact
commands, failures and timings. A mandatory infrastructure failure remains
nonpassing even when independent workflows finish successfully.

The first corrected-source run returned a resume successor session projection
whose lastAppliedIntentJson named the production agent root. This field is
preserved in the raw response. Source explanation:
`target-message-successor-handlers.ts:normalizeLocalProjectSuccessorIntent`
re-resolves local placement through `resolveNodeLocalPlacement` at successor
minting, replacing the supplied placement in that returned session intent.
Resume-continuation itself mints the successor and does not start its runtime.
The profile then explicitly calls runtimes/start with the original scratch
intent. The operative `runtime_operations.preparation_json` for initial,
restarted and resumed runtimes contains the scratch agent/project roots in both
intent and ASP response.plan.placement, and scratch cwd in resolvedBundle and
admission.execution.dispatchRequest.startRequest.spec.process. These frozen
preparations, not the intermediate successor projection, bind actual dispatch.
The runner now reads each generation's raw preparation through readonly SQL,
requires exact scratch roots and correlates its runtime IDs with the actual
start/restart responses. A production prepared root fails a discriminating
control. No response is rewritten and no Bun behavior is changed for this test.
