# 🔧 Refactoring Analysis — packages/hrc-cli/src

**Target:** packages/hrc-cli/src (analysis profile: general) · **Files read:** 29/29 (all non-test `.ts`) · **Lines:** ~8,950 · **Package type:** leaf CLI binary (`bin: hrc → src/cli.ts`), no `exports` map, no in-repo importers.

## 🧭 Summary
This is a recently-decomposed CLI (the big-file `index.ts` split is done; `cli.ts` re-exports a historical surface that the test-suite still imports). Structure is healthy: handlers are thin, the commander wiring is mechanical, and prior dedup passes already extracted `monitor-conditions.ts` / `monitor-fields.ts`. The remaining smells are concentrated in the hand-rolled `parseArgv` in `monitor-watch.ts` (duplicated flag-parsing intent vs `monitor-wait.ts`), a dead `_intent` parameter + a pure pass-through `attachOpenAiRuntime`, and the triple-encoded event-filter predicate (`buildEventFilter` / `deriveStoreFilters` / `isFilterActive`). No concurrency hazards beyond best-effort polling that is already correctly guarded.

## 🚪 Public boundary (assess first)
**API surface:** Two surfaces. (1) The user-facing CLI contract — verbs, flags, exit codes, stdout/stderr bytes — exercised end-to-end through `main()`. (2) A small re-export surface on `cli.ts` (`chooseDefaultProjectId`, `harnessStringToHarnessId`, `resolveAgentHarness`, `attachOpenAiRuntime`, `selectLatestUsableRuntime`, `explainScopeCommandError`, `main`). Grep confirms **no other package imports `hrc-cli`** (no `exports` map; `files: ["dist"]`), but the **test suite imports every one of these from `'../cli'`**, so the re-export surface is load-bearing *internally* and is NOT free to break.

**T07/M02 findings:** None warranted at the boundary. Because there are no cross-package consumers, M02 expand/contract does not apply (leaf package). The re-exports are deliberate test seams, not leaky internals — keep them. The dual-signature `cmdMonitorWatch(argv | args, deps)` is an intentional test seam (documented), not a fat interface to narrow.

**Verdict:** 🟢 — boundary is coherent and well-characterized; all proposed work is behind it.

## 🎯 Findings by mechanism (outside-in, highest impact first)

### F1 — Dead `_intent` parameter on `attachWithRetry` (partial→total / boundary narrowing)
- **Location:** `cli/runtime-select.ts:87-92` (param `_intent?: HrcRuntimeIntent`), caller `cli/handlers-scope-cmd.ts:607-612` passes `intent`.
- **Mechanism repaired:** [T07] align interface to actual usage — the parameter is accepted, named `_intent` (underscore = "unused"), and never read. The signature lies about what the function consumes.
- **Symptom:** Caller threads a constructed `intent` into a function that ignores it; a reader cannot tell whether attach is intent-sensitive.
- **Current→Suggested:** Drop the `_intent` param from `attachWithRetry`; drop the now-dead `intent` argument at the call site.
- **Direction:** DE-abstraction (remove unused surface).
- **Preservation:** type/compiler-proof — removing an unread param cannot change behavior; tsc + suite confirm.
- **Falsifiable signal:** suite still green; `attachWithRetry` arity drops by one with no behavioral diff.
- **Risk:** Low · **API-impact:** internal-only · **Effort:** XS · **Tests:** existing attach tests in `cli.test.ts`.
- **Contraindication:** `attachOpenAiRuntime` (see F2) also calls `attachWithRetry` without intent — confirm it is the only other caller before removing (it is). None.

