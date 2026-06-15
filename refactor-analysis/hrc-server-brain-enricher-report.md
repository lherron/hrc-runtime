# 🔧 Refactoring Analysis — packages/hrc-server/src/brain-enricher

**Target:** `packages/hrc-server/src/brain-enricher` · **Files read:** 3/3 (index.ts, format.ts, cache.ts) + re-export shim `brain-enricher.ts` + both consumers · **Lines:** 198 src · **Package type:** general (internal module of hrc-server)

## 🧭 Summary
This module is in a **half-gutted state**: the public entry `enrichTurnPromptForBrain` always returns `passThrough(..., 'disabled')` — it never resolves a runtime, formats a prompt, or touches the cache. As a result `format.ts` and `cache.ts` are **entirely unreferenced** dead code, and the `_deps` parameter, the `BrainRuntimeResolver` type, and most of `BrainEnricherResult`'s `reason` union are unreachable. The dominant finding is de-abstraction (T16): structure was built for a variation (live gbrain enrichment) that the current code path never exercises. There are zero characterization tests, so any change must add them first (T40).

## 🚪 Public boundary (assess first)
**Exported surface** (via `brain-enricher.ts` shim, the only thing outside the dir imports): `enrichTurnPromptForBrain`, `BrainEnricherInput`, `BrainEnricherResult`, `BrainRuntimeResolver`.

- **Actual external consumers:** only `turn-dispatch-handlers.ts:299` and `target-message-handlers.ts:416`. Both call `enrichTurnPromptForBrain({ session, intent, prompt, runId })` with **no second `deps` arg**, then read only `enriched.prompt`, `enriched.reason`, `enriched.applied`, and `enriched.sources?.length`.
- `format.ts` exports (`formatBrainPrompt`, `contextSourcesForResult`, `BrainRule`, `BrainContextSource`) and `cache.ts` exports (`getBrainSessionCache`, `cacheKey`, `BrainCacheKey`, `BrainSessionCache`) are **never imported anywhere** — not by `index.ts`, not by the shim, not by consumers, not by tests.
- **[T07] leaky/fat boundary:** `BrainRuntimeResolver` is exported but never consumed (callers pass no deps); `_deps` is accepted and ignored. The `reason` union advertises 7 outcomes but only 3 (`disabled`, `empty-prompt`, `non-agent-scope`) are reachable. `sources` is declared on the result but never populated.
- **[M02]:** the surface IS public (re-exported, two live consumers). Trimming the type union or removing `BrainRuntimeResolver`/`_deps` is a contract narrowing — low real risk (no caller uses them) but must be done expand/contract, hence DEFERRED.

**Verdict: 🔴** — the boundary advertises a capability the implementation no longer delivers. The right move is a product/intent decision (restore enrichment vs. delete the module), not a mechanical refactor. Until that decision is made, the safe internal-only action is adding characterization tests and collapsing the dead deps param.

## 🎯 Findings by mechanism (outside-in, highest impact first)

### F1 — [T40] Characterization tests on the public surface (gates everything)
- **Location:** whole module; no `*.test.ts` exists for brain-enricher anywhere in hrc-server.
- **Mechanism repaired:** make-safe — there is no behavioral net under `enrichTurnPromptForBrain`, `formatBrainPrompt`, or the cache.
- **Symptom:** zero tests; every other change here is unguarded.
- **Current → Suggested:** add table-driven char-tests pinning (a) `enrichTurnPromptForBrain` returns `{applied:false, reason}` for each reachable branch — `non-agent-scope` (scopeRef not `agent:`), `empty-prompt` (whitespace prompt), `disabled` (otherwise), and that `prompt` is returned verbatim; (b) `formatBrainPrompt` output for a representative rules+context input including the cap/escape/sanitize edges; (c) `cacheKey` separator behavior and `getBrainSessionCache` identity (same key ⇒ same object).
- **Direction:** add safety.
- **Preservation:** char-test (establishes the baseline).
- **Falsifiable signal:** tests pass on current code; later removals/edits keep them green (or green after intentional union-trim).
- **Risk:** Low · **API-impact:** internal-only · **Effort:** S.
- **Tests:** these ARE the tests.
- **Contraindication:** none — pinning current (even stubbed) behavior is the prerequisite for safely deleting dead code.

### F2 — [T16] Collapse premature abstraction: dead `_deps` / `BrainRuntimeResolver`
- **Location:** `index.ts:26-33,37` (`BrainRuntimeResolver` type, `BrainEnricherDeps`, the `_deps` param).
- **Mechanism repaired:** remove structure whose variation never materialized — a substitution seam (injected resolver) that no caller wires and the body never reads.
- **Symptom:** `_deps: BrainEnricherDeps = {}` is accepted and ignored; both call sites pass one arg; `BrainRuntimeResolver` is exported but unused.
- **Current → Suggested:** drop the `_deps` param and the `BrainEnricherDeps` type internally; remove `BrainRuntimeResolver` from the exported surface. **DEFERRED**, because `BrainRuntimeResolver` is part of the re-exported public boundary (contract narrowing ⇒ M02). The param removal alone is internal-only and safe, but is only worth doing together with the resolver-export trim.
- **Direction:** de-abstract.
- **Preservation:** type/compiler-proof (TS confirms no caller passes deps).
- **Falsifiable signal:** build + full hrc-server typecheck stays green after removal; grep shows no `BrainRuntimeResolver` usage.
- **Risk:** Low · **API-impact:** public-surface (resolver export) · **Effort:** S.
- **Contraindication:** if enrichment is about to be restored, the seam is a *deliberate option* being held open — confirm the product direction first (this is the load-bearing reason to DEFER, not auto-apply).

