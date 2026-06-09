# Refactor Analysis — `packages/hrc-core/`

Behavior-preserving SOLID + code-smell audit. **Report only — no source edited in this phase.** Date: 2026-06-08.

## Package shape

`hrc-core` is the HRC domain layer: error taxonomy, selectors, fences, path resolution, the monitor reader + condition engine, and a large body of pure TypeScript **type contracts** (`contracts.ts`, `http-contracts.ts`, `hrcchat-contracts.ts`). The three contract files together (~1856 lines) contain **zero runtime functions** — they are pure `export type`/`interface` declarations and constitute the package's public type surface. They are out of scope for behavior-preserving extraction and any change there is public-surface by definition.

Logic-bearing files (all with test coverage):

| File | Lines | Tests |
|---|---|---|
| `src/monitor/condition-engine.ts` | 611 | `monitor-condition-engine.acceptance.test.ts` |
| `src/monitor/index.ts` | 566 | `monitor.acceptance.test.ts` |
| `src/selectors.ts` | 466 | `selectors.test.ts` |
| `src/errors.ts` | 188 | `errors.test.ts` |
| `src/fences.ts` | 143 | `fences.test.ts` |
| `src/paths.ts` | 86 | `paths.test.ts` |
| `src/index.ts` | 271 | (barrel — re-exports only) |

## SOLID scorecard

| Principle | Grade | Notes |
|---|---|---|
| **S** — Single Responsibility | B | `condition-engine.ts` (611) and `monitor/index.ts` (566) exceed the 300-line guide, but each is one cohesive module of small pure functions. The contract files are large but are pure type aggregates, not mixed-concern units. No single function > 50 lines. |
| **O** — Open/Closed | B+ | Selector/condition logic is `switch`-on-discriminated-union. These are exhaustive switches over closed unions (TS enforces exhaustiveness), not growth-prone `if-else` ladders. Standard discriminated-union tradeoff, well-contained. |
| **L** — Liskov | A | No overrides that throw/no-op. The `HrcDomainError` subclass hierarchy only narrows the constructor `code` type via `Extract<>` and sets `name`; base behavior preserved. |
| **I** — Interface Segregation | A- | `HrcMonitorConditionEngineReader` (3 members) and `HrcMonitorConditionEngine` (1 member) are tight. No fat interfaces, no stubbed-unused implementors. `HrcMonitorEvent` has many optional fields but it is an event envelope (data), not a service interface. |
| **D** — Dependency Inversion | A | The condition engine takes its reader via `createMonitorConditionEngine(reader)` injection. `createMonitorReader(state)` is a closure factory. No hardcoded singletons in business logic. |

Overall: a clean, well-factored domain package. Findings are localized dedup / dead-code / micro-clarity items, all internal-only and low risk.

---

## Priority Refactorings

### P1 — Dead/redundant branch in `evaluateTurnFinished`
- **Location:** `src/monitor/condition-engine.ts:287-294`
- **Current:** The two failure `if` bodies (`turn_failed`; `runtime_dead || runtime_crashed`) are byte-identical. The final ternary `result === 'turn_succeeded' ? result : 'turn_succeeded'` is a no-op — both arms yield `'turn_succeeded'`.
- **Suggested:** Collapse the two failure guards into one `if (result === 'turn_failed' || result === 'runtime_dead' || result === 'runtime_crashed')`, and simplify the tail to `return { result: 'turn_succeeded', exitCode: EXIT_CODE.ok }`.
- **Risk:** Low
- **API-impact:** internal-only (private function; return values unchanged)
- **Effort:** S (~5 min)
- **Tests:** `monitor-condition-engine.acceptance.test.ts` covers turn.finished success/failure/runtime-dead; behavior identical, existing reds stay green.

