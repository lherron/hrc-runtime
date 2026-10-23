# Rust parity and execution-state ownership audit

2026-10-23 · Cody · T-11525.state-audit (Rust parity and state ownership)

Source snapshot: `763c28dbf27ccb36ab3ccd532320d3585e89179e` in canonical hrc-runtime. Read-only source investigation; no builds, tests, implementation, commits, installs or service operations. Existing dirty SDK files were outside this audit. Paths below are repo-relative; symbols identify the inspected definitions. The parent owns proposal/contract edits and design review. This report establishes source findings, not runtime parity or implementation approval.

## Verdict

The provisional S1–S5 order is unsafe as an ownership-transfer plan. Its route groupings conceal shared actuation, process-local exclusion, alternate ingress, recovery and notifications. SQLite writer serialization does not serialize asynchronous broker actions or recreate another process's maps. Develop the complete native Rust daemon incrementally on isolated state and substrate; retain one production execution owner until the coupled lifecycle/message/turn/federation mutation system can transfer together. This preserves complete, unchanged standalone Bun operation without inventing a new cross-process lock protocol to rescue provisional slices.

Optional earlier native passive reads are reasonable only after route-specific proof; initially keep the kernel's proven API-fed role. A Rust facade is useful transport/presentation, but cannot count as native lifecycle, messaging, storage or federation ownership.

## What Rust actually owns

`crates/Cargo.toml` contains only `hrc-domain` and `hrc-kernel`. No native HRC front or HRC state store exists in this workspace. The Cardo store dependency is not an implementation of HRC's SQLite schema.

* Native Rust: Cardo document/wire service, API-fed `HrcApiLedger`, `SeatProjector`, projection/preview formatting and attach-descriptor construction. See `hrc-kernel/src/main.rs::run`, `hrc-domain/src/{ledger,projector,projection,preview,attach}.rs`. Cardo observation state is rebuildable and not HRC execution authority.
* Facade: `hrc-domain/src/api.rs::HrcApi` uses the pinned HTTP read set; `post_owner` only permits declarations resolve, runtime start and session restart. `summon.rs::Summon::run` calls resolve then start; `restart.rs::Restart::run` calls restart. All placement, claim, idle, rotation and launch decisions remain Bun's.
* Native orchestration around facade: `hrc-kernel/src/adapter.rs::HrcAdapter` runs owner calls on worker threads, tracks `pending`, suppresses completion on cancellation and deliberately avoids Cardo receipt caching. Cancellation does not undo an owner mutation.
* Absent natively here: public HRC HTTP daemon, HRC schema/repositories/migrations, runtime provisioning/controller ownership, semantic messages, submission admission, event ingest/project/ACK, timers/recovery, participant lifecycle and federation. This is a source inventory, not a claim about code outside this repository or what is currently activated.

## Route-family gap/ownership matrix

Every HTTP route below currently resolves to Bun. “Passive candidate” means potentially independently implementable after proof, not implemented Rust parity. Exact registration and computed/dynamic routes are enumerated in the appendix; do not inventory only literal strings in `buildExactRouteHandlers`.

