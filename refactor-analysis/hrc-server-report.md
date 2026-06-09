# Refactor Analysis — `packages/hrc-server`

Behavior-preserving refactor audit. Source-read, not grep-only. 78 non-test source
files, 30,992 LOC. 91 test files in `src/__tests__/` provide dense coverage
(notably `broker-controller.test.ts`, broker `*.red.test.ts` suite, parser tests).

## SOLID scorecard

| Principle | Grade | Notes |
|-----------|-------|-------|
| **S** — Single Responsibility | C | A handful of very large, multi-concern units: `broker/controller.ts` (2490 LOC, `HarnessBrokerController` ~30 methods incl. a 273-line `start` and 180-line `attachAndReplay`), `index.ts` (1522 LOC, `HrcServerInstance` ~24 HTTP handlers + lifecycle), `startup-reconcile.ts` (1559 LOC, 30+ free functions of mixed concern). Lower-level modules (`broker-decisions.ts`, parsers) are well factored. |
| **O** — Open/Closed | B+ | `BrokerEventMapper.projectState` is already a dispatch-to-per-family switch (good). `decideHeadlessExecutionRoute`/`decideInteractiveTmuxExecutionRoute` are small closed switches. Main wart is the HTTP route ladder in `index.ts handleRequest` (repeated prefix/suffix string-slicing per route). |
| **L** — Liskov | A | No throwing/no-op overrides found. `isDurableBrokerClient` is a structural type-guard used at a seam, not a Liskov violation. |
| **I** — Interface Segregation | B | Controller dep object (`HarnessBrokerControllerDeps`) is wide but every member is genuinely used; collaborators are narrow `Pick<>`/structural types (`Pick<BrokerEventMapper,'apply'>`, `BrokerPermissionChannel`). Acceptable. |
| **D** — Dependency Inversion | A- | Strong injection seams: `brokerClientFactory`, `brokerUnixClientFactory`, `tmuxAllocator`, `now`, `logger` all injected. No `new Concrete()` of collaborators in business logic. `createHrcServer` is the composition root. |

Overall: the package is architecturally healthy at the seam/abstraction level; the
debt is concentrated in a few oversized files/methods that grew by accretion of
flag-gated waves (broker cutover T-01690…T-01941). All high-value refactors here are
**extract-private-method / extract-helper**, which are behavior-preserving.

---

## Priority Refactorings

### P1 — Decompose `HarnessBrokerController.start` (273-line method)
- **Location:** `packages/hrc-server/src/broker/controller.ts:575`
- **Current:** Single `async start()` spanning ~273 lines inside one `try`. Sequential
  phases: substrate/tmux allocation → durable-vs-stdio client acquisition → permission/close
  wiring → hello + protocol-version gate → capability admission → lifecycle preflight →
  attached-launch gate → invocation start → admission of started invocation → persist
  start graph → error/cleanup. Phase boundaries are already marked via `markPhase(...)`.
- **Suggested:** Extract private helpers along the existing phase seams, e.g.
  `private async acquireBrokerClient(input, markPhase): {client, tmuxAllocation, durableSocketPath}`,
  `private async negotiateHello(client, durableSocketPath, input, markPhase)`,
  `private async admitAndStartInvocation(...)`. Keep `start` as the orchestrator. No
  signature/return-type change.
- **Risk:** Med — internal-only (private method body; public `start` signature unchanged).
- **API-impact:** internal-only.
- **Effort:** M (the `try/catch` cleanup state — `client`, `tmuxAllocation` — must be
  threaded carefully so failure cleanup still runs; this is the only subtlety).
- **Tests:** `broker-controller.test.ts`, `broker-durable-activation.red.test.ts`,
  `broker-durable-allocator.red.test.ts` exercise start paths; run full broker suite after.

### P2 — Decompose `HarnessBrokerController.attachAndReplay` (180-line method)
- **Location:** `packages/hrc-server/src/broker/controller.ts:968`
- **Current:** ~180-line method covering attach-request build, dial/attach, replay-staleness
  check (`failReplayStale`/`lastProjectedBrokerSeq`), event-stream consumption wiring, and
  terminal/close bookkeeping.
