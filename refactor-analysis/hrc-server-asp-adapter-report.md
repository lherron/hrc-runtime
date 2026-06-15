# 🔧 Refactoring Analysis — packages/hrc-server/src/agent-spaces-adapter

**Target:** `packages/hrc-server/src/agent-spaces-adapter` (analysis profile: general)
**Files read:** 6 / 6 (`index.ts`, `sdk-adapter.ts`, `compile-adapter.ts`, `cli-adapter.ts`, `aspc-facade-client.ts`, `compile-profile-selector.ts`)
**Lines:** 1620 total (no `*.test.ts` files in-dir; characterization tests live in `packages/hrc-server/src/__tests__/`)
**Package type:** general (intra-package adapter layer; not a published leaf)

## 🧭 Summary
This is a thin, well-factored translation layer (HRC intent → agent-spaces CLI / SDK / broker-compile surfaces). It is unusually disciplined: explicit attachment-vocabulary translation, hash/identity verification, deep-freeze of verified plans, injected runners/allocators for testing. The highest-value moves are small DE-abstraction (collapse two unused exported predicates), one [T15] extraction of a thrice-repeated optional-spread idiom, and a few [T17]/[T18] partial→total / error-handling tightenings. There are no concurrency races (the one `for(;;)` retry loop is single-owner) and no N+1/data smells.

## 🚪 Public boundary (assess first)

**Intra-package surface (`index.ts`):** re-exports ONLY `cli-adapter` (`buildCliInvocation`, `mergeEnv`, `UnsupportedHarnessError`, types) and `sdk-adapter` (`runSdkTurn`, `deliverSdkInflightInput`, `getSdkInflightCapability`, types). All consumers are inside `hrc-server`.

**Direct (non-index) imports — also part of the de-facto contract:**
- `compile-adapter.ts` → `broker-interactive-handlers.ts`, `broker-headless-handlers.ts`, `broker-run-preview.ts`
- `aspc-facade-client.ts` (`AspcFacadeBrokerClient`, `asBrokerClient`) → `option-resolvers.ts`, `broker-interactive-handlers.ts`
- `cli-adapter.ts` (`buildHrcCorrelationEnv`, `mergeEnv`) → `broker-interactive-handlers.ts:714`, `broker-headless-handlers.ts:53`
- `compile-profile-selector.ts` → only `__tests__/` import the predicates directly.

**T07/M02 findings:**
- The directory has two front doors: `index.ts` (curated) and deep path imports of `compile-adapter`/`aspc-facade-client`. Not a defect — the broker path is deliberately kept off the curated index ("FLAG DARKNESS" docs). No M02 action.
- `isHeadlessCodexBrokerProfile` and `isInteractiveTmuxBrokerProfile` are `export`ed but have ZERO non-test, non-self callers — only `isBrokerControllerProfile` uses them. Over-wide surface ([T07] narrow). See Finding 1.

**Verdict: 🟢** — boundary is sound and contract-preserving. The only boundary nit is two predicates exported wider than their single internal use.

## 🎯 Findings by mechanism (outside-in, highest impact first)