| Family | Relevant source/symbols | State and coupling / native gap |
|---|---|---|
| Health, status, server lifecycle and admission | `server-status-methods.ts::{handleHealth,handleStatus}`, `server-lifecycle-controller.ts`, `index.ts` constructor | Health is trivial; status includes process/release/config identity. Lifecycle owns incarnation credentials, live-binding checks and turn-admission gate. Front status must not impersonate private Bun's release/lifecycle owner. No native owner. |
| Presentation, sessions listing/page/facets/get/by-host/resolve, metadata and titles | `presentation-read-model.ts`, `session-index-handlers.ts`, `server-session-methods.ts`, `session-metadata-handlers.ts`, `server-request-methods.ts::dispatchRequest` | Presentation reads are pinned passive candidates. Session page/facets and scoped continuity reads include home/fleet routing. Metadata/title mutations emit durable events and need correct notification ownership. Resolve is not a blanket permission to mint. No native HRC repository. |
| Runtime and run listing, live refs, targets | `runtime-list-handlers.ts::{queryRuntimesForProjection,reconcileWithinDeadline,handleListRuns}`, `index.ts` computed route registration | Runtime listing calls effectful liveness reconciliation, even for peer projections. The 15s deadline answers stored rows while reconciliation continues. Local runs read is passive; scope-filtered runs are forwarded to home. Targets may lead to ensure paths. S1 “none” is false. |
| Event head/page/tail/latest, legacy follow and bounded follow | `event-handlers.ts::{handleEvents,handleEventsPage,handleEventsTail,handleBoundedEvents}`, `follow-fanout.ts::FollowFanOut`, `subscriber-admission-accounting.ts` | Pure local ledger pages can move independently with schema/incarnation proof. Follow uses subscriber sets, admission/receipt ACK, stream closers, timers and replay/live seam. Scoped tail/bounded routes consult home. Polling only lifecycle rows cannot replace every stream's semantics. |
| Broker events/query/follow/forensics and input/contribution observations | `event-handlers.ts`, `input-handlers.ts::{handleGetInput,handleWatchInput}`, submission handlers | Raw broker subscriber stream is separate from lifecycle follow. Input watch uses `followSubscribers`, live/replay high-water and stream closers; single input lookup is a store read. Contributions and input receipts correlate with admission. Native gap includes both retained and live observations. |
| Message query/trace/create/dm/turn-handoff/wait/watch; target ensure and selector delivery | `target-message-{dm,handoff}-handlers.ts`, `selector-message-handlers.ts`, `selector-wait-handlers.ts`, `event-notification-handlers.ts` | Query/trace may use collective history, not only local rows. DM executes admitted turns, can rotate/reprovision/reattach. Handoff and terminal processing share `turnResponseFinalizers`. Wait/watch use `messageSubscribers`, timeout and stream lifecycle. S2 is not an isolated message-store port. |
| Runtime ensure/start/attach/inspect, broker-session open, runtime seat, capture and capture control/recovery | `runtime-start-handlers.ts`, `broker-{headless,interactive}-handlers.ts`, `runtime-io-handlers.ts`, `runtime-inspect-handlers.ts` | Starts share `runtimeStartOperations`, attach/reattach maps, first-turn rendezvous and broker warmup. `captureRuntime` inspects tmux and **writes runtime activity**; inspect can seat-probe and recover retained evidence. Attach reconciles. S1 capture cannot be classified as passive. |
| Session clear-context/restart/drop/resume; interrupt/terminate/restart-self | `session-restart.ts::handleRestartSession`, `runtime-control-handlers/`, `self-restart.ts` | Idle authority is broker seat, including human turns with no HRC run. Restart probes, disposes/rotates and launches; committed rotation with failed launch remains success receipt. Self-restart intents fire on terminal events. State transfer belongs with execution. |
| Turns, submissions steer/enqueue/invoke/preempt/admission/withdraw, in-flight input, contributions, command-run launch, attached-run prepare/resume | `turn-admission/routes/`, `turn-dispatch-handlers.ts`, `broker/submission-doors.ts`, `server-instance-context.ts` | Admission gate, pending literal inputs, attached operations, durable queue drains, runtime-start singleflight and controller dispatch all interact. Includes participant routes, accepted-run recovery and request cancellation. No native implementation. |
| Sweep/prune/reconcile/recover, kill broker leases, capture recover | `sweep-handlers.ts`, `runtime-prune-handlers.ts`, startup reconciliation | Actuate across sessions/runs/runtime/broker state and filesystem substrates. Lease GC also runs retained-evidence recovery. Moving a route without the background and startup equivalents leaves duplicate authority. |
| Registrations/participants attach/register and registration GC | `participant-registration-handlers.ts`, `external-registration-rendezvous.ts`, `index.ts` | External clients, registration/establishment/participant-operation maps, deferred rendezvous and staged broker activation belong with attach/replay and external lifecycle owner semantics. Missing from provisional named slices; must be explicit parity scope. |
| Surfaces bind/unbind/list and bridges target/local-target/deliver/deliver-text/close/list | `bridge-surface-handlers.ts` | Surface mutations append events; bridge delivery resolves continuity and can deliver into runtime execution. Both target aliases must resolve to the same owner. Store-only list paths may be candidates separately. |
| Declarations/placements resolve and run previews | `declaration-handlers.ts`, `placements-resolve.ts` | ASP placement/intent assembly is already a dependency of the summon facade. Preserve accepting-node localization and unsupported/refusal behavior; apparent “resolve” is not generic pure state access. |
| Federation locate/peers/runtimes/retire/bindings/designations and placement bindings; separate registry/peer listeners | `server-federation-startup.ts::startFederationServices`, `federation/{authority-lock,retirement,summon-gate-server-authority,collective-history}.ts` | Peer callbacks directly invoke local lifecycle, reads, lifecycle authority and start claims. Per-owner locks coordinate summon/mint vs retirement. Health/projection changes reachability/cache and can reconcile liveness. Replication, outbox/acceptance metadata and collective query span messaging. S5 is much more than peer health. |
| Internal stop/hint decisions and project-event publishers | `wrkq/stop-gate-handlers.ts`, `wrkq/session-project-events.ts::SessionProjectEventPublisher`, `wrkq/server-project-events.ts` | External wrkq client, durable `wrkq_ledger_cursors`, publisher timers and observation hooks. Session publisher tails ledger independently and advances after posts settle; cannot transfer just a route or duplicate cursor consumers. |
| Transcript search/index status/rebuild and diagnostics | `transcript-index-handlers.ts`, `first-turn-diagnostics-handlers.ts`, indexer startup in `index.ts` | Search/status needs index contract; rebuild is mutating background work. Diagnostics include bundles/artifacts, first-turn health and producer ownership. Neither omitted nor automatically passive. |
| Retired hook/launch callback routes and separate ingest/forwarding transport | `server-exact-routes.ts`, `server-request-methods.ts`, `event-ingest.ts`, `index.ts::initializeEventTransport` | Retired routes must preserve refusals, not revive old launch-wrapper ingestion. Active separate Unix/TCP ingest handles imported lifecycle/raw broker/blob feeds and ACK/conflict semantics; forwarding has durable cursor file and retries. Public route inventory alone misses it. |