- **Suggested:** Extract `private buildAttachRequest(...)`, `private async resolveReplayCursor(...)`,
  and reuse existing `consumeEvents`. Orchestrator stays.
- **Risk:** Med — internal-only.
- **API-impact:** internal-only.
- **Effort:** M.
- **Tests:** `broker-attach-descriptor.test.ts`, `broker-durable-reattach-on-dispatch.red.test.ts`.

### P3 — Extract the `/v1/internal/launches/<id>/<suffix>` route-parsing duplication
- **Location:** `packages/hrc-server/src/index.ts:660-709` (`handleRequest`)
- **Current:** Five near-identical `if (method==='POST' && pathname.startsWith('/v1/internal/launches/') && pathname.endsWith('/<suffix>'))` blocks, each doing
  `pathname.slice(prefix.length).replace('/<suffix>', '')` then calling a `handleX(launchId, request)`.
  Same prefix string literal repeated; same slice/replace shape repeated.
- **Suggested:** A small private helper `matchLaunchSubroute(method, pathname): {launchId, suffix} | undefined`
  plus a `Record<suffix, handler>` lookup, or a single guarded block that extracts `launchId`
  once and dispatches on the trailing segment. Behavior-identical (same routes, same 404 fallthrough).
- **Risk:** Low — internal-only (routing internals; the HTTP contract/paths are unchanged).
- **API-impact:** internal-only (the wire routes stay byte-identical).
- **Effort:** S.
- **Tests:** server request/router tests in `__tests__/` (launch lifecycle handlers).

### P4 — Split `HrcServerInstance` HTTP handlers out of `index.ts` — DEFER
- **Location:** `packages/hrc-server/src/index.ts:337` (`class HrcServerInstance`, ~24 methods)
- **Current:** One class mixes server lifecycle (`stop`, `createHrcServer` orchestration),
  routing (`handleRequest`), and ~20 endpoint handlers (resolve-session, capture, attach,
  inspect, broker-inspect, drop-continuation, launch lifecycle, status, health). 1522 LOC file.
- **Suggested:** Already partially done — most logic delegates to free handler modules
  (`*-handlers.ts`). The remaining safe move is to relocate cohesive handler GROUPS (e.g. the
  launch-lifecycle handlers) into a dedicated module taking server deps, leaving thin forwarders.
  DEFER: moving methods off a class instance touches `this`-bound state and risks subtle behavior
  change; treat as a larger, separately-reviewed task.
- **Risk:** Med — broad, `this`-dependent move → DEFER (ambiguous-to-do-safely in one pass).
- **API-impact:** internal-only.
- **Effort:** L.
- **Tests:** broad server-handler suite.

### P5 — Extract repeated phase/timing + structured-log scaffolding
- **Location:** `packages/hrc-server/src/broker/controller.ts:587-597` (`markPhase` closure);
  `createHrcServer` log-context at `index.ts:1471-1521`.
- **Current:** The `createHrcServer` structured-log envelope
  (`{runtimeRoot, stateRoot, socketPath, dbPath, tmuxSocketPath}`) is repeated verbatim in the
  `begin`/`ready`/`failed` `writeServerLog` calls. `markPhase` timing closure is inline in `start`.
- **Suggested:** Build the log-context object once (`const logCtx = {...}`) and spread it into
  each `writeServerLog`. Pure dedupe; log shape preserved.
- **Risk:** Low — internal-only.
- **API-impact:** internal-only.
- **Effort:** S.
- **Tests:** covered indirectly by startup tests.

### P6 — Extract private parsing helpers out of `startup-reconcile.ts`
- **Location:** `packages/hrc-server/src/startup-reconcile.ts` (1559 LOC, 30+ exports)
- **Current:** One module mixes startup reconciliation, durable-broker reattach, warmup,
  orphan-lease sweep, tmux reassociation, runtime dead/stale marking, AND low-level private
  record/pane parsing helpers (`getRecord`, `toTmuxPaneState`, `tmuxPaneIdentityMatches`,
  `brokerTuiWindowMatches`, `getPersisted*` getters).
