# Refactor Analysis — `packages/hrc-server/src`

Methodology: SOLID violations, code smells, complexity. Analysis only — no source files were edited.

- Production files analyzed (excluding `__tests__`): 78
- Production source lines: ~30,882
- Largest / most-central files:
  - `broker/controller.ts` (2,462) — broker lifecycle/RPC/supervision god-class
  - `startup-reconcile.ts` (1,563) — restart reconcile + warmup + orphan sweep
  - `index.ts` (1,518) — `HrcServerInstance` HTTP router + lifecycle + many handlers
  - `broker-interactive-handlers.ts` (1,399) — interactive turns + DI wiring + allocators
  - `broker/event-mapper.ts` (1,203) — sole broker-event → HRC-state projector
  - `selector-message-handlers.ts` (1,091), `runtime-control-handlers.ts` (1,054), `app-session-handlers.ts` (867), `sweep-reconcile.ts` (859), `broker-decisions.ts` (768), `target-message-handlers.ts` (747)

The package is mid-decomposition: handler clusters are split into `*-handlers.ts` modules whose exported method-bags are `Object.assign`-ed onto `HrcServerInstance.prototype`, with a shared `ServerContext` and a `this`-typed `HrcServerInstanceForHandlers`. The seams exist but several core units are still very large.

## SOLID Scorecard

| Principle | Status | Notes |
|---|---|---|
| S — Single Responsibility | red | `controller.ts` mixes lifecycle, RPC, persistence, event consumption, tmux-lease reaping, SQL; `event-mapper.projectState` is a 363-line switch; ~25 methods >50 lines |
| O — Open/Closed | yellow | `event-mapper` has a 30+ case type switch (projection) plus a parallel `lifecyclePayload` switch and a `BROKER_TO_HRC_KIND` map — three places to edit per new broker event type |
| L — Liskov | green | No throwing/no-op overrides; optional-method capability guards (`listInvocations?`, `streamInvocationEvents?`) are honestly typed and runtime-checked |
| I — Interface Segregation | red | `HrcServerInstanceForHandlers` is a ~190-member `this`-type with 147 `HandlerMethod` entries; every handler module depends on the whole surface |
| D — Dependency Inversion | yellow | Good seams in `controller.ts` (factories injected); but `getHarnessBrokerController` reads `process.env`/`process.pid` directly and hand-builds collaborators inline; `event-mapper` news directly off SQL via `db.sqlite.query(...)` raw strings |

## Priority Refactorings

### 1. Split `event-mapper.projectState` (363-line switch) by event family
- Location: `broker/event-mapper.ts:423-786`
- Principle: SRP / OCP
- Current: one `switch (envelope.type)` with 30+ cases mutating runtime/invocation/run/buffer/continuation/permission state inline; a second switch (`lifecyclePayload`, ~line 1096) and a third map (`BROKER_TO_HRC_KIND`, line 146) must be kept in lockstep for each event type.
- Suggested: extract per-family private projectors (`projectInvocationLifecycle`, `projectTurn`, `projectMessage`, `projectToolCall`, `projectPermission`, `projectContinuation`) and dispatch via a `Partial<Record<eventType, projector>>` table colocated with the kind map, so adding an event type touches one record entry.
- Risk: medium — large surface, but `broker-event-mapper.test.ts` pins atomicity/idempotency/conflict invariants. API-preserving (internal restructuring of one class; `apply()` signature unchanged).
- Effort: M-L. Tests: existing mapper suite covers the contract; add a per-family unit test as families are extracted.

### 2. Decompose `HarnessBrokerController.start` (277 lines) into named phases
- Location: `broker/controller.ts:569-845`
- Principle: SRP
- Current: one method does substrate/headless allocation, durable-vs-stdio client construction, retry dial, hello, protocol/admission gating, preflight, persistence graph, attached-launch gate, invocation start, post-start admission, DB updates, active-map registration, event-consumer launch, and error teardown.
- Suggested: extract `acquireClient(input)`, `negotiateAndAdmit(client, input)`, `dispatchInvocation(client, input, allocation)`, `registerActiveRuntime(...)`; keep `start` as a linear orchestrator returning the result union.
- Risk: medium — central dispatch path; covered by broker controller + route tests. API-preserving.
- Effort: M.