### P2 — Repeated `unknownString(event, 'sessionRef')` reads in `evaluateContextChanged`
- **Location:** `src/monitor/condition-engine.ts:369,380-383,392-395`
- **Current:** `unknownString(event, 'sessionRef')` is recomputed up to 4× in one function; the `sessionRef === capture.sessionRef` guard is duplicated.
- **Suggested:** Hoist `const eventSessionRef = unknownString(event, 'sessionRef')` once at the top and reuse; collapse the duplicated guards.
- **Risk:** Low
- **API-impact:** internal-only
- **Effort:** S
- **Tests:** condition-engine acceptance covers context-changed (generation / session_rebound / cleared); no behavior change.

### P3 — Pointless indirection `evaluateRuntimeDead` → `runtimeDeathOutcome`
- **Location:** `src/monitor/condition-engine.ts:344-357`
- **Current:** `evaluateRuntimeDead` is a one-line passthrough to `runtimeDeathOutcome`; `evaluateRuntimeFailure` is the same call guarded by `condition !== 'runtime-dead'`.
- **Suggested:** Inline `evaluateRuntimeDead` at its single call site (the `runtime-dead` switch arm), keeping `evaluateRuntimeFailure` as the guarded variant.
- **Risk:** Low
- **API-impact:** internal-only
- **Effort:** S
- **Tests:** covered by runtime-dead/crashed acceptance cases.

### P4 — Duplicate `concrete`/`host` selector arms (multiple sites)
- **Location:** `src/monitor/index.ts:198-207` (`resolveParts`), `:387-390` (`eventMatchesSelector`), mirrored in `notFoundDetail:527-534`.
- **Current:** `case 'concrete'` and `case 'host'` bodies are identical (both match on `hostSessionId`), written out twice in each switch.
- **Suggested:** Use switch fall-through (`case 'concrete': case 'host': return …`) so the identical arms share one body — the pattern already used for `stable`/`target`/`session`.
- **Risk:** Low
- **API-impact:** internal-only
- **Effort:** S
- **Tests:** `monitor.acceptance.test.ts` exercises host/concrete resolution.

