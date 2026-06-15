# 🔧 Refactoring Analysis — packages/hrc-frame-render/src

**Target:** `packages/hrc-frame-render/src` (profile: general) · **Files read:** 5/5 source (index.ts, types.ts, logger.ts, session-events-manager.ts, hrc-event-adapter.ts) + both test files scanned · **Lines:** 1566 source · **Package type:** near-leaf library, ONE in-repo consumer (`hrcchat-cli`)

## 🧭 Summary

The package folds gateway/HRC session events into a per-run projection (`RunState`) and renders frames (`RenderFrame`). It is well-structured: immutable-ish reducer, derived-tuple metadata-event type, decent characterization tests in `tests/`. The central risk is `processEvent` (a 460-line `noExcessiveCognitiveComplexity`-suppressed switch with subtle assistant-segment state). The biggest *mechanism* opportunities are de-abstraction: a wide exported surface (sink metadata, second callback, several helper exports, all `Gateway*` event types) that has **no in-repo consumer**, plus the implicit assistant-segment state machine that the `upsertAssistantSegment` mode-flags reify by accident.

## 🚪 Public boundary (assess first)

`index.ts` re-exports: `adaptHrcLifecycleEvent`, `canonicalSessionRefFromEvent`, `hrcLifecycleEventToSessionEnvelope` (alias), `HrcLifecycleEventPayload`; `createLogger`; `SessionEventsManager`, `runStateToFrame`, `AssistantSegment`, `OnRenderCallback`, `OnRunQueuedCallback`, `RunState`; plus ~17 type exports (`Gateway*Event`, `RenderFrame/Block/Action`, `PermissionAction`, `RunId`, `ProjectId`, `SessionEventEnvelope`).

**Actual in-repo usage (`hrcchat-cli` only):** `SessionEventsManager` (constructor with 2-arg `onRender`, `.subscribe`, `.receive`), `adaptHrcLifecycleEvent`, and the types `RenderFrame`, `RenderBlock`, `RenderAction`, `SessionEventEnvelope`. That's it.

**Unconsumed in-repo:** `runStateToFrame` (used internally; exported but no external caller), `canonicalSessionRefFromEvent`, `hrcLifecycleEventToSessionEnvelope` alias, `OnRunQueuedCallback` + the manager's `onRunQueued` ctor param, `SessionEventsManager.setSinkMetadata` + `getRunState`, the `RunState.sinkMetadata` field, the 5th `run` arg of `OnRenderCallback`, and every `Gateway*Event` type plus `PermissionAction`/`RunId`/`ProjectId`.

The doc comments (`sinkMetadata`, `deriveProjectId`) name **gateway-discord** as the intended consumer, but no such package exists in this repo. So this surface is either (a) genuinely public API for an out-of-repo/future consumer, or (b) speculative generality. **Contraindication is real:** removing a published export is an M02 contract break and may strand an external sink. Treat all surface-narrowing as DEFERRED/public — do not auto-apply.

- **[T07] narrow leaky boundary — `onRender` 5th arg `run: RunState`** (`session-events-manager.ts:791-797`): consumer ignores it (`(_sessionRef, _projectId, _runId, frame) =>`). Exposes the full mutable internal `RunState` to every sink. DEFERRED (public-surface). 
- **[T16] collapse speculative generality — sink metadata + 2nd callback + helper exports**: `setSinkMetadata`/`getRunState`/`sinkMetadata`/`onRunQueued`/`canonicalSessionRefFromEvent`/`hrcLifecycleEventToSessionEnvelope` have zero in-repo callers. DEFERRED (public-surface; requires confirming no external consumer).

**Verdict: 🟡** — internals are healthy and safe to churn; the boundary is wider than its single consumer and several constructs are unexercised, but they may serve an out-of-repo sink, so narrowing is deferred to a human.

## 🎯 Findings by mechanism (outside-in, highest impact first)

### F1 — [T10] Reify the implicit assistant-segment state machine
- **Location:** `session-events-manager.ts:181-230` (`upsertAssistantSegment`) consumed by `message_start/update/end`, `turn_end`, `run_completed` (lines 289-439).
- **Mechanism repaired:** implicit state machine. The "active segment vs. current message ref vs. id-keyed segment" lifecycle is encoded across four boolean-ish dimensions (`mode: append|replace|set`, `close`, `rawId !== undefined`, `activeAssistantSegmentId`). The transitions live as ad-hoc `findIndex` branches duplicated in `message_update` (lines 387-389, 405-407) and the `upsert` helper.
- **Symptom:** `noExcessiveCognitiveComplexity` suppression on `processEvent`; the segment branches are the bulk of it.
- **Current→Suggested:** extract a small `AssistantSegmentBuffer` with named transitions (`startMessage(ref)`, `appendDelta(ref?, text)`, `replaceBody(ref?, text)`, `closeActive()`) owning `assistantSegments` + `activeAssistantSegmentId` + `currentAssistantMessageRef`. `processEvent` calls intent-named methods instead of passing mode/close flags.
- **Direction:** extract missing abstraction (toward structure — but it *replaces* the flag-bag, not adds to it).
- **Preservation:** test-suite (the two existing suites + `hrcchat-cli/render-frame.test.ts` cover start/update/end/turn_end ordering); ideally add char-tests first.
- **Falsifiable signal:** `processEvent` drops below the complexity threshold and the `biome-ignore` on line 141 can be removed; segment tests stay green.
- **Risk:** Med · **API-impact:** internal-only · **Effort:** M
- **Tests:** existing segment-ordering tests; add a focused buffer unit test.
- **Contraindication:** the four call-sites have *subtly* different `targetRef ?? currentAssistantMessageRef` fallbacks (lines 338, 378); the extraction must preserve each, not unify them prematurely.