### 3. Carve a persistence layer out of `controller.ts`
- Location: `broker/controller.ts` — `persistStartGraph` (1403-1562), `buildRuntimeStateJson` (1564-1657), `markStartedInvocationFailed`, `markBrokerInvocationTerminal`, `markBrokerCrashTerminal`, plus raw SQL in `findUserInitiatedContinuationClearReason*` (2137, 2165)
- Principle: SRP / DIP
- Current: the controller embeds DB-row construction, runtime-state-JSON shaping, and inline `db.sqlite.query("SELECT ... json_extract ...")` strings alongside lifecycle/RPC logic.
- Suggested: move row construction + the two raw queries into a `BrokerControllerStore` (or extend the existing `db.brokerInvocationEvents` repo with a `latestContinuationClearReason(invocationId, beforeSeq?)` method); controller calls typed methods.
- Risk: medium — SQL must be moved verbatim; behavior identical. The repo method is a new exported symbol on the store package (not on hrc-server's public API), so the hrc-server surface is preserved but the store package gains a method.
- Effort: M.

### 4. Shrink `HrcServerInstanceForHandlers` (ISP)
- Location: `server-instance-context.ts:36-~230` (147 `HandlerMethod` members)
- Principle: ISP
- Current: every extracted handler module is typed `this: HrcServerInstanceForHandlers` and thus structurally depends on all ~190 members, even though each handler uses a handful.
- Suggested: define narrow per-cluster `this`-types (e.g. `BrokerInteractiveThis`, `AppSessionThis`) composed from small mixin interfaces, and type each handler bag against only what it needs. `HrcServerInstanceForHandlers` becomes the intersection of those.
- Risk: low — pure type-level change, no runtime behavior; compiler enforces correctness. API-preserving.
- Effort: M (mechanical but broad).

### 5. Inject environment/clock into `getHarnessBrokerController`
- Location: `broker-interactive-handlers.ts:1168-1327`
- Principle: DIP / SRP
- Current: 160-line factory reads `process.env`, `process.pid`, `randomUUID`, `writeServerLog` directly and inlines two allocator closures + a reap closure.
- Suggested: extract `buildBrokerControllerDeps(this, opts)` returning the deps object; source env/pid/serverInstanceId from `this.options`/`ctx` (already partly available) so the factory is testable without globals. Move the inline legacy-allocator closure to a named `createLegacyBrokerTmuxAllocator`.
- Risk: low-medium — wiring only; the controller already accepts all of these as injectable deps. API-preserving.
- Effort: M.

### 6. Split `selector-message-handlers.handleSdkDispatchTurn` (264 lines)
- Location: `selector-message-handlers.ts:163-426`
- Principle: SRP
- Current: single handler resolves session/runtime, branches transport, runs the SDK turn, records detached failures, and shapes the response.
- Suggested: extract `resolveSdkDispatchTarget`, `runSdkTurnAndFinalize`, reuse `recordDetachedSemanticTurnFailure` (already extracted). 
- Risk: low — local to one module; SDK turn tests cover it. API-preserving.
- Effort: S-M.

### 7. Split `app-session-handlers.handleEnsureAppSession` (232 lines) and `target-message-handlers.handleSemanticTurnHandoff` (211 lines)
- Location: `app-session-handlers.ts:99-330`; `target-message-handlers.ts:98-308`
- Principle: SRP; note `handleEnsureAppSession` also constructs sub-`Request` objects to re-enter its own routes (`app-session-handlers.ts:624,641`) — an internal HTTP self-call smell.
- Suggested: extract validation/lookup/dispatch helpers; replace the in-process `new Request(...)` self-invocation with direct method calls.
- Risk: low-medium. API-preserving.
- Effort: M.

## Code Smells

| Smell | Location | Detail |
|---|---|---|
| Long method | `event-mapper.ts:423` (363), `controller.ts:569` (277), `selector-message-handlers.ts:163` (264), `app-session-handlers.ts:99` (232), `target-message-handlers.ts:98` (211), `turn-dispatch-handlers.ts:262` (198), `controller.ts:968` (181), `sweep-reconcile.ts:543` (177) | ~25 methods exceed 50 lines; 8 exceed 175 |
| Large file | `controller.ts` (2462), `startup-reconcile.ts` (1563), `index.ts` (1518), `broker-interactive-handlers.ts` (1399), `event-mapper.ts` (1203) | 11 files >700 lines |
| Duplicated dispatch table | `event-mapper.ts:146` (`BROKER_TO_HRC_KIND`) + `:443` (projectState switch) + `:1096` (lifecyclePayload switch) | three structures keyed on the same event-type enum |
| Raw SQL in domain code | `controller.ts:2137,2165`; `event-mapper.ts:396,409` | inline `db.sqlite.query("SELECT ... json_extract ...")` strings outside the store package |
| Inline magic constants | `controller.ts:102-105` connect-retry numbers (named consts — OK); `controller.ts:1696` `'/tmp/hrc-runtime'`, `:1708` `'synthesized-headless-attach-token'`; `broker-interactive-handlers.ts:1274` `timeoutMs: 5_000`, `:1391` `120_000` | scattered literals in fallback/synthesis paths |
| In-process HTTP self-call | `app-session-handlers.ts:624,641` | handler builds `new Request(...)` to invoke its own routes instead of calling the method |
| God interface | `server-instance-context.ts:36` | ~190-member `this`-type; ISP violation feeding every handler |
| Repeated terminal-state bookkeeping | `controller.ts` mark* methods (1773, 2026, 2278) | near-identical runtime/invocation/run "mark failed/terminal" update blocks |

## Quick Wins
- Extract the two raw continuation-clear SQL queries in `controller.ts` (2137, 2165) into one private/store helper — they differ only by an optional `beforeSeq`.
- Promote the headless-synthesis literals (`controller.ts:1696,1708`) to named constants next to the existing `BROKER_UNIX_CONNECT_*` block.
- Collapse the `BROKER_TO_HRC_KIND` map and `lifecyclePayload` switch into a single colocated table so new event types are added in one place.
- Replace the `new Request(...)` self-invocation in `app-session-handlers.ts` (624,641) with direct handler-method calls.
- Factor the three `mark*` terminal-bookkeeping blocks in `controller.ts` into a shared `applyTerminalRuntimeState(...)`.

## Technical Debt Notes
- The prototype-`Object.assign` handler pattern (`index.ts:1448`) plus the giant `this`-type is the dominant architectural debt: it gives modular files but global structural coupling and defeats per-handler unit isolation. The narrow-`this` refactor (#4) is the highest-leverage, lowest-risk structural improvement.
- `controller.ts` and `event-mapper.ts` carry heavy historical comment ballast (flag-cutover narratives, T-IDs). Much describes decommissioned states (legacy v0.1 stdio, removed hatches) and can be pruned, but pruning is doc-only and out of scope for behavior-preserving refactors.
- DIP is mostly healthy in the controller (factories injectable); the remaining global reads are concentrated in the one factory (#5).

## Safety Checklist (before applying any refactor)
- Run the full hrc-server suite with `TMPDIR=/tmp`; re-run flaky tests in isolation (per MEMORY: dispatch-turn-live-harness-literal timing; server-bridge-phase2 deliver-text env-sensitivity).
- Pin `broker-event-mapper.test.ts` green before/after any `projectState` change (atomic / idempotent / conflict / `source:'broker'`).
- Keep `apply()`, `start()`, controller RPC signatures, and all `handle*` route handler signatures byte-identical (API-preserving items only).
- For store-method extractions, move SQL verbatim; diff query text.
- Do not commit on `main` without branching; diff before commit (shared-worktree co-edit hazard).
