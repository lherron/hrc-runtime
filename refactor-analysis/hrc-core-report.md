# 🔧 Refactoring Analysis — packages/hrc-core/src

**Target:** `packages/hrc-core/src` (general profile) · **Files read:** 10/10 source `.ts` (all non-test) · **Lines:** ~4227 · **Package type:** shared contracts/core library (type-heavy, consumed by 180+ files across hrc-server, hrc-cli, hrc-sdk, hrc-store-sqlite, hrcchat-cli)

## 🧭 Summary
hrc-core is the monorepo's contract spine: 4 of 10 files (`contracts.ts`, `http-contracts.ts`, `hrcchat-contracts.ts`, and most of `errors.ts`/`selectors.ts` types) are pure exported type declarations with exactly one runtime value export outside errors/selectors/monitor (`OPERATOR_REAP_REASON`). The real executable logic lives in `monitor/condition-engine.ts`, `monitor/index.ts`, `selectors.ts`, `fences.ts`, `errors.ts`, `paths.ts`. The code is already unusually well-factored (named exit codes, derived-from-source-of-truth sets, parameter objects via `EvaluationContext`, guard-clause style). Findings are therefore few, mostly internal-only Low-risk dedup/seam items; everything touching the exported type surface is DEFERRED because the blast radius is the whole repo.

## 🚪 Public boundary (assess first)
`index.ts` re-exports ~150 named types + a handful of runtime functions. Consumers: hrc-server (119 files), hrc-cli (22), hrcchat-cli (17), hrc-store-sqlite (16), hrc-sdk (6). This is a **leaf-of-the-dependency-graph contract package whose entire reason to exist is its public surface** — [M02 expand/contract] applies to ANY shape change, and even a "narrow" [T07] is a breaking change for downstream `.d.ts` consumers (several consume the built `dist/*.d.ts`).

- **[T07] surface width:** The surface is wide but that width is *load-bearing* — each exported type is the wire/RPC contract for a distinct endpoint. No fat-interface or leaky-abstraction finding survives pressure-testing; narrowing would break consumers, not align to usage.
- **[M02] contract additions** (e.g. `eventGlobalHighWaterSeq?`, `OPERATOR_REAP_REASON`) are already done additively/optionally — the established pattern is correct.
- **Verdict: 🟢** The boundary is healthy and deliberately wide. Do **not** restructure exported types in a refactor pass; any change there is a redesign requiring an expand/contract migration across 5 packages.

## 🎯 Findings by mechanism (outside-in, highest impact first)

### F1 — Duplicated message-correlation intent across the two monitor modules
- **Location:** `monitor/condition-engine.ts:418-436` (`messageResponseMatchesSelector`) and `monitor/index.ts:424-441` (`isCorrelatedMessageResponse`)
- **Mechanism repaired:** [T15] extract missing abstraction — duplicated *intent* ("does this event correlate to this msg:/seq: selector via messageId | replyToMessageId | rootMessageId | messageSeq").
- **Symptom:** Two copies of the same 3-field-OR / messageSeq-equality predicate, one reading typed `HrcMonitorEvent` fields, the other reading via `unknownString(event,...)`. They must stay in lock-step (both encode the same correlation rule) but live in different files with no shared definition.
- **Current → Suggested:** Extract one `selectorMatchesMessageResponse(selector, { messageId, replyToMessageId, rootMessageId, messageSeq })` accepting a plain projected record, and call it from both sites (condition-engine projects via its `unknownString` helpers, index passes typed fields). Direction: **extract/consolidate**.
- **Direction:** extract.
- **Preservation:** test-suite — `selectors.test.ts`, `monitor.acceptance.test.ts`, `monitor-condition-engine.acceptance.test.ts` cover both paths; behavior is byte-identical because the predicate is unchanged.
- **Falsifiable signal:** the OR-predicate exists in exactly one place afterward; a deliberately-introduced asymmetry (e.g. dropping `rootMessageId`) fails an acceptance test in both modules.
- **Risk:** Low · **API-impact:** internal-only (both functions are module-private) · **Effort:** S
- **Tests:** existing acceptance tests.
- **Contraindication:** the two are *not* identical today (typed vs `unknown` access). The shared helper must take a pre-projected record so the index path keeps its compiler-checked field access — do not force `condition-engine` to import `HrcMonitorEvent`-typed access or you lose its defensive `unknownString` coercion.

