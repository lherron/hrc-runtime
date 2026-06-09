# Refactor Analysis — `packages/hrc-frame-render`

Behavior-preserving refactor audit. Scope: `src/` (excluding `src/tests/`).
Date: 2026-06-08.

## Package shape

| File | Lines | Role |
|------|-------|------|
| `src/session-events-manager.ts` | 973 | Event-fold projection + frame builder + `SessionEventsManager` class |
| `src/hrc-event-adapter.ts` | 321 | HRC lifecycle event → `SessionEventEnvelope` adapter |
| `src/types.ts` | 193 | Public type/union/const surface |
| `src/logger.ts` | 61 | JSON line logger factory |
| `src/index.ts` | 34 | Barrel of public exports |

Test coverage: `src/tests/session-events-manager.test.ts` (450 LOC) exercises `SessionEventsManager.receive`/`runStateToFrame`/projection; `src/tests/hrc-event-adapter.test.ts` (244 LOC) exercises `adaptHrcLifecycleEvent`. The core projection logic is well covered, which makes internal extraction relatively safe (behavior is pinned by tests).

---

## SOLID Scorecard

| Principle | Grade | Notes |
|-----------|-------|-------|
| **S** — Single Responsibility | **D** | `session-events-manager.ts` mixes a 480-line event-fold reducer, the frame-rendering pipeline, AND the stateful manager class in one 973-line file. `processEvent` alone is one giant function with nested closures. |
| **O** — Open/Closed | **C** | Two parallel `switch(event.type)` chains (`processEvent`, `getAffectedRunId`) that must both grow per new event type. Acceptable for a closed event union, but the duplication-of-cases coupling is real. |
| **L** — Liskov | **A** | No inheritance, no overrides. N/A and clean. |
| **I** — Interface Segregation | **A** | No fat interfaces; `RunState`/`ToolExecution` are data records, not behavior contracts. |
| **D** — Dependency Inversion | **B** | `createLogger` is called at module scope as a hidden singleton (`const log = ...`) in two files — a minor hardcoded dependency, but callbacks (`onRender`, `onRunQueued`) are properly injected into the manager. |

---

## Priority Refactorings

### P1 — Split `session-events-manager.ts` into reducer / frame-builder / manager modules
- **Location:** `src/session-events-manager.ts:1-973`
- **Principle:** S (Single Responsibility), file > 300 lines.
- **Current:** One file holds three distinct concerns: (a) the event-fold reducer (`processEvent` + helpers, lines 84-618), (b) the frame projection pipeline (`runStateToFrame` + `toolBlocks`/`noticeBlocks`/`segmentBlocks`/`permissionBlock`/`progressPlaceholder`/`mediaRefBlocks`/`titleFor`/`formatToolSummary`, lines 620-805), (c) the `SessionEventsManager` stateful class (lines 817-973).
- **Suggested:** Move the reducer to `src/run-reducer.ts`, the frame pipeline to `src/run-state-to-frame.ts`, keep the class in `session-events-manager.ts`. Re-export the same symbols from `index.ts` so the public surface is byte-identical. Internal-only file moves.
- **Risk:** **Med** — touches many internal imports; mechanical but broad. `index.ts` re-export keeps the public API stable.
- **API-impact:** **internal-only** (public exports preserved via barrel).
- **Effort:** M
- **Tests:** Existing two test files import from package root / module paths — verify their import specifiers. If they import `./session-events-manager.js` directly for `runStateToFrame`/`SessionEventsManager`, keep those symbols re-exported from that file or update test imports (a private-symbol-follow rename, allowed). Run full `bun test` after.

### P2 — Decompose `processEvent` (≈480 lines, one function)
- **Location:** `src/session-events-manager.ts:134-618`
- **Principle:** S; long method; deep nesting; high cognitive complexity (already has a `biome-ignore noExcessiveCognitiveComplexity` suppression at line 134, an explicit smell marker).
- **Current:** A single function containing 3 nested closures (`getOrCreateRun`, `closeActiveSegment`, `upsertAssistantSegment`) plus a 15-case `switch`. Each case mutates `run` and calls `newState.runs.set(...)`. `tool_execution_end` (lines 470-565) is ~95 lines by itself.
- **Suggested:** Extract each `case` body into a private handler `handleRunQueued(run, event, seq)`, `handleToolExecutionEnd(run, event, seq)`, etc., each mutating the cloned `run`. Lift `getOrCreateRun`/`closeActiveSegment`/`upsertAssistantSegment` to module-level helpers taking explicit params (they close over only `newState`/`state`/`run`, all passable). This drops nesting and lets the biome suppression be removed.
- **Risk:** **Med** — large surface, but pinned by `session-events-manager.test.ts`. Pure behavior-preserving extraction.
- **API-impact:** **internal-only** (`processEvent` is not exported).
- **Effort:** L
- **Tests:** `src/tests/session-events-manager.test.ts` covers the projection end-to-end; rely on it as the safety net. No test edits expected.

