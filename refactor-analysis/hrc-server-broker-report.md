# 🔧 Refactoring Analysis — packages/hrc-server/src/broker

**Target:** `packages/hrc-server/src/broker` (concurrent profile, recursive) · **Files read:** 18 / 18 source `.ts` · **Lines:** ~5,794 · **Package type:** internal sub-module of `hrc-server` (no `index.ts`; consumed only through sibling `hrc-server/src` handlers + tests, never across a package boundary).

## 🧭 Summary
This is an already-decomposed, heavily-commented module: `controller.ts` and `event-mapper.ts` were each split into a `controller/` and `event-mapper/` sub-tree of verbatim mechanical moves, and the seams (DispatchContext / LifecycleContext / PersistenceContext / AllocationContext) are clean dependency-injection. The remaining findings are **duplication / parameter-object** opportunities and a couple of **partial-function** smells — not structural rot. The concurrency surface (the `active` Map, the attached-start waiter maps, the fire-once reap Set) is single-threaded by Bun's event loop and protected by check-then-act-in-one-tick discipline; I found **no true data race**, but one **deferred** widening (the `notActive` not-active check is read at call-entry and the awaited RPC can resolve against a since-deleted record — see DF-1).

## 🚪 Public boundary (assess first)
The module exposes no `index.ts`. Its observable surface is:
- `HarnessBrokerController` (class) + `BrokerControllerError`, `isDurableBrokerClient`, and ~20 re-exported types from `controller.ts` — consumed by `turn-dispatch-handlers.ts`, `startup-reconcile.ts`, `broker-interactive-handlers/*` (all via `Pick<HarnessBrokerController, …>` in reconcile, which is a healthy narrow interface already).
- `BrokerEventMapper` — instantiated only by the controller.
- `runtime-hosting.ts` predicates (`parseBrokerRuntimeHostingState`, `hasDurableBrokerEndpoint`, `canOperatorAttach`, …) — pinned by `broker-substrate-presentation-characterization.test.ts`.
- `runtime-state.ts`, `capabilities.ts`, `lifecycle-overlay.ts` helpers.

**T07/M02:** No fat or leaky public interface worth narrowing. The `Pick<>` usage at the reconcile call sites is already a good consumer-aligned narrowing. The class API is wide (start/attach/dispatchInput/interrupt/stop/status/listInvocations/snapshot/reconcile/dispose/resume/cancel/waitForAttachedStartReady/shutdown) but each method maps to a distinct broker RPC or lifecycle hook — the width is genuine, not envy. No contract change is warranted.

**Verdict: 🟢** boundary is sound; all actionable findings are internal-only churn except DF-1 (concurrency) and DF-2 (duplicated endpoint type), which are public-surface/observable enough to defer.

## 🎯 Findings by mechanism (outside-in, highest impact first)

### F1 — RPC method guard+try/catch boilerplate → extract missing abstraction [T15]
- **Location:** `controller.ts:364–605` (`dispatchInput`, `interrupt`, `stop`, `status`, `listInvocations`, `snapshot`, `dispose`, `reconcile`).
- **Mechanism repaired:** duplicated *intent* — "resolve active runtime or return `notActive`; run the RPC; map a thrown error via `toControllerError(code, …)`". Eight methods repeat this 5-line scaffold with only `(code, body)` varying.
- **Symptom:** ~8× `const active = this.active.get(runtimeId); if (!active) return { ok:false, error: this.notActive(runtimeId) }` followed by `try { … } catch (error) { return { ok:false, error: toControllerError('<code>', error) } }`.
- **Current → Suggested:** introduce a private `private async withActive<T>(runtimeId, code, fn: (active) => Promise<T>): Promise<BrokerControllerRpcResult<T>>` that does the lookup, the not-active short-circuit, and the catch→`toControllerError`. Each RPC body shrinks to the one `await active.client.X(...)` call. `listInvocations` (non-`RpcResult` return shape) and `dispose`/`reconcile` (extra pre/post steps) stay bespoke or use a thinner variant.
- **Direction:** extract (toward abstraction) — justified: 8 instances, identical control flow.
- **Preservation:** test-suite (the broker RPC tests exercise both ok + not-active + thrown-error arms).
- **Falsifiable signal:** controller.ts net `-30..-45` lines; the string `toControllerError(` count drops from 8 to 1; the `if (!active)` count drops from 8 to 1; all broker RPC tests still green.
- **Risk:** Low · **API-impact:** internal-only · **Effort:** M.
- **Tests:** existing `broker-*` RPC tests; add none.
- **Contraindication:** `status`/`snapshot`/`listInvocations` thread an `opts.probeLiveness && livenessProbeAllowed(active.inspection)` gate — the helper must hand `active` (with `.inspection`) to the callback, not just the client. `dispose` also mutates `this.active`/DB after the call, so it is only a partial fit; do NOT force it through the helper.

