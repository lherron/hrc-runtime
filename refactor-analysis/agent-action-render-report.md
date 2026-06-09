# Refactor Analysis — `packages/agent-action-render`

Scope: `packages/agent-action-render/src` (9 source files, 617 LoC total). Tests:
`src/__tests__/formatters.test.ts` (covers `admissionLabel`, `formatToolLine`,
`getHrcEventIcon`, `formatNoticeLine`, `extractToolPreview`, `getToolEmoji`,
`renderMarkdownBlock`, `formatEventPreviewLine`). All findings are report-only; no
source edited in this phase.

This package is small, cohesive, and was already passed over in the d19ade8 SOLID
sweep (presenter registry extraction, named event-kind constants, etc.). There are
**no High-risk structural problems**. Findings below are minor polish / quick wins.

## SOLID Scorecard

| Principle | Grade | Notes |
|-----------|-------|-------|
| SRP | A- | Each file owns one rendering concern (tool lines, notices, markdown blocks, icons, budgets, admission labels). Largest file 213 LoC; largest function ~30 LoC. No file > 300, no function > 50. |
| OCP | A | Tool rendering is data-driven via the `PRESENTERS` registry + `resolveToolPresenter`. New tools = new array entry, no branch edits. Minor: `getHrcEventIcon` and `admissionLabel` still use switch/if-chains, but they key on a bounded, slow-moving enum of HRC event kinds (acceptable; see TD-1). |
| LSP | A | No class hierarchies / overrides. `ToolPresenter` is a plain data interface; no inheritance to violate. |
| ISP | A | `ToolPresenter` interface has 5 members, 2 optional; implementors (the registry literals) only fill what they use. No fat interfaces. |
| DIP | A | No `new Concrete()` of collaborators; pure functions and module-level data tables. Dependencies flow one direction (formatters -> budgets / presenters). No singletons beyond const lookup tables. |

## Priority Refactorings

### P1 — Duplicated default icon literal `'⚙️'`
- **Location**: `src/tool-formatters.ts:13` (`DEFAULT_TOOL_EMOJI`),
  `src/hrc-kind-icons.ts:3` (`DEFAULT_HRC_ICON`),
  `src/tool-presenters.ts:181` (`DEFAULT_PRESENTER.emoji`) and the inline literal at
  `src/tool-presenters.ts:174`.
- **Principle/Smell**: Magic-value duplication (DRY); the default fallback emoji is
  defined as a literal in 4 places.
- **Current**: Three separately-declared constants plus an inline literal, all equal
  to `'⚙️'`.
- **Suggested**: Internal dedupe only — have one reference the other inside the
  package, or add a private shared const. Keep the *exported* constant names AND
  values byte-identical.
- **Risk**: Low. **API-impact**: internal-only (provided exported values are
  preserved). **Effort**: XS.
- **Tests**: `getToolEmoji` default path and `getHrcEventIcon` default path both
  covered in `formatters.test.ts`; value drift would be caught.

### P2 — `extractToolPreview` implicit "first non-empty string" fallback loop
- **Location**: `src/tool-formatters.ts:45-49`.
- **Principle/Smell**: Minor readability / unclear fallback; inline
  `for (const value of Object.values(input))` re-implements a "first string value"
  scan.
- **Current**: Inline `for` loop returning the first non-empty string field of
  `input`.
- **Suggested**: Extract a private `firstStringValue(input)` helper; behavior
  identical, file-private.
- **Risk**: Low. **API-impact**: internal-only. **Effort**: XS.
- **Tests**: `extractToolPreview` covered (2 assertions); fallback path exercised.

### P3 — `admissionLabelFromResponse` long if-chain with embedded eventKind mapping
- **Location**: `src/admission-labels.ts:78-122`.
- **Principle/Smell**: Sequential `if` chain (5 branches) mapping
  `(admissionKind, applicationStatus, reason)` -> eventKind; mild OCP pressure and a
  44-line function.
- **Current**: Five guard `if` blocks each calling `admissionLabel({eventKind})`,
  then a primitive fallback.
