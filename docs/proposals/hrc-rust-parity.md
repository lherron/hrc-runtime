# HRC Rust parity: remaining feature and gap closure

Status: design APPROVED by Daedalus (EN-33646), pending Lance adoption, 2026-10-23. Owner: Astra. Task: T-11525 (Rust native parity proposal). Source baseline: `763c28dbf27ccb36ab3ccd532320d3585e89179e`. Analysis only: no runtime parity, activation or implementation completion is claimed. Design review and Lance's adoption are separate from implementation dispatch.

## Recommendation

Build the native Rust daemon incrementally alongside the complete Bun implementation, using isolated state and execution substrates. Keep production Bun functioning independently throughout. Transfer the coupled execution owner **as a whole per node**, only after parity and real rollback pass. Do not split lifecycle, messaging, broker execution and federation across two live writers just to follow the old S1–S5 table.

This amends the provisional stage-2 execution strategy in [the migration proposal](hrc-rust-migration.md), not its delivered Cardo kernel. The original M1 question is now answered at source-analysis level: the proposed slices are useful work categories but are not independent production ownership boundaries. We retain one repository, the existing HTTP and Cardo contracts, Bun migration authority, separate brokers, and existing operational authority. No Bun retirement or schema-ownership transfer is authorized by this proposal. Historical stage 3 remains a later, separately authorized decision.

The alternative is to add cross-process claim locks, execution routing, notification bridging and startup/job suppression to Bun. That changes the working system to support the port and requires another architecture to prove. It is avoidable under Lance's requirement that current Bun HRC continue functioning as-is.

## What exists and what does not

The Cargo workspace has two members: `hrc-domain` and `hrc-kernel`. Rust owns the Cardo document/wire service, API ledger adapter, projection/preview logic and attach descriptors. `seat.summon` and `seat.restart` are implemented **facades** over Bun's existing owner routes; they are not native lifecycle implementations. There is no native HRC HTTP daemon or HRC SQLite repository implementation in these crates. `contract/` and `conformance/` are absent at the source baseline.

Kernel release packaging and Rust verification already exist (`scripts/lib/kernel-release.ts`, `justfile`); extend these rather than create a second installation system. The old proposal's header predates delivered summon/restart work; code at this baseline takes precedence over that status summary.

Two independent Cody audits supply the detailed source inventory, and Astra checked the critical coupling and operational findings:

- [State ownership and complete public route inventory](hrc-rust-parity/state-audit.md): 112 exact registrations, two computed registrations, pattern routes and separate peer/registry/ingest transports; route-family matrix, shared maps/jobs and proposed acceptance scenarios.
- [Storage, CLI, maintenance and release audit](hrc-rust-parity/operations-audit.md): direct consumers/writers, schema and notification semantics, package dependencies, rollback and fleet gaps.

These are source findings, not runtime measurements. They are checked-in snapshots; the first implementation package must turn their inventories into executable coverage and refresh them against its dispatch commit.

## Why the old ownership sequence fails

| Proposed separation | Source evidence | Consequence |
|---|---|---|
| S1 reads before execution | `runtime-list-handlers.ts` reconciles liveness; `runtime-io-handlers.ts::captureRuntime` writes activity | Classifying by GET or “read” loses existing side effects. |
| S2 messages before S4 turns | `target-message-dm-handlers.ts` calls `executeAdmittedTurn`; handoff and terminal processing share `turnResponseFinalizers` | A message route can start, recover and complete execution. Moving its subscriber set does not move its owner. |
| S3 lifecycle before S5 federation | `scope-claim-core.ts` checks in-flight starts before row persistence; `federation/authority-lock.ts` has process-local summon/retirement/mint locks; peer callbacks directly invoke starts | Public route routing does not fence peer ingress, asynchronous occupancy or retirement. SQLite writer locking does not fix this. |
| Shared WAL supplies event propagation | `lifecycle-append-hub.ts` uses a WeakMap keyed by a Bun Database; `notifyEvent` also triggers execution effects | Rust writes do not wake Bun observers automatically. Replaying notifications can repeat actuation. |
| Socket swap provides rollback | Constructor starts recovery, controllers, listeners, publishers and timers; stop drains handlers before closing the store | Ownership transfer includes all these surfaces and credential incarnation, not just `hrc.sock`. |