### Finding 1 — [T16] collapse premature abstraction: two exported predicates with one internal caller
- **Location:** `compile-profile-selector.ts:80-102` (`isHeadlessCodexBrokerProfile`, `isInteractiveTmuxBrokerProfile`)
- **Mechanism repaired:** surface over-exposure / structure whose variation never materialized — neither predicate is composed anywhere except inside `isBrokerControllerProfile` (verified: no non-test caller in `packages/`).
- **Symptom:** two `export function` type-guards consumed only by their sibling guard and by tests.
- **Current → Suggested:** keep the behavior, but drop `export` (make them module-private) OR inline them into `isBrokerControllerProfile`. Dropping `export` is the minimal, behavior-identical move; inlining is a follow-up.
- **Direction:** DE-abstraction (narrow).
- **Preservation:** type/compiler-proof — tests import these symbols (`compile-profile-selector.test.ts`, `headless-v02-admission.red.test.ts`), so un-exporting them is a **test-visible** change. This makes it **public-surface within the test contract** → DEFERRED (see deferred list), not auto-applied.
- **Falsifiable signal:** after un-export, `grep -rn isHeadlessCodexBrokerProfile packages --include='*.ts'` returns only intra-file hits and the build+tests still pass once tests are updated.
- **Risk:** Low. **API-impact:** public-surface (test contract). **Effort:** S.
- **Tests:** `compile-profile-selector.test.ts` (15), `headless-v02-admission.red.test.ts`.
- **Contraindication:** the predicates may be deliberately exported as named, individually-testable admission rules (the red test asserts each one's protocol-version behavior independently). If that granularity is intended, LEAVE the exports. → deferred for human judgment.

### Finding 2 — [T15] extract missing abstraction: the `...(x !== undefined ? { x } : {})` optional-spread idiom (13× in one file)
- **Location:** `sdk-adapter.ts` — 13 occurrences (e.g. `:128-132`, `:157`, `:276`, `:299`, `:347-349`, `:352`, `:418`); also present in `compile-adapter.ts:179-180,257-259,279,298,308-309,348` and `aspc-facade-client.ts:140-144`.
- **Mechanism repaired:** duplicated intent (conditionally include a key only when defined) expressed as a verbose, error-prone literal each time.
- **Current → Suggested:** introduce one tiny helper, e.g. `function optional<K extends string, V>(k: K, v: V | undefined): Partial<Record<K, V>> { return v === undefined ? {} : { [k]: v } as Record<K, V> }`, used as `...optional('semantics', options.semantics)`. Preserves exact field set (only spreads when defined).
- **Direction:** extract (light).
- **Preservation:** test-suite + type-proof. The exact-field-set invariant is the whole point of this refactor — the helper MUST reproduce "key absent when value is `undefined`" (not "key present = undefined"), or projection/hash equality (`jsonEqual`, `recomputeStartRequestHash`) will silently diverge.
- **Falsifiable signal:** `JSON.stringify` of every built request/event payload is byte-identical before/after for both defined and undefined inputs.
- **Risk:** Med (the spread feeds hashed/projected material; a subtle `{k: undefined}` regression is invisible until a hash mismatch). **API-impact:** internal-only. **Effort:** M.
- **Tests:** `compile-adapter.test.ts` (12) exercises hash/identity equality; add a unit test for `optional()` covering the undefined case.
- **Contraindication:** the idiom is locally obvious and TS-narrowing-friendly; a helper adds one indirection. Only worth it because it appears 20+ times across the dir AND guards a hash invariant. If reviewers prefer explicitness near hashed material, leave compile-adapter sites alone and apply only in sdk-adapter.

### Finding 3 — [T17] partial→total: `toFrontend` silently coerces unknown frontends to `'agent-sdk'`
- **Location:** `sdk-adapter.ts:181-187`
- **Mechanism repaired:** a "can't happen" fallback (`return 'agent-sdk'`) masks a config/contract drift instead of surfacing it. `resolveHarnessFrontendForProvider` can in principle return something outside `{agent-sdk, pi-sdk}`, and the default silently maps it to anthropic's sdk.
- **Current → Suggested:** either (a) keep the default but emit a diagnostic/throw a typed `HrcUnprocessableEntityError(PROVIDER_MISMATCH)` consistent with the rest of the file, or (b) make the union exhaustive at the type level so the fallback is provably dead and can be removed.
- **Direction:** total (tighten).
- **Preservation:** char-test — current behavior on the happy path (anthropic→agent-sdk, openai→pi-sdk or agent-sdk) is unchanged; only the unknown branch changes from silent-coerce to explicit. **This changes observable behavior on the error branch → borderline redesign**; flag as DEFERRED.
- **Falsifiable signal:** feed a provider whose resolver returns an unexpected frontend; today it runs as agent-sdk, after it rejects/logs.
- **Risk:** Med. **API-impact:** public-surface (changes a runtime outcome). **Effort:** S.
- **Tests:** `sdk-adapter.agent-tools.test.ts`; add a case for the unexpected-frontend branch.
- **Contraindication:** the default may be a deliberate "anthropic is the safe default" policy. → deferred for human decision.

### Finding 4 — [T18] restructure error handling: stringly-typed error classification in the retry loop
- **Location:** `sdk-adapter.ts:167-169` (`isMissingActiveRunError`) used by `deliverSdkInflightInput:136-141`
- **Mechanism repaired:** retry-eligibility decided by `error.message.includes('No active in-flight run')` — a substring match on a human-readable string couples this module to the exact wording produced elsewhere; a downstream message reword silently turns a retryable condition into a thrown error (or vice-versa).
- **Current → Suggested:** classify on a typed signal — a `code` field / error subclass exported by `agent-spaces`, if one exists; otherwise keep the string match but centralize the literal as a named constant and add a characterization test pinning the exact upstream message.
- **Direction:** tighten / reify implicit contract.
- **Preservation:** char-test — behavior identical for the current message; the goal is to make the coupling explicit and testable.
- **Falsifiable signal:** a test that constructs the real upstream error and asserts `isMissingActiveRunError` returns `true`; it goes red if the upstream wording drifts.
- **Risk:** Low (if only adding the constant + test). **API-impact:** internal-only. **Effort:** S.
- **Tests:** add `deliverSdkInflightInput` retry test (none found for this path).
- **Contraindication:** string-matching is acceptable if `agent-spaces` exposes no structured code; in that case the centralized-constant + pinning-test variant is the whole fix. Auto-applicable in that reduced form.

### Finding 5 — [T15] extract duplicated abstraction: the `aspHome/spec/cwd` "required-but-ignored-when-placement-set" triad
- **Location:** `sdk-adapter.ts:339-341` and `cli-adapter.ts:308-310` (identical `aspHome: getAspHome(), spec: { spaces: [] }, cwd: '/'` with the same explanatory comment).
- **Mechanism repaired:** duplicated intent — the same "placeholder fields the type demands but the placement path ignores" appears in two builders with the same comment.
- **Current → Suggested:** one shared helper `placementPlaceholders()` returning `{ aspHome: getAspHome(), spec: { spaces: [] }, cwd: '/' }`, spread into both requests.
- **Direction:** extract (light).
- **Preservation:** type-proof — identical literal; pure dedup.
- **Falsifiable signal:** both request objects are structurally unchanged; build + both adapter test suites stay green.
- **Risk:** Low. **API-impact:** internal-only. **Effort:** S.
- **Tests:** `cli-adapter.execution-mode.test.ts`, `sdk-adapter.agent-tools.test.ts`.
- **Contraindication:** the two builders live in different files and target different agent-spaces request types; a shared helper creates a cross-file coupling for three trivial constants. Marginal — apply only if you also share the explanatory comment (the comment is the real duplication). Borderline auto-applicable.

### Finding 6 — [T15] reify magic literals: retry/timeout numbers and string sentinels
- **Location:** `sdk-adapter.ts:119` (`10_000`), `:120` (`250`), `:179` (`VALID_PROVIDERS`), `:402` runtime check.
- **Mechanism repaired:** primitive obsession — defaults inlined at call site (`?? 10_000`, `?? 250`). They are already overridable via options, so this is minor; naming them (`DEFAULT_MISSING_ACTIVE_RUN_RETRY_MS`, `DEFAULT_RETRY_DELAY_MS`) documents intent.
- **Current → Suggested:** hoist to named module constants.
- **Direction:** extract (cosmetic).
- **Preservation:** type-proof — identical values.
- **Falsifiable signal:** none behavioral; readability only.
- **Risk:** Low. **API-impact:** internal-only. **Effort:** S.
- **Tests:** existing.
- **Contraindication:** values are already documented inline and overridable; this is the lowest-value finding. Apply opportunistically.

## 🪶 Deliberately left alone (where-NOT)

- **`aspc-facade-client.ts` overloaded 2nd arg (`dispatchEnvOrOptions`)** (`:113-159`): looks like a candidate for [T07] narrowing, but the comment documents that it MIRRORS `spaces-harness-broker-client`'s polymorphic signature on purpose so controller.ts can pass either shape. Narrowing would break call-site symmetry. **Load-bearing — leave.**
- **`toCompileAttachments` explicit vocabulary translation** (`compile-adapter.ts:147-168`): reads like pass-through ripe for [T23], but the comment states the two packages use different `kind` vocabularies; the explicit map is the abstraction. **Leave.**
- **`deepFreeze` recursion** (`compile-profile-selector.ts:115-123`): a hand-rolled deep-freeze. Not premature — it enforces the "verified plan NEVER mutated" invariant. **Leave.**
- **`for (;;)` retry loop** (`sdk-adapter.ts:123-142`): single-owner, no shared mutable state, deterministic exit on `retryUntil`. No [T31]/[T32] race. **Leave.**
- **`VALID_PROVIDERS` runtime guard** (`sdk-adapter.ts:402-408`): a runtime re-validation of a value crossing the runner boundary; defensible defense-in-depth at a trust boundary, not a redundant check. **Leave.**
- **`asBrokerClient` adapter object** (`aspc-facade-client.ts:251-282`): a literal wrapper that looks like [T23] middle-man, but it narrows `AspcFacadeBrokerClient` to the exact `BrokerClient` shape controller.ts expects (substitution seam). **Leave.**

## 🔭 If applying: outside-in sequence
1. (Boundary, deferred) Decide Finding 1 (un-export predicates) — needs human call + test update.
2. Finding 6 (name the constants) — zero-risk warm-up.
3. Finding 5 (placement-placeholder helper) — light dedup, type-proof.
4. Finding 4 reduced form (centralize the sentinel string + pin with a test) — internal-only.
5. Finding 2 (`optional()` helper) — highest dedup payoff, but do it LAST and gate on byte-identical `JSON.stringify` of hashed material; apply sdk-adapter first, compile-adapter only if reviewers accept it near hash code.
6. (Deferred) Findings 3 — behavior-changing, human-owned.

## ✅ Safety checklist
- [ ] Re-run `packages/hrc-server` suites: `compile-adapter.test.ts`, `compile-profile-selector.test.ts`, `cli-adapter.execution-mode.test.ts`, `sdk-adapter.agent-tools.test.ts`, `headless-v02-admission.red.test.ts`.
- [ ] For Finding 2: assert `JSON.stringify` parity on built requests/events for BOTH defined and `undefined` inputs (the exact-field-set invariant feeds hashing).
- [ ] biome lint pass — note: parameterizing literals (Finding 6) or building objects via computed keys (Finding 2) can trip `useValidTypeof`/lint-style rules; run `biome check` on the two touched files.
- [ ] Typecheck the whole `hrc-server` package — direct-path consumers (broker-*-handlers, option-resolvers) import these symbols.
- [ ] Do NOT touch the deferred items (Findings 1, 3) without explicit sign-off.