### F2 — [T15] Extract the duplicated "merge new-or-keep-existing tool payload" intent
- **Location:** `session-events-manager.ts:514-547` (`tool_execution_end`).
- **Mechanism repaired:** missing abstraction / duplicated intent. The `finalOutput`/`finalImages`/`finalMediaRefs` "prefer new else keep existing" computation (lines 519-521) plus the two near-identical object-spreads (the `toolIndex >= 0` update vs. the `else` push, lines 523-547) restate one merge rule twice.
- **Symptom:** parallel triplets `output||existing`, `images.length? : existing`, `mediaRefs.length? : existing`; copy-pasted push/update shapes.
- **Current→Suggested:** a local `mergeToolResult(existing | undefined, {status, output, images, mediaRefs})` returning the finished `ToolExecution`; both arms call it.
- **Direction:** extract (toward structure, dedup).
- **Preservation:** char-test (the existing manager test exercises tool start→end). 
- **Falsifiable signal:** the two spread blocks collapse to one return; tool-result tests green.
- **Risk:** Low · **API-impact:** internal-only · **Effort:** S
- **Tests:** existing tool-execution test cases.
- **Contraindication:** the `images.length > 0 ? images : existingImages` keeps a *present-but-empty* prior array distinct from undefined — preserve exact truthiness, don't coalesce with `??`.

### F3 — [T22] Guard-clause the per-case `if (!runId) break` prologue
- **Location:** `session-events-manager.ts` — repeated at lines 290-292, 330-332, 372-374, 416-418, 442-444, 478-480, 580-582 (seven cases).
- **Mechanism repaired:** flatten nesting / dedup of the run-context precondition. Every context-run event opens with the same 3-line guard + `getOrCreateRun(runId)` + `run.lastSeq = seq`.
- **Symptom:** seven identical 5-line preambles inside the switch.
- **Current→Suggested:** since `getAffectedRunId` (lines 940-956) *already* classifies which events carry their own `runId` vs. context `runId`, resolve the effective `runId` once before the switch and skip the case if absent — or pass the resolved `run` into per-event handler functions. Lightest version: hoist `if (!runId) return newState` for the context-run group.
- **Direction:** collapse (toward less nesting).
- **Preservation:** test-suite; behavior identical because every guarded case currently `break`s (no state mutation) when `runId` is absent.
- **Falsifiable signal:** seven guards become one; switch arms shrink; all tests green.
- **Risk:** Med (touches the central reducer) · **API-impact:** internal-only · **Effort:** M
- **Tests:** both manager suites + consumer render-frame suite.
- **Contraindication:** `getAffectedRunId` and `processEvent` must agree on the event→runId mapping; don't let the hoist diverge from the dispatcher classification. Best done *with* F1 (per-event handler functions) rather than before it.