Optional early read fronting is not on the critical path. If later requested, restrict it to a proved method/path/query/locality allowlist in a reader process with no controller, recovery, timers, credentials or ingest. Reconciling reads, status identity, scoped forwarding and streams stay with their owner until separately proved. This proposal does not authorize deploying a read front.

## Compatibility fixed points

1. **Bun alone remains supported.** Existing executable names, launch configuration, API, SDK exports, direct-store tools and behavior remain available without any Rust process. The port does not require changes to Bun's execution architecture. Ordinary Bun fixes/features continue; corresponding Rust contracts are refreshed before Rust can be graded current.
2. **One execution owner per node/state/substrate.** Production Bun and native Rust never simultaneously own the same controllers, peer actuation, ingest, recovery or jobs. Existing external writers such as `hrc run annotate` and maintenance tools remain explicit compatibility consumers; this is not a claim that SQLite has only one connection.
3. **Schema stays Bun-owned.** Rust understands the exact compatible schema/migration set, refuses unknown or incomplete schemas, and does not migrate a live store. Native tests initialize scratch stores using the canonical Bun migration machinery. A standalone Rust schema bootstrap/migrator is a later closure item gated separately; it does not silently acquire production migration authority.
4. **No state-model redesign.** Preserve session/scope/lane/generation, claims and request hashes, input/admission receipts, lifecycle and raw sequences, incarnation IDs, holes, spill references, projection-before-ACK and recovery behavior. Cardo remains a derived view, not another execution ledger.
5. **Fallback is a named release.** At each qualification, record the exact Bun release/config/producer tuple that must read and continue Rust-written state. Same-release fallback is required; backward compatibility with every historical Bun release is not implied. Requalify the pair when Bun schema or behavior changes.
6. **Isolation includes destinations.** Separate DB/runtime roots alone are insufficient. Scratch execution has separate tmux servers/leases, scopes, sockets/ports, registry, ASP configuration, wrkq authority and publication destinations. Sanitized copied state must not authorize attaching or reaping production brokers. Reuse the current checkout and Cargo target directory; isolate installed artifacts and runtime data, not compilation caches.
7. **Existing boundaries stay.** ASP owns preparation and brokers; wrkq owns collaboration storage; ACP owns the injector and gateways. No consolidation, ACP port, new feature flags or package removals are part of this port.

## Feature closure ledger and order

These are bounded implementation packages, not yet-dispatched backlog tasks. Each receives a task and reviewed detailed contract when armed. The next package is P0; avoid filing a task for every source observation. The critical path is **P0 → P1 → P2 → P3 → P4 → P5 → P6 → P8**. P7 is required for full HRC tooling parity and can proceed alongside P3–P6 after its contracts stabilize.

