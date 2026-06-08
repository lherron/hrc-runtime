# Refactor Analysis — `hrc-frame-render`

**Package:** `packages/hrc-frame-render/src`
**Date:** 2026-06-07
**Scope:** Production source only (`tests/` excluded from production view; coverage gaps noted).
**Production lines analyzed:** ~1542 (session-events-manager.ts 941, hrc-event-adapter.ts 321, types.ts 185, logger.ts 61, index.ts 34).

## Overview

This package is a pure projection/adapter layer: it folds gateway/HRC session events into per-run state (`SessionEventsManager`) and renders that state into provider-neutral `RenderFrame`s (`runStateToFrame`). It is a `bun`-from-source library consumed by sinks (gateway-discord, terminal). The code is well-typed and free of obvious correctness smells, but it is dominated by one very large file with two oversized functions and a type-keyed dispatch chain that grows per event.

## SOLID Scorecard

| Principle | Grade | Notes |
|-----------|-------|-------|
| **S**RP | red | `session-events-manager.ts` is 941 lines mixing state-folding, frame rendering, formatting, and the event-manager class. `processEvent` (~490 lines) and `runStateToFrame` (~116 lines) each do many things. |
| **O**CP | yellow | Two parallel type-keyed `switch` chains (`processEvent`, `getAffectedRunId`) plus the adapter `switch` and `isSessionMetadataEvent` list all grow per new event type, in different files — no registry/table seam. |
| **L**SP | green | No inheritance/overrides; no `not implemented` throws or no-op overrides. N/A and clean. |
| **I**SP | green | Interfaces are small data shapes (`RunState`, `ProjectState`, callbacks). `RenderBlock` union has many variants but that is a discriminated data union, not a fat interface. |
| **D**IP | yellow | No `new Concrete()` of collaborators (callbacks are injected — good). But `Date.now()` is called directly in business logic (`processEvent` turn_end, `runStateToFrame`), `process.env` is read at call-time in the logger, and the module-level `log` singleton is created via direct `createLogger` import — no clock/log injection seam, which hurts deterministic testing. |

## Priority Refactorings

### 1. Decompose `processEvent` (per-event-type handlers)
- **Location:** `session-events-manager.ts:139-629` (~490-line function, flagged with a `biome-ignore noExcessiveCognitiveComplexity`).
- **Principle:** SRP + OCP.
- **Current:** A single `switch (event.type)` with 16 inline cases, plus four closures (`getOrCreateRun`, `closeActiveSegment`, `upsertAssistantSegment`, and the result-block parsing) defined inside it. The `tool_execution_end` case alone (lines 481-576) inlines a large ad-hoc `result`/`details.content` block-parsing loop with image/media_ref extraction.
- **Suggested:** Extract a `handlers` map keyed by event type, each handler `(ctx, run, event, seq) => void` operating on a cloned run. Hoist `upsertAssistantSegment`, `closeActiveSegment`, and `getOrCreateRun` to module-level pure helpers taking explicit state. Extract the tool-result content-block parsing (lines 489-546) into a standalone `parseToolResultBlocks(result)` function. This shrinks the dispatcher to a lookup and makes adding an event type an additive change (OCP).
- **Risk:** medium (behavior-dense; the immutability/clone semantics in `getOrCreateRun` must be preserved exactly).
- **Effort:** medium-high.
- **Tests:** `tests/session-events-manager.test.ts` (450 lines) covers many paths; extract handlers behind the same `processEvent` signature and keep the suite green. Add targeted tests for `parseToolResultBlocks` (image + media_ref + text mixing) since that logic is currently only exercised end-to-end.
- **apiPreserving:** true (internal; `processEvent` is not exported).

### 2. Split the file into modules
- **Location:** `session-events-manager.ts` (entire 941-line file).
- **Principle:** SRP.
- **Current:** One file holds: internal `ToolExecution`/`ProjectState` types, exported `RunState`/`AssistantSegment`, the event-fold (`processEvent` + helpers), the renderer (`runStateToFrame` + `titleFor` + `formatToolSummary`), and the `SessionEventsManager` class.
- **Suggested:** Split into `run-state.ts` (types + fold helpers + `processEvent`), `frame-renderer.ts` (`runStateToFrame`, `titleFor`, `formatToolSummary`), and `session-events-manager.ts` (the class only). Re-export through `index.ts` unchanged.
- **Risk:** low (move-only; the public surface is the barrel in `index.ts`).
- **Effort:** medium.
- **Tests:** existing suites continue to import from the package root / new module paths; no behavior change.
- **apiPreserving:** true (exports preserved via `index.ts`).

