# 🔧 Refactoring Analysis — packages/hrc-store-sqlite/src

**Target:** `packages/hrc-store-sqlite/src` (profile: data) ·
**Files read:** 17 of 17 non-test source files (100%) + 1 migration file sampled, plus consumer grep across the monorepo ·
**Lines:** ~6,471 (src incl. tests); ~5,150 non-test ·
**Package type:** data-access (SQLite repository layer over `bun:sqlite`), heavily consumed (121 consumer files; the public surface is `openHrcDatabase` + the `HrcDatabase` object graph)

## 🧭 Summary

This package has already absorbed a prior decomposition pass: the repository layer was split into cohesive sibling modules under `repositories/`, with shared helpers (`collectPatchEntries`, `buildSetClause`, `buildLifecycleWhere`, canonical `*_COLUMNS` constants, `map*Row` projections) factored out. The remaining smells are **small and mostly DE-abstraction or public-surface narrowing**, not "extract more." The single highest-value structural finding is that `index.ts` re-exports a large set of repository *classes* that no external consumer imports directly — a leaky public boundary that should contract (deferred, M02). Internally the code is in good shape; the auto-applicable findings are minor (a duplicated `execute` helper, a pass-through re-export shim, two trivially-mergeable methods).

## 🚪 Public boundary (assess first)

**Surface:** `index.ts` exports `openHrcDatabase`, the `HrcDatabase` type, `MessageRepository` (+ `MessageInsertInput`), five broker/runtime repository classes (`BrokerInvocationEventRepository`, `BrokerInvocationRepository`, `CompiledRuntimePlanRepository`, `PermissionDecisionRepository`, `RuntimeArtifactRepository`, `RuntimeOperationRepository`), `BrokerInvocationEventConflictError`, and a set of input/filter types.

**Actual usage (grep across 121 consumer files, dist excluded):**
- `openHrcDatabase` (59), `HrcDatabase` type (46), `AppManagedSessionRecord` (3), `BrokerInvocationEventConflictError` (2), a few filter/input types (1 each).
- **Every repository *class* value-export is imported 0 times externally** (`BrokerInvocationRepository`, `CompiledRuntimePlanRepository`, `PermissionDecisionRepository`, `RuntimeArtifactRepository`, `RuntimeOperationRepository`, `MessageRepository` — all 0; `BrokerInvocationEventRepository` "2" are doc-comment mentions, not imports). Consumers reach repositories exclusively through the typed `HrcDatabase` properties (`db.sessions`, `db.brokerInvocations`, …).

**T07 finding (leaky interface):** the public surface is wider than its usage. The repository-class value exports leak internal construction types that callers never instantiate. Narrowing to `openHrcDatabase` + `HrcDatabase` + the genuinely-imported types/errors aligns the interface to actual usage. Because there are 121 consumers and these are published symbols, this is **M02 expand/contract** territory — DEFERRED, not auto-applied.

**`repositories.ts` (the re-export shim):** pure middle-man between `index.ts`/`database.ts` and `repositories/*`. It exists only to preserve the old `./repositories.js` import path during the split. No external consumer deep-imports `repositories/*` (grep: 0). Collapsing the shim is internal-only but touches `database.ts`'s import line and the `index.ts` re-exports — low risk, modest churn (see Findings).

**Verdict:** 🟡 — boundary is sound for the *primary* entrypoint (`openHrcDatabase`), but carries a band of unused repository-class exports. One deferred contraction (M02) + one internal shim collapse.

## 🎯 Findings by mechanism (outside-in, highest impact first)

### F1 — Contract narrowing: unused repository-class value exports `[T07/M02]` (DEFERRED)
- **Location:** `index.ts:17-26` (and the mirrored value exports in `repositories.ts:28-70`).
- **Mechanism repaired:** boundary alignment — narrow a fat published interface to actual usage.
- **Symptom:** six repository classes are exported but imported 0 times by any of the 121 consumers; they are only ever constructed internally in `database.ts` and surfaced via `HrcDatabase` properties.
- **Current → Suggested:** keep `openHrcDatabase`, `HrcDatabase`, `BrokerInvocationEventConflictError`, and the imported types; drop the unused repository *class* exports from `index.ts` (retain them as internal `repositories.ts` exports for `database.ts`).
- **Direction:** DE-abstraction / contract contraction.
- **Preservation:** type/compiler-proof (downstream `tsc` over all 121 consumers is the gate) + char-test on `openHrcDatabase`.
- **Falsifiable signal:** repo-wide `tsc` stays green after removal; `grep` confirms 0 broken imports.
- **Risk:** Med. **API-impact:** public-surface. **Effort:** S (deletion + monorepo typecheck).
- **Contraindication:** if any external package is *intended* to construct a bare repository against its own `Database` (e.g. a future migration/repair tool), these are a deliberate option — confirm with `hrc-server`/`hrc-cli` owners before removing. This is why it is DEFERRED.