| Package | Deliverable and native gap closed | Prerequisite | Evidence required to close |
|---|---|---|---|
| **P0 — executable compatibility baseline** | Neutral inventory for public exact/computed/pattern routes, aliases/refusals, peer/registry/ingest protocols, CLI commands, direct-store consumers, files, jobs and package exports. Socket-parameterized external conformance runner; real Bun observations before fixtures. | Adopt this bearing; task-scoped design review of concrete runner/manifest | Every inventory entry maps to a scenario or explicit remaining gap. Bun-alone installed baseline produces durable artifacts. Deliberate broken response, missing route and wrong owner make relevant checks fail. |
| **P1 — native store and finite observations** | `hrc-store` for canonical SQLite mappings, transactions, schema guards, lifecycle/raw ledgers, FTS/index/blob compatibility and passive local reads. Reuse `hrc-domain` types/projections where sound. | P0 | Coherent nonempty scratch snapshots; holes/highest-row deletion, large payloads, malformed JSON, busy/crash/reopen and rollback. Unchanged Bun CLI/export/capture verifier reads Rust-written data. Side-effect-free candidate reads checked against mutating controls. |
| **P2 — native daemon and lifecycle foundation** | Native listener/config/error/status and shutdown shell; credentials/admission; ASP intent/preparation; sessions/claims/placement; runtime provisioning and participant registration/attach. Broker-facing contracts laid out before implementation. | P1 and external ASP/wrkq interface decisions | Real scratch cold/warm launch, exact/suffix replay/conflict, concurrent local+peer claim harness, stale generation, participant reconnect and bounded shutdown. Incomplete turn paths remain unqualified; no production owner transfer. |
| **P3 — broker events, turns and recovery** | Controller integration with existing external brokers; raw ingest/project/ACK, gaps/replay, submissions/input, permission/capture/bridge behavior, context/continuation/restart, retained evidence, startup recovery and execution sweeps. | P2 | Real turn.message and turn.completed; human busy turn without a run row; commit-before-ACK crash and reattach; no duplicate queue drains; phase-B restart launch failure; capture evidence and all named recurring/startup jobs. |
| **P4 — messages and durable publication** | DM/handoff/query/trace/wait/watch, response finalization, target/selector paths, stop/hint decisions, lifecycle/raw/message streams with admission/receipt ACK, wrkq session/server publications and cursors. | P3; wrkq external contract fixed in P0 | Real semantic reply exactly once across owner restart; replay/live boundaries, loss/overflow/abort/incarnation controls; lost publication ACK and idempotent cursor recovery. Bun is unavailable in the native test, so delegation cannot masquerade as parity. |
| **P5 — federation and remaining transports** | Peer/registry endpoints, home routing, claims/retirement/designations, accepted requests/outbox/collective history, ingest Unix/TCP, forwarder spool/cursors, foreign-home cleanup. Federation types/races begin in P0/P2; full qualification waits for execution/messages. | P4 | Real isolated mixed Bun/Rust peers both directions; concurrent public/peer start versus retirement, wrong-home/refusal, no second hop, peer loss/recovery, remote message terminal, blob-before-reference and forwarder crash/retry. |
| **P6 — operational closure and native kernel integration** | Transcript index/search/rebuild, diagnostics, all jobs/files/direct consumers; native daemon packaging/status/installed tests; embed existing Cardo projection through native ledger while preserving document/mount behavior. | P5 | Matrix has no unowned route/job/transport. Installed Rust with Bun daemon stopped passes real CLI/SDK/broker workflows; kernel rebuild/resync/attach remain equivalent. Native listener health cannot be a proxy response. Resource/latency results compared with Bun baseline on representative state. |
| **P7 — Rust CLI and HRC-owned tools** | Native CLI argument/output/exit/PTY behavior, monitor/export/annotation/capture verification, maintenance/rebuild utilities and HRC launch/status/install-facing integration. Preserve TS SDK/package exports for TS clients. | P0; P1 store contracts; execution commands qualify after P3–P6 | Command inventory includes aliases/help/errors/JSON/NDJSON/exit codes. Real PTY attach and monitor, annotated run export, protected worktree prune, spill/retention crash-resume and registry rebuild. Run new Rust CLI against Bun and Rust; run unchanged Bun CLI against both. No replacing the default binary before qualification. |
| **P8 — reversible node qualification** | Reviewed activation/rollback procedure transferring the complete execution owner, installed release provenance and supported rollout tooling. | P6 plus P7 commands needed by activation; full-tooling claim additionally requires all P7 | Scratch Rust→Bun and Bun→Rust continue the same broker/session/history, streams and pending work with exactly one owner. Then separately authorized pilot/fleet qualification and same-release Bun fallback. |

P0 precedes implementation because it determines what “rest of HRC” actually counts and catches new Bun behavior while Rust is being built. P1 makes later ports cheaper by sharing canonical storage and transaction semantics. P2/P3 establish execution before P4 can truthfully deliver messages. P5 closes alternate ingress before ownership can transfer. P6/P8 prevent an HTTP-only completion claim.