- **Suggested**: Optionally extract a private `resolveAdmissionEventKind(payload)`
  returning the eventKind (or `undefined`), leaving the public function to do the
  single label lookup. Signature unchanged.
- **Risk**: Low. **API-impact**: internal-only (public signature unchanged; only a
  private helper added). **Effort**: S.
- **Tests**: NOT covered by `formatters.test.ts` (no assertions on
  `admissionLabelFromResponse`). Because it is untested, safest posture is to leave
  it; documented as optional only.

## Code Smells

| # | Location | Smell | Severity | Risk | API-impact |
|---|----------|-------|----------|------|------------|
| C1 | `tool-presenters.ts:70-176` | Large literal table (`PRESENTERS`, 106 LoC) | Info — desired OCP shape, not a fix | n/a | public-surface (exported) |
| C2 | `tool-formatters.ts:13`, `hrc-kind-icons.ts:3`, `tool-presenters.ts:174,181` | Magic-string `'⚙️'` repeated | Low | Low | mixed (P1) |
| C3 | `tool-formatters.ts:45-49` | Implicit first-string-value scan | Low | Low | internal-only (P2) |
| C4 | `admission-labels.ts:78-122` | 44-line if-chain mapper | Low | Low | internal-only (P3) |
| C5 | `tool-formatters.ts:68` | Dead `const suffix = ''` then `- suffix.length` / `${suffix}` no-ops | Low | Low | internal-only |
| C6 | `markdown-block.ts:14-37` | `wrapLine` nesting depth ~3 with multiple mutation points | Info — readable, within budget | Low | internal-only |

### C5 detail — dead `suffix`
`src/tool-formatters.ts:68` declares `const suffix = ''` then subtracts/appends it at
`:69` and `:72`. It is always empty, so the arithmetic and concatenation are no-ops.
Removing it is a behavior-preserving dead-code cleanup. Risk Low, internal-only.
Covered by `formatToolLine` tests (16 assertions).

## Quick Wins (safe, internal-only, behavior-preserving)

1. **Remove dead `suffix` in `formatToolLine`** (`tool-formatters.ts:68-72`). Pure
   dead-code removal; well covered. Risk Low.
2. **Internal dedupe of the `'⚙️'` default emoji** keeping exported values identical
   (P1). Risk Low.
3. **Extract `firstStringValue` private helper** in `tool-formatters.ts` (P2). Risk
   Low.

## Technical Debt Notes

- **TD-1 (accepted debt, do NOT change):** `getHrcEventIcon`
  (`hrc-kind-icons.ts:23-44`) and `admissionLabel` (`admission-labels.ts:43-73`) use
  switch / if-chains keyed on event-kind enums. These are deliberate readable
  lookup-with-special-cases (`notice` level sub-branch, `message_*` prefix match,
  `REASON_FALLBACK_QUEUED` override) a pure table cannot express cleanly. Slow-growing
  and heavily test-covered. Not worth restructuring.

- **TD-2 (public-surface, DEFER):** `TOOL_EMOJI` and `PRIMARY_ARG_KEY`
  (`tool-formatters.ts:7-24`) are `@deprecated` ("Use the ToolPresenter registry
  instead") yet still exported from `index.ts:21-22`. Removing them is a
  public-surface breaking change for downstream consumers (CLI, projection,
  ops-server, ops-web, Discord gateway). DEFER — needs a cross-package consumer audit
  + coordinated removal; out of scope for a behavior-preserving pass.

- **TD-3 (public-surface, informational):** `PRESENTERS` and the `ToolPresenter`
  interface are exported; `resolveToolPresenter` is first-match-wins, so ordering is
  observable behavior. `isShellLikeExecTool` MUST stay first to keep shell-detection
  precedence. No change recommended; flagged so a future refactor does not reorder.

## Auto-apply summary

Safe to auto-apply (Low + internal-only): C5 dead-`suffix` removal, P1 internal emoji
dedupe (values preserved), P2 `firstStringValue` extract. P3 left optional (no direct
test coverage). TD-2 deferred (public-surface deprecated export).
