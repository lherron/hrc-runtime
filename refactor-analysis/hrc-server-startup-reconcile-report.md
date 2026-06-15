# 🔧 Refactoring Analysis — packages/hrc-server/src/startup-reconcile

**Target:** `packages/hrc-server/src/startup-reconcile/` · **Files read:** 4/4 (`lease-identity.ts` 366, `runtime-mutations.ts` 286, `broker-probe.ts` 152, `types.ts` 97) · **Lines:** 901 · **Package type:** general (with concurrent/data sub-profiles — broker IPC + sqlite runtime mutations)

## 🧭 Summary
This directory is the implementation tier behind the sibling barrel `startup-reconcile.ts` (791 lines), which re-exports nearly every function here and is imported by ~10 sibling modules plus exercised directly by characterization tests. The code is broadly clean, well-commented, and invariant-aware. The strongest mechanism opportunities are de-duplicating the three near-identical `markRuntime{Dead,Stale,Terminated}` mutators ([T15] extract missing abstraction) and relocating a generic `withTimeout` ([T03] affinity). Most other "smells" are load-bearing (deliberate fallbacks, defensive `getRecord` narrowing) and are documented under where-NOT.

## 🚪 Public boundary (assess first)
**API surface:** No `index.ts`. The boundary is the sibling barrel `../startup-reconcile.ts`, which re-exports from all three impl files. Because the barrel surfaces these symbols and tests import them by name (`broker-lease-teardown.red.test.ts`, `broker-endpoint-substrate-reconcile.red.test.ts`), **every exported function here is effectively public-surface.** Internal-only (not re-exported, not test-referenced): `withTimeout`, `getRecord` (re-used internally only by broker-probe), `toTmuxPaneState`, `tmuxPaneIdentityMatches`.

- **[T07] align interface to actual usage:** `getRecord`, `toTmuxPaneState`, `tmuxPaneIdentityMatches` are file-local helpers that don't need to be in the public re-export set — they already aren't, which is correct. `withTimeout` is `export`ed from `broker-probe.ts` but used only on line 118 of the same file and never re-exported by the barrel → over-exposed (narrow it). 🟡
- **[M02] expand/contract:** Not a leaf package — barrel + tests are real consumers. Any signature change to a re-exported mutator (the `markRuntime*` family) requires the barrel + test references to move in lockstep. This raises those to DEFERRED/public-surface even though they look internal.

**Verdict:** 🟡 — surface is coherent and intent-revealing, but the `markRuntime*` triple duplication and the over-exported `withTimeout` are worth addressing; nothing is broken.

## 🎯 Findings by mechanism (outside-in, highest impact first)

### F1 — [T15] Extract the shared runtime-terminal-mutation skeleton
- **Location:** `runtime-mutations.ts:70` (`markRuntimeDead`), `:107` (`markRuntimeStale`), `:213` (`markRuntimeTerminatedAfterUserExit`)
- **Mechanism repaired:** missing abstraction — the *intent* "fail the active run, clear runId, set terminal status, append lifecycle event" is triplicated. Each copy independently re-implements the `activeRunId !== undefined → updateRunId(undefined) + runs.markCompleted({status:'failed', errorCode: RUNTIME_UNAVAILABLE, errorMessage: …})` block (lines 78–87, 124–133, 230–239) and the `controllerKind==='harness-broker' && invocationId → dispose/exit invocation if !terminal` block (115–123 vs 221–229, differing only in `'disposed'` vs `'exited'`).
- **Symptom:** three ~30-line bodies that diverge only in target status string, invocation terminal-state, runtimeStateJson extra keys, and event kind. A future invariant change (e.g. a new errorCode) must be applied in three places — exactly the class of drift that produced the wrong-socket reaper incidents in this subsystem's history.
- **Current → Suggested:** extract `private finalizeActiveRun(db, runtime, now, kind)` and `private settleInvocation(db, runtime, now, terminalState)` helpers; each public mutator composes them + its own status/runtimeStateJson/event tail. Keep the three public functions (callers + tests depend on them) — only the *bodies* collapse.
- **Direction:** extract (consolidate) — genuine, not "extract more for its own sake."
- **Preservation:** test-suite (characterization tests in `broker-lease-teardown.red.test.ts` / `broker-endpoint-substrate-reconcile.red.test.ts` assert stale/terminated outcomes) + type-compiler-proof on the helper signatures.
- **Falsifiable signal:** line count of the three bodies drops ~50%; a deliberately mutated errorMessage in the shared helper fails all three call-sites' tests at once (proving single authority).
- **Risk:** Med · **API-impact:** public-surface (functions stay exported; bodies change, behavior identical) · **Effort:** M
- **Tests:** existing red/green suites cover stale + terminated; add a characterization assert for `markRuntimeDead`'s run-fail path if not already present.
- **Contraindication:** the divergence in `runtimeStateJson` shape (`staleReason`/`stalePayload` vs `terminationReason`/`userExitReason`) is real domain difference — do NOT over-unify into a single parameterized JSON builder that obscures which keys each status writes. Keep the tails explicit.