### F2 — `attachOpenAiRuntime` is a pure pass-through middle-man (remove middle man)
- **Location:** `cli/runtime-select.ts:79-85`. Body is `return attachWithRetry(client, hostSessionId, runtime)`.
- **Mechanism repaired:** [T23] remove middle man / collapse pass-through. It adds no behavior over `attachWithRetry` and exists only on the re-export surface.
- **Symptom:** Two names for one operation; the OpenAI-specific name is misleading (it is provider-agnostic).
- **Current→Suggested:** Two options. (a) Inline at the only non-test caller — but there is none; it is exported via `cli.ts` and referenced **only** by `cli.test.ts`. So the honest move is to collapse the test onto `attachWithRetry` and delete `attachOpenAiRuntime` + its re-export. (b) If the name is wanted as a stable test seam, keep it but document it as an alias. Prefer (a).
- **Direction:** DE-abstraction.
- **Preservation:** test-suite (the test importing it must be updated in the same commit) — this is the one rung above char-test because a test references it.
- **Falsifiable signal:** suite green after the test is repointed; symbol count on `cli.ts` re-export block drops by one.
- **Risk:** Low · **API-impact:** internal-only (test-facing re-export) · **Effort:** XS.
- **Contraindication:** It IS on the documented re-export surface; because a test imports it, treat the edit as touching the (internal) public surface — bundle the test change. Marginal; defer-or-apply judgment call → I classify as auto-applicable since it is internal-only + behavior-preserving, but it edits a test.

### F3 — Hand-rolled `parseArgv` flag loop duplicates intent across two monitor commands (extract missing abstraction)
- **Location:** `monitor-watch.ts:716-906` (`parseArgv`, `matchStringFlag`, `parsePositiveInteger`, `parseNonNegativeInteger`) vs `monitor-wait.ts:105-163` (`parseWaitArgs`) — both re-implement `--until`/`--timeout`/`--stall-after` long-flag `=`/space parsing by hand; `cli/argv.ts` already has `parseFlag`.
- **Mechanism repaired:** [T15] extract missing abstraction for the shared "string flag with `--name value` and `--name=value`" parsing intent. The `matchStringFlag` helper in `monitor-watch.ts` is exactly the abstraction; `monitor-wait.ts` open-codes the same three cases.
- **Symptom:** The same `--until`/`--timeout`/`--stall-after` parse logic exists in two files with subtly different unknown-option handling; a new shared flag must be edited in two places.
- **Current→Suggested:** Lift `matchStringFlag` (+ the two integer parsers) into a shared private module (e.g. `monitor-args.ts` next to `monitor-conditions.ts`/`monitor-fields.ts`, the established pattern) and have `parseWaitArgs` consume it.
- **Direction:** extract (toward shared abstraction) — but conservative; do NOT also fold in `cli/argv.ts`'s `parseFlag` (different error model: `fatal()` vs `CliUsageError`).
- **Preservation:** char-test — the byte-for-byte error strings (`--until requires a value`, `unknown option: …`) are asserted by `monitor-wait.acceptance.test.ts`; keep messages identical.
- **Falsifiable signal:** both monitor suites green; one copy of the flag-matcher remains.
- **Risk:** Med (two error-model dialects; easy to converge them by accident) · **API-impact:** internal-only · **Effort:** S.
- **Contraindication:** The duplication is partly load-bearing — `monitor-wait` throws `CliUsageError`, `cli/argv.ts` calls `fatal()` (process.exit). Only unify the two that share the `CliUsageError` model; do not collapse into `argv.ts`.