- **Suggested:** Move ONLY the private (non-exported) pane/record parsing helpers into a sibling
  private module imported back here. The EXPORTED reconcile/warmup functions are consumed by other
  modules → moving/renaming those is public-surface → out of scope for this pass.
- **Risk:** Low for the private-helper extraction (exported symbols untouched).
- **API-impact:** internal-only (private helpers only).
- **Effort:** M.
- **Tests:** `startup-reconcile*.test.ts` family.

---

## Code smells

| # | Location | Smell | Detail | Risk | API-impact |
|---|----------|-------|--------|------|-----------|
| 1 | `broker/controller.ts:575` | Long method | `start` 273 lines, deep single `try` | Med | internal-only |
| 2 | `broker/controller.ts:968` | Long method | `attachAndReplay` 180 lines | Med | internal-only |
| 3 | `index.ts:660-709` | Duplicated block | 5× launch-subroute prefix/suffix slicing | Low | internal-only |
| 4 | `index.ts:1471-1521` | Duplicated literal | repeated `{runtimeRoot,…,tmuxSocketPath}` log ctx ×3 | Low | internal-only |
| 5 | `broker/controller.ts:2220` `handleBrokerClose` (67 lines) / `:2298` `markBrokerCrashTerminal` (65 lines) | Long methods | terminal-marking branches inline; de-nestable | Low | internal-only |
| 6 | `startup-reconcile.ts` | Large file / mixed concern | 1559 LOC, parsing + reconcile + sweep colocated | Med | mixed |
| 7 | `index.ts handleRequest` | Primitive-string routing | string `startsWith/endsWith/slice` instead of a route table for prefixed routes | Low | internal-only |

No dead code, no Liskov violations, no hardcoded-singleton DI violations found. Magic
numbers in the broker connect-retry path are already extracted to named constants
(`BROKER_UNIX_CONNECT_*`, `controller.ts:102-115`) — exemplary; cite as the pattern to follow.

---

## Quick wins (Low-risk, internal-only, safe to auto-apply)

1. **P3** — dedupe the 5 launch-subroute blocks in `index.ts handleRequest`. Routes byte-identical.
2. **P5** — build `createHrcServer`'s log-context object once and spread into begin/ready/failed.
3. **P6 (private slice only)** — extract private pane/record parsing helpers in
   `startup-reconcile.ts` into a sibling private module (no exported-symbol moves).
4. De-nest `handleBrokerClose` / `markBrokerCrashTerminal` via early-returns (no behavior change).

---

## Technical-debt notes

- **Accretion debt from flag-gated cutover waves.** `controller.ts` and
  `broker-interactive-handlers.ts` carry extensive comments referencing T-01690/T-01812/T-01866/
  T-01874/T-01941 — successive durable-broker cutover phases. The code is correct but `start`
  absorbed every phase. P1/P2 extraction is the highest-leverage paydown and is purely mechanical
  given the existing `markPhase` seams.
- **`index.ts` is composition root + HTTP server class + route table.** Already largely decomposed
  (handlers live in `*-handlers.ts`); finishing the job (P4) is worthwhile but is a `this`-bound
  move that should be a reviewed standalone task, not part of a parallel auto-apply pass — DEFERRED.
- **Healthy patterns to preserve:** `broker-decisions.ts` (small pure predicates),
  `BrokerEventMapper` per-family projector dispatch, narrow injected collaborators, and the
  named-constant retry tunables. These are the target shape for the rest of the package.
- **Test safety:** 91 test files including a dense broker `*.red.test.ts` suite mean the
  extract-method refactors are well-guarded. Run the full `hrc-server` suite with `TMPDIR=/tmp`
  (per repo memory on env-sensitive flakes) after any change.
