# Native workflow tests

`just cargo-check` runs `foundation.py` here, plus the CLI differential chain
and the five kernel workflows. It runs no other native scripts.

`just e2e-native-full` runs eight standing product workflows, by hand only. It
is not on the post-push runner, because it needs a Bun baseline and live model
turns (Lance ruling 2026-10-26: no Bun in the gate). The workflows: schema refusal without writes,
owner recovery/lifecycle, accounting, the front door, cold birth and reattach,
mid-turn broker restart, submission doors, and maintenance live-seat safety.
It builds the native/kernel binaries and runs each script even if an earlier
one fails. A failure is a failed check; no expected-red list masks it.

Run from a clean terminal (for example `ghostmux new --cwd <checkout>`).
Required: Bun (migration owner and parity baseline), the current installed Bun
release, live aspd, tmux, wrkq and harness credentials. The runner copies the
Bun release outside the atomic tree before any daemon starts. All writes use
fresh disposable runtime/state/project roots. It never installs or restarts a
shared service. Drivers own their scratch daemon/broker cleanup.

Artifacts default to `${FOUNDRY_ARTIFACTS:-/tmp}/hrc-native-full-<time>-<pid>`;
set `HRC_NATIVE_FULL_ARTIFACTS` to keep them elsewhere. `summary.json` contains
each command and exit status; each suite directory contains `driver.log` plus
the driver's original captures/comparison reports. Override baseline/socket
with `python3 crates/hrc-native/e2e/full.py --help`.

The manual corpus below remains explicit qualification, with scratch roots,
real seats, paired captures or node-specific prerequisites supplied by its
caller. A unit test cannot replace these broker/HTTP/projection claims.
Scripts named by an open parity task, including blocked tasks, are protected.
The triage was posted before deletion as T-11945 comment C-32046; the complete
task-body/comment reference snapshot is in that task's artifacts. The gate
signature history was checked through 178a9474; `evaluate` was unchanged.

Reusable modules: `n2_scratch.py`, `n3_scratch.py`, `n2_aspd_proxy.py`.
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
records any fixture-driver stop/dispose call. `result.json` and `steps.json` are
the repeatable evidence. Broker-side saved-token invalidation is unsupported.

Participant `.mjs` files are descriptor assets. `n2_restart_self.md` is an
operator recipe. Retained CLI helpers are documented in its README.

## Corpus decisions

Deleted entries stay listed to explain their removal; their source remains in git.