## Concrete ownership edges that defeat the provisional sequence

1. **S1 → S3/S4:** `runtime-list-handlers.ts::queryRuntimesForProjection` calls `reconcileWithinDeadline`, which invokes `reconcileTmuxRuntimeLiveness`; `runtime-io-handlers.ts::captureRuntime` updates runtime activity after tmux capture. `GET /v1/attach` is also reconciling (the approved contract explicitly excludes it from pinned reads). These cannot become stateless Rust reads while retaining unchanged observable behavior.
2. **S2 ↔ S4:** `target-message-handoff-handlers.ts` invokes `executeAdmittedTurn` and sets/deletes `turnResponseFinalizers`. `event-notification-handlers.ts::finalizeSemanticTurnResponse` reads the same map or recovers durable metadata, writes a response and updates the original request. `maybeCompleteInteractiveSemanticTurn` also completes runs/messages and constructs federated terminal metadata. Moving `messageSubscribers` alone drops these ownership edges.
3. **S3 ↔ S4:** `session-restart.ts::{assertIdle,handleRestartSession}` uses controller `seatProbe`, rotates context and starts successor. `index.ts` constructor warms `getHarnessBrokerController` and then recovers cold-boot input continuations. `startup-reconcile/durable-broker-reattach.ts::reconcileDurableBrokerRuntimeReattach` classifies with `attach:false`, while only the serving controller with `attach:true` performs attach/replay/ACK. Two “complete” daemon constructors do not constitute passive coexistence.
4. **S3 ↔ S5:** `scope-claim-core.ts::withScopeClaimMutex` explicitly assumes a daemon singleton and serializes claim through registration of its start promise. Occupancy includes `runtimeStartOperations`, before a runtime row exists. `federation/authority-lock.ts` keeps `ownerLocks` and `ownerSessionMintTails` in WeakMaps; `summon-gate-server-authority.ts` takes summon/mint locks and `retirement.ts::retireFederationScope` takes the exclusive counterpart. `server-federation-startup.ts` peer `exactStart`/`rosterStart` call `startExactScopeRuntime`/`startSuffixRosterRuntime` directly, bypassing front route routing. DB `BEGIN IMMEDIATE` cannot protect the intervening asynchronous prepare/start/retirement work or another process's in-flight map.
5. **S1/S2/S4/S5 notification split:** store `lifecycle-append-hub.ts` is a WeakMap keyed by a Bun Database connection. It flushes committed rows in seq order into `FollowFanOut`; it is not an interprocess bus. `notifyEvent` additionally runs actuation: queue drains, self-restart and semantic finalization, plus bridges and publisher hints. Polling rows could reproduce observation after design/proof; calling `notifyEvent` indiscriminately on polled history risks repeating actuation. `evidenceOrigin != null` must stay non-actuating. Raw broker and message streams use different stores/subscribers.
6. **Broker projection atomicity is an indivisible boundary:** `broker/event-mapper.ts::BrokerEventMapper::apply` transactionally appends/projects, snapshots/restores buffer-chunk sequence state on rollback, and tracks ignored raw-delta cursors. `broker/controller/bc-events.ts::projectBrokerEventWithBusyRetry` applies then ACKs committed projection; gap backfills and terminal handling have timers. Separate raw ingest or lifecycle porting must not ACK ahead of projection or duplicate these effects.
7. **Global start/stop is stateful:** constructor starts recurring jobs, federation, credentials, indexer, warmup and external rendezvous. `server-stop-methods.ts` tracks requests, bounds drain, closes streams and shuts down controller before store close. It deliberately does not drain all runtime-start promises. “Point socket back” omits quiescence, in-flight uncertain mutations, credential incarnation, ingress redirect, controller handoff and loop shutdown.

