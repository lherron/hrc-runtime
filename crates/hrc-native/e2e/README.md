# Native workflow tests

`just cargo-check` runs `kernel_fold.py`, `runtime_created.py`,
`kernel_fd_cost.py`, `foundation.py`, `store_migration.py`,
`lifecycle_publication.py` and `command_runs.py`, plus the CLI differential.
Rust tests create stores through the library migrator; Python drivers use
`rusthrc store migrate`. These native drivers need no Bun for store creation.
The CLI differential still needs its Bun oracle, as do the manual comparisons
and drivers exercising Bun repositories, SDKs or a Bun backend.

The native-only owner/route/lifecycle drivers run individually with
`--binary <rusthrc> --artifacts <directory>`; `routes.py`, `target_list.py`,
`ensure_archived_successor.py` and `accounting.py` also require a fresh
`--scratch-root /tmp/<name>`. `hrcpty_substrate.py` accepts `--root` instead.
They migrate private stores, launch native owners, assert literals or durable
invariants and clean their scratch roots. `lifecycle_credentials.py` uses the
shared deterministic real-hrcpty seat fixture. None of these needs a model.
The retired front proxy and full comparison orchestrator are deleted.

T-13074 follow-on List (retained, not native-qualified): runtime_reads,
maintenance, session_index, session_projection. T-13117 qualified lifecycle_actions,
lifecycle_peer, runtimes_start, turn_no_intent and steer_no_intent with private
native actors and deterministic broker turns. `error_wire.py` retains its
422 capability assertion and is product-blocked on native cold schema admission;
see the task's `error-wire-judgment.md`. Lists do not count as passing suites.

The manual corpus below remains explicit qualification, with scratch roots,
real seats, paired captures or node-specific prerequisites supplied by its
caller. A unit test cannot replace these broker/HTTP/projection claims.
Scripts named by an open parity task, including blocked tasks, are protected.
The triage was posted before deletion as T-11945 comment C-32046; the complete
task-body/comment reference snapshot is in that task's artifacts. The gate
signature history was checked through 178a9474; `evaluate` was unchanged.

Reusable modules: `lifecycle_fixture.py`, `no_intent_fixture.py`,
`hrc-cli/e2e/native_seat.py`, `n2_scratch.py`, `n3_scratch.py`, `n2_aspd_proxy.py`, and
`n4_federation.Node`. The scratch helpers are native by default and run no Bun;
`--installed-release` is read only when a caller asks for a Bun owner, release or
store fixture (T-13064).
`peer_caller.py` checks original caller attribution across two private native
nodes (locate, JSON read/write, stream, registry, concurrent/absent/invalid callers;
T-12661). It takes the standard binary/release/socket/scratch/artifacts arguments;
`--baseline` checks the pre-fix loss. It is manual qualification, outside the gate.
`peer_events_page.py` checks authenticated native peer pages, the 200-row
ceiling and local cursor/fence semantics against a private seeded ledger
(T-12257). It takes the same binary, installed-release, aspd-socket,
scratch-root and artifacts arguments as the federation drivers.
`events_kind_filter.py` checks the `category`/`eventKind` list filters (T-12422)
on a private seeded ledger: every unfiltered and single-value read is
byte-identical to `--baseline-binary` (the installed rusthrc), lists and the
category-or-kind union match the unfiltered history (over raw HTTP and through
hrc-sdk `watch()` with typed lists), and a filtered follow (and
bounded stream) cut after skipped rows resumes from the last delivered seq with
no gap or duplicate. Same arguments as `peer_events_page.py` plus
`--baseline-binary`.
`participant_eviction.py` drives external termination and context invalidation
against a native scratch daemon and the real ASP broker with its exported idle
`noop-driver` fixture. It proves finalization, HRC token removal, the old-attempt
reattachment fence before and after owner restart, idempotent audit, settled runs,
and preserved process, presentation, continuation, placement and held reservation.
It takes the standard binary/release/socket/scratch/artifacts arguments plus
`--broker-module <absolute path to harness-broker/dist/index.js>` for the ASP
broker module. `participant_eviction_broker.mjs` runs that module's real CLI and
records any fixture-driver stop/dispose call; that module is the only Bun left
(the descriptor is built by `participant_descriptor.py`). `result.json` and
`steps.json` are the repeatable evidence. Broker-side saved-token invalidation is
unsupported.

`participant_descriptor.py` builds and hashes participant broker descriptors
(descriptor.rs is the spec). `n2_restart_self.md` is an
operator recipe. Retained CLI helpers are documented in its README.

## Corpus decisions

Deleted entries stay listed to explain their removal; their source remains in git.