### P3 — Lift the inline `result` shape type in `tool_execution_end`
- **Location:** `src/session-events-manager.ts:487-510`
- **Principle:** primitive obsession / duplicated block; smell.
- **Current:** A ~24-line inline structural type for `event.result` with `content` and `details.content` arrays of the *identical* block shape declared twice.
- **Suggested:** Declare a private `type ToolResultContentBlock = {...}` once and reuse it for both `content` and `details.content`. Pure internal type alias.
- **Risk:** **Low**
- **API-impact:** **internal-only**
- **Effort:** S
- **Tests:** Covered by tool-result projection cases in the manager test.

### P4 — Dedupe the `mediaRef` block shape, repeated 4×
- **Location:** `src/session-events-manager.ts:20-27, 480-485, 679-690, 756-764`
- **Principle:** DRY / duplicated block.
- **Current:** The `{ url; mimeType?; filename?; alt? }` mediaRef record literal is re-spelled in `ToolExecution.mediaRefs`, the local `mediaRefs` accumulator, `collectMediaRefs`'s return type and its inner `allMediaRefs`, and `mediaRefBlocks`.
- **Suggested:** Introduce one private `type MediaRef = { url: string; mimeType?: string | undefined; filename?: string | undefined; alt?: string | undefined }` and reference it everywhere. Internal type only.
- **Risk:** **Low**
- **API-impact:** **internal-only** (not exported; `RenderBlock`'s `media_ref` variant in `types.ts` stays untouched).
- **Effort:** S
- **Tests:** Existing media-ref projection test.

### P5 — Collapse the redundant trailing `default` in `processEvent`
- **Location:** `src/session-events-manager.ts:610-614`
- **Principle:** dead code / no-op branch.
- **Current:**
  ```ts
  default:
    if (isSessionMetadataEvent(event)) {
      break
    }
    break
  ```
  Both branches `break`; the `if` has no observable effect.
- **Suggested:** Replace with a bare `default: break`. If the `isSessionMetadataEvent` call documents "known-but-ignored", swap for a comment instead of a dead conditional.
- **Risk:** **Low**
- **API-impact:** **internal-only**
- **Effort:** S
- **Tests:** Metadata-event drop is covered; no behavior change.

### P6 — Name magic numbers in title/summary truncation
- **Location:** `src/session-events-manager.ts:644 (100), 654/658 (80), 659 (2)`
- **Principle:** magic number.
- **Current:** Title truncates at `100`, tool summaries at `80`, and `json.length > 2` (the empty-`{}` guard) are bare literals.
- **Suggested:** Module-level `const TITLE_MAX_LEN = 100`, `const TOOL_SUMMARY_MAX_LEN = 80`, `const EMPTY_JSON_LEN = 2`. Internal constants only.
- **Risk:** **Low**
- **API-impact:** **internal-only**
- **Effort:** S
- **Tests:** Title/summary formatting covered by manager test.

### P7 — `formatToolSummary` ignores its first parameter
- **Location:** `src/session-events-manager.ts:648` (`_toolName` unused), call sites `670, 750`
- **Principle:** dead parameter / misleading signature.
- **Current:** `formatToolSummary(_toolName, toolInput)` — the tool name is passed but never used.
- **Suggested:** Drop the unused first parameter and update the two internal call sites. `formatToolSummary` is **not exported** (absent from `index.ts`), so this is internal-only. Verify `src/tests/` does not import it directly first; if it does, this becomes a private-symbol-follow edit (allowed) — otherwise leave as-is.
- **Risk:** **Low** (becomes **Med** if a test imports the symbol directly)
- **API-impact:** **internal-only**
- **Effort:** S
- **Tests:** Confirm no direct import in `session-events-manager.test.ts`.

### P8 — Reduce `runStateToFrame` length & nesting via small private extracts
- **Location:** `src/session-events-manager.ts:766-805`
- **Principle:** S (function ~40 lines doing assemble + sort + fallback + actions mapping).
- **Current:** Builds timeline, sorts, appends permission/placeholder/media, maps actions, returns frame — several responsibilities inline.
- **Suggested:** Extract `buildOrderedBlocks(run, phase)` and `buildActions(run)` private helpers. Minor; mostly aids P2 readability.
- **Risk:** **Low**
- **API-impact:** **internal-only** (`runStateToFrame` keeps identical signature/behavior).
- **Effort:** S
- **Tests:** Frame-assembly cases in manager test.

### P9 — Shorten `adaptHrcLifecycleEvent` (≈90 LOC) by extracting the kind dispatch
- **Location:** `src/hrc-event-adapter.ts:228-319`
- **Principle:** S; long method; switch chain.
- **Current:** Guards (runId/projectId/sessionRef) + notice short-circuit + a 13-case `switch(event.eventKind)` + the `input.*` default branch, all inline in the exported function.
- **Suggested:** Extract a private `adaptEventByKind(eventKind, payload, hrcSeq)` holding the switch, leaving `adaptHrcLifecycleEvent` to do guard/derive/envelope assembly. Behavior-identical; the extracted helper is not exported.
- **Risk:** **Low**
- **API-impact:** **internal-only**
- **Effort:** S
- **Tests:** `src/tests/hrc-event-adapter.test.ts` covers all kinds.

### P10 — `hrcLifecycleEventToSessionEnvelope` is a public alias of `adaptHrcLifecycleEvent`
- **Location:** `src/hrc-event-adapter.ts:321`; both re-exported in `index.ts:2,4`.
- **Principle:** duplicated public name / possible dead alias.
- **Current:** `export const hrcLifecycleEventToSessionEnvelope = adaptHrcLifecycleEvent` — two public names for one function.
- **Suggested:** Likely a back-compat alias. **DEFER** — removing it changes the exported surface; a consumer in another package may import the old name.
- **Risk:** **High** (export removal)
- **API-impact:** **public-surface**
- **Effort:** S (but defer)
- **Tests:** N/A this phase.

---

## Code Smells Table

| # | Location | Smell | Severity | Disposition |
|---|----------|-------|----------|-------------|
| 1 | `session-events-manager.ts:134-618` | Long function (480 LOC) + explicit cognitive-complexity suppression | High | P2 — apply |
| 2 | `session-events-manager.ts:1-973` | God file (3 concerns) | High | P1 — apply (Med risk) |
| 3 | `session-events-manager.ts:470-565` | Long case body (~95 LOC) `tool_execution_end` | Med | P2 — apply |
| 4 | `session-events-manager.ts:487-510` | Duplicated inline block type | Med | P3 — apply |
| 5 | `session-events-manager.ts:20-27,480-485,679-690,756-764` | mediaRef shape repeated 4× | Med | P4 — apply |
| 6 | `session-events-manager.ts:610-614` | No-op `default` branch | Low | P5 — apply |
| 7 | `session-events-manager.ts:644,654,658,659` | Magic numbers (100/80/2) | Low | P6 — apply |
| 8 | `session-events-manager.ts:648` | Unused `_toolName` param | Low | P7 — apply (verify no test import) |
| 9 | `session-events-manager.ts:174-223` | `upsertAssistantSegment` — 3-branch find/mutate duplication | Med | folded into P2 |
| 10 | `session-events-manager.ts:956-972` vs `225-615` | Parallel `switch(event.type)` chains (`getAffectedRunId` mirrors `processEvent` cases) | Med | note (O) — leave; closed union |
| 11 | `hrc-event-adapter.ts:228-319` | `adaptHrcLifecycleEvent` ~90 LOC guards + 13-case switch | Med | P9 — apply |
| 12 | `hrc-event-adapter.ts:321` | Dead/duplicate public alias | High | P10 — DEFER (public) |
| 13 | `logger.ts:7` / `hrc-event-adapter.ts:7` / `session-events-manager.ts:10` | Module-scope `createLogger` singleton (hidden dep) | Low | note (D) — leave; idiomatic |

---

## Quick Wins (Low risk, internal-only — safe to auto-apply)

- **P3** — single `ToolResultContentBlock` type.
- **P4** — single `MediaRef` type.
- **P5** — collapse no-op `default`.
- **P6** — named truncation constants.
- **P7** — drop unused `_toolName` param (pending no-test-import check).
- **P8** — frame-builder extracts (`buildOrderedBlocks`/`buildActions`).
- **P9** — extract `adaptEventByKind` from the adapter switch.

## Medium (internal-only, larger — apply with the test suite as the gate)

- **P1** — module split (re-export-preserving).
- **P2** — `processEvent` decomposition into per-case private handlers + module-level segment helpers.

## Deferred (do NOT touch this phase)

- **P10 / Smell 12** — removing `hrcLifecycleEventToSessionEnvelope` alias: **public-surface, High risk.** Requires a cross-package grep for consumers and an owner decision.

---

## Technical Debt Notes

- **Two switch chains must co-evolve.** `processEvent` (state fold) and `getAffectedRunId` (run-id resolution) both branch on `event.type`. Adding an event type means editing both; nothing enforces parity. A future (non-behavior-preserving, out of scope) improvement is a single per-event descriptor table mapping `type → { affectedRunId, fold }`. Note only.
- **`upsertAssistantSegment` is the trickiest logic** (3 fallback branches over active-segment vs explicit id; append/replace/set modes). Highest-value target to keep pinned by tests; preserve semantics exactly during P2.
- **`Date.now()` inside `processEvent`/`runStateToFrame`** (lines 416, 803) makes output time-dependent. Do not "improve" by injecting a clock in this phase — that would be a behavior/API change.
- The public type surface in `types.ts` is deliberately verbose (explicit `| undefined` unions, single-source `SESSION_METADATA_EVENT_TYPES` tuple driving the union). Intentional — do not "simplify".