### 3. Extract `runStateToFrame` block-builders
- **Location:** `session-events-manager.ts:657-773` (~116-line function).
- **Principle:** SRP.
- **Current:** One function builds tool blocks, notice blocks, segment blocks, sorts/merges them, then appends permission-code blocks, a progress placeholder, media_ref blocks, and actions — six distinct concerns inline.
- **Suggested:** Extract `toolBlocks(run)`, `noticeBlocks(run)`, `segmentBlocks(run)`, `permissionBlock(run)`, `progressPlaceholder(run, phase)`, `mediaRefBlocks(run)` and have `runStateToFrame` compose them. Keeps the seq-sort/merge explicit and each builder unit-testable.
- **Risk:** low.
- **Effort:** low-medium.
- **Tests:** `tests/session-events-manager.test.ts` already asserts frame shapes; refactor under the same signature.
- **apiPreserving:** true (`runStateToFrame` signature unchanged).

### 4. Collapse phase mapping into a lookup table
- **Location:** `session-events-manager.ts:657-667` (status→phase ternary ladder) and `631-633` (phase→emoji ternary).
- **Principle:** OCP + readability.
- **Current:** Nested ternaries map `RunState.status` → `phase` and `phase` → emoji. Each new status/phase requires editing the ladder.
- **Suggested:** Two `const` record maps: `STATUS_TO_PHASE: Record<RunState['status'], RenderFrame['phase']>` and `PHASE_EMOJI: Record<RenderFrame['phase'], string>`. The compiler then enforces exhaustiveness when a status/phase is added.
- **Risk:** low.
- **Effort:** low (quick win).
- **Tests:** covered by existing frame-shape tests.
- **apiPreserving:** true.

### 5. Dedupe message-content flattening
- **Location:** `session-events-manager.ts:297-300` and `341-344` (identical `typeof message.content === 'string' ? ... : map(block => block.type==='text' ? block.text : '').join('')`).
- **Principle:** DRY.
- **Current:** The same string-or-block-array flattening is inlined twice in `message_start` and `message_end`; a near-identical variant (`extractTextContent`, lines 100-116) already exists.
- **Suggested:** Reuse/normalize a single `flattenMessageContent(content)` helper (reconcile with `extractTextContent`).
- **Risk:** low.
- **Effort:** low (quick win).
- **Tests:** existing message_start/message_end tests cover both call sites.
- **apiPreserving:** true.

### 6. Introduce a clock seam (DIP)
- **Location:** `session-events-manager.ts:427` (`run.completedAt = Date.now()`), `771` (`updatedAt: Date.now()`).
- **Principle:** DIP / testability.
- **Current:** `Date.now()` is called directly inside the fold and renderer, making `updatedAt`/`completedAt` non-deterministic in tests.
- **Suggested:** Accept an optional `now: () => number` on `SessionEventsManager` (default `Date.now`) and thread it into `processEvent`/`runStateToFrame`. Note: `runStateToFrame` is an *exported* free function, so adding a parameter to it touches the public surface — prefer an optional trailing param (default `Date.now`) to keep callers compiling.
- **Risk:** medium.
- **Effort:** medium.
- **Tests:** lets the suite assert exact timestamps; would simplify time-sensitive assertions.
- **apiPreserving:** false (changes the exported `runStateToFrame` signature, even if optional).

### 7. Unify event-type knowledge (OCP)
- **Location:** `isSessionMetadataEvent` list (`session-events-manager.ts:77-94`), `GatewaySessionMetadataEvent` union (`types.ts:138-154`), and the adapter `switch` (`hrc-event-adapter.ts:261-304`).
- **Principle:** OCP / single-source-of-truth.
- **Current:** The set of metadata event types is duplicated as a runtime array (manager) and a type union (types.ts); adding a metadata type means editing both, and silently falling out of sync compiles fine.
- **Suggested:** Derive the runtime list from a single `const SESSION_METADATA_EVENT_TYPES = [...] as const` and build the union via `(typeof X)[number]['type']`, so the array and type cannot diverge.
- **Risk:** low.
- **Effort:** low-medium.
- **Tests:** add a test asserting every metadata type is handled (no-op) by the fold.
- **apiPreserving:** true (the exported `GatewaySessionMetadataEvent` type still resolves to the same union).