### F2 — `dispatchInput` inlines the not-active error instead of `this.notActive()` [T15]
- **Location:** `controller.ts:368–375` vs the helper `notActive()` at `controller.ts:927–932`.
- **Mechanism repaired:** a single literal copy of the `'broker_runtime_not_active'` / `no active broker client for runtime ${id}` message that every *other* RPC already routes through `this.notActive(runtimeId)`.
- **Symptom:** `dispatchInput` constructs the `BrokerControllerError` inline; the message string is duplicated verbatim at two sites (grep-confirmed: controller.ts:373 and :930).
- **Current → Suggested:** replace the inline `new BrokerControllerError('broker_runtime_not_active', …)` with `this.notActive(input.runtimeId)`. (Subsumed by F1 if F1 is applied.)
- **Direction:** dedup.
- **Preservation:** type/compiler-proof (identical error code + message; same `RpcResult` shape).
- **Falsifiable signal:** the literal `no active broker client` appears once in source after the change.
- **Risk:** Low · **API-impact:** internal-only · **Effort:** S.
- **Tests:** existing dispatch-not-active test.
- **Contraindication:** none.

### F3 — `checkPreStartDriverCapabilities` ≈ `checkInvocationCapabilities` near-duplication [T15]
- **Location:** `capabilities.ts:132–196` and `198–259`.
- **Mechanism repaired:** duplicated capability-comparison intent. The two functions are line-for-line identical for 11 of ~13 `checkNeed(...)` calls; they differ only in two arms: `input.queue` (pre-start wraps `requiredOnly(...)`, invocation passes through) and `turns.concurrency` (pre-start tests `=== 'multiple'`, invocation tests `!== 'any'`).
- **Current → Suggested:** extract a shared `checkCommonCapabilities(missing, requirements, caps)` for the 11 identical `checkNeed` calls; keep the two divergent arms (`input.queue`, `turns.concurrency`) in each caller. The `caps` shape differs (`DriverSummary['capabilities']` vs `InvocationCapabilities`) but both expose the same `.input/.turns/.continuation/.permissions/.events/.control` sub-shape used here — a structural-typed `caps` parameter or a small `Pick` union covers it.
- **Direction:** extract.
- **Preservation:** char-test — **add a characterization test** first asserting the exact `missing[]` for one admitting + one rejecting profile through BOTH functions (the two divergent arms are behaviorally load-bearing and easy to fumble).
- **Falsifiable signal:** the `checkNeed(missing, 'events.assistantDeltas'…)` block appears once; capabilities.ts net `-40..-50` lines; admission tests (`interactive-broker-admission.red.test.ts`, `broker-*-admission`) green.
- **Risk:** Med · **API-impact:** internal-only · **Effort:** M.
- **Tests:** add the char-test above; rely on existing admission red tests.
- **Contraindication:** the `caps.input.queue` types differ between the two (driver caps is `boolean`, invocation is `boolean`); confirm structural compatibility — if a `checkNeed` arm's `actual` type diverges, leave that arm in the caller, do not over-unify. This duplication is **partly load-bearing** (the two divergent arms encode a real pre-start-vs-post-start policy difference) — only the 11 identical arms should be collapsed.