## Shared-state checklist for the parent ownership manifest

The source of truth is `index.ts::HrcServerInstance` plus `server-instance-context.ts::HrcServerInstanceDataForHandlers`; module-level WeakMaps also count. This inventory groups the inspected shared declarations rather than assuming every map requires serialization across a process boundary:

* Runtime/participant coordination: `runtimeAttachOperations`, `runtimeStartOperations`, `brokerReattachOperations`, `invokeFirstTurnRendezvous`, `externalRegistrationOperations`, `externalRegistrationEstablishmentOperations`, `participantEstablishmentOperations`, `externalParticipantClients`, and runtime-start presentation abort signal. Ownership includes failure and shutdown cleanup, not just successful map insertion.
* Turn/message coordination: `attachedRunOperations`, `turnResponseFinalizers`, `pendingBrokerLiteralInputs`, `queuedTurnInputDrains`, `turnAdmissionGate`, `selfRestartIntents`, and claim/mint/authority mutex WeakMaps. Durable rows permit some recovery but do not make the live maps interchangeable.
* Live observations: `followSubscribers`, `followFanOut` dedup memory, `rawBrokerSubscribers`, `messageSubscribers`, `activeStreamClosers`, `subscriberAdmissions`, process-local store append hub, and per-request replay queues/keepalive/timeout state. Keep declaration/ACK and stop semantics with the serving stream owner.
* Server jobs: zombie sweep, active-run reconcile, broker lease GC, tmux aging, session retention, first-turn evaluation, foreign-home shadow teardown and lifecycle-credential sweep, each with in-flight state where declared. Also retained-evidence startup/terminal timers, transcript indexer, ACP event bridge, session/server project publishers, collective-history poll, event forwarder and event-loop monitoring. Start/stop and one-owner evidence must cover these, not only `sweep-handlers.ts` loops.
* Broker controller internals (`broker/controller.ts`): `active`, `stagedParticipants`, intentional-close tracking, reaped lease IDs, pending tmux reaps, pending attached starts and readiness waiters, gap-backfill timers, seat-monitor timers/probes, pending disposals and crash-terminal retries. Event mapper adds ignored-delta and buffer-chunk cursor memory. These represent lease ownership, transport ownership and replay correctness, not just caches.
* Federation/status: `foreignHomeMemo`, `peerReachability`, `peerRuntimeProjectionCache`, binding-scan singleflight, registry client and collective-history coordinator. Caches may be independently reconstructable, but peer callbacks and retirement are execution authority and cannot be classified that way.
* Global shutdown and incarnation: `inFlightRequests`, `stopping`, immutable captured release, lifecycle credentials and controller, startup recovery/warmup and listener handles. Reconstruct from compatible durable state where designed; never copy promises or assume a socket swap transfers them.

