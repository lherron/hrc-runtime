# 🔧 Refactoring Analysis — packages/hrc-server/src/parsers

**Target:** `packages/hrc-server/src/parsers` (general profile, recursive)
**Files read:** 7/7 — `common.ts` (258), `runtime.ts` (550), `app-sessions.ts` (557), `bridges.ts` (206), `sweeps.ts` (167), `messages.ts` (56), `runtime-harness-resolver.ts` (59). Plus the consuming barrel `../server-parsers.ts` and the one test `__tests__/server-parsers.runtime-intent.test.ts`.
**Lines:** 1853 (parsers only)
**Package type:** general — pure HTTP request-body / query-string validation. No concurrency, no shared mutable state, no DB access. These are stateless `unknown -> typed DTO` total functions that throw `HrcBadRequestError`/`HrcUnprocessableEntityError` on invalid input.

## 🧭 Summary
The dir is a cohesive, already-decomposed family of validation parsers fronted by the `server-parsers.ts` barrel. The dominant smell is **massive duplication of imperative field-validation intent** (`isRecord` guard, "must be a boolean", trimmed-string-or-throw, conditional-spread projection) repeated ~40+ times — a textbook [T15] missing-abstraction. The structural fix is a small set of validated readers/combinators (several already exist in `common.ts` but are unevenly adopted). A handful of pass-through wrappers ([T23]) and one duplicated boolean-field helper are also present. No races, no illegal-state machines, no N+1.

## 🚪 Public boundary (assess first)
**API surface:** `server-parsers.ts` re-exports the parser functions + their DTO types to ~20 consumers across `hrc-server`. Within the dir, the cross-file public edges are `parseRuntimeIntent` (runtime.ts → app-sessions.ts), `parseSessionRef` (messages.ts → index/target-view/messages/selector handlers), `resolveHarnessFromPlacement` (resolver → runtime.ts), and `common.ts` helpers consumed dir-wide.

**T07 (align interface to usage):** The barrel re-exports `parseBridgeSelector` and `parseSessionRef` individually; both have real external callers (`target-view.ts`, `index.ts`), so the surface is *not* over-wide. Note `parseRuntimeIntent` is intentionally **not** re-exported through the barrel (used only intra-dir) — correct narrowing, leave it.

**M02 (expand/contract):** Not a leaf package — `server-parsers.ts` has ~20 internal consumers and `__tests__` import the parsers directly. Any signature/return-shape change must go through expand/contract. All findings below are internal-body refactors that **preserve every emitted field and every thrown error code/message**, so M02 is not triggered.

**Verdict: 🟢** — boundary is well-shaped and appropriately narrow. All work is internal-body cleanup behind a stable surface.

## 🎯 Findings by mechanism (outside-in, highest impact first)

### F1 — [T15] Extract missing abstraction: optional-boolean-field reader (body validation)
- **Location:** repeated across `runtime.ts:264-271, 337-343, 344-351, 420-433, 465-474, 510-528`; `sweeps.ts:65-86, 113-125, 148-160` (×3 nearly identical blocks per file); `app-sessions.ts:350-354, 380-384`.
- **Mechanism repaired:** duplicated validation *intent* — "field absent → ok; present-and-not-boolean → throw `MALFORMED_REQUEST` with `{field}`; else carry through" — has no single owner. ~15 copies.
- **Symptom:** the same 6-line `if (x !== undefined && typeof x !== 'boolean') throw …` block.
- **Current → Suggested:** add `readOptionalBooleanField(input, field): boolean | undefined` to `common.ts` (sibling of the existing `readBooleanField`, `parseOptionalBooleanQuery`). Replace the inline blocks; emit via `...(v !== undefined ? { [field]: v } : {})`.
- **Direction:** DE-duplicate → extract (toward `common.ts`).
- **Preservation:** type/compiler-proof for the DTO shape + char-test for exact error message/code. The helper must reproduce the existing message `\`${field} must be a boolean\`` and code `MALFORMED_REQUEST` verbatim.
- **Falsifiable signal:** line count drops ~70; a char-test asserting `parseBrokerInspectRequest({runtimeId:'r', probeLiveness:'no'})` throws with message `probeLiveness must be a boolean` still passes.
- **Risk:** Low. **API-impact:** internal-only. **Effort:** M.
- **Tests:** add characterization for one representative per call site family before edit (currently only `runtime-intent` is covered).
- **Contraindication:** `sweeps.ts` uses `{ field: 'dryRun' }` while some runtime blocks add no detail object beyond `{field}` — confirm the detail payload is identical before collapsing; a couple use a nested-indent object literal. Where the detail differs, parameterize it, do not drop it.

