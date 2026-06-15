# 🔧 Refactoring Analysis — packages/hrc-server/src/launch

**Target:** `packages/hrc-server/src/launch` (general profile) · **Files read:** 8/8 (all non-test `.ts`, recursive) · **Lines:** 476 · **Package type:** internal module (in-monorepo only; no external npm consumers — barrel + direct file imports both inside `hrc-server`).

## 🧭 Summary
Small, well-factored module (8 cohesive files, each one concern). The big finding is at the **boundary, not the internals**: the `index.ts` barrel is *both leaky and stale* — it omits two symbol families that external siblings actually import by deep path (`env.ts`, `codex-otel.ts`), and it re-exports a spool-replay surface (`replaySpoolEntries` + 2 types) that has **zero production consumers** because `replay-spool.ts` reimplemented replay against the DB. Internals are clean; the only material internal item is a benign multi-writer seq allocation in `spoolCallback` (already handled correctly via `wx`).

## 🚪 Public boundary (assess first)

**Exported surface (`index.ts`):** `readLaunchArtifact`, `writeLaunchArtifact`, `postCallback`, `readSpoolEntries`, `replaySpoolEntries`, `spoolCallback`, `buildHookEnvelope` + types `SpoolEntry`, `SpoolPostCallback`, `SpoolReplayResult`, `HookEnvelope`, `HookEnvelopeEnv`.

**Actual usage (verified via grep, non-test):**
- Barrel consumers: `replay-spool.ts` → `readSpoolEntries` only; `launch-lifecycle-handlers.ts` + `otel-ingest.ts` → `readLaunchArtifact`.
- Deep-path consumers that **bypass the barrel**: `tmux.ts` imports `sanitizeTmuxServerPath`, `sanitizeTmuxClientEnv`, `listInheritedEnvKeysToScrub` directly from `./launch/env.js`. `injectCodexOtelConfig` (codex-otel.ts) has callers elsewhere in hrc-server, never via the barrel.
- `hook-cli.ts` (an internal CLI entrypoint, not re-exported) uses `postCallback`, `buildHookEnvelope`, `spoolCallback`.
- **No production caller** of `replaySpoolEntries`, `spoolCallback` (outside hook-cli), `postCallback` (outside hook-cli), `writeLaunchArtifact` (outside tests), or the `SpoolPostCallback`/`SpoolReplayResult` types. They survive only in `__tests__/launch.test.ts`.

**T07 (align interface to usage) — leaky barrel:** The barrel under-exports the env/otel helpers that siblings genuinely need (they reach past it), and over-exports the replay-spool surface nobody calls. This is the textbook "narrow the fat / widen the leaky" mismatch.

**M02 (expand/contract):** Because there are no out-of-repo consumers, contract changes are a same-repo edit + grep, not a deprecation cycle. Still public-*surface* relative to this module, so DEFERRED.

**Verdict:** 🟡 — boundary is sound mechanically (no broken contracts) but mis-aligned: stale exports + bypassed barrel. Worth a deliberate human realignment, not an auto-apply.

## 🎯 Findings by mechanism (outside-in, highest impact first)

### F1 — Stale/over-wide barrel export of unused replay surface · [T07] align interface to usage · [T16] collapse premature abstraction
- **Location:** `index.ts:5-6` (`export { … replaySpoolEntries, spoolCallback }`, `export type { … SpoolPostCallback, SpoolReplayResult }`); impl `spool.ts:83-114` (`replaySpoolEntries`), `spool.ts:134-154` (`parseReplayPayload`), `spool.ts:12-22` (the two types).
- **Mechanism repaired:** dead public surface — an in-module abstraction (callback-replay) whose variation never materialized because `replay-spool.ts` owns replay against the DB.
- **Symptom:** `replaySpoolEntries` + `SpoolPostCallback` + `SpoolReplayResult` + `parseReplayPayload` are referenced **only** by `__tests__/launch.test.ts`. Two parallel replay paths exist; production uses the other.
- **Current → Suggested:** Remove `replaySpoolEntries`/`parseReplayPayload`/`SpoolPostCallback`/`SpoolReplayResult` (and their barrel lines), or — if kept as a deliberate spare — keep but stop re-exporting via the barrel. Confirm with the spool.test author whether the test is characterizing intended capability before deleting.
- **Direction:** DE-abstraction (remove).
- **Preservation:** type/compiler-proof — once removed, `tsc` + the (then-updated) test suite prove no production caller. Behavior of the live replay path (`replay-spool.ts`) is untouched.
- **Falsifiable signal:** repo build + full hrc-server test green after deletion; `grep -rn replaySpoolEntries packages --include='*.ts'` returns only the deletion site.
- **Risk:** Med · **API-impact:** public-surface (module barrel) · **Effort:** S
- **Contraindication:** if `replaySpoolEntries` is an intentionally-spared "socket replay" fallback (vs the DB replay), the test is the option-holder — do not delete; instead narrow the barrel only. Human call required → DEFERRED.

