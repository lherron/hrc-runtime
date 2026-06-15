# 🔧 Refactoring Analysis — packages/hrc-events/src

**Target:** `packages/hrc-events/src` (analysis profile: general) · **Files read:** 9/9 source (`.ts`, non-test) · **Lines:** 1,641 · **Package type:** general (pure normalizer + schema library, multi-consumer)

## 🧭 Summary

`hrc-events` is a clean, pure-function library: three harness normalizers (Claude hook, Codex OTEL, Pi hook) that fold raw payloads into a shared `HookDerivedEvent` union, plus the Zod schemas and the monitor-output contract. All three normalizers already use a dispatch-table mechanism — the structure is healthy. The main repairable mechanism is a **missing shared abstraction**: each normalizer independently reimplements the same JSON-accessor primitives (`getString` / `asRecord` / `getAttrString`), and `asRecord` (pi) duplicates `asToolInputRecord` (internal/record.ts) with a subtle array-handling divergence. Everything else is deliberately left alone.

## 🚪 Public boundary (assess first)

The barrel `index.ts` re-exports types + values from `events.ts`, `schemas.ts`, the three normalizers, `tool-output-formatter.ts`, and `monitor-schema.ts`. **Real external consumers exist** (`hrc-server`: `hrc-event-helper.ts`, `otel-ingest.ts`, `hook-lifecycle.ts`, broker `event-mapper`; `hrc-cli`: `monitor-watch.ts`; `hrc-store-sqlite` tests). This is **not** a leaf package — M02 expand/contract applies to any contract change.

- **T07 (align interface to usage):** The surface is narrow and matches usage; exported functions are pure with stable result-object shapes. No fat/leaky interface found.
- **M02:** No contract change is being proposed (all findings below are internal-only). The exported `getString`/`asRecord` helpers are **not** exported — they are file-private, so consolidating them is invisible to consumers.
- Internal helpers `asToolInputRecord` are correctly kept out of the barrel (`internal/record.ts` header documents this intent).

**Verdict: 🟢** — public boundary is well-shaped; no breaking changes warranted. All findings are internal churn.

## 🎯 Findings by mechanism (outside-in, highest impact first)

### F1 — [T15] Extract the duplicated JSON-accessor primitives into `internal/`
- **Location:** `pi-normalizer.ts:65` (`asRecord`), `pi-normalizer.ts:71` (`getString` variadic), `pi-normalizer.ts:79` (`getBoolean`), `pi-normalizer.ts:87` (`getRecord`); `hook-normalizer.ts:38` (`getString` single-key); `otel-normalizer.ts:52` (`getAttrString`), `otel-normalizer.ts:61` (`getAttrBool`)
- **Mechanism repaired:** missing abstraction — three normalizers reimplement the same "read a typed field off an `unknown` record" primitive in three incompatible signatures. The repair is one shared accessor module under `internal/` (not exported), so each normalizer consumes a single canonical `getString(record, ...keys)` / `getBoolean(...)` / `asRecord(...)`.
- **Symptom (duplicated intent):** `hook-normalizer.getString(obj,key)` is the single-key special case of `pi-normalizer.getString(record,...keys)`. `otel.getAttrString` is `getString` pre-bound to the attrs object. `otel.getAttrBool` and `pi.getBoolean` differ only in that OTEL also coerces the strings `'true'`/`'false'` (attribute values arrive stringified) — so the merged `getBoolean` must keep an opt-in string-coercion path or remain two functions.
- **Current → Suggested:** keep `internal/record.ts`'s `asToolInputRecord`; add `getString`, `getBoolean`, `getRecord`, `asRecord` there (or a sibling `internal/access.ts`); delete the per-file copies and import. Preserve the variadic `...keys` signature (hook's single-key callers pass one key — behavior identical).
- **Direction:** consolidate (de-duplicate), not extract-more.
- **Preservation:** test-suite — `hook-normalizer.test.ts`, `pi-normalizer.test.ts`, `otel-normalizer.test.ts` exist and exercise each normalizer's field extraction.
- **Falsifiable signal:** all three normalizer test suites stay green; net LOC drops (~5 helper functions collapse to one set); no new import of the helpers appears in `index.ts` (proves the surface is unchanged).
- **Risk:** Low · **API-impact:** internal-only · **Effort:** M
- **Tests:** existing three suites + run full `hrc-events` suite.
- **Contraindication:** the OTEL `getAttrBool` string-coercion (`'true'`/`'false'`) is load-bearing (OTEL attributes are stringly-typed) — do NOT let the merge silently drop it. Keep a `coerceStrings` flag or a thin `getAttrBool` wrapper. Merging it away would change OTEL behavior (a redesign, not a refactor).

### F2 — [T15/T16] Reconcile `pi.asRecord` vs `internal/asToolInputRecord` (array-handling divergence)
- **Location:** `pi-normalizer.ts:65` vs `internal/record.ts:7`
- **Mechanism repaired:** duplicated-with-drift abstraction. `asToolInputRecord` returns any object (arrays included) as a record; `pi.asRecord` additionally rejects arrays (`!Array.isArray(value)`). Two near-identical coercers with different array semantics are an invariant trap — a caller picking the "wrong" one silently changes behavior.
- **Symptom:** the same conceptual operation ("is this an object-record?") has two answers in the package.
- **Current → Suggested:** make the array-rejecting variant the canonical `asRecord` in `internal/`, and have `asToolInputRecord` either delegate or be documented as the deliberate "arrays-allowed" variant. Do NOT blindly unify — verify each call site's intent first (hook-normalizer passes `tool_input`, which can legitimately be array-shaped for some tools).
- **Direction:** consolidate, with a documented split if both semantics are genuinely needed.
- **Preservation:** test-suite + careful call-site audit (this one is behavior-sensitive).
- **Falsifiable signal:** suites green; the two coercers either become one or carry explicit doc comments naming why arrays differ.
- **Risk:** Med (semantic drift if unified carelessly) · **API-impact:** internal-only · **Effort:** S
- **Tests:** pi + hook normalizer suites; add a characterization test for array-shaped `tool_input` if none exists.
- **Contraindication:** if `asToolInputRecord` callers rely on arrays-passing-through, the divergence is intentional — keep both, just name the distinction. Unifying would be a behavior change.