### F2 — [T15] Extract missing abstraction: optional-non-empty-string-field-with-trim projection
- **Location:** `runtime.ts:476-490` (the local `stringField` closure for reason/source/actor), `app-sessions.ts:384-399` (reason), `runtime.ts:290-298` (prompt), `messages.ts:20-31` (create), plus the `...(typeof x === 'string' && x.trim().length>0 ? {x:x.trim()} : {})` projection pattern in `app-sessions.ts:360-362, 394-396`.
- **Mechanism repaired:** the "optional string, validate type, trim, include only if non-empty" projection is reimplemented inline and as a one-off closure (`runtime.ts:476`) even though `readOptionalNonEmptyStringField` in `common.ts:177` already encodes exactly this.
- **Current → Suggested:** replace the `stringField` closure in `parseTerminateRuntimeRequest` and the inline projections with `readOptionalNonEmptyStringField` (already imported in several files). Note: `parseTerminateRuntimeRequest`'s closure does NOT enforce non-empty (it allows `''`) and does NOT trim — verify whether callers rely on empty-string `reason`/`source`/`actor` passing through before swapping; if they do, this is a behavior change and must be deferred.
- **Direction:** DE-duplicate → reuse existing abstraction (collapse one-off closure).
- **Preservation:** char-test < test-suite. Because the closure's empty-string/trim semantics differ subtly from `readOptionalNonEmptyStringField`, a characterization test on `parseTerminateRuntimeRequest({runtimeId:'r', reason:'  x  '})` is mandatory to pin current output (`reason: '  x  '` today vs `reason: 'x'` after).
- **Falsifiable signal:** closure removed; behavior test green only if semantics match — otherwise the test exposes the divergence and the item is correctly DEFERRED.
- **Risk:** Med (semantic drift on trim/empty). **API-impact:** internal-only. **Effort:** S.
- **Tests:** characterize reason/source/actor whitespace handling first.
- **Contraindication:** the trim/empty difference is load-bearing IF a consumer distinguishes `''` from absent — do not blindly collapse.

### F3 — [T23] Remove middle man: thin pass-through parser wrappers
- **Location:** `runtime.ts:281-283` `parseStartRuntimeRequest` (→ `parseEnsureRuntimeRequest`), `runtime.ts:500-502` `parseInspectRuntimeRequest` (→ `parseRuntimeActionBody`), `runtime.ts:548-550` `parseAttachRuntimeRequest` (→ `parseRuntimeActionBody`).
- **Mechanism repaired:** indirection with no added validation — three exported names alias one body.
- **Current → Suggested:** **KEEP, do not collapse.** Each returns a *distinct DTO type* (`StartRuntimeRequest`, `InspectRuntimeRequest`, `AttachRuntimeRequest`) and is a named seam in the route table; the type identity is the value. This is a where-NOT. Listed here only to record it was pressure-tested and rejected.
- **Direction:** n/a (rejected).
- **Risk:** n/a. **Contraindication:** the alias carries semantic/type intent — collapsing would erase the type distinction and force call sites to cast.

### F4 — [T15] Extract missing abstraction: query-string "include-if-present" projection in list filters
- **Location:** `runtime.ts:85-97` (`parseListRuntimesFilter`) and `runtime.ts:107-116` (`parseListRunsFilter`) — repeated `...(normalizeOptionalQuery(url.searchParams.get('x')) ? { x: normalizeOptionalQuery(url.searchParams.get('x')) } : {})`, which calls `normalizeOptionalQuery` **twice** per field.
- **Mechanism repaired:** duplicated double-evaluation projection; primitive obsession on the `(searchParams, key) -> optional field` step.
- **Current → Suggested:** add `pickOptionalQuery(url, key): Record<string,string>` to `common.ts` returning `{}` or `{[key]: normalized}` (mirrors the existing `readOptionalStringField` body shape). Replaces the double-call with one evaluation.
- **Direction:** DE-duplicate → extract.
- **Preservation:** type/compiler-proof (same field set) + char-test on a URL with mixed present/absent params.
- **Falsifiable signal:** each `searchParams.get('hostSessionId')` appears once not twice; filter output identical for `?hostSessionId=a&scope=` (scope dropped).
- **Risk:** Low. **API-impact:** internal-only. **Effort:** S.
- **Contraindication:** none — pure projection equivalence.