### F2 — `evaluateRuntimeFailure` is a one-line conditional pass-through (middle man)
- **Location:** `monitor/condition-engine.ts:341-347`
- **Mechanism repaired:** [T23] remove middle man / collapse pass-through.
- **Symptom:** `evaluateRuntimeFailure` exists only to early-return `null` when `condition === 'runtime-dead'` and otherwise delegate verbatim to `runtimeDeathOutcome`. It adds a stack frame and a name for "runtimeDeathOutcome but suppressed for the dedicated case."
- **Current → Suggested:** Inline at the single call site (`evaluateEvent:256`): `if (context.condition !== 'runtime-dead') { const f = runtimeDeathOutcome(context, event); if (f) return f }`. Direction: **inline/collapse**.
- **Direction:** collapse.
- **Preservation:** type/compiler-proof + test-suite — pure relocation of a guard already adjacent in `evaluateEvent`.
- **Falsifiable signal:** call graph loses one hop; condition-engine acceptance tests unchanged green.
- **Risk:** Low · **API-impact:** internal-only · **Effort:** S
- **Contraindication:** the named function documents *why* the suppression exists (the `runtime-dead` branch handles it explicitly below). If the team values the self-documenting name over the collapse, leave it — this is a judgment call, not a clear win. Keep a one-line comment if inlined.

### F3 — Duplicated `isResolution`/`isCapture`/`resolutionError` discriminator
- **Location:** `monitor/index.ts:499-501` (`isResolution`), `monitor/condition-engine.ts:574-578` (`isCapture`), `:580-589` (`resolutionError`)
- **Mechanism repaired:** [T15] extract missing abstraction — the `!('ok' in result && result.ok === false)` discriminator for "this is a success not an `HrcMonitorResolutionResult` error" is written three times across the two files.
- **Symptom:** Three sites hand-decode the same `{ ok: false, error }` tagged-union shape. The shape is defined in `monitor/index.ts` (`HrcMonitorResolutionResult`); the discriminator should travel with it.
- **Current → Suggested:** Export a single `isResolutionError(result): result is …{ok:false}` (or its positive form) from `monitor/index.ts` and reuse in condition-engine. Direction: **extract**.
- **Direction:** extract.
- **Preservation:** type/compiler-proof — the type guard narrows identically; compiler verifies the predicate.
- **Falsifiable signal:** one definition of the `ok:false` check; grep for `'ok' in result` returns a single hit.
- **Risk:** Low · **API-impact:** internal-only if the helper stays unexported from the package `index.ts` (export only across the two `monitor/*` modules). · **Effort:** S
- **Contraindication:** `isCapture` and `isResolution` narrow to *different* positive types (`HrcMonitorCapture` vs `HrcMonitorResolution`). Share only the negative discriminator (`isResolutionError`) and let each caller keep its own positively-typed wrapper, or you weaken the narrowing.