### F4 — Event-filter predicate is encoded three times (extract missing abstraction / single source of truth)
- **Location:** `monitor-watch.ts` — `buildEventFilter` (993-1014, in-memory predicate), `deriveStoreFilters` (1020-1037, SQL filter), `isFilterActive` (951-958, boolean). All three independently re-derive "is `--kind`/`--tool`/`--grep`/`--milestone` set and what does each mean."
- **Mechanism repaired:** [T15] extract the filter *spec* once (a normalized `{milestone?, kinds?, tools?, grep?}` parsed from args) and derive the predicate, the store-filter, and the active-flag from that single object.
- **Symptom:** `args.grep !== '' ` vs `args.kind.trim() !== ''` activation rules are repeated and must stay in lockstep across three functions; a fourth filter dimension means editing three sites. The `milestone supersedes kind/tool/grep` rule lives in two of them.
- **Current→Suggested:** Introduce `normalizeEventFilterSpec(args) → FilterSpec | undefined`; have `isFilterActive` = `spec !== undefined`, `buildEventFilter` consume `spec`, `deriveStoreFilters` map `spec → HrcLifecycleMonitorFilters`.
- **Direction:** extract (introduce a parameter object / value type — borders on [T21]).
- **Preservation:** char-test — `monitor-watch` filtering is exercised by the T-04232 tests; the SQL-vs-in-memory parity is the documented invariant. Re-run the watch suite.
- **Falsifiable signal:** the three activation predicates collapse to one; T-04232 filter tests stay green.
- **Risk:** Med (parity between in-memory and SQL filter is a stated invariant; a refactor that drifts them is a regression) · **API-impact:** internal-only · **Effort:** S-M.
- **Contraindication:** The in-memory predicate is a *deliberate redundant guard* over already-narrowed live state (documented at 988-992). Preserve both consumers; only unify their *source*, not their existence.

### F5 — Two coexisting `fatal()` + `hasFlag()` definitions with different semantics (substitution seam clarity)
- **Location:** `runtime-args.ts:1-8` (`fatal` → `process.exit(1)`; `hasFlag`) vs `cli/shared.ts:10-12` (`fatal` → `throw new CliUsageError`) and `cli/argv.ts:31-33` (`hasFlag`).
- **Mechanism repaired:** [T16]/[T03] collapse/relocate — `runtime-args.ts` is a 8-line near-duplicate. `cli-runtime.ts` imports `fatal`/`hasFlag` from `runtime-args.js`; the rest of `cli/*` imports the throwing `fatal` from `shared.js`. The two `fatal`s are NOT interchangeable (one exits, one throws into the commander error handler).
- **Symptom:** Same-named helpers with divergent control-flow semantics in one package is a footgun — an edit that swaps the import silently changes whether a usage error is catchable.
- **Current→Suggested:** Do **not** merge the two `fatal`s (semantics differ — see contraindication). Instead, (a) rename `runtime-args.ts`'s `fatal` to `fatalExit` to make the process-exit semantics explicit, and (b) have `runtime-args.ts` re-use `hasFlag` from `cli/argv.ts` (identical `args.includes(flag)` body) to delete the duplicate.
- **Direction:** clarify + de-dup the identical half (`hasFlag`); keep the divergent half (`fatal`) but disambiguate the name.
- **Preservation:** type/compiler-proof for `hasFlag` (identical body); char-test for the rename (no behavior change).
- **Falsifiable signal:** one `hasFlag` definition remains; grep for `fatal` shows two distinct names with documented semantics.
- **Risk:** Low · **API-impact:** internal-only · **Effort:** XS.
- **Contraindication:** The two `fatal`s are load-bearing-different. `cli-runtime.ts` runs in daemon/launchctl paths where a hard `process.exit(1)` is correct; the `cli/*` throwing `fatal` must reach the commander handler. Merging them would break one path. Only de-dup `hasFlag`.

### F6 — Repeated CSV-split-and-trim idiom (extract missing abstraction)
- **Location:** `handlers-runtime.ts:42-46` (`--status` split), `handlers-runtime.ts:278-283` (sweep `--status` split); `monitor-watch.ts:943-948` already has `splitList`.
- **Mechanism repaired:** [T15] extract the `split(',').map(trim).filter(len>0)` clump into one shared `splitCsv` (the `splitList` in `monitor-watch.ts` is exactly it, privately).
- **Symptom:** The same comma-list normalization is inlined twice in `handlers-runtime.ts` and once (named) in monitor.
- **Current→Suggested:** Promote `splitList` to a shared `cli/argv.ts` (or `cli/shared.ts`) `splitCsv` and call it from the runtime handlers.
- **Direction:** extract.
- **Preservation:** type/compiler-proof (pure, identical body).
- **Falsifiable signal:** one CSV-split helper; `runtime list`/`runtime sweep` status filtering unchanged in tests.
- **Risk:** Low · **API-impact:** internal-only · **Effort:** XS.
- **Contraindication:** None. (Note: the bodies are byte-identical, so no biome `useValidTypeof`-style lint risk — this is a list op, not a `typeof` compare.)