### F2 — Remove middle man: collapse the `repositories.ts` re-export shim `[T23]` (AUTO-APPLICABLE)
- **Location:** `repositories.ts:1-70` (consumed by `database.ts:7-28` and `index.ts:17-26`).
- **Mechanism repaired:** remove a pass-through indirection layer that adds a hop without behavior.
- **Symptom:** `repositories.ts` is a pure barrel re-exporting `repositories/*`; the split is done and no external code deep-imports the subdir (grep: 0). The barrel duplicates the export list maintenance.
- **Current → Suggested:** have `database.ts` and `index.ts` import directly from `./repositories/session-repositories.js`, `./repositories/runtime-repositories.js`, etc.; delete `repositories.ts`. (Contraindication-aware: keeping a single barrel is defensible — see below.)
- **Direction:** DE-abstraction.
- **Preservation:** type/compiler-proof — imports resolve or they don't; no runtime behavior changes.
- **Falsifiable signal:** package builds and the full test suite passes; `index.ts` exports the identical symbol set (diff the `.d.ts`).
- **Risk:** Low. **API-impact:** internal-only (the published `index.ts` surface is unchanged; only the internal hop is removed). **Effort:** S.
- **Tests:** existing `__tests__/*` exercise every repository via `openHrcDatabase`; no new chars needed.
- **Contraindication:** a single re-export barrel is a *deliberate* convenience that keeps `database.ts`'s import block to one source and gives one obvious place to see the whole repo surface. If the team values that, **leave it** — the indirection is load-bearing as documentation. Marked auto-applicable only because it is provably behavior-preserving; defer to maintainer preference.

### F3 — Duplicated `execute` helper across modules `[T15]` (AUTO-APPLICABLE)
- **Location:** identical `execute(db, sql, ...params)` defined three times: `repositories/shared.ts:425-427`, `migrations/types.ts:8-10`, and `message-repository.ts:114-116`.
- **Mechanism repaired:** extract the single missing abstraction for "prepare+run a parameterized write."
- **Symptom:** three byte-identical implementations; `message-repository.ts` and `migrations/types.ts` each re-declare it instead of importing the shared one.
- **Current → Suggested:** `message-repository.ts` imports `execute` from `./repositories/shared.js`; `migrations/types.ts` keeps its own copy ONLY if a layering rule forbids migrations depending on the repository layer (see contraindication), else it too imports the shared one.
- **Direction:** dedup (consolidate).
- **Preservation:** type/compiler-proof + existing suite.
- **Falsifiable signal:** one definition remains reachable from all three call sites; tests green.
- **Risk:** Low. **API-impact:** internal-only. **Effort:** S.
- **Contraindication:** `migrations/` is intentionally a lower layer than `repositories/` (migrations must not import repository code). The `migrations/types.ts` copy is plausibly a **deliberate layering boundary**, not accidental duplication — in that case dedup only the `message-repository.ts` copy and leave `migrations/types.ts` alone. The duplication there may be load-bearing.