### F5 — [T19] Conditional → table: enum-membership validation repeated as `!== 'a' && !== 'b' && …` chains
- **Location:** `runtime.ts:62-73` & `sweeps.ts:17-28` (transport: tmux/headless/sdk — **identical** check duplicated across files), `runtime.ts:129-135` (provider anthropic/openai), `runtime.ts:256-262, 273-279`(app) (restartStyle reuse_pty/fresh_pty — duplicated), `app-sessions.ts:98-109` (launchMode), `app-sessions.ts:194-200` (spec.kind).
- **Mechanism repaired:** open-coded set-membership test; the allowed-value set is implicit in a boolean chain rather than data.
- **Current → Suggested:** add a generic `requireOneOf(value, allowed: readonly string[], field, message?)` (or `parseEnumField`) to `common.ts`; the two transport copies and two restartStyle copies collapse to one call each. Keeps the exact message strings as the `message` arg.
- **Direction:** DE-duplicate → extract + conditional→dispatch.
- **Preservation:** char-test on each enum's reject path (message + code) < type-proof.
- **Falsifiable signal:** transport validation defined once; `parseSweepRuntimesRequest({transport:'ssh'})` and `parseListRuntimesFilter(?transport=ssh)` both still throw `transport must be one of: tmux, headless, sdk`.
- **Risk:** Low. **API-impact:** internal-only. **Effort:** M.
- **Contraindication:** **biome `useLiteralKeys`/narrowing** — after `requireOneOf`, TS won't narrow `value` to the union literal automatically; you'll need `requireOneOf<T extends string>(...): T` with an `as const` tuple to preserve the literal type the DTO expects, or a cast. Verify no `useValidTypeof`-style lint regression and that downstream `transport: transport` still type-checks without `as`.

### F6 — [T22] Guard clauses / collapse nested IIFE in `parseRuntimeIntent`
- **Location:** `runtime.ts:126-155` — the `resolvedHarness` ternary wraps a multi-statement IIFE `(() => { … })()` inside `isRecord(harness) ? … : resolveHarnessFromPlacement(...)`.
- **Mechanism repaired:** expression-position control flow (IIFE) used to host statements; harms readability and stack traces.
- **Current → Suggested:** extract `parseInlineHarness(harness): HrcRuntimeIntent['harness']` as a named function; `resolvedHarness = isRecord(harness) ? parseInlineHarness(harness) : resolveHarnessFromPlacement(placement, execution)`.
- **Direction:** restructure (flatten); also raises cohesion (sibling of `resolveHarnessFromPlacement`).
- **Preservation:** test-suite — `server-parsers.runtime-intent.test.ts` already exercises this path; type-proof on return shape.
- **Falsifiable signal:** IIFE gone; existing runtime-intent test stays green; same fields emitted (provider/interactive/id/fallback/model/yolo conditional spread preserved exactly).
- **Risk:** Low. **API-impact:** internal-only. **Effort:** S.
- **Contraindication:** none.

### F7 — [T15] Magic duration multiplier ladder
- **Location:** `common.ts:89-98` — nested ternary mapping unit→multiplier.
- **Mechanism repaired:** magic-number ladder; the unit table is implicit.
- **Current → Suggested:** replace with a `const UNIT_MS: Record<'ms'|'s'|'m'|'h'|'d', number> = {...}` lookup; `durationMs = amount * UNIT_MS[unit]`.
- **Direction:** extract (de-magic).
- **Preservation:** char-test: `parseDurationMs('2h') === 7_200_000`, `'30m'`, `'1d'`.
- **Falsifiable signal:** ternary gone, table present, identical numeric outputs.
- **Risk:** Low. **API-impact:** internal-only. **Effort:** S.
- **Contraindication:** none — the regex `(ms|s|m|h|d)` already guarantees `unit` is a key, so the lookup is total.