## Recommended implementation and transfer order

Adopt Astra's independent native-daemon alternative. This is an implementation sequence with one later ownership transfer, not five production mutation cutovers.

1. Freeze the contract inventory: exact/computed/pattern routes, aliases/refusals, public and peer/registry/ingest transports, schemas, errors, streams, producer cursors, process lifecycle. Populate black-box tests using observed real Bun responses before doubles. Keep Bun source, launch and standalone behavior complete; no temporary lock or slice-disable protocols solely for coexistence.
2. Implement native HRC store and passive contracts against a scratch DB, explicit compatible schema version, stable incarnation/seq and transaction/rollback behavior. Bun retains migration authority. Retain stage-1 API-fed kernel separately until native ownership is real. Native reader must not initialize/migrate a production store accidentally.
3. Build isolated native daemon startup/shutdown/admission and runtime provisioning/participants/ASP preparation; then broker attach/replay, event projection/ACK, turn/submission execution, continuation/recovery and timers. Add semantic messaging, wrkq publication and federation incrementally as implementation milestones. Each remains native test-only until its dependency closure passes; no claim that message/lifecycle milestones independently own live mutation.
4. Exercise the complete coupled native execution system in a separate two-node scratch federation with separate scope identities, state/runtime roots, tmux leases, ingest sockets/TCP ports, registry, authority/cursors and external destinations. Isolation must include wrkq: `index.ts` warns that default node locator ignores state/runtime isolation, so use explicit isolated configuration. A copied production runtime row is not permission to attach its real broker or reap its lease.
5. Optional passive read fronting only after native contract proof: explicit route/method/query/local-only allowlist, compatible schema guard, no startup jobs/credentials/controller/ingest in reader role, and unchanged home forwarding and stream contract where claimed. Prefer finite local pinned reads first; keep reconciling reads, live streams and status/lifecycle with execution owner. Starting a second complete native daemon on the live DB is not passive fronting.
6. Transfer **all coupled mutation authority together per node**, through a reviewed activation/rollback design: public writers, peer starts/retirement, ingest, controller/replay/ACK, credentials/admission, recovery, publishers and sweeps. A separate development binary does not require simultaneous fleet cutover: hrcdev, svc, max3 can transfer individually under unchanged mixed-version federation. Preserve whole-node rollback to complete Bun and schema compatibility; retire Bun/migration constraints only after the fleet proof.

This avoids extending Bun purely to host a port. It preserves gradual development and reversible node activation, but materially amends the approved route-slice production ownership model. Update proposal §1/§2/§5/§6/§7/§8/§13 and active `architecture/contracts/hrc-rust-migration.yaml` together and submit to Daedalus before implementation. Cross-process lock/notification protocols would be a different architecture, not an incidental implementation detail.

## Executable acceptance scenarios (future gates, not executed here)

Use a socket-parameterized driver for the same scenarios against unchanged standalone Bun and native Rust, with independently fresh equivalent scratch stores/substrates. Preserve command/output, status, IDs, ledger rows and substrate/controller counts under the task artifacts. Assert control cases; a missing JSON field or accepted start receipt is not successful completion.

