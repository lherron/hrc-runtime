# Refactor Analysis — `packages/agent-action-render/src`

_Analysis only. No source files were modified._

**Scope:** 9 production TypeScript files, 576 LOC (excluding `__tests__`).
Largest / most central files:

| File | LOC | Role |
|------|-----|------|
| `tool-presenters.ts` | 213 | Registry of tool presenters + resolution (core) |
| `admission-labels.ts` | 93 | eventKind → human label mapping |
| `tool-formatters.ts` | 74 | Tool-line formatting + deprecated emoji/arg maps |
| `markdown-block.ts` | 61 | Markdown wrap/truncate renderer |
| `event-previews.ts` | 46 | eventKind → preview extractor |
| `index.ts` | 35 | Barrel exports |
| `hrc-kind-icons.ts` | 32 | eventKind → icon mapping |
| `notice-formatters.ts` | 13 | Notice-line formatting |
| `budgets.ts` | 9 | Width constants + `truncateText` |

**Overall:** This is a small, cohesive, mostly-pure presentation library. There are no large-file SRP violations, no LSP violations, no DIP/injection problems (all functions are pure, no `new Concrete()` of collaborators). The real issues are: (1) a deprecated emoji/arg-key duplication layer that diverges from the presenter registry, (2) three parallel `eventKind`-keyed dispatch surfaces that risk drift, and (3) missing test coverage on the admission-label module.

## SOLID Scorecard

| Principle | Status | Notes |
|-----------|--------|-------|
| **S** — Single Responsibility | 🟡 | `tool-formatters.ts` mixes live formatting with a deprecated back-compat emoji/arg-key shim. Otherwise clean; no file >300, no function >50 lines. |
| **O** — Open/Closed | 🟡 | `hrc-kind-icons.ts` (if-else chain), `admissionLabel` (switch), `event-previews` map, and `tool-presenters` registry are four separate per-eventKind/per-tool dispatch tables that must be edited in lock-step when a new kind is added. |
| **L** — Liskov Substitution | 🟢 | No inheritance, no overrides, no `not implemented` stubs. |
| **I** — Interface Segregation | 🟢 | `ToolPresenter` has 5 members, all optional-where-appropriate. No fat interfaces, no stubbed members. |
| **D** — Dependency Inversion | 🟢 | All units are pure functions over plain data; no hardcoded singletons or hidden collaborators. Module-level const registries are data, not behavior dependencies. |

## Priority Refactorings

### 1. Deprecated `TOOL_EMOJI` / `PRIMARY_ARG_KEY` / `getToolEmoji` silently drop non-string presenters
- **Location:** `tool-formatters.ts:7-24, 54-56`; consumed by `hrc-kind-icons.ts:15,18`.
- **Principle/Smell:** SRP (two responsibilities in one file) + correctness drift / duplicated source of truth.
- **Current:** `TOOL_EMOJI` and `PRIMARY_ARG_KEY` are built only from presenters whose `match` is a `string` (`typeof presenter.match === 'string'`). The shell presenter (`isShellLikeExecTool`, a function) and the `/^mcp:/` regex presenter are excluded, so `getToolEmoji('command_execution')` returns the default ⚙️ instead of 💻. `getHrcEventIcon` calls `getToolEmoji`, so icon selection for shell/mcp tools is wrong relative to `formatToolLine` (which uses the registry directly).
- **Suggested:** Make `getToolEmoji(toolName, input?)` delegate to `resolveToolPresenter(...).emoji`, and have `getHrcEventIcon` thread the tool input through. Keep the deprecated maps as thin derived views (or remove once consumers migrate). This collapses the duplicate emoji source of truth into the registry.
- **Risk:** medium — `getToolEmoji` and the maps are exported public symbols; behavior changes for shell/mcp tools (arguably a bug-fix, but observable).
- **Effort:** S (≈1 hr).
- **Tests:** Add cases asserting `getToolEmoji('command_execution', {command:'a | b'})` and an `mcp:` tool resolve to the registry emoji; assert `getHrcEventIcon('tool_execution_start', {toolName:'command_execution'})` matches `formatToolLine`'s emoji.
- **apiPreserving:** false (signature/behavior of exported `getToolEmoji` changes).

### 2. Four parallel `eventKind`/tool dispatch surfaces invite drift (OCP)
- **Location:** `hrc-kind-icons.ts:14-31`, `admission-labels.ts:23-49`, `event-previews.ts:16-26`, `tool-presenters.ts:70-176`.
- **Principle/Smell:** OCP — adding a new event kind requires touching an if-else chain, a switch, and a record map independently with no compiler linkage.
- **Current:** Icon selection is an ordered if-else chain; labels are a `switch`; previews are a `Record`. Each is keyed on the same `eventKind` namespace but uncoordinated.
- **Suggested:** Lower-risk, incremental: convert `getHrcEventIcon`'s exact-match arm into a `Record<string,string>` lookup table (keeping the `startsWith('message_')`, notice-level, and `failed` special cases as explicit pre/post checks). This makes icon additions data-only and parallels `event-previews.ts`/`notice-formatters.ts` style. A larger unification (single `eventKind` descriptor registry feeding icon+label+preview) is possible but higher-risk and not warranted at this size.
- **Risk:** low (icon table conversion is internal; output unchanged).
- **Effort:** S.
- **Tests:** Existing `maps HRC event icons` test covers the happy path; extend with notice-level and `message_*` prefix cases to lock the special-case behavior before refactor.
- **apiPreserving:** true (pure internal restructuring of `getHrcEventIcon`; export signature unchanged).