### F7 — `printResultsNdjson` already shared, but three near-identical human formatters remain (low-priority, leave-mostly-alone)
- **Location:** `handlers-runtime.ts:313-419` (`printSweepHuman`, `printZombieSweepHuman`, `printReconcileActiveHuman`).
- **Mechanism repaired:** would be [T15], but the per-row columns and summary keys genuinely differ (matched/stale/terminated vs matched/zombied vs matched/reaped/suspect).
- **Symptom:** structural rhyme, not duplication.
- **Current→Suggested:** **Leave alone.** The shared `printResultsNdjson` already captured the one truly-identical path; the human formatters carry distinct, byte-asserted column layouts. Parameterizing them would trade three readable functions for one config-driven one with no net simplicity.
- **Direction:** none (de-abstraction not warranted, extraction not warranted).
- **Risk/Effort:** n/a.
- **Contraindication:** The differing summary fields are load-bearing output contract; a shared formatter would risk drift.

## 🪶 Deliberately left alone (where-NOT)
- **`cli.ts` re-export block** — looks like a leaky surface but is a deliberate, test-consumed seam (and documented as preserving the historical import surface). Keep.
- **Dual-signature `cmdMonitorWatch` / `MonitorWatchDeps`** — intentional dependency-injection test seam; not a fat interface.
- **`monitor-render.ts` renderer classes (Tree/Compact/Verbose/Json)** — a real dispatch over four output modes with four live instantiations via `createMonitorRenderer`; this is correct [T19] conditional→dispatch already done, not premature abstraction. Leave.
- **`toLegacyArgv` / `toLegacyArgvForScopeCommand` / `rawArgvForVerb`** — transitional commander→legacy glue, well-documented, with subtle negated-boolean handling that is load-bearing. Do not "simplify" without the full negation matrix.
- **`waitForAttachProcess` / `cmdSessionReport` polling loops** — best-effort retry against a documented reap-vs-reconcile race; the swallowed catches are intentional and annotated. Not [T18] candidates.
- **Three human sweep formatters (F7)** — distinct output contracts; parameterizing is a net loss.
- **The two `fatal` semantics** — divergence is intentional (process-exit vs throw); only the duplicate `hasFlag` is dedup-safe (F5).

## 🔭 If applying: outside-in sequence
1. F5 (de-dup `hasFlag`, rename `runtime-args.fatal`→`fatalExit`) — smallest, unblocks nothing but reduces footgun.
2. F1 (drop dead `_intent`) — compiler-proof, mechanical.
3. F2 (remove `attachOpenAiRuntime` middle-man, repoint its test).
4. F6 (shared `splitCsv`).
5. F3 (shared monitor flag-matcher) — char-test guarded, keep error bytes identical.
6. F4 (single filter-spec) — last, Med-risk, re-run T-04232 watch suite to prove SQL/in-memory parity.

## ✅ Safety checklist
- [ ] `bun test` green in `packages/hrc-cli` before and after each step (18 test files; they exercise `main()` end-to-end + the re-exports).
- [ ] `tsc --noEmit` clean (F1/F2 are compiler-provable).
- [ ] Error-message bytes unchanged for F3 (asserted by `monitor-wait.acceptance.test.ts`) and F4 (T-04232).
- [ ] F2 edits the importing test in the same commit (internal public-surface change).
- [ ] No biome lint regressions (F6 is a list op, not a `typeof` parameterization).
- [ ] Do NOT merge the two `fatal()`s (F5 contraindication) — only `hasFlag`.