### F2 — [T03] Relocate the generic `withTimeout` out of broker-probe
- **Location:** `broker-probe.ts:138`
- **Mechanism repaired:** affinity/cohesion + over-export — `withTimeout<T>` is a domain-agnostic promise-race utility with zero broker knowledge, living in a broker-probe module and `export`ed though only line 118 consumes it. A second hand-rolled `withTimeout` already exists in `hrcchat-cli/stacked-summary.ts` (duplicated intent across packages).
- **Symptom:** generic concurrency primitive misfiled in a feature module; a reader scanning `broker-probe.ts` meets an unrelated abstraction.
- **Current → Suggested:** move to `server-util.ts` (already the home of `timestamp`, `isRuntimeUnavailableStatus`) as a non-exported-from-barrel util, or drop the `export` keyword and keep it file-local if you prefer minimal churn. Lower priority: unify with the hrcchat-cli copy later.
- **Direction:** relocate (+ narrow visibility).
- **Preservation:** type/compiler-proof (pure move, single caller) + existing broker-probe tests.
- **Falsifiable signal:** `grep export.*withTimeout broker-probe.ts` returns nothing; broker-probe imports it from server-util; build green.
- **Risk:** Low · **API-impact:** internal-only (not in barrel re-export set) · **Effort:** S
- **Tests:** no behavior change; covered by build + probe tests.
- **Contraindication:** if a follow-up wants a single repo-wide `withTimeout`, that's a cross-package consolidation — out of scope for this dir-local pass.

### F3 — [T22] Flatten the nested sweep loop in `sweepOrphanedBrokerTmuxLeases`
- **Location:** `lease-identity.ts:83-136` (the `for (const entry of entries)` body)
- **Mechanism repaired:** guard-clause flattening — the per-entry body nests `try → inner try/catch (stat) → if(grace) → if(no sessions){if(removeDead)} → if(!kill) → kill`. The happy path is buried ~4 deep and the early-`continue` guards are interleaved with the outer try.
- **Symptom:** reading the reclaim decision requires tracking two nested try blocks; the "claimed" / "within grace" / "vanished" skips are scattered.
- **Current → Suggested:** extract `classifyLeaseSocket(entry) → 'claimed'|'within-grace'|'vanished'|'dead'|'live-orphan'` (or a small `processLeaseEntry` returning a partial result delta), letting the loop read as a flat dispatch over the classification. Keep the `result` accumulator semantics identical.
- **Direction:** extract + flatten.
- **Preservation:** test-suite (sweep counters `scanned/skippedClaimed/skippedWithinGrace/killedLiveLeaseServers/removedDeadSocketFiles/errors` are observable and asserted) — characterization first.
- **Falsifiable signal:** max nesting depth in the loop drops to ≤2; counter assertions unchanged across a fixture with claimed + grace + dead + live-orphan sockets.
- **Risk:** Med · **API-impact:** internal-only (function exported, but extraction is internal; signature/return unchanged) · **Effort:** M
- **Tests:** ensure a sweep fixture covers all six counter outcomes before refactoring; the `errors` path (catch on line 132) must stay exercised.
- **Contraindication:** the two-layer try is partly deliberate — the inner stat catch is a benign "vanished between readdir and stat" skip distinct from the outer "real error → result.errors++". Any extraction MUST preserve that the stat-race does NOT increment `errors`. Do not collapse the two catches into one.