### F2 — Barrel omits env/otel helpers that siblings deep-import · [T07] widen leaky interface
- **Location:** `index.ts` (missing exports); bypass sites `tmux.ts:5-8` (`from './launch/env.js'`) and `codex-otel.ts` callers.
- **Mechanism repaired:** boundary leak — consumers reach past the declared interface into file internals, so the barrel no longer represents the module's real contract.
- **Symptom:** `env.ts` (5 exported fns) and `codex-otel.ts` (`injectCodexOtelConfig`) are part of the module's de-facto API but absent from `index.ts`; callers import by relative file path.
- **Current → Suggested:** Either (a) add `env`/`codex-otel` exports to the barrel and migrate `tmux.ts` + otel caller to the barrel, or (b) make a *deliberate* decision that `index.ts` is the "launch-artifact/callback/hook" surface and env/otel are a separate concern — then leave deep imports as the documented pattern. Pick one consistent rule.
- **Direction:** widen (or formalize the split).
- **Preservation:** test-suite — pure import-path move, no runtime change; `tsc` + tests prove it.
- **Falsifiable signal:** after migration, no non-test file outside `launch/` imports `./launch/<file>.js` except `index.js`.
- **Risk:** Low · **API-impact:** public-surface (changes the module's declared surface) · **Effort:** S
- **Contraindication:** the deep imports may be intentional cohesion (env helpers "belong" to tmux's domain). Choosing direction is a judgment → DEFERRED.

### F3 — Duplicated `.json` seq parse + EEXIST helper inlined twice · [T15] extract missing abstraction (minor)
- **Location:** `spool.ts:64-68` and `spool.ts:124-127` — identical `filter(endsWith '.json') → parseInt(replace('.json','')) → !isNaN` pipeline appears in both `readSpoolEntries` and `readExistingSeqs`.
- **Mechanism repaired:** duplicated intent (seq-filename parsing) — two copies of "turn a spool dir listing into sorted numeric seqs."
- **Symptom:** the same filename→seq decode logic is written twice; a change to the `%06d.json` naming scheme must be edited in two places (and `spoolCallback:37` pads it in a third).
- **Current → Suggested:** extract `parseSeqFromFilename(file): number | null` and/or `listSeqFiles(dir): {file, seq}[]`; reuse in both readers. Keep the `padStart(6,'0')` formatting alongside as `seqFilename(seq)`.
- **Direction:** extract (small).
- **Preservation:** char-test — `readSpoolEntries`/`spoolCallback` already have coverage in `launch.test.ts`; extraction is behavior-identical.
- **Falsifiable signal:** tests green; one definition of the `.json` seq convention.
- **Risk:** Low · **API-impact:** internal-only · **Effort:** S
- **Contraindication:** the two copies are tiny (3-4 lines); over-extraction could add an indirection for marginal gain. Borderline — apply only if the seq-naming convention is considered an invariant worth centralizing.

### F4 — `shouldScrubInheritedEnvKey` uses a contorted `Set.has` cast · [T22]/[T15] clarity (micro)
- **Location:** `env.ts:14-16` — `SCRUB_EXACT_KEYS.has(key as typeof SCRUB_EXACT_KEYS extends Set<infer T> ? T : never)`.
- **Mechanism repaired:** none structurally; this is a type-noise smell. The conditional-type cast exists only because `Set<'A'|'B'>.has` is typed to accept only members. A `Set<string>` typing of `SCRUB_EXACT_KEYS` (keeping `as const` for the literal list elsewhere if needed) removes the cast entirely.
- **Symptom:** unreadable inline conditional type for a plain membership check.
- **Current → Suggested:** declare `const SCRUB_EXACT_KEYS: ReadonlySet<string> = new Set([...])`, then `SCRUB_EXACT_KEYS.has(key)`.
- **Direction:** simplify.
- **Preservation:** type/compiler-proof — membership semantics unchanged; `listInheritedEnvKeysToScrub` already seeds a `Set<string>` from it, so widening the element type is compatible.
- **Falsifiable signal:** `tsc` green, `launch-env.test.ts` green, cast gone.
- **Risk:** Low · **API-impact:** internal-only · **Effort:** XS
- **Contraindication:** widening to `string` loses the literal-union narrowing on `.has` arg, but that narrowing has no caller value here (input is an arbitrary env key). None material.

### F5 — `spoolCallback` seq allocation: check-then-act under concurrent writers · [T32] make check-then-act atomic (already mitigated — note only)
- **Location:** `spool.ts:32-52` — reads existing max seq, then loops `writeFile(flag:'wx')`, incrementing on `EEXIST`.
- **Mechanism repaired:** N/A — this is the *correct* pattern. The `wx` (exclusive-create) flag + retry-on-EEXIST already makes the allocate-write atomic against concurrent hook processes spooling to the same `launchId`. Recording it so a future reader does not "simplify" it into a TOCTOU bug.
- **Symptom:** none — flagged because the shape (read-max → write) superficially looks racy.
- **Current → Suggested:** leave as-is. Optionally add a one-line comment that `wx` is load-bearing for multi-writer safety.
- **Direction:** keep.
- **Preservation:** observational — concurrent hook spool is the real scenario; current code is correct.
- **Falsifiable signal:** a concurrency test (two `spoolCallback` calls in parallel) yields two distinct files, no overwrite — likely already implicit in `launch.test.ts`.
- **Risk:** Low (no change) · **API-impact:** internal-only · **Effort:** none
- **Contraindication:** do NOT replace the loop with a precomputed `nextSeq` write — that would reintroduce the race.

## 🪶 Deliberately left alone (where-NOT)
- **`callback-client.ts` (`postCallback`)** — clean Promise-wrapping of `http.request` over a unix socket; the `resolve(false)` on error is the intended "spool-on-failure" contract, not a swallowed catch. No change.
- **`hook.ts` (`buildHookEnvelope`)** — pure projection; preserves exact field set. No spread-refactor temptation here.
- **`launch-artifact.ts` validation ladder** — the `REQUIRED_FIELDS` loop + per-type checks (`launchId` string, `generation` number, `argv` non-empty array) read as a hand-rolled schema. Tempting [T13] "push invariant into a constraint" (zod/valibot), but that is a **redesign** (changes error messages/behavior + adds a dep) and the file is the trust boundary for an external artifact — intentionally explicit. Left alone.
- **`hook-cli.ts` env-var validation** — the missing-env guard and `exit(1)` codes are a CLI contract observed by the launcher; restructuring error handling here would change observable exit behavior. Left alone.
- **`codex-otel.ts` TOML merge** — the `isTomlTable` guards + shallow-clone merge are correct defensive parsing of untrusted on-disk config; the hardcoded `'hrc'`/`'none'`/`'json'` literals are config values, not magic numbers. Left alone.
- **`spool.ts` `parseReplayPayload` error messages** — distinct, path-annotated throws; good [T18] already. (Subject to F1 deletion, not improvement.)

## 🔭 If applying: outside-in sequence
1. **F5** — add the load-bearing comment only (zero risk), prevents a future regression.
2. **F4** — drop the conditional-type cast in `env.ts` (XS, compiler-proof). AUTO-APPLICABLE.
3. **F3** — extract `parseSeqFromFilename`/`seqFilename` in `spool.ts` (S, char-tested). AUTO-APPLICABLE (borderline — apply only if centralizing the naming convention is wanted).
4. **F2** (human decision) — pick barrel-widen vs documented-split, then migrate `tmux.ts`/otel caller.
5. **F1** (human decision) — confirm with spool-test intent, then delete the unused replay surface and narrow the barrel.

## ✅ Safety checklist
- [ ] `bun run build` / `tsc` green for hrc-server.
- [ ] Full `hrc-server` test suite green (`launch.test.ts`, `launch-env.test.ts`, `launch-hook-cli.test.ts`), `TMPDIR=/tmp`.
- [ ] `grep` confirms no non-test caller of any symbol slated for removal (F1) before deleting.
- [ ] After F2/F4 import changes: no non-test file outside `launch/` deep-imports `./launch/<file>.js` (or the split is documented).
- [ ] F5: no edit to the `wx`+retry loop logic.