### 3. `admission-labels.ts` untested + dual mapping logic
- **Location:** `admission-labels.ts:20-93`.
- **Principle/Smell:** Missing test coverage + primitive-obsession / duplicated decision logic.
- **Current:** `admissionLabelFromResponse` re-derives an `eventKind` via a second cascade of `if` checks (lines 72-89) that mirrors the `switch` in `admissionLabel`, with magic strings (`'accepted_in_flight'`, `'admission_pending'`, `'queued_run'`, `'contribution_unsupported_fallback_queued'`) repeated. No test file exercises either function despite the "all consumers must call this single function" mandate.
- **Suggested:** Extract the admission-kind/status → eventKind mapping into a small named table, and add unit tests covering each branch (including the `contribution_unsupported_fallback_queued` reason and the bare fallback returning `applicationStatus ?? admissionKind ?? ''`). Centralize the magic-string literals as named constants.
- **Risk:** low (extraction is internal; the test addition is non-breaking).
- **Effort:** S–M.
- **Tests:** New: one per branch of `admissionLabelFromResponse`; one default-branch test of `admissionLabel`.
- **apiPreserving:** true (internal table extraction; exported signatures unchanged).

### 4. `markdown-block.ts` `renderLine` has a dead branch
- **Location:** `markdown-block.ts:36-41`.
- **Principle/Smell:** Dead code / confusing control flow.
- **Current:** `renderLine` returns `line` in both the `inFence` branch (line 40) and the final `return line` (line 41) — identical outputs; the `inFence` parameter only matters because the caller skips wrapping decisions, but inside `renderLine` it is inert. The `if (inFence) return line` is unreachable-effect dead code.
- **Suggested:** Drop the redundant `if (inFence) return line` line, or document why both exist. Confirms the only transform is the `- ` → `• ` bullet substitution for non-markdown styles.
- **Risk:** low.
- **Effort:** XS.
- **Tests:** Existing `renders markdown blocks` test guards output; add a fenced-code-block case to lock fence passthrough.
- **apiPreserving:** true (internal helper; `renderMarkdownBlock` signature unchanged).

## Code Smells

| Smell | Location | Detail |
|-------|----------|--------|
| Duplicated source of truth | `tool-formatters.ts:7-24` vs `tool-presenters.ts:70-176` | Emoji/arg-key maps derived from a filtered view of presenters; diverges for non-string matches. |
| Magic strings | `admission-labels.ts:72-89` | Admission-kind / status literals repeated across two functions. |
| Magic numbers | `markdown-block.ts:43` (`Math.max(20, ...)`), `budgets.ts:1-2` (80/60) | Width floor `20` is an unnamed literal; budget constants are named (good) but the `20` floor is not. |
| Dead branch | `markdown-block.ts:40` | `if (inFence) return line` returns same as fallthrough. |
| Parallel dispatch tables | see Refactoring #2 | Three eventKind-keyed surfaces with no shared key contract. |
| Linear scan resolution | `tool-presenters.ts:194-203` | `resolveToolPresenter` is O(n) per call; fine at n=15 but a `Map` for string matches would clarify intent (not a perf concern). |
| Loose typing | throughout | `Record<string, unknown>` for tool input / payloads is intentional (untrusted JSON) — acceptable primitive obsession given the boundary. |

No long methods (>50 lines), no long param lists (>4), no deep nesting (≥4), and no feature envy were found.

## Quick Wins

1. Remove the dead `if (inFence) return line` in `markdown-block.ts:40`.
2. Name the `20` width floor in `markdown-block.ts:43` (e.g. `MIN_BLOCK_WIDTH`).
3. Add unit tests for `admissionLabel` / `admissionLabelFromResponse` (currently zero coverage).
4. Extend `maps HRC event icons` test to cover notice-level and `message_*` prefix branches before any icon refactor.

## Technical Debt Notes

- The `@deprecated` `TOOL_EMOJI`, `PRIMARY_ARG_KEY`, and (implicitly) `getToolEmoji` form a back-compat layer that is both deprecated and **subtly incorrect** for shell/mcp tools. The deprecation comment points to the presenter registry, but `getToolEmoji` does not yet route through it, so the icon path (`hrc-kind-icons.ts`) and the line-formatting path (`tool-formatters.ts`) can disagree. This is the single highest-value cleanup.
- The package has a clean public API (barrel in `index.ts`); most refactorings can be internal. Only Refactoring #1 touches observable export behavior.
- Test coverage is good for tool/notice/icon/markdown formatting but absent for the admission-label module — the most business-rule-heavy file.

## Safety Checklist

- [ ] Run `bun test` in `packages/agent-action-render` (existing `formatters.test.ts`) before and after any change.
- [ ] Before Refactoring #1, audit all consumers of `getToolEmoji`, `TOOL_EMOJI`, `PRIMARY_ARG_KEY` across the monorepo (Discord gateway, CLI, projection) — these are cross-package exports.
- [ ] Add the missing admission-label tests (Quick Win #3) BEFORE touching `admission-labels.ts`.
- [ ] Add fenced-code-block + notice-level/`message_*` test cases BEFORE Refactorings #2 and #4.
- [ ] Keep all exported symbol signatures in `index.ts` stable for apiPreserving items (#2, #3, #4).
- [ ] Verify no behavioral change in `getHrcEventIcon` output for existing kinds when converting to a lookup table.