### F3 — [T16] Orphaned modules: `format.ts` and `cache.ts` are fully unreferenced
- **Location:** entire `format.ts` (110 LOC) and `cache.ts` (34 LOC).
- **Mechanism repaired:** dead-code removal — the formatting + per-session cache machinery exists for the enrichment path that `index.ts` no longer invokes.
- **Symptom:** no import of `formatBrainPrompt`, `contextSourcesForResult`, `getBrainSessionCache`, `cacheKey` exists in source or tests. The module-level `const sessionCaches = new Map(...)` (cache.ts:16) is a process-global that is never read.
- **Current → Suggested:** either (a) delete both files if enrichment is abandoned, or (b) re-wire them from `index.ts` if enrichment is being restored. This is a **product decision, not a mechanical refactor** ⇒ **DEFERRED**. Auto-deleting would silently erase the only implementation of the gbrain formatting/caching contract.
- **Direction:** de-abstract (delete) OR re-integrate.
- **Preservation:** observational (the only safe proof is "behavior identical because the code was never reached") — but deciding delete-vs-restore needs a human.
- **Falsifiable signal:** after the decision, grep for the symbols returns only the dir itself (delete) or returns a call from `index.ts` (restore); build green either way.
- **Risk:** Med · **API-impact:** internal-only (neither file's symbols cross the package boundary today) · **Effort:** S (delete) / L (restore).
- **Contraindication:** **load-bearing-by-intent** — this is staged WIP (commit 7786c6a "capture pre-existing WIP — brain-enricher module split"). Deleting could throw away work someone intends to finish. Do not auto-apply.

### F4 — [T17] Partial → total: unreachable arms in the `reason` union
- **Location:** `index.ts:15-23` — union members `enabled`, `injection-disabled`, `resolution-error`, `query-timeout` are never produced.
- **Mechanism repaired:** illegal/unreachable states — the result type claims outcomes the function cannot return, so consumers (e.g. the `brain.enricher.${reason}` log key) handle phantom cases.
- **Symptom:** 4 of 7 union members are dead under current control flow.
- **Current → Suggested:** narrow the union to the reachable set, OR (preferred) restore the code paths that produce them. **DEFERRED** — same root cause as F2/F3 and a public-surface narrowing (M02). Coupled to the restore-vs-delete decision.
- **Direction:** de-abstract (narrow) OR re-integrate.
- **Preservation:** type/compiler-proof for the narrowing.
- **Falsifiable signal:** char-test (F1) enumerates exactly the reachable reasons; narrowed union compiles; consumer log-key string still type-checks.
- **Risk:** Low · **API-impact:** public-surface · **Effort:** S.
- **Contraindication:** restoring enrichment re-populates these arms — don't narrow if restore is imminent.

### F5 — [T15] Magic-number cluster in `format.ts` is acceptable but undocumented (where-leaning-NOT)
- **Location:** `format.ts:14-17` — `MAX_RULES=5`, `MAX_CONTEXT=5`, `MAX_SNIPPET_CHARS=200`, `MAX_CONTEXT_CHARS=3200`.
- **Mechanism repaired:** missing abstraction (named constants) — but these are **already named module constants**, which is the correct shape. No extraction needed.
- **Symptom:** none structurally; the only mild smell is no comment on why 3200/200, but that's not a refactor.
- **Verdict:** **leave alone.** Pressure-test result: the "magic number" smell is already fixed (named consts). Auto-applying anything here would be churn. Listed only to record it was checked.

## 🪶 Deliberately left alone (where-NOT)
- **`format.ts` internals** (`cappedContext`, `snippetText`, `sanitizeBlockText`, `escapeAttribute`, `formatScore`): cohesive, single-purpose, well-factored helpers with guard clauses already flat (max nesting ~2). `escapeAttribute`'s ordered `&` → `"`/`<`/`>` replacement is **load-bearing** (ampersand must be escaped first) — do not "simplify" into a single regex/lookup without preserving order. No finding.
- **Named constants (F5):** already correct shape.
- **`cacheKey` `\0` separator** (cache.ts:19): deliberate collision-safe delimiter; not primitive obsession worth a value object for an internal map key.
- **The whole formatting pipeline:** it is dead (F3) but internally clean; if restored it needs no structural rework, so no internal-quality findings are raised against it.

## 🔭 If applying: outside-in sequence
1. **F1 first** — land characterization tests pinning the 3 reachable `enrichTurnPromptForBrain` reasons and the `formatBrainPrompt`/`cacheKey` outputs (auto-applicable, internal-only).
2. **STOP for a product decision** on F3 (delete vs. restore enrichment). Everything else (F2 resolver-export trim, F4 union narrowing, F3 file deletion) is contingent on that decision and is therefore DEFERRED to a human.
3. Only after the decision: if "delete", remove `format.ts`/`cache.ts`, drop `_deps`/`BrainRuntimeResolver`, narrow the `reason` union (one expand/contract step). If "restore", re-wire `index.ts` to call the resolver → `formatBrainPrompt` → cache.

## ✅ Safety checklist
- [x] Public boundary assessed first — surface trimming is DEFERRED (M02).
- [x] Re-verified each smell against current source (re-read; F5 magic-number smell already fixed).
- [x] Honored contraindications — dead modules are staged WIP (commit 7786c6a), not auto-deleted.
- [x] Direction marked honestly — this target is **de-abstraction / dead-code**, not "extract more".
- [x] Spread/projection: `cappedContext` uses `{ ...source, text }` preserving exact field set — noted, untouched.
- [x] Only F1 (char-tests) is auto-applicable; all structural changes gated on a human product decision.