## Code Smells

| Smell | Location | Detail | Severity |
|-------|----------|--------|----------|
| Long function | `session-events-manager.ts:139` `processEvent` | ~490 lines, explicitly biome-ignored for cognitive complexity | high |
| Long function | `session-events-manager.ts:657` `runStateToFrame` | ~116 lines, 6 concerns | medium |
| God file | `session-events-manager.ts` | 941 lines, 4 responsibilities | high |
| Duplicated block | `:297-300` vs `:341-344` vs `:100-116` | message-content flattening x3 | medium |
| Nested ternary | `:631-633`, `:657-667` | phase/emoji ladders | low |
| Magic numbers | `:639` (`100`), `:649/645` (`80`), `:654` (`> 2`) | truncation lengths & JSON-empty sentinel, unnamed | low |
| Primitive obsession | `session-events-manager.ts:498-521` | inline anonymous structural type for tool `result` duplicated across `content`/`details.content` | medium |
| Deep nesting | `:548-572` tool_execution_end | switch case > if > else with index branches | medium |
| Feature envy | `runStateToFrame` reaches deeply into `RunState` internals (`toolExecutions`, `noticeEntries`, `assistantSegments`) | renderer knows fold internals; acceptable for a projection but a candidate for builder extraction (see #3) | low |
| Aliased export | `hrc-event-adapter.ts:321` `hrcLifecycleEventToSessionEnvelope = adaptHrcLifecycleEvent` | two public names for one function; confirm both are consumed or drop one | low |
| Hidden env read | `logger.ts:17-23` | `thresholdFromEnv()` reads `process.env` on every `write` (not cached) | low |

## Quick Wins

- Replace the status→phase and phase→emoji ternary ladders with `Record` lookup tables (#4) — exhaustiveness for free.
- Extract a single `flattenMessageContent` helper and reuse it at the two `message_start`/`message_end` sites (#5).
- Name the truncation magic numbers (`TITLE_MAX = 100`, `TOOL_SUMMARY_MAX = 80`) as module consts.
- Cache the log threshold once at module load in `logger.ts` instead of recomputing per `write`.
- Hoist the inline tool-`result` structural type (`:498-521`) into a named `RawToolResult` type to kill the duplicated content-block shape.

## Technical Debt Notes

- The presence of a `biome-ignore lint/complexity/noExcessiveCognitiveComplexity` on `processEvent` is an explicit acknowledgement of debt; refactoring #1 removes the need for the suppression.
- Two parallel switches over the same event-type space (`processEvent` and `getAffectedRunId`) must be kept consistent by hand — a handler-table approach (#1) could co-locate the affected-runId resolution with each handler.
- The metadata-event list/type duplication (#7) is a latent drift bug: a new metadata type added to `types.ts` but not to `isSessionMetadataEvent` would fall through to the `default` branch silently.
- No test file for `logger.ts` (env-threshold behavior, level routing) or for `types.ts`/`index.ts` barrel; `processEvent` tool-result media parsing is only covered transitively.
- `runStateToFrame` being an exported free function constrains the clock-seam refactor (#6) — any signature change there is a public-API change for downstream sinks.

## Safety Checklist

- [ ] Run `bun test` for the package (both `tests/session-events-manager.test.ts` and `tests/hrc-event-adapter.test.ts`) before and after each refactor.
- [ ] Keep `index.ts` barrel exports byte-for-byte identical for items #1-#5, #7 (apiPreserving).
- [ ] For #6 (clock seam), grep all consumers of `runStateToFrame` across the monorepo before changing its signature; prefer an optional trailing param.
- [ ] Preserve the exact clone/immutability semantics of `getOrCreateRun` when hoisting it (deep-ish copy of toolExecutions/noticeEntries/assistantSegments).
- [ ] Verify dedupe behavior (`seq <= lastSeq`) and `visibility === 'internal'` drop path are unchanged after any manager refactor.
- [ ] Since this is a shared bun-from-source worktree, a broken edit blocks all consumers — typecheck (`bun tsc --noEmit` or package build) after each step.