### F4 — `findUserInitiatedContinuationClearReason` vs `…ForRuntime` duplicated SQL [T15]
- **Location:** `controller/persistence.ts:357–374` and `382–403`.
- **Mechanism repaired:** duplicated query intent — both run the same `SELECT json_extract(broker_event_json,'$.reason') … WHERE invocation_id=? AND type='continuation.cleared' ORDER BY seq DESC LIMIT 1` and apply the same `USER_INITIATED_CONTINUATION_CLEAR_REASONS.has(...)` filter; the only difference is the seq-scoped variant adds `AND seq < ?` and the runtime-scoped variant first resolves `activeInvocationId`.
- **Current → Suggested:** factor a private `latestContinuationClearReason(db, invocationId, beforeSeq?)` returning the raw reason; both public functions become a 2-line `resolve invocationId → call helper → apply the user-initiated filter`.
- **Direction:** dedup.
- **Preservation:** test-suite (Lever-2 graceful-exit reap tests exercise both the terminal-seq and close-path variants).
- **Falsifiable signal:** the `continuation.cleared` SQL literal appears once; graceful-exit reap tests green.
- **Risk:** Low · **API-impact:** internal-only · **Effort:** S.
- **Tests:** existing Lever-2 reap tests.
- **Contraindication:** the `seq < ?` predicate is semantically load-bearing (the terminal variant must look strictly *before* the terminal envelope). Keep it parameterized; never drop it.