### F8 — [T15] Extract missing abstraction: "selector is required + parse" preamble
- **Location:** `app-sessions.ts:249-255, 302-308, 341-347, 374-379, 409-415, 429-435` — six functions repeat `const selectorRaw = input['selector']; if (selectorRaw === undefined) throw … 'selector is required'; parseAppSessionSelector(selectorRaw)`. (Two others — `parseInterruptAppSessionRequest:456`, `parseTerminateAppSessionRequest:467` — instead call `parseAppSessionSelector(input['selector'])` directly, an **inconsistency**.)
- **Mechanism repaired:** duplicated required-field-then-parse intent + inconsistent missing-selector error (six throw `selector is required` from `MALFORMED_REQUEST`; the other two fall through to `parseAppSessionSelector`'s `'selector must be an object'`).
- **Current → Suggested:** `requireSelector(input): {appId; appSessionKey}` that does the undefined-check + `parseAppSessionSelector`. Adopt in all eight for one consistent error.
- **Direction:** DE-duplicate → extract; also [T17] partial→total (unifies the two divergent missing-selector behaviors).
- **Preservation:** char-test BEFORE — the two direct-call sites (interrupt/terminate) currently emit a *different* message for a missing selector, so unifying is a **behavior change** on that error string. Pin both messages first; if any consumer asserts on `'selector must be an object'` for interrupt, this becomes DEFERRED.
- **Falsifiable signal:** one `requireSelector` definition; missing-selector error string consistent across all eight endpoints.
- **Risk:** Med (error-string unification across two endpoints). **API-impact:** internal-only (error message is observable to clients but not a typed contract). **Effort:** M.
- **Contraindication:** if external clients/tests branch on the exact `selector is required` vs `selector must be an object` text, the divergence is load-bearing — keep separate or align deliberately.

## 🪶 Deliberately left alone (where-NOT)
- **F3 thin wrappers** — type-identity seams, keep.
- **`parseRuntimeIntent` not re-exported via barrel** — correct narrowing.
- **`parseDispatchAppHarnessTurnRequest` fence/fences dual-write** (`app-sessions.ts:325-329`) — the `{ fence: x, fences: x }` canonical+legacy mirror is a deliberate back-compat shim; collapsing it would drop a wire field. Leave.
- **`parseEnsureRuntimeRequest` returns `restartStyle` un-spread** (`runtime.ts:276`, always present even when `undefined`) vs the conditional-spread style elsewhere — looks inconsistent but the DTO type allows `restartStyle?` and downstream tolerates explicit-undefined; changing it risks altering `Object.hasOwn` behavior. Low value, leave unless a consumer enumerates keys.
- **Per-file local `isRecord` re-imports** — fine; `common.ts` is the single source.
- **`messages.ts` `parseSessionRef` string-split parsing** — small, total, well-guarded; no abstraction needed.

## 🔭 If applying: outside-in sequence
1. **[T40] Make-safe first.** Only `server-parsers.runtime-intent.test.ts` exists (11 cases, runtime-intent only). Add characterization tests covering: each optional-boolean field reject path (F1), terminate reason/source/actor whitespace (F2), list-filter present/absent projection (F4), each enum reject message (F5), duration units (F7), and the two divergent missing-selector messages (F8). This gates everything.
2. F7 (duration table) — smallest, self-contained, total.
3. F4 (query projection helper) — isolated to two functions.
4. F6 (flatten harness IIFE) — covered by existing test.
5. F1 (optional-boolean reader) — broadest dedup, big line win, after its char-tests land.
6. F5 (`requireOneOf`) — watch the literal-narrowing/biome lint (F5 contraindication).
7. F2 + F8 — **only if** char-tests prove no semantic/error-string drift; otherwise DEFER.

## ✅ Safety checklist
- [ ] Characterization tests added on the public surface BEFORE any edit (currently runtime-intent only).
- [ ] Every extracted helper reproduces the exact `HrcErrorCode` + message string + detail `{field}` payload.
- [ ] Conditional-spread projections preserve the exact emitted field set (no new/dropped keys, explicit-undefined unchanged).
- [ ] F5 literal-type narrowing preserved (generic + `as const`), no biome lint regression.
- [ ] F2 / F8 deferred unless char-tests confirm identical trim/empty + error-string behavior.
- [ ] Full `hrc-server` build/typecheck/test green; no change to `server-parsers.ts` barrel surface.