### F4 — [T19] (minor) `brokerLeaseIdsMatch` literal-pair loop
- **Location:** `lease-identity.ts:204-213`
- **Mechanism repaired:** none strong — this is a tidy data-driven comparison over `[['sessionId',…],['windowId',…],['paneId',…]]`. Listed only to record that it was pressure-tested and is FINE as-is (the loop is already the de-abstracted, parameterized form; `tmuxPaneIdentityMatches` at :276 does the full 6-field compare flatly). No change recommended.
- **Direction:** none. **Risk:** n/a.

## 🪶 Deliberately left alone (where-NOT)
- **`getRecord` defensive narrowing (`lease-identity.ts:293`)** — repeated `getRecord(...)` calls look like dup but each guards a distinct untrusted-JSON access (`runtimeStateJson.broker`, `broker.endpoint`, nested pane records). This is load-bearing primitive-obsession defense against `unknown` persisted JSON; consolidating would weaken the per-field narrowing. Keep.
- **Substrate-vs-legacy fallback duplication** (`lease-identity.ts:71-75` sweeper claim vs `broker-probe.ts:40-43` probe) — the `hosting.substrate.kind==='leased-tmux' ? … : getBrokerRuntimeTmuxSocketPath(runtime)` pattern is intentionally mirrored (the comments at both sites cite T-01875 / T-01884 and explicitly say "mirrors the sweeper claim source"). Unifying into one helper is tempting but the two contexts (claim-set build vs probe) read different fields (socket-only vs socket+session); the mirror is a documented invariant, not accidental dup. Leave, or extract only if both call-sites genuinely need the same `{socketPath, sessionName}` pair.
- **`markBrokerReattachStale` re-read (`lease-identity.ts:313`)** — the `getByRuntimeId` re-fetch before update is a deliberate freshness guard (avoids clobbering concurrent runtimeStateJson writes). [T32] check-then-act is relevant but this is a single-process sqlite mutation, not a true race window worth restructuring. Keep.
- **`probeBrokerHealth` swallowed catch (`broker-probe.ts:131`)** — `catch { return 'unreachable' }` looks like [T18] swallowed-error, but the long comment (96-108) establishes that ANY connect/timeout/RPC failure MUST map to non-terminal `unreachable` (never a false "dead"). This is the correct, documented error-restructuring already in place. Keep.
- **`reconcileStartupState` / `reconcileDurableBrokerRuntimeReattach`** — these live in the sibling barrel `startup-reconcile.ts`, OUTSIDE the target dir; not analyzed here.

## 🔭 If applying: outside-in sequence
1. **F2** (Low, S) — move/narrow `withTimeout`; pure mechanical, derisks the file.
2. **F1** (Med, M) — add characterization for `markRuntimeDead` run-fail path, then extract `finalizeActiveRun` + `settleInvocation`; run full hrc-server suite (TMPDIR=/tmp per known flakes).
3. **F3** (Med, M) — only after a six-counter sweep fixture exists; extract `classifyLeaseSocket`, preserving the stat-race-≠-error invariant.
4. Re-run `broker-lease-teardown.red.test.ts` + `broker-endpoint-substrate-reconcile.red.test.ts` + full server suite + isolation re-runs.

## ✅ Safety checklist
- [ ] Full `hrc-server` test suite green (TMPDIR=/tmp; tolerate the 2 known NON-cutover flakes per memory).
- [ ] `broker-lease-teardown.red.test.ts` + `broker-endpoint-substrate-reconcile.red.test.ts` green.
- [ ] Barrel `startup-reconcile.ts` re-export list unchanged for F1/F3 (signatures preserved).
- [ ] Biome lint clean (watch `useValidTypeof` if any literal `typeof` checks get parameterized — none planned here).
- [ ] Sweep counter semantics + stat-race-not-error invariant verified by fixture (F3).
- [ ] hrc-server daemon restarted before any live/ghoste2e validation (daemon holds these libs resident).