1. **Coverage:** generated manifest equals exact + computed + dynamic public routes; exercise all aliases, malformed URI/body/unknown-field/sealed-format and retired-route refusals; include peer/registry/ingest wire endpoints separately. Every route maps to conformance case or named evidence gap.
2. **Passive discriminator:** seed dead substrate and read page/presentation/session candidates; compare runtime rows, events, lease state and filesystem before/after. Control `/v1/runtimes`, `/v1/attach` and interactive capture must demonstrate existing mutation/reconciliation where applicable. Page holes/spill stubs/full and short pages/rollback/incarnation mismatch preserve scan semantics.
3. **Claim/authority race:** barrier simultaneous exact/suffix starts via public API and peer listener, plus ensure/DM cold start and retirement for same scope. Assert one winning runtime/start, correct durable claim/hash replay/conflict, lane identity, and retirement waits/refuses according to Bun. Observe pre-runtime-row window as well as post-commit state.
4. **Broker ledger crash windows:** kill scratch owner after projection commit before ACK, resume against same compatible DB and surviving scratch broker; compare replayed/acked contiguous seqs and unique dispositions. Include raw ignored delta, out-of-order gap, divergent duplicate, terminal gap flush, retained evidence non-actuation and unavailable lease. No double queue drain or semantic response.
5. **Messages and live observation:** open wait/watch before headless and interactive handoff, plus explicit reply DM; restart owner while turn continues. Verify final-only response selection, durable finalizer recovery, one response, execution joins and collective trace. Exercise lifecycle and raw broker followers separately, filtered replay/live admission seam, receipt ACK, overflow/gap/oversize/keepalive, abort and ledger replacement. A seq polling latency benchmark alone is insufficient stream proof.
6. **Lifecycle/participants:** cold and warm ASP launches, attached start/resume, external register/attach/reconnect, busy human-typed broker turn without run row, stale generation, restart phase-B launch failure, continuation/successor/clear/drop, self-restart, interrupt/terminate and capture mutations. Inspect actual turn terminal and substrate, not only HTTP accepted status.
7. **Jobs and shutdown:** run each sweep/publisher/recovery deterministically against fixture state, then daemon restart while start/probe/follow is pending. Assert bounded stop, controller shutdown before DB close, no orphan writes, no duplicated cursor advancement or leases, expected terminal jobs and full broker warmup attachment count. Include timers hidden inside controller and foreign-home teardown.
8. **Federation:** two real isolated peers, mixed Bun/Rust both directions: home localization, exact/suffix remote birth, retired/wrong-home refusal, read forwarding with no second hop, bounded streaming, unreachable/recovered peers, designation/registry behavior, semantic delivery/response and collective replication/checkpoint. Inspect receiving owner IDs and durable acceptance/outbox/claim records.
9. **Whole-node rollback:** start real scratch turns and streams in Rust; controlled handoff to complete Bun with same compatible DB/substrate after drain/fencing. Assert one active controller and timer owner, broker replay/ACK continuation, queued input and publisher recovery, incarnation/seq stability and credential/admission behavior. Repeat forward direction. Preserve untouched standalone Bun acceptance throughout native development.

Unknowns needing measured proof: polling/stream latency budgets, full production fixture schema compatibility, runtime/peer behavior of the proposed Rust daemon (absent), mixed-runtime projection/ACK parity and atomic activation mechanics. None are resolved by this source audit. The independent native approach removes a need for new cross-process locks; it does not waive end-to-end ownership-transfer proof.

## Appendix: complete public route inventory at snapshot

The following literal registrations are extracted from `server-exact-routes.ts`; computed routes and pattern routes follow. This is a coverage checklist, not a claim that all handlers are passive or independent. Families and special transports are classified above.