### F5 — `isRecord` triplicated across the module [T15]
- **Location:** `runtime-hosting.ts:92`, `runtime-state.ts:77`, `event-mapper/helpers.ts:12` (and an inline `extractFullRuntimeControlState` use).
- **Mechanism repaired:** a trivial type-guard `typeof x === 'object' && x !== null && !Array.isArray(x)` defined three times. (helpers.ts and runtime-hosting include the `!Array.isArray`; runtime-state's also does.)
- **Current → Suggested:** export one `isRecord` from a single leaf (e.g. `event-mapper/helpers.ts` already exports it, or a new `broker/json.ts`) and import it. Low value alone — bundle with F6.
- **Direction:** dedup.
- **Preservation:** type/compiler-proof.
- **Falsifiable signal:** one `function isRecord` definition in `broker/`.
- **Risk:** Low · **API-impact:** internal-only · **Effort:** S.
- **Contraindication:** these are intentionally local leaf utilities; a shared import adds a cross-file edge. Only worth it bundled with F6's endpoint consolidation, or skip (see Left-alone).

### F6 — `markStartedInvocationFailed`/`failReplayStale`/`markBrokerCrashTerminal` repeat the `runtimeStateJson` spread-and-stamp [T21 parameter object / T15]
- **Location:** `controller/persistence.ts:296–355`, `controller/lifecycle.ts:144–256`.
- **Mechanism repaired:** the recurring "build a terminal `runtimeStateJson` = `{...prior, status, updatedAt, <one diagnostic block>}` + `db.runtimes.update(id, {status, lastActivityAt, updatedAt, runtimeStateJson})`" shape recurs 4×. This is a *data clump* (the `{status, now, runtime, diagnostic}` tuple) more than free duplication.
- **Current → Suggested:** a small `applyTerminalRuntimeState(db, runtime, {status, now, diagnostic})` that performs the merge+update. Modest win; each call site keeps its own diagnostic key (`brokerCrash` / `lastAttachError` / `admissionFailure`).
- **Direction:** extract.
- **Preservation:** char-test — terminal-state shape is observed by `hrc run` shutdown-report and the inspect surface; pin the exact JSON before/after.
- **Falsifiable signal:** the `runtimeStateJson: { ...(runtime.runtimeStateJson ?? {}), status, updatedAt: now,` prelude appears once.
- **Risk:** Med · **API-impact:** internal-only (observable JSON shape) · **Effort:** M.
- **Tests:** terminal/stale/crash projection tests + a fresh char-test on the exact JSON.
- **Contraindication:** the field set per terminal kind differs (`terminalReason`+`terminalInvocation` vs `lastAttachError` vs `brokerCrash`); a spread refactor MUST preserve the exact field set per call (the prompt's spread-preservation rule). If the helper risks normalizing key order or dropping a conditional key, leave it.

### F7 — `connectDurableBrokerWithRetry` "unreachable" final throw → partial→total comment [T17, minor]
- **Location:** `controller.ts:310–313`.
- **Mechanism:** the loop always returns or throws on the last attempt, so the post-loop `throw lastError…` is a `// Unreachable` guard. This is correct defensive code, not a smell to remove — flagged only to note that re-expressing the loop as `for (attempt of 1..max-1) {retry}; return await lastAttempt()` would make totality compiler-evident and delete the dead tail. **Low value; likely leave alone** (the current form is clearer about the retry budget).
- **Risk:** Low · **API-impact:** internal-only · **Effort:** S · **Recommendation:** leave alone unless touching this function for another reason.

## 🪶 Deliberately left alone (where-NOT)
- **The `controller/` and `event-mapper/` sub-tree splits.** These are deliberate big-file decompositions (per MEMORY: index.ts-decomposition / T-01807) into *verbatim mechanical moves* with explicit context objects. The `DispatchContext`/`LifecycleContext`/`PersistenceContext`/`AllocationContext` seams are textbook [T01] substitution seams — do not collapse them back.
- **The `BROKER_TO_HRC_KIND` table + per-family `projectInvocationLifecycle/projectLifecyclePolicy/projectTurn/...` dispatch** in `event-mapper.ts`. This is already a healthy [T19] conditional→dispatch; the big `switch` in `projectState` routes to cohesive per-family methods. No further extraction needed; the comment explicitly pins byte-identical behavior to the prior single switch.
- **`compactEnv`, `toControllerError`, `isControllerFencedError`, `isBrokerSocketNotReadyError`, `livenessProbeAllowed`, `rehydrateInspectionCapabilities`** in `controller/internal.ts` — single-purpose leaf helpers, correctly placed.
- **The connect-retry magic numbers** (`MAX_ATTEMPTS=24`, `BASE_DELAY_MS=25`, …) — already named constants with a load-bearing comment (T-02009). Not magic.
- **`USER_INITIATED_CONTINUATION_CLEAR_REASONS` ⊋ `BROKER_TMUX_PROMPT_EXIT_REASONS`** — the `clear` exclusion is deliberate and commented (a `/clear` keeps the session). Do NOT unify these two Sets; the difference is the invariant.
- **The `active` Map / `intentionalClosingRuntimeIds` Map / `reapedBrokerTmuxRuntimeIds` Set as separate shared-mutable maps.** Tempting [T31] target, but each is read-then-written within a single synchronous tick (no `await` between check and act for the reap-once Set and the closing map), so Bun's single-threaded loop makes them race-free. Collapsing them into one record-per-runtime is a redesign, not a refactor. Left alone.
- **F7 unreachable-throw** — current form documents the retry budget; not worth churning.

## 🔭 If applying: outside-in sequence
1. **F2** (trivial, subsumed by F1) and **F4**/**F5** (pure dedup, compiler-proof) first — safest.
2. **F1** `withActive` helper — biggest line win; gated by the existing RPC test corpus.
3. **F3** and **F6** last, each preceded by the named characterization test (divergent capability arms / exact terminal JSON) — these are the only Med-risk items.
4. Re-run the full `broker-*` test suite under `TMPDIR=/tmp` after each step (per MEMORY: Wave-B flakes are non-cutover; isolate re-runs).

## ✅ Safety checklist
- [ ] No public type signature changed (controller re-exports untouched).
- [ ] F3/F6 each have a char-test pinning the exact `missing[]` / terminal-JSON BEFORE the edit.
- [ ] Spread refactors (F6) preserve the exact per-call field set + key presence.
- [ ] `withActive` (F1) forwards `active` (not just `active.client`) so `.inspection` liveness gating is intact.
- [ ] Parameterized-literal dedup (F4 SQL, F3 `checkNeed`) introduces no biome lint regression.
- [ ] Full `hrc-server` broker test suite green; no behavior delta in `hrc run` graceful-exit reap or inspect surface.