### F4 — Parallel `switch (condition)` dispatch tables that must be kept congruent
- **Location:** `monitor/condition-engine.ts:226-244` (`evaluateStartSnapshot`) and `:259-276` (`evaluateEvent`)
- **Mechanism repaired:** [T19] conditional ↔ dispatch (note: candidate, leans **leave-as-is**).
- **Symptom:** Two `switch` statements over the same `HrcMonitorCondition` union, in two functions, each contributing the start-snapshot arm and the streaming-event arm for the same condition. Adding a new condition requires editing both, with no compiler link between the halves.
- **Current → Suggested:** A per-condition strategy record `{ start, event }` keyed by `HrcMonitorCondition` would co-locate the two halves and let `satisfies Record<HrcMonitorCondition, …>` force exhaustiveness across both. Direction: **conditional→dispatch**.
- **Direction:** dispatch (tentative).
- **Preservation:** test-suite — the acceptance suite exercises every condition arm.
- **Falsifiable signal:** removing a condition from the union produces exactly one compiler error (the record), not silent partial handling.
- **Risk:** Med · **API-impact:** internal-only · **Effort:** M
- **Contraindication:** Both switches already use a bare `switch` with no `default`, so TS *already* enforces exhaustiveness per-function via the union return path; the only real gain is co-locating the two halves. The current shape is readable and the conditions genuinely have different start vs stream logic. **Recommend leaving as-is** unless a third parallel switch appears — flagged for awareness, not for application.

### F5 — `protectStreamCursor` Proxy: defensive structure with no demonstrated variation
- **Location:** `monitor/index.ts:503-527`
- **Mechanism repaired:** [T16] collapse premature abstraction (candidate) — a full `Proxy` with get/set/defineProperty traps exists solely to make one field (`streamCursorSeq`) read-only on a returned capture object.
- **Symptom:** 25 lines of `Proxy` machinery to enforce immutability of a single numeric field. No consumer in the repo attempts to mutate `streamCursorSeq` (the field is set once in `captureStart`). The Proxy also changes object identity/perf characteristics versus a plain object.
- **Current → Suggested:** Replace with `Object.freeze`-style intent or a plain readonly field — `Object.defineProperty(captured, 'streamCursorSeq', { value: streamCursorSeq, writable: false, enumerable: true })`, or simply rely on the TS `readonly`-typed return. Direction: **de-abstract/simplify**.
- **Direction:** collapse.
- **Preservation:** char-test — needs a characterization test asserting `streamCursorSeq` survives spread/JSON and (if the runtime guarantee matters) that assignment is rejected, BEFORE simplifying. The Proxy's enumerable/spread behavior is subtle; a naive `Object.freeze` over the whole capture would change mutability of *other* fields.
- **Falsifiable signal:** `captureStart` returns a plain object; existing monitor acceptance tests stay green; a new char-test pins the read-only contract.
- **Risk:** Med · **API-impact:** internal-only (`HrcMonitorCapture` shape unchanged) · **Effort:** M
- **Contraindication:** The Proxy may be a deliberate guard against a real past bug where the inclusive-replay cursor got mutated (the inline comment at `:165` stresses the monotonic-cursor contract). If the read-only guarantee is load-bearing for the cursor invariant, this is a deliberate option — **do not remove the protection, only swap the mechanism** (Proxy → `defineProperty`/frozen single field) and only if a char-test proves equivalence. Lean toward leaving it.

### F6 — `scopeRef` string assembly via repeated concat (primitive obsession)
- **Location:** `selectors.ts:224-244` (`formatCanonicalScopeRef`)
- **Mechanism repaired:** [T15] extract missing abstraction (minor) — scopeRef is built by `scopeRef += ':project:' + …` etc., re-encoding the `agent:…:project:…:task:…:role:…` grammar that `agent-scope` already owns.
- **Symptom:** Manual string concatenation of a structured ref that the imported `agent-scope` package already has parse/format primitives for (`parseScopeRef`, `formatScopeHandle`). The literal segment keys (`:project:`, `:task:`, `:role:`) are magic strings local to this function.
- **Current → Suggested:** If `agent-scope` exposes a `formatScopeRef({agentId, projectId, taskId, roleName})`, delegate to it. If not, this is acceptable local glue. Direction: **extract/delegate** (only if the upstream primitive exists).
- **Direction:** extract (conditional).
- **Preservation:** test-suite — `selectors.test.ts` covers ref formatting; final `validateScopeRef` guard already pins correctness.
- **Falsifiable signal:** the `:project:`/`:task:`/`:role:` literals disappear from hrc-core; `selectors.test.ts` green.
- **Risk:** Low · **API-impact:** internal-only · **Effort:** S
- **Contraindication:** If `agent-scope` has no builder, the manual concat IS the local abstraction and dedup would mean *adding* a dependency surface — leave it. Verify the upstream API before touching. Marked applicable-conditional, defaulting to leave-alone if the primitive is absent.