```text
GET /v1/admin/registrations/gc
POST /v1/admin/registrations/gc
POST /v1/registrations
POST /v1/participants/attach
POST /v1/participants/register
POST /v1/sessions/resolve
GET /v1/sessions/get
GET /v1/sessions/metadata
PATCH /v1/sessions/metadata
GET /v1/sessions
GET /v1/sessions/page
GET /v1/sessions/facets
GET /v1/events
GET /v1/events/tail
GET /v1/events/page
GET /v1/events/bounded-stream
GET /v1/broker-events
GET /v1/broker-events/query
GET /v1/broker-events/follow
POST /v1/server/subscribers
GET /v1/events/head
GET /v1/broker-forensics
POST /v1/transcript-search
GET /v1/transcript-index/status
POST /v1/transcript-index/rebuild
GET /v1/events/latest-by-session
GET /v1/server/subscribers
POST /v1/server/subscribers/ack
POST /v1/server/lifecycle
POST /v1/runtimes/ensure
POST /v1/runtimes/start
POST /v1/runtimes/restart-self
POST /v1/command-runs/launch
POST /v1/broker-sessions/open
POST /v1/runtimes/attach
POST /v1/runtimes/inspect
POST /v1/runtimes/broker/inspect
POST /v1/runtimes/capture/status
POST /v1/runtimes/capture/release
POST /v1/capture/recover
POST /v1/runtimes/sweep
POST /v1/runtimes/prune
POST /v1/server/tmux/kill-broker-leases
POST /v1/runs/sweep-zombies
POST /v1/runs/reconcile-active
POST /v1/runs/recover-unstarted
POST /v1/runs/prepare-attached
POST /v1/runs/resume-attached
POST /v1/turns
POST /v1/submissions/steer
POST /v1/submissions/enqueue
POST /v1/submissions/invoke
POST /v1/submissions/preempt
POST /v1/submissions/preempt/admission
POST /v1/submissions/withdraw
POST /v1/active-run-contributions
POST /v1/in-flight-input
GET /v1/capture
GET /v1/attach
POST /v1/surfaces/bind
POST /v1/surfaces/unbind
GET /v1/surfaces
POST /v1/bridges/local-target
POST /v1/bridges/target
POST /v1/bridges/deliver
POST /v1/bridges/deliver-text
POST /v1/bridges/close
GET /v1/bridges
POST /v1/interrupt
POST /v1/terminate
POST /v1/clear-context
POST /v1/sessions/restart
POST /v1/sessions/drop-continuation
POST /v1/sessions/resume-continuation
POST /v1/internal/hooks/ingest
GET /v1/runtime-diagnostics
POST /v1/presentation/seats/read
GET /v1/presentation/runtimes
GET /v1/health
GET /v1/status
GET /v1/federation/locate
GET /v1/federation/peers
GET /v1/federation/runtimes
POST /v1/federation/retire
GET /v1/federation/bindings
GET /v1/federation/designations
GET /v1/placement/bindings
GET /v1/runtimes/live-refs
GET /v1/targets
GET /v1/targets/by-session-ref
POST /v1/messages/query
POST /v1/messages/trace
POST /v1/messages/dm
POST /v1/messages/turn-handoff
POST /v1/targets/ensure
POST /v1/messages
POST /v1/capture/by-selector
POST /v1/literal-input/by-selector
POST /v1/turns/by-selector
POST /v1/messages/wait
POST /v1/messages/watch
POST /v1/internal/mail/stop-decision
POST /v1/internal/mail/hint-decision
POST /v1/declarations/resolve
POST /v1/placements/resolve
POST /v1/previews/run
```

112 exact registrations above (including the constant restart-self path). Additionally:

```text
GET /v1/runs
GET /v1/runtimes
GET /v1/inputs/:inputId
GET /v1/inputs/:inputId/watch
GET /v1/sessions/by-host/:hostSessionId
POST /v1/sessions/:hostSessionId/title
DELETE /v1/sessions/:hostSessionId/title
GET /v1/runtimes/:runtimeId/seat
GET /v1/active-run-contributions/:inputApplicationId
POST /v1/internal/launches/:launchId/{continuation,wrapper-started,child-started,event,exited} (retired)
```

Computed registrations: `index.ts` invokes `runtime-list-handlers.ts::createRuntimeListRoutes`. Pattern routing: `server-request-methods.ts::dispatchRequest`, `server-routing.ts`, `input-handlers.ts::matchInputRoute`. Unmatched requests preserve 404/error behavior. Separate peer/registry listeners and ingest/forwarder transports are required coverage beyond this public-socket manifest.