| Script | Product claim / reason | Verdict |
| --- | --- | --- |
| `accounting.py` | Real-owner accounting differential, with separate stores for proxy traffic. | promote |
| `cold_birth.py` | N1 gates 1, 2 and 4 as one real workflow on fresh, isolated state. | promote |
| `broker_projection_failure.py` | Owner projection failure preserves a live hrc-pty runtime and credential, reports degradation and recovers; real broker exit crash-marks; transport-only close with running broker averts condemnation (T-12169). | keep-manual |
| `error_wire.py` | Internal error cause/request ID and real codex presentation broker capability refusal, with an unstructured turn control (T-12063). | keep-manual |
| `ensure_archived_successor.py` | Archived ensure differential: real Bun repository snapshot, isolated owners. (requires explicit scratch/capture inputs; retained qualification) | keep-manual |
| `front_accounting.py` | Separate-state front accounting probe; real Bun behind a byte-forwarding tap. (requires explicit scratch/capture inputs; retained qualification) | keep-manual |
| `front_door.py` | F gates 1-3: rusthrc front on hrc.sock, Bun behind on hrc-bun.sock, one scratch state. (protected by T-11826) | promote |
| `front_door_report.py` | none — task-time acceptance measurement for completed T-11822; front_door.py retains the behavioral gate | delete |
| `lifecycle_actions.py` | Granted lifecycle on the one authorized disposable owner, versus copied Bun. (requires explicit scratch/capture inputs; retained qualification) | keep-manual |
| `lifecycle_credentials.py` | Real owner credential lifecycle: boot backfill, rotation, mint and revocation. (requires explicit scratch/capture inputs; retained qualification) | keep-manual |
| `lifecycle_peer.py` | Bun/native origins forward a verified primary's grant to the owned Bun peer. (requires explicit scratch/capture inputs; retained qualification) | keep-manual |
| `lifecycle_rows.py` | Compare real boot/stop ledger rows over clean, malformed and foreign history. (requires explicit scratch/capture inputs; retained qualification) | keep-manual |
| `lifecycle_shutdown.py` | Real HTTP request drain: a partial body must not hold the owner indefinitely. (requires explicit scratch/capture inputs; retained qualification) | keep-manual |
| `maintenance.py` | Real live-seat safety and Bun-authored orphan maintenance in both modes. | promote |
| `n2_attached.py` | N2 attached-run door on one owner (bun or native), recorded for `compare --suite n2-attached`. (requires explicit scratch/capture inputs; retained qualification) | keep-manual |
| `n2_continuation.py` | A seat re-born on a scope with a stored continuation compiles with it and continues. (protected by T-11899) | keep-manual |
| `n2_continuation_harness.py` | A respawn after the profile drifts (codex-hrcpty to claude-hrcpty) keeps the session's applied harness and resumes the Codex thread. An explicit cross-provider harness on that continuation is refused `continuation_harness_mismatch` before any operation is recorded (T-12419). Needs live codex credentials; scratch root under /tmp (socket path length). | keep-manual |
| `n2_inspect_crash.py` | N2 broker death mid-turn, then broker inspect with recoverFinalSummary, on (requires explicit scratch/capture inputs; retained qualification) | keep-manual |
| `n2_lanes.py` | N2 non-main lane on one owner (bun or native), for `compare --suite n2-lanes`. (requires explicit scratch/capture inputs; retained qualification) | keep-manual |
| `n2_participant.py` | Real participant-owned EPR broker: staged replay, live turn, clean exit; `--mode delivery` drives addressed steer/turn/literal into it pending, ACTIVE and absorbing, for `compare --suite n2-participant-delivery` (T-11960). `--mode respawn` drives a same-incarnation respawn onto the live runtime (advance) plus three refused controls, for `compare --suite n2-participant-respawn` (T-11996). (requires explicit scratch/capture inputs; retained qualification) | keep-manual |
| `n2_quit.py` | N2 human /quit on one owner (bun or native), for `compare --suite n2-quit`. (requires explicit scratch/capture inputs; retained qualification) | keep-manual |
| `n2_recovery.py` | N2 cold-boot input recovery on one owner (bun or native), for `compare --suite n2-recovery`. (requires explicit scratch/capture inputs; retained qualification) | keep-manual |
| `n2_restart.py` | N2 gate 2: restart rusthrc mid-turn, then hand the seat to the named Bun copy. | promote |
| `n2_restart_self.py` | Real restart-self workflow on Bun first, then native, using copied releases. (requires explicit scratch/capture inputs; retained qualification) | keep-manual |
| `n2_retained.py` | N2 retained-evidence recovery on one owner (bun or native), for (requires explicit scratch/capture inputs; retained qualification) | keep-manual |
| `n2_routes.py` | none — task-time acceptance for completed T-11823; promoted n3_submissions covers the standing submission doors | delete |
| `n2_startup.py` | N2 startup reconciliation and broker lease GC on one owner (bun or native), (requires explicit scratch/capture inputs; retained qualification) | keep-manual |
| `n2_turns.py` | N2 turn workflow on one owner (bun or native), dumped for per-case compare. (requires explicit scratch/capture inputs; retained qualification) | keep-manual |
| `n3_edges.py` | Real HTTP subscriber-name identity and combined-error precedence edges. (requires explicit scratch/capture inputs; retained qualification) | keep-manual |
| `n3_events.py` | Compare native event history to the named Bun copy on one scratch ledger. (requires explicit scratch/capture inputs; retained qualification) | keep-manual |
| `n3_handoff.py` | Semantic handoff's refusal order, before any durable target/message write. (requires explicit scratch/capture inputs; retained qualification) | keep-manual |
| `n3_injector.py` | Unchanged injector + wrkc reply, with the Rust owner replaced mid-delivery. (requires explicit scratch/capture inputs; retained qualification) | keep-manual |
| `n3_kernel_volume.py` | Historical independent-kernel survival workflow; superseded by embedded kernel checks (T-12141). | delete |
| `n3_mail.py` | Stop gate on real private wrkc obligations, with identical Bun/native drives. (requires explicit scratch/capture inputs; retained qualification) | keep-manual |
| `n3_messages.py` | Message filters/row shape against real Bun repo inserts and HTTP responses. (requires explicit scratch/capture inputs; retained qualification) | keep-manual |
| `n3_presentation.py` | Compare the two real kernel presentation routes on one real-born seat. (requires explicit scratch/capture inputs; retained qualification) | keep-manual |
| `n3_publication.py` | Replay real Bun lifecycle rows through both publication observers. (requires explicit scratch/capture inputs; retained qualification) | keep-manual |
| `n3_replay.py` | Bun/native stream replay, receipt headers and bounded-loss wire parity. (requires explicit scratch/capture inputs; retained qualification) | keep-manual |
| `n3_streams.py` | Replay/live/reconnect streams and the unchanged kernel on real HTTP writes. (requires explicit scratch/capture inputs; retained qualification) | keep-manual |
| `n3_submissions.py` | Real HTTP submission doors: parser order, unavailable target, broker withdraw. | promote |
| `n3_subscribers.py` | Real copied-Bun/native subscriber and broker evidence parity on a private DB. (requires explicit scratch/capture inputs; retained qualification) | keep-manual |
| `n4_federation.py` | N4 federation reads on two scratch nodes, recorded for a per-case compare. (protected by T-11872) | keep-manual |
| `n4_gate.py` | N4 summon gate on one owner (bun or native), recorded for a compare. (requires explicit scratch/capture inputs; retained qualification) | keep-manual |
| `n4_history.py` | N4 collective history on two scratch nodes: origin n4a and authority svc. (requires explicit scratch/capture inputs; retained qualification) | keep-manual |
| `n4_listener_stop.py` | Native federation listeners drain on owner shutdown (N5's stop seam). (requires explicit scratch/capture inputs; retained qualification) | keep-manual |
| `n4_mail.py` | N4 gate 1: mail and a reply in both directions between mixed scratch nodes. (protected by T-11899) | keep-manual |
| `n4_ops.py` | N4 operations reads on one frozen store: Bun then native answer the same cases. (requires explicit scratch/capture inputs; retained qualification) | keep-manual |
| `n4_placement.py` | N4 project-root placement on one owner (bun or native), recorded for a compare. (requires explicit scratch/capture inputs; retained qualification) | keep-manual |
| `n4_svc_authority.py` | svc as registry host and collective-history authority, on svc's own data (T-11931). (protected by T-11933) | keep-manual |
| `n4_watchdog.py` | N4 first-turn watchdog: Bun then native trip the same armed rows. (requires explicit scratch/capture inputs; retained qualification) | keep-manual |
| `owner_relative_controls.py` | Mutate real ready captures; the named owner-relative gate must discriminate. (requires explicit scratch/capture inputs; retained qualification) | keep-manual |
| `participant_live.py` | Actual participant-owned bootstrap broker, real ASP compile, blank claude profile. (requires explicit scratch/capture inputs; retained qualification) | keep-manual |
| `participants.py` | Direct join/attach HTTPs against sequential owners of empty scratch state. (requires explicit scratch/capture inputs; retained qualification) | keep-manual |
| `passthrough.py` | Proxy workflow: real copied Bun, separate stores, buffered and live responses. (requires explicit scratch/capture inputs; retained qualification) | keep-manual |
| `preparation.py` | Real ASP declaration workflow; no broker or model starts. (requires explicit scratch/capture inputs; retained qualification) | keep-manual |
| `routes.py` | Finite N1 API workflow on a real Bun-created scratch store. (protected by T-11933) | keep-manual |
| `runtime_key_order.py` | none — completed T-11880 capture analysis; promoted maintenance and existing conformance key-order comparisons retain wire checks | delete |
| `runtime_reads.py` | Real-seat runtime reads against sequential owners on one scratch snapshot. (requires explicit scratch/capture inputs; retained qualification) | keep-manual |
| `runtime_surfaces.py` | Real ready-seat attachment and durable surface fences on isolated state. (requires explicit scratch/capture inputs; retained qualification) | keep-manual |
| `runtimes_start.py` | POST /v1/runtimes/start on Bun and native, compared case by case (T-11911). `--deferred-message-only` qualifies native exact/suffix deferred message binding, pinned delivery/replay, changed-message refusal and unchanged ensure refusal on Codex (T-12316). Requires explicit scratch/capture inputs. | keep-manual |
| `schema_refusal.py` | Gate3: schema refusal preserves canonical DB and control files. | promote |
| `server_owner.py` | Real owner recovery, with refusal and concurrent-reclaimer controls. | promote |
| `session_index.py` | N1 session index workflow on a real Bun-created scratch store. (requires explicit scratch/capture inputs; retained qualification) | keep-manual |
| `session_projection.py` | Real owners, own historical fixtures: recency, liveness, ordering and parsing. (requires explicit scratch/capture inputs; retained qualification) | keep-manual |
| `steer_no_intent.py` | T-11928: `hrc turn` steers a seat that has a session but no live runtime. (requires explicit scratch/capture inputs; retained qualification) | keep-manual |
| `steer_returns_on_admission.py` | T-12243: a steer to a codex-hrcpty stub seat answers at admission, both when it starts a long turn on an idle seat and when it lands in that open turn (the pre-fix binary held the response until the run ended). Self-contained (stub broker, fake aspd); `--artifacts` required. | keep-manual |
| `steer_timeout.py` | T-12228: a steer past the 20 s RPC bound into a live codex-hrcpty stub seat fails that submission only (binding kept, runtime not stale, next delivery on the same runtime); the orphan sweep preserves a stale row whose broker answers and delivery then fails closed instead of minting; terminating a never-launched runtime keeps the continuation. Self-contained (stub broker, fake aspd); `--artifacts` required. | keep-manual |
| `target_placement.py` | Real target-session intent and placement reads, on an existing ready scratch seat. (requires explicit scratch/capture inputs; retained qualification) | keep-manual |
| `transcript_index.py` | T-12013: transcript follower resume from Bun's cursor, late-prose/inversion repair, search, status and rebuild against Bun on one snapshot. (requires explicit scratch/capture inputs; retained qualification) | keep-manual |
| `turn_no_intent.py` | T-11928: the real `hrc turn` births a session that never applied an intent. (requires explicit scratch/capture inputs; retained qualification) | keep-manual |

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
N3 stream transport parity remains in `n3_streams.py`; `front_door.py` asserts
that front mode hosts no kernel. See migration §8.1 for activation gates.

`seat_handoffs.py --binary <unmanaged rusthrc> --scratch-root <fresh path> --out <artifacts>` now drives the native handoff CLI and private owner/store, including etag refusals and owner-restart durability. Live model rotation is the installed acceptance for T-12248.


2026-11-02 amendment (praesidium-kernel r1.9 / T-12360): `kernel_projection.py`
retired with the HRC document; praesidium-kernel and T-12361 own projection,
lineage and resource-attach coverage. `kernel_fold.py` now checks the ops-only
provider and all six owner operations. `live_probe.py` checks its installed
read-only discovery. `kernel_fd_cost.py` keeps plain/events connection checks;
query subscriptions now belong to praesidium-kernel. `seat_handoffs.py` and
`seat_work.py` keep owner/CLI/ledger durability and fence checks, while their
projection assertions move to the praesidium kernel. `front_door.py` still
requires no HRC operator socket on fronts. `kq.py` reads praesidium:praesidium.

The retained `kernel_fold.py` also proves owner clear-context termination:
one runtime.terminated ledger row with reason clear-context and owner refusal
when terminating that ended runtime again. `kq.py status` prints a bounded
Praesidium binding/cursor summary; `status --full` opts into raw ingest details.