## 🪶 Deliberately left alone (where-NOT)
- **`contracts.ts`, `http-contracts.ts`, `hrcchat-contracts.ts`** — pure exported type declarations = the wire contract. No executable smell; any "consolidation" is a public-surface redesign (DEFERRED, not a refactor).
- **`errors.ts` `HRC_ERROR_STATUS_BY_CODE` + per-class `Extract<HrcErrorCode, …>` unions** — this looks like a candidate for [T19], but the `Record<HrcErrorCode, HrcHttpStatus>` already forces exhaustiveness at compile time, and the `Extract<…>` unions make illegal (code, class) pairings unrepresentable [T12 already satisfied]. Leave it.
- **`EXIT_CODE`, `CONDITION_RESULTS`/`CONDITION_RESULT_SET`, `DEAD_RUNTIME_STATUSES` etc.** — already the textbook [T15] result: named constants derived from a single source via `satisfies`. No magic numbers remain. Do not "extract more."
- **`EvaluationContext` parameter object (condition-engine)** — [T21] already applied; the evaluate* family takes one context object. No data clump to introduce.
- **`fences.ts`** — clean guard-clause parsing + total result union (`{ok:true}|{ok:false}`); [T18]/[T17] already satisfied. Leave.
- **`paths.ts`** — small, linear env-precedence resolvers; the env-name literals are intrinsic config, not magic numbers. Leave.
- **F4 parallel switches & F5 Proxy** — flagged above but recommended **left alone** absent a concrete trigger; removing defensive structure without proof of dead variation risks reintroducing a guarded bug.

## 🔭 If applying: outside-in sequence
1. [T40] Add/confirm characterization coverage for F1 (message correlation in both modules) and F5 (cursor read-only + spread) — the two findings whose behavior is subtle.
2. F3 (`isResolutionError` shared discriminator) — pure type-guard extraction, compiler-proven, lowest risk.
3. F1 (shared `selectorMatchesMessageResponse`) — extract with a pre-projected record param.
4. F2 (inline `evaluateRuntimeFailure`) — only if the team prefers the collapse over the self-documenting name.
5. F6 — only after verifying an `agent-scope` builder exists; otherwise skip.
6. Leave F4 and F5 unless a concrete trigger (third parallel switch / proven cursor-mutation bug) materializes.
7. Re-run full hrc-core suite + a typecheck of the 5 consumer packages (no public type changed, so this is a sanity gate not a contract migration).

## ✅ Safety checklist
- [ ] No exported type in `index.ts` changed (boundary frozen — 180+ consumers).
- [ ] F1/F3 helpers stay module/`monitor`-private; not re-exported from package `index.ts`.
- [ ] F1 shared predicate preserves the exact field set (messageId, replyToMessageId, rootMessageId, messageSeq) — no field added/dropped.
- [ ] F3 shares only the negative discriminator; positive narrowing to `HrcMonitorCapture` vs `HrcMonitorResolution` preserved per-caller.
- [ ] F5 only attempted with a char-test pinning spread/JSON/enumerable behavior of `streamCursorSeq`; whole-object `Object.freeze` rejected.
- [ ] No new biome lint (the F1/F3 dedup parameterizes object access, not a `typeof`, so `useValidTypeof` is not at risk — confirm `biome check` clean).
- [ ] Behavior preserved: `monitor.acceptance`, `monitor-condition-engine.acceptance`, `selectors`, `fences`, `errors` test files all green.