### F4 — [T17] Make `STATUS_TO_PHASE` total at the type level instead of relying on the `Record` literal
- **Location:** `session-events-manager.ts:604-619` (`STATUS_TO_PHASE`, `PHASE_EMOJI`).
- **Mechanism repaired:** partial→total via constraint. These are already `Record<RunState['status'], ...>` / `Record<RenderFrame['phase'], ...>`, so the compiler *already* enforces totality. **This is a where-NOT candidate confirmed: the smell is absent.** No action. (Recorded so a later pass doesn't "fix" it.)

### F5 — [T16] `hrcLifecycleEventToSessionEnvelope` alias is a pure pass-through
- **Location:** `hrc-event-adapter.ts:321` (`export const hrcLifecycleEventToSessionEnvelope = adaptHrcLifecycleEvent`).
- **Mechanism repaired:** remove middle man (T23) / collapse premature abstraction. Two exported names for one function; the alias has no in-repo caller.
- **Symptom:** duplicate public name.
- **Current→Suggested:** drop the alias (or, if kept for an external consumer, leave it). 
- **Direction:** de-abstract (remove).
- **Preservation:** type/compiler-proof (removal surfaces as a missing-export error if anything imports it).
- **Falsifiable signal:** build stays green after removal.
- **Risk:** Low (mechanically) but **API-impact: public-surface** → DEFERRED. A human must confirm no external import.
- **Effort:** S
- **Contraindication:** may be the *intended* stable name for gateway-discord; the canonical `adaptHrcLifecycleEvent` could be the one to deprecate instead.

### F6 — [T15] Hoist the repeated `getString`-on-record admission destructure
- **Location:** `hrc-event-adapter.ts:263-275` (the `input.` branch).
- **Mechanism repaired:** small missing abstraction / readability; low priority. The inline `isRecord(payload) ? payload : {}` then four `getString(pr, …)` calls mirror the `adaptToolCall`/`adaptToolResult` record-guard pattern.
- **Current→Suggested:** marginal; only worth it alongside a broader adapter pass. Could factor a `recordOrEmpty(payload)` helper used by all `adapt*` functions (lines 93, 113, 143, 199, 264).
- **Direction:** extract (minor).
- **Preservation:** char-test (adapter suite covers `input.*` → notice).
- **Falsifiable signal:** `isRecord(x) ? x : {}` appears once.
- **Risk:** Low · **API-impact:** internal-only · **Effort:** S
- **Contraindication:** the guards return *different* sentinels in different functions (`undefined` vs `{}`); a shared helper must not flatten that distinction.

### F7 — [T01] `createLogger` reads `process.env['LOG_LEVEL']` on every `write`
- **Location:** `logger.ts:17-26` (`thresholdFromEnv` called per `write`).
- **Mechanism repaired:** substitution seam / hidden global. The threshold is recomputed from `process.env` on every log line; there is no seam to inject a level for tests, and re-reading env per-call is both a hidden dependency and needless work.
- **Symptom:** singleton env read buried in the hot path.
- **Current→Suggested:** compute the threshold once at module/logger creation (or accept an optional `level` in `createLogger`'s arg object). 
- **Direction:** seam (toward injectability) + minor de-work.
- **Preservation:** observational/char-test; **behavior changes** for the (unlikely) case of `LOG_LEVEL` mutated mid-process — flag as a behavior-affecting nuance, so prefer the "read once at creation" form only if no test mutates env between calls.
- **Falsifiable signal:** env read happens once per logger; log output unchanged in tests.
- **Risk:** Low · **API-impact:** internal-only (the `createLogger` arg is exported; adding an *optional* field is additive) · **Effort:** S
- **Contraindication:** if any test sets `LOG_LEVEL` after constructing a logger and expects the change to take effect, caching breaks it — verify first. Given this nuance, treat as borderline; only auto-apply the no-arg cache if env-mutation tests are absent.

## 🪶 Deliberately left alone (where-NOT)

- **`STATUS_TO_PHASE` / `PHASE_EMOJI` (F4):** already `Record`-keyed on the source union → compiler-total. No partial-function smell.
- **`SESSION_METADATA_EVENT_TYPES` tuple → union derivation (`types.ts:143-162`):** exemplary [T15] already done; the comment explicitly prevents drift. Do not "simplify."
- **Magic numbers `TITLE_MAX_LEN`/`TOOL_SUMMARY_MAX_LEN`/`EMPTY_JSON_LEN` (`session-events-manager.ts:11-13`):** already named constants. Smell absent.
- **`isRecord` duplicated in two files:** load-bearing micro-helper; extracting to a shared module would couple two otherwise-independent files for 3 lines. Leave (dup is cheaper than coupling here).
- **Immutable-copy in `getOrCreateRun` (lines 150-175):** deliberate defensive cloning so the reducer doesn't mutate prior state shared with emitted frames. Do not "optimize away" the spreads.
- **The wide `Gateway*Event` type exports:** likely the real contract for an external sink (gateway-discord per the doc comments). Narrowing is M02 — left for a human with consumer knowledge.

## 🔭 If applying: outside-in sequence

1. **A [T40]:** add/confirm characterization tests on `SessionEventsManager.receive` → `RenderFrame` for the segment lifecycle and tool-merge paths (cover F1/F2/F3 before touching them). The consumer's `render-frame.test.ts` already gives partial coverage.
2. **F2** (tool-merge dedup) — smallest, lowest risk, internal.
3. **F6** (adapter record-guard) — internal, isolated.
4. **F7** (logger env cache) — only after confirming no env-mutation test.
5. **F1 + F3 together** (segment state machine + guard hoist) — the big internal win; do as one move since F3's per-event handlers fall out of F1's extraction.
6. **DEFERRED (human):** boundary narrowing (onRender 5th arg, sink metadata, onRunQueued, alias F5) — only after confirming there is no out-of-repo consumer; M02 expand/contract if proceeding.

## ✅ Safety checklist

- [ ] Char-tests green BEFORE F1/F3 (central reducer).
- [ ] F2: preserve `images.length>0 ? : existing` truthiness (not `??`).
- [ ] F1: preserve each call-site's distinct `targetRef` fallback (lines 338 vs 378).
- [ ] F3: keep `getAffectedRunId` classification in sync with the hoisted guard.
- [ ] F7: do not cache the env read if any test mutates `LOG_LEVEL` post-construction.
- [ ] No public export removed without confirming zero external consumers (F5 and all boundary items DEFERRED).
- [ ] Run `hrc-frame-render` suite + `hrcchat-cli/render-frame.test.ts` after each step.