### P5 — Double `resolveParts` traversal in `snapshotState`
- **Location:** `src/monitor/index.ts:313-315`
- **Current:** `resolveSelector(...)` internally calls `resolveParts(...)` (line 171), then `snapshotState` calls `resolveParts(state, selector)` *again* (line 315) for the same `{session, runtime}`. The selector is also re-cast with `as HrcSelector`.
- **Suggested:** Add a private variant of `resolveSelector` that returns the already-computed `parts` alongside the resolution (or compute `parts` once and derive the resolution), removing the second traversal and the cast. Keep the public `resolveSelector` method signature unchanged.
- **Risk:** Med (touches resolve/snapshot data flow; must preserve exact `resolution`/`session`/`runtime` shape and the "resolution present but parts null" edge)
- **API-impact:** internal-only (private helpers; `createMonitorReader`'s returned method signatures unchanged)
- **Effort:** M
- **Tests:** `monitor.acceptance.test.ts` covers snapshot with/without resolution and the not-found branch. Verify the case where `resolution` succeeds but `resolveParts` returns null still omits `session`/`runtime`.

### P6 — Runtime-resolution fallback duplicated across `partsFromSession`/`partsFromMessage`
- **Location:** `src/monitor/index.ts:235-239` and `:268-272`
- **Current:** Both repeat the same "prefer explicit `runtimeId`, else last runtime by `hostSessionId`" block.
- **Suggested:** Extract a private `resolveRuntimeFor(state, hostSessionId, preferredRuntimeId?)` helper used by both.
- **Risk:** Low
- **API-impact:** internal-only
- **Effort:** S
- **Tests:** covered by session/message resolution acceptance cases.

### P7 — Duplicated catch-fallback in `parseTargetMonitorSelector`
- **Location:** `src/selectors.ts:303-307,316-319`
- **Current:** Two `catch` blocks each compute `error instanceof Error ? error.message : 'invalid target selector'` before calling `invalidMonitorSelector('target', 0, reason)`.
- **Suggested:** Extract a private `selectorReason(error, fallback)` helper (also reusable by `parseSessionMonitorSelector:280-283`). De-dupes 3 catch fallbacks.
- **Risk:** Low
- **API-impact:** internal-only
- **Effort:** S
- **Tests:** `selectors.test.ts` covers invalid target/session inputs.

---

## Code Smells table

| # | Location | Smell | Note | Risk | API-impact |
|---|---|---|---|---|---|
| 1 | `monitor/condition-engine.ts:287-294` | Dead code / duplicate branch | identical failure guards + no-op ternary (P1) | Low | internal-only |
| 2 | `monitor/condition-engine.ts:369-395` | Duplicated guard / repeated computation | `sessionRef` read 4× (P2) | Low | internal-only |
| 3 | `monitor/condition-engine.ts:344-349` | Speculative indirection | one-line passthrough wrapper (P3) | Low | internal-only |
| 4 | `monitor/index.ts:198-207,387-390,527-534` | Duplicated switch arms | `concrete`/`host` written twice (P4) | Low | internal-only |
| 5 | `monitor/index.ts:313-315` | Redundant work | `resolveParts` run twice per snapshot (P5) | Med | internal-only |
| 6 | `monitor/index.ts:235-272` | Duplicated block | runtime-fallback logic repeated (P6) | Low | internal-only |
| 7 | `selectors.ts:280-283,303-319` | Duplicated catch fallback | `selectorReason` helper (P7) | Low | internal-only |
| 8 | `selectors.ts:274-283` | Definite-assignment `let` | `let sessionRef; let parts;` assigned inside try, used after — relies on `invalidMonitorSelector` being `never`. Correct but fragile; a value-returning helper would remove the `let`. | Low | internal-only |
| 9 | `contracts.ts` / `http-contracts.ts` / `hrcchat-contracts.ts` | Large files (>300, up to 910) | Pure type aggregates; size inherent to a contracts module. Splitting risks changing import paths — **defer**, public surface, no logic to extract. | High | public-surface |
| 10 | `errors.ts:11` | Deprecated alias retained | `CONFLICT: 'stale_context'` marked `@deprecated`. Removal is a breaking export change — leave as-is. | High | public-surface |

## Quick Wins (safe to auto-apply)

- **P1** — collapse dead/duplicate branch in `evaluateTurnFinished`.
- **P2** — hoist repeated `sessionRef` read in `evaluateContextChanged`.
- **P3** — inline the `evaluateRuntimeDead` passthrough.
- **P4** — fall-through the identical `concrete`/`host` switch arms (3 sites).
- **P6** — extract `resolveRuntimeFor` helper.
- **P7** — extract `selectorReason(error, fallback)` helper.

All private-symbol-only, behavior-preserving, guarded by existing acceptance tests.

## Technical Debt notes

- **Magic numbers already addressed.** `condition-engine.ts` already names its exit codes (`EXIT_CODE`) and runtime-status sets. `DEFAULT_REPLAY_TAIL = 100` is named. No raw magic-number debt remains in logic files.
- **`protectStreamCursor` Proxy** (`monitor/index.ts:476-500`) is a deliberate immutability guard on `streamCursorSeq` that intentionally allows mutation of other fields. Not a refactor target without a behavior-equivalence argument; **leave**.
- **`paths.ts`** mixes `process.env` reads with path building (an SRP nit), but this is the canonical config-resolution seam and is small/tested. Injecting an env reader would be a public-surface change for negligible benefit; **leave / defer**.
- **Contract files (#9):** the package's exported type surface. Any reorganization is public-surface and must be human-reviewed, not auto-applied.
- **`errors.ts` deprecated `CONFLICT` alias (#10):** safe to remove *eventually* but breaks downstream imports; defer to an intentional API-version bump.