| Script | Product claim / reason | Verdict |
| --- | --- | --- |
| `accounting.py` | Native weighted request metrics, nonempty ledger, streams, writer recovery, cap and retention. | keep-manual |
| `broker_projection_failure.py` | Owner projection failure preserves a live hrc-pty runtime and credential, reports degradation and recovers; real broker exit crash-marks; transport-only close with running broker averts condemnation (T-12169). | keep-manual |
| `error_wire.py` | T-13074 List: follow-on conversion; not native-qualified. 422 assertion retained; product-blocked capability admission. | list |
| `ensure_archived_successor.py` | Native archived succession: generation, inherited intent/continuation, repeat identity and continuity. | keep-manual |
| `front_door_report.py` | none — task-time acceptance measurement for completed T-11822; the front proxy is now retired (T-13074) | delete |
| `lifecycle_actions.py` | Six granted restart/stop variants, valid non-primary credential refusals, reason/unknown-node refusals, drain admission, successor PID and durable grant facts. | keep-manual |
| `lifecycle_credentials.py` | Native real-runtime credential rotation, file protection, authorization refusals and revocation. | keep-manual |
| `lifecycle_peer.py` | Two private native owners: forwarded primary restart/stop grant, remote boot proof, non-primary refusals and origin unchanged. | keep-manual |
| `lifecycle_rows.py` | Native boot/stop facts, predecessor classification, lastRestart provenance and immutable history. | keep-manual |
| `lifecycle_shutdown.py` | Native clean/held-request shutdown and bounded drain, with listener variants. | keep-manual |
| `retention_auto_vacuum.py` | A non-incremental scratch store keeps expired bundle directories and artifact/watch pointers when retention refuses; `--reproduce` demonstrates the pre-fix gap (T-13046). | keep-manual |
| `nightly_retention.py` | C1b three-table, backup and first-turn bundle checks against a frozen Bun-verified survivor golden on APFS clones of its SHA256-pinned offline store; schedule with no window/no mark, bounded holds and vacuum. Takes `--source <offline backup> --binary <rusthrc> --out <evidence>`. | keep-manual |
| `ledger_prune.py` | Mark-gated runtime prune on copies of a real ledger: every refusal deletes nothing, only runtimes behind the mark go, the scheduled task (TZ-shifted to 04:00) reports `no_window` or deletes, and the deadline stops it (T-12855). Takes `--source <state.sqlite backup>`. | keep-manual |
| `ledger_prune_resume.py` | A seat whose every runtime was pruned through the mark-gated task is started again with its stored continuation, handoff and session intact (T-12855, contract gate 5). Live model turns. | keep-manual |
| `maintenance.py` | T-13074 List: follow-on conversion; not native-qualified.  | list |
| `n2_attached.py` | `hrc run` attached-run door on an hrcpty seat in a real pty: parked promptless birth, gate after the committed start, warm run on the same seat, refusals. Live model turns. | keep-manual |
| `n2_continuation_harness.py` | A respawn after the profile drifts (codex-hrcpty to claude-hrcpty) keeps the session's applied harness and resumes the Codex thread. An explicit cross-provider harness on that continuation is refused `continuation_harness_mismatch` before any operation is recorded (T-12419). Needs live codex credentials; scratch root under /tmp (socket path length). | keep-manual |
| `n2_inspect_crash.py` | Broker SIGKILL mid-turn settles the runtime terminal and the run failed; inspect with recoverFinalSummary answers terminal-fenced. Live model turns. | keep-manual |
| `n2_lanes.py` | Non-main lane seat: warm turn, selector echo, canonical API lane, raw stored lane_ref in every table. Live model turns. | keep-manual |
| `n2_participant.py` | Real participant-owned EPR broker: staged replay, live turn, clean exit; `--mode delivery` drives addressed steer/turn/literal into it pending, ACTIVE and absorbing, judged in the driver (T-11960). `--mode respawn` drives a same-incarnation respawn onto the live runtime (advance) plus three refused controls, judged in the driver (T-11996). (requires explicit scratch/capture inputs; retained qualification) | keep-manual |
| `n2_quit.py` | Human `/quit` through the hrc-pty attach client ends the seat `user_initiated_session_end`, once, and ends the lease. Live model turns. | keep-manual |
| `n2_recovery.py` | Cold-boot input recovery on restart: owed prompt delivered once, the runtime-less and non-durable runs failed `cold_input_continuation_lost`. Live model turns. | keep-manual |
| `n2_restart.py` | Restart rusthrc mid-turn (no lost, duplicated or replayed rows), then restart idle and take a warm turn; drained-stop log per shutdown. Live model turns. | promote |
| `n2_restart_self.py` | Restart-self arm/cancel/execute with handoff refusals and a fresh compile; `--negative-control` must fail. Live model turns. | keep-manual |
| `n2_retained.py` | Owner killed, operator turn and `/quit` while down, supervisor killed: startup recovers the tail as retained rows equal to the broker ledger. Live model turns. | keep-manual |
| `n2_routes.py` | none — task-time acceptance for completed T-11823; promoted n3_submissions covers the standing submission doors | delete |
| `n2_startup.py` | Startup reconciliation: live hrcpty seat reattached and takes a turn, dead seat and legacy row staled, terminal run settled once. Live model turns. | keep-manual |
| `n2_turns.py` | Cold and Skill-tool warm turns checked against the seat's own broker ledger; Skill rows; N2 reads answer 200. Live model turns. | keep-manual |
| `n3_edges.py` | Subscriber name identity across routes, UTF-16 name cap, and combined-error parse order on /v1/events. | keep-manual |
| `n3_events.py` | Event history reads over rows seeded with the native append: filters, inclusive/exclusive cursors, tail/page limits, head vs allocated head, incarnation fences, refusals. | keep-manual |
| `n3_handoff.py` | Semantic handoff refusal order before any durable write; `--turns` adds warm, restart-held and cold real turns with one durable response each. | keep-manual |
| `n3_injector.py` | Production `bunx hrc-mail-injector` + wrkc reply with the native owner replaced mid-delivery. Still starts the Bun injector (T-13068 List). | keep-manual |
| `n3_kernel_volume.py` | Historical independent-kernel survival workflow; superseded by embedded kernel checks (T-12141). | delete |
| `n3_mail.py` | Stop gate on real private wrkc obligations: unseen clear, presented block, refusal cap and reset, reply clears; malformed bodies 400, unknown runtime fails open. | keep-manual |
| `n3_messages.py` | Message filters and row shape over native-seeded rows (messages.rs insert), each filter judged against its own model. | keep-manual |
| `n3_publication.py` | Live project-event publication, then a from-zero replay with a withheld wrkq reply: no duplicate, created=false retry, live and replay facts agree. Live model turns. | keep-manual |
| `n3_replay.py` | Bounded replay gaps (replay_window, event_oversize) over rows seeded with the native append, broker follow equals finite read, receipt ACK, selector refusals. | keep-manual |
| `n3_streams.py` | Replay/live/reconnect streams over an owner restart on real HTTP writes. | keep-manual |
| `n3_submissions.py` | Submission doors: parser refusal codes, absent target unavailable, withdraw refusals, real enqueue/steer/preempt turns. Live model turns. | promote |
| `n3_subscribers.py` | Subscriber declare/follow/ACK doors on a private DB: undeclared and wrong-token refusals, retained refused for delivery, inclusive retry, stale ACK. Live model turns. | keep-manual |
| `n4_federation.py` | N4 federation reads on two scratch nodes, recorded for a per-case compare. (protected by T-11872) | keep-manual |
| `n4_gate.py` | N4 summon gate on a native owner over native-seeded ledger/registry rows, each case a literal. (requires explicit scratch/capture inputs; retained qualification) | keep-manual |
| `n4_history.py` | N4 collective history on two scratch nodes: origin n4a and authority svc. (requires explicit scratch/capture inputs; retained qualification) | keep-manual |
| `n4_listener_stop.py` | Native federation listeners drain on owner shutdown (N5's stop seam). (requires explicit scratch/capture inputs; retained qualification) | keep-manual |
| `n4_mail.py` | N4 gate 1: mail and a reply in both directions between two native scratch nodes (the injector is the production `bunx hrc-mail-injector`). (protected by T-11899) | keep-manual |
| `n4_ops.py` | N4 operations reads on one frozen store, each case a literal. (requires explicit scratch/capture inputs; retained qualification) | keep-manual |
| `n4_placement.py` | N4 project-root placement on a native owner; hrcpty births land in the resolved root. (requires explicit scratch/capture inputs; retained qualification) | keep-manual |
| `n4_svc_authority.py` | svc as registry host and collective-history authority, on svc's own data (T-11931). (protected by T-11933) | keep-manual |
| `n4_watchdog.py` | N4 first-turn watchdog: a native owner trips the armed rows, judged from first_turn.rs. (requires explicit scratch/capture inputs; retained qualification) | keep-manual |
| `participant_live.py` | Actual participant-owned bootstrap broker, real ASP compile, blank claude profile. (requires explicit scratch/capture inputs; retained qualification) | keep-manual |
| `participants.py` | Direct join/attach HTTPs against one native owner of empty scratch state, each case a literal. (requires explicit scratch/capture inputs; retained qualification) | keep-manual |
| `preparation.py` | Real ASP declaration workflow; no broker or model starts. (requires explicit scratch/capture inputs; retained qualification) | keep-manual |
| `routes.py` | Native HTTP route literals and metadata event invariants; shared scenario callback runner. | keep-manual |
| `runtime_key_order.py` | none — completed T-11880 capture analysis; promoted maintenance and existing conformance key-order comparisons retain wire checks | delete |
| `runtime_reads.py` | T-13074 List: follow-on conversion; not native-qualified.  | list |
| `runtime_surfaces.py` | Real ready-seat attachment and durable surface fences on isolated state. (requires explicit scratch/capture inputs; retained qualification) | keep-manual |
| `runtimes_start.py` | Exact/suffix claims, independent canonical SHA-256 hashes, replay/conflict/refusal/reuse and pinned initial-message delivery. | keep-manual |
| `schema_refusal.py` | Gate3: schema refusal preserves canonical DB and control files. | promote |
| `server_owner.py` | Native owner recovery and malformed/live/dead/replaced lock controls. | keep-manual |
| `session_index.py` | T-13074 List: follow-on conversion; not native-qualified.  | list |
| `session_projection.py` | T-13074 List: follow-on conversion; not native-qualified.  | list |
| `steer_no_intent.py` | No-intent 422 with zero runtimes; direct and CLI stored-intent revival, completed messages and distinct runtime instances on the same host. Real harness qualification requires explicit config. | keep-manual |
| `steer_returns_on_admission.py` | T-12243: a steer to a codex-hrcpty stub seat answers at admission, both when it starts a long turn on an idle seat and when it lands in that open turn (the pre-fix binary held the response until the run ended). Self-contained (stub broker, fake aspd); `--artifacts` required. | keep-manual |
| `steer_timeout.py` | T-12228: a steer past the 20 s RPC bound into a live codex-hrcpty stub seat fails that submission only (binding kept, runtime not stale, next delivery on the same runtime); the orphan sweep preserves a stale row whose broker answers and delivery then fails closed instead of minting; terminating a never-launched runtime keeps the continuation. Self-contained (stub broker, fake aspd); `--artifacts` required. | keep-manual |
| `target_placement.py` | Real target-session intent and placement reads, on an existing ready scratch seat. (requires explicit scratch/capture inputs; retained qualification) | keep-manual |
| `turn_no_intent.py` | No-intent steer refusal control; native CLI missing-intent fallback births the same host session, completes and persists placement. | keep-manual |

## Embedded kernel history (T-12141)

Historical description, superseded by the 2026-11-02 amendment below:

`kernel_fold.py`, `kernel_projection.py` and `kernel_fd_cost.py` run in
`just cargo-check` against rusthrc's own socket. `kernel_projection.py`
verifies ingest errors/recovery for an unrepresentable activity expiry and
drives the moved wire probe. `kernel_fd_cost.py` (T-12168) holds plain,
events.subscribe and query.subscribe connections and requires one daemon fd
each, released on close without a further accept.
`kq.py` and `live_probe.py` are the read-only inspection and wire smoke tools.
The latter accepts `--socket <runtimeRoot>/hrc-kernel.sock --artifacts <dir>`.

The historical standalone kernel fixture suites (bootstrap, surrogate, summon,
restart, send) retired with the binary. Their HTTP fake-owner seam and
survival across owner shutdown are superseded by the in-process fold.
Projection shape, malformed JSON, sparse ledger and operation mapping are
covered by hrc-domain's existing tests; `kernel_fold.py` covers real owner
summon/attach, ledger wake, startup and shutdown. The historical N3 volume
and N4 kernel-vs-Bun parity drivers retired too: a Bun owner has no kernel.
N3 stream transport parity remains in `n3_streams.py`; the retired front probe asserted
that front mode hosts no kernel. See migration §8.1 for activation gates.

`seat_handoffs.py --binary <unmanaged rusthrc> --scratch-root <fresh path> --out <artifacts>` now drives the native handoff CLI and private owner/store, including etag refusals and owner-restart durability. Live model rotation is the installed acceptance for T-12248.


2026-11-02 amendment (praesidium-kernel r1.9 / T-12360): `kernel_projection.py`
retired with the HRC document; praesidium-kernel and T-12361 own projection,
lineage and resource-attach coverage. `kernel_fold.py` now checks the ops-only
provider and all six owner operations. `live_probe.py` checks its installed
read-only discovery. `kernel_fd_cost.py` keeps plain/events connection checks;
query subscriptions now belong to praesidium-kernel. `seat_handoffs.py` and
`seat_work.py` keep owner/CLI/ledger durability and fence checks, while their
projection assertions move to the praesidium kernel. the retired front probe previously
requires no HRC operator socket on fronts. `kq.py` reads praesidium:praesidium.

The retained `kernel_fold.py` also proves owner clear-context termination:
one runtime.terminated ledger row with reason clear-context and owner refusal
when terminating that ended runtime again. `kq.py status` prints a bounded
Praesidium binding/cursor summary; `status --full` opts into raw ingest details.