Potential parallel work after P0: store/read implementation; CLI parser/output inventory and compatible transport; release/activation design; external dependency protocol work. Actual runtime/message/federation integration remains ordered. Mable owns implementation campaign execution, task seats own bounded diffs, Astra grades durable results, and Daedalus verifies material designs. No workers are armed for implementation by this document.

## Acceptance and grading

Each package records source commit, candidate and fallback release/config tuples, commands, expected assertions, negative controls and artifacts. Tests compare behavior and durable effects, not merely response shapes. Normalize only declared nondeterministic values; never normalize away missing fields, errors, ordering or duplicate effects. Use consistent SQLite backup/VACUUM snapshots, never copy a live WAL file.

Three independent claims must remain distinct:

- **Bun compatibility:** existing installed Bun alone passes the real workflows, without kernel/front. Removing the Rust process must not affect it.
- **Native daemon parity:** Rust performs all daemon work with Bun daemon unavailable. Existing Bun CLI/SDK/direct tools continue working. A fixture owner or HTTP proxy does not satisfy this claim.
- **Full HRC tooling parity:** P7 and standalone bootstrap/tooling closure are complete, including fresh-store initialization through a reviewed Rust migrator. JS SDKs and external ASP/ACP processes may remain for their consumers; their existence does not imply HRC daemon work is still delegated.

For native bootstrap, implement a Rust runner for the canonical migration history only after parity of fresh and upgraded scratch stores is proved. During coexistence it is test-only; production migration authority remains Bun. Authorizing its production use and retiring Bun are separate decisions after this proposal's compatibility goal, not prerequisites for developing the Rust implementation.

Minimum cross-cutting gates: nonempty read/store cases; exact/suffix claim races before row persistence; broker commit/ACK crash windows; lifecycle and raw stream replay/live seam; semantic response recovery; every startup/recurring job; direct-store external writers; real mixed federation; installed release identity; and forward/reverse owner handoff. Both audit appendices spell out scenarios and controls. No fixed throughput or polling latency promise is invented here: P0 records Bun baselines and proposes numerical budgets for approval before the relevant performance gate is armed.

## Deployment and rollback design required before P8

Development is gradual; the eventual execution-owner switch is per node. It is not a simultaneous fleet cutover and does not require retiring Bun. Do not run two full daemon constructors against one live state/substrate.

The P8 design must name and fence every ingress, controller, startup recovery, recurring job and publisher, and account for requests accepted before drain. It must close admission, establish bounded settlement or durable uncertainty, stop the prior owner without terminating brokers, verify it relinquished endpoints/control, start the replacement against the same compatible state, and read back reattach, event progress and real turn completion. On failure, stop/fence the candidate before restoring the named Bun release. Credential rotation, replay cursors, pending input, projections and publication recovery must be demonstrated in both directions. This is an acceptance contract, not a claim that an atomic handoff mechanism already exists.

All installs, activations and promotions retain the build/deploy guide and Mable restart authority. The intended qualification order is isolated scratch → hrcdev → svc → max3. Current `just deploy-fleet` promotes max3 → svc → hrcdev; it cannot be cited as implementing that pilot order. Before fleet activation, Mable must have a reviewed supported pilot procedure or a separately delivered change to deployment tooling. No hand deployment or service operation is authorized here.

Preserve `sourceCommit`, selected/running release comparison and actual binary/package path reporting. Same source commit does not by itself prove native authority: also record which implementation owns execution. Use the existing incremental Cargo target and atomic release machinery.

## Decision and next action

Adopt the **independent native build with cohesive per-node owner transfer** as the replacement for the provisional split-writer plan. Keep the existing API-fed kernel and Bun deployment unchanged. Then arm only P0, with P1 next after the executable baseline is graded. Detailed component designs and P8 activation mechanics still need their own reviewed specs; this proposal is the feature closure map, not permission to improvise them.

Neither Bun retirement, an ACP port nor broker consolidation belongs to this authorization. If “all Rust” later means eliminating every build-time Bun dependency or every external Bun process, that is a separate scope ruling; this proposal includes HRC native daemon and HRC-owned operational tooling while preserving client package compatibility.