### F3 — [T15] Lift the duplicated `truncate` literal + helper out of the formatters
- **Location:** `hook-normalizer.ts:55` (`truncate` closure + `…`), `otel-normalizer.ts:183` (inline prompt truncation with `…`), `tool-output-formatter.ts` (preview truncation `... +N more lines`)
- **Mechanism repaired:** missing abstraction — "truncate a string to N chars with an ellipsis" is reimplemented inline in two places (hook closure, otel inline ternary) using the same `…` sentinel. A single `truncate(s, max)` in `internal/` removes the magic-character duplication.
- **Symptom:** repeated `s.length > max ? \`${s.slice(0, max)}…\` : s` shape.
- **Current → Suggested:** one `truncate(s, max)` helper; the per-tool char limits (`CMD_TRUNCATE=80`, `PATH_TRUNCATE=60`, `PROMPT_TRUNCATE=200`) stay as named constants in their own files (they are domain limits, not duplication).
- **Direction:** consolidate the verb, keep the per-domain constants distinct.
- **Preservation:** char-test/test-suite — hook + otel suites assert truncated output.
- **Falsifiable signal:** suites green; `…` literal appears once.
- **Risk:** Low · **API-impact:** internal-only · **Effort:** S
- **Contraindication:** the `tool-output-formatter` "+N more lines" truncation is a *different* shape (line-count, not char-count, different suffix) — do NOT fold it into the char truncator; that would change Write-preview output.

### F4 — [T16] Re-confirm the dispatch tables are NOT over-abstraction (de-abstraction check — NEGATIVE)
- **Location:** `hookHandlers` (`hook-normalizer.ts:313`), `otelEventHandlers` (`otel-normalizer.ts:209`), `piEventHandlers` (`pi-normalizer.ts:217`), `toolRenderers` (`tool-output-formatter.ts:250`)
- **Finding:** each table has **multiple distinct entries with real behavioral variation** (8, 4, 8, and 2 implementors respectively). These are genuine conditional→dispatch payoffs, not premature abstraction. **No T16 collapse warranted.** Recorded here so the negative is explicit (direction honesty: not everything extracts/collapses).
- **Risk:** n/a (no change) · leave as-is.

## 🪶 Deliberately left alone (where-NOT)

- **`monitor-schema.ts` enum arrays** (`MonitorResult`, `MonitorFailureKind`, `MonitorEventName`): these are a FROZEN output contract (§10, FROZEN Q2/Q5). They look like "stringly-typed primitive obsession" but the `as const` + `z.enum` pattern is exactly the right reification; touching them is a contract change. T13 (push-invariant-into-constraint) is already satisfied by the Zod enums.
- **`isHookDerivedEvent` literal list** (`events.ts:118`): duplicates the union discriminants, but it is the runtime projection of a compile-time union — a small, intentional, load-bearing redundancy. Parameterizing it off the union is not possible without a registry; leave it.
- **`events.ts` / `schemas.ts` type↔schema parallelism:** the interfaces and Zod schemas are deliberately kept in lockstep by hand. This is duplication, but it is the type/runtime-validation seam; auto-deriving one from the other (`z.infer`) would be a redesign with consumer-visible inference changes.
- **Per-tool `formatToolSummary` switch** (`hook-normalizer.ts:57`): a flat `switch` over ~10 tools each extracting a different field with a different label — converting to a data table is possible but the variation is genuinely per-arm (different keys, different prose), so a table buys little and reads worse. Leave it.
- **The three normalizers' separate files:** they share *primitive* helpers (F1) but their *domain* logic is correctly separated by harness (Claude/Codex/Pi). No T03 relocation — cohesion is already high.

## 🔭 If applying: outside-in sequence

1. **(A/T40)** Confirm the three normalizer test suites + `monitor-schema.acceptance.test.ts` are green as the characterization baseline (public surface is already covered).
2. **F1** — add the shared accessors to `internal/`, migrate `pi`/`hook`/`otel` one file at a time, run that file's suite after each. Keep OTEL's string-coercing bool as a wrapper.
3. **F2** — audit `asToolInputRecord` vs `asRecord` call sites; unify or document. Behavior-sensitive — do this with the array characterization test in hand.
4. **F3** — extract `truncate`, leave per-domain constants and the line-count truncator untouched.
5. Re-run the **full** `hrc-events` suite; confirm `index.ts` exports are byte-identical (no surface drift).

## ✅ Safety checklist

- [ ] No edit to `index.ts` export set (public surface frozen).
- [ ] No edit to `monitor-schema.ts` enum members (FROZEN contract).
- [ ] OTEL `'true'`/`'false'` string-bool coercion preserved after F1 merge.
- [ ] Array-shaped `tool_input` behavior preserved/characterized before F2.
- [ ] Write-preview "+N more lines" truncation NOT merged into char-truncate (F3).
- [ ] Full `hrc-events` suite green; net LOC down, no new barrel imports.