### F4 — Two-tier nullable-transform inconsistency in patch specs `[T15]` (AUTO-APPLICABLE, low value)
- **Location:** `repositories/runtime-repositories.ts:25-81` (`RUNTIME_UPDATE_SPEC`) vs `broker-repositories.ts` specs.
- **Mechanism repaired:** make the implicit "coerce-null vs pass-through" rule explicit/uniform.
- **Symptom:** in `RUNTIME_UPDATE_SPEC` some optional string columns use `transform: nullableTransform` (e.g. `lifecyclePolicyHash`) while equally-optional sibling columns (e.g. `activeRunId`, `controllerKind`, `compileId`) have **no** transform and rely on the raw value being passed through. The `collectPatchEntries` contract only ever inserts *defined* values, so `undefined` can't reach the binder; the asymmetry is harmless but signals an unstated rule ("only the T-01946/T-04xxx-era columns got `nullableTransform`").
- **Current → Suggested:** decide the rule once — either every nullable column carries `nullableTransform` or none do (since `undefined` is filtered upstream, the transform is a no-op for these and could be dropped). Prefer dropping the redundant `nullableTransform` from columns whose patch type can't carry `null`.
- **Direction:** simplify (remove redundant transform) — verify each column's patch field type first.
- **Preservation:** type/compiler-proof + char-test asserting a patch with an explicit `null` still writes `NULL` for the columns whose types allow `null`.
- **Falsifiable signal:** round-trip test: `update({ lifecyclePolicyHash: null })` still nulls the column; `update({ activeRunId: 'x' })` unchanged.
- **Risk:** Med (a wrong removal could turn an intended `null`-write into a no-op for a column whose type *does* allow `null`). **API-impact:** internal-only. **Effort:** M (must audit each column's patch-field type against whether `null` is a legal input).
- **Contraindication:** `nullableTransform` is genuinely load-bearing for any column whose `*UpdatePatch` field type is `T | null | undefined` (an explicit `null` must coerce to SQL `NULL`). Do NOT strip it from those. Several broker columns are exactly this shape — leave them.

### F5 — Merge `markAccepted`/`markRejected` thin wrappers `[T23]` (AUTO-APPLICABLE, low value)
- **Location:** `repositories/bridge-repositories.ts:286-300` (`ActiveInputDeliveryRepository.markAccepted` and `markRejected`).
- **Mechanism repaired:** remove middle-man methods that are byte-identical delegations.
- **Symptom:** both methods are `return this.markResponse(inputApplicationId, response, now)` verbatim — the accepted/rejected distinction is already carried by `response.status`, not by which method is called.
- **Current → Suggested:** expose a single `markResponse(...)` publicly (or keep one named method) and have callers pass the response whose `.status` already encodes accepted vs rejected.
- **Direction:** collapse pass-through.
- **Preservation:** char-test on the two call sites in `hrc-server` (the names may be semantically meaningful at the call site).
- **Falsifiable signal:** call sites updated, behavior identical (same row written), suite green.
- **Risk:** Med (these are repository-method names; renaming is a mini API change for internal callers). **API-impact:** internal-only (not in `index.ts`, reached via `HrcDatabase.activeInputDeliveries`). **Effort:** S–M (must update `hrc-server` call sites).
- **Contraindication:** the two names are **intent-revealing at the call site** ("this path accepted the input" vs "this path rejected it"). That self-documentation is a legitimate reason to keep both even though the bodies match. Treat as optional polish; the duplication is arguably load-bearing as a domain vocabulary.

### F6 — `findByHostSessionId` is a pure alias of `getByHostSessionId` `[T23]` (AUTO-APPLICABLE, low value)
- **Location:** `repositories/session-repositories.ts:188-190` (`SessionRepository.findByHostSessionId` → `getByHostSessionId`).
- **Mechanism repaired:** remove a redundant synonym method.
- **Symptom:** `findByHostSessionId` does nothing but call `getByHostSessionId`; two names for one query.
- **Current → Suggested:** pick one name, update call sites. (Likely `get*` is the house style given `getByRunId`, `getByLaunchId`, `getByOperationId` elsewhere.)
- **Direction:** dedup.
- **Risk:** Low–Med (internal call-site rename). **API-impact:** internal-only. **Effort:** S.
- **Preservation:** type/compiler-proof across call sites + suite.
- **Falsifiable signal:** the alias is gone, `tsc` green.
- **Contraindication:** if some consumer subsystem standardizes on `find*` for "may-return-null" vs `get*` for "throws-if-missing", the two names could encode a nullability convention — but here both return `... | null`, so the distinction is not honored. Safe to collapse.

### F7 — `RunRepository.listRuns` re-implements the shared filter builder `[T15]` (AUTO-APPLICABLE, low value)
- **Location:** `repositories/runtime-repositories.ts:392-423` (`listRuns`) vs `shared.ts:494-515` (`buildEventWhere`).
- **Mechanism repaired:** reuse the existing `[host_session_id, generation, runtime_id]` predicate builder instead of re-rolling the `if (filters.x !== undefined) { predicates.push(...) }` ladder.
- **Symptom:** `listRuns` hand-rolls the same three-predicate accumulation that `buildEventWhere` already encapsulates (minus `run_id`). The shared helper is `runs`-agnostic (column names match).
- **Current → Suggested:** factor a tiny `buildIdentityWhere(filters, where, values)` (or reuse `buildEventWhere`, which already emits exactly `host_session_id`/`generation`/`runtime_id`/`run_id` — `listRuns` doesn't filter on `run_id`, so a 3-field variant is cleaner) and call it from `listRuns`.
- **Direction:** dedup / consolidate.
- **Preservation:** char-test on `listRuns` filter combinations (the ordering of bound values must stay positionally identical).
- **Falsifiable signal:** `listRuns({hostSessionId, generation, runtimeId})` returns the identical rows/order; suite green.
- **Risk:** Low. **API-impact:** internal-only. **Effort:** S.
- **Contraindication:** `buildEventWhere` is named/scoped for `events`; reusing it for `runs` couples two tables to one helper. If the team wants table-independent filter builders kept separate to avoid accidental column drift, a small dedicated helper (not reuse) is the right call. Low stakes either way.

## 🪶 Deliberately left alone (where-NOT)

- **`parseJson` swallow-and-log (`shared.ts:184-198`):** returns `undefined` on corrupt JSON and logs to `console.error`. This is **not** a swallowed-catch smell to "fix" — it is a deliberate, documented resilience boundary (corrupt-JSON tolerance is explicitly tested in `store.json-corruption.test.ts` / `store.json-parse-crash.test.ts`). Changing it to throw would be a **behavior change (redesign)**, not a refactor. Leave as-is.
- **The `*_COLUMNS` SQL constants + `map*Row` projections (`shared.ts`, `broker.ts`):** these are the canonical single-site column lists; the duplication between an `INSERT (...)` column list and the `*_COLUMNS` SELECT constant is **load-bearing** (INSERT order is positional and independent of SELECT projection). Do not try to unify INSERT column lists with the SELECT constants — they serve different positional contracts.
- **The conditional-spread projections in `map*Row` (e.g. `...(row.run_id !== null ? { runId: row.run_id } : {})`):** these preserve the exact optional-field semantics of the `Hrc*Record` types (omit vs `undefined`). A "simplification" to always-assign-`undefined` would change the emitted field set and break `exactOptionalPropertyTypes` consumers. Preserve the exact field set — leave untouched.
- **Per-repository explicit `INSERT` statements:** they look repetitive but each is a positional contract against a distinct table; there is no safe parameterization (column count/order differs per table). The `collectPatchEntries`/`PatchEntrySpec` abstraction already covers the *update* path, which is where the real duplication risk lived. Inserts are correctly left explicit.
- **`MILESTONE_PREDICATE_SQL` literal LIKE clauses (`event-repositories.ts:37-51`):** a curated operator-action preset. Parameterizing the literal `'%hrcchat dm%'` etc. would not reduce complexity and the values are a fixed product decision. Leave literal.
- **`allocateStreamSeq` check-then-increment (`shared.ts:807-817`):** read `next_seq` then `UPDATE ... SET next_seq + 1`. This LOOKS like a check-then-act race (concurrent profile), but every caller wraps it in a `db.transaction(...)` (see `EventRepository`/`HrcLifecycleEventRepository`/`MessageRepository` constructors) and `bun:sqlite` serializes writers (single-writer WAL + `busy_timeout`). The atomicity is provided by the enclosing transaction, so this is **not** an applicable [T32] finding. Note it as verified-safe rather than a finding.

## 🔭 If applying: outside-in sequence

1. **First, gate with characterization** [T40]: the existing `__tests__/*.test.ts` already cover the public `openHrcDatabase` graph broadly — confirm they pass as the baseline before any edit.
2. **F2 (collapse shim)** — internal, compiler-proven; smallest blast radius, do first IF the team agrees the barrel isn't wanted as documentation.
3. **F3 (dedup `execute` in `message-repository.ts` only)** — trivial, respect the migrations-layer contraindication.
4. **F6 → F5 → F7** — small internal collapses; update `hrc-server` call sites, re-run the full suite each time.
5. **F4** — only after auditing each column's patch-field type; lowest value, highest care.
6. **F1 (M02 contraction)** — DEFERRED: confirm with surface owners, then expand/contract across the monorepo with a full downstream `tsc`.

## ✅ Safety checklist

- [ ] Baseline: `bun test` for `hrc-store-sqlite` green before edits.
- [ ] Every internal change re-verified with full-package build + test (the suite drives all repos via `openHrcDatabase`).
- [ ] Any call-site rename (F5/F6) re-typechecks the whole monorepo (`tsc`), not just this package.
- [ ] `index.ts` `.d.ts` diffed to prove F2 leaves the published surface byte-identical.
- [ ] Spread/projection field sets in `map*Row` untouched (exact-optional preserved).
- [ ] `parseJson` resilience behavior unchanged (json-corruption tests still green).
- [ ] F1 NOT applied without surface-owner sign-off (121 consumers).
