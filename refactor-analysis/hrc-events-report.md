# Refactor Analysis — `packages/hrc-events/src`

Date: 2026-06-07
Scope: production TypeScript only (`__tests__` excluded from the production view, noted for coverage).
Methodology: SOLID violations, code smells, complexity. Analysis only — no source edited.

## Scope

Production source: 1,523 lines across 8 files.

| File | Lines | Role |
|------|-------|------|
| `hook-normalizer.ts` | 293 | Claude Code hook payload → `HookDerivedEvent[]` (pure) |
| `tool-output-formatter.ts` | 269 | Tool response → display string + structured diff (pure) |
| `pi-normalizer.ts` | 268 | Pi/OpenAI hook envelope → events + semantic events + continuation |
| `otel-normalizer.ts` | 221 | Codex OTEL log record → `HookDerivedEvent[]` |
| `monitor-schema.ts` | 168 | Zod schema + const enums for `hrc monitor` output contract |
| `events.ts` | 127 | TS interfaces + union for hook-derived events |
| `schemas.ts` | 112 | Zod schemas mirroring `events.ts` |
| `index.ts` | 65 | Barrel re-exports |

Tests: 881 lines across 4 files (`hook-normalizer`, `otel-normalizer`, `pi-normalizer`, `monitor-schema.acceptance`).
**Coverage gap:** `tool-output-formatter.ts` — the single most complex algorithm in the package (structured-patch + line-diff rendering) — has **no dedicated test file**. It is only exercised indirectly via `hook-normalizer` PostToolUse cases.

This is a small, well-factored, side-effect-free normalizer library. There are no IO/DI/singleton concerns, so D (DIP) and most of L (LSP) are not in play. The dominant smell is **branch-per-case dispatch** (OCP) and a handful of **long functions / duplication**.

## SOLID Scorecard

| Principle | Status | Notes |
|-----------|--------|-------|
| **S** — Single Responsibility | yellow | `normalizeClaudeHook` and `formatToolOutput` each fold many concerns into one long function; otherwise files are cohesive. |
| **O** — Open/Closed | yellow | Three normalizers (`hook`, `otel`, `pi`) and `formatToolSummary` are long `if`/`switch` chains keyed on an event/tool name that grow one branch per new case. Adding a harness or tool = editing the chain. |
| **L** — Liskov | green | No inheritance, no overrides, no throwing stubs. N/A in practice. |
| **I** — Interface Segregation | green | Result types are small and purpose-specific (≤6 members). No fat interfaces, no stubbed members. |
| **D** — Dependency Inversion | green | All functions are pure; the only external dep is `diff` (a leaf util). No `new Concrete()` collaborators, no singletons, no hidden IO. |

Overall: healthy library. The findings below are quality/maintainability improvements, not structural defects.

## Priority Refactorings

### 1. `formatToolOutput` — long function mixing response-shape parsing with per-tool rendering (S, O)

- **Location:** `tool-output-formatter.ts:176-269` (function body ~94 lines)
- **Principle:** SRP + OCP
- **Current:** One function does three things in sequence: (a) coerce arbitrary `toolResponse` (string | array | object with stdout/stderr/content) into a base output string, (b) special-case `Write` rendering with an inline `langMap`, (c) special-case `Edit` rendering via structured-patch-or-line-diff. Branches (b) and (c) are keyed on `toolName`; a new richly-rendered tool means another `if (toolName === 'X')` block inside this function.
- **Suggested:** Extract a `coerceResponseToOutput(toolResponse)` helper for step (a), and split per-tool renderers into a lookup `Record<string, (input, responseObject) => string | undefined>` (e.g. `toolRenderers.Write`, `toolRenderers.Edit`). `formatToolOutput` then becomes: coerce base, look up renderer by `toolName`, fall back to `stringifyToolValue`. New tools register a renderer instead of editing the body. Keep the exported signature identical.
- **Risk:** medium — behavior-preserving but it is the package's most algorithm-heavy code AND it has no dedicated test, so regressions would be caught only indirectly.
- **Effort:** M
- **API-preserving:** yes (internal restructuring; `formatToolOutput` signature unchanged).
- **Tests:** ADD a dedicated `tool-output-formatter.test.ts` FIRST (golden cases: Write preview + truncation, Edit via structuredPatch, Edit via line-diff fallback, stdout/stderr/content coercion, error passthrough). Do the extraction only after the characterization tests are green.

### 2. Duplicated edit-summary builder across two functions (DRY / S)

- **Location:** `tool-output-formatter.ts:111-120` and `tool-output-formatter.ts:164-172`
- **Principle:** SRP / DRY
- **Current:** `buildEditOutputFromStructuredPatches` and `buildEditOutputFromLineDiff` contain an identical ~10-line block computing the `Modified` / `Added N lines` / `Removed N lines, ...` summary from `(added, removed)`. The two functions also share the `${line}|+|`, `|-|`, `|c|` line-emit convention.
- **Suggested:** Extract `summarizeEdit(added: number, removed: number): string` and use it in both builders. Optionally extract an `emitDiffLine(kind, lineNo, content)` helper to unify the marker format.
- **Risk:** low
- **Effort:** S
- **API-preserving:** yes (both functions are module-private).
- **Tests:** covered once finding #1's characterization tests exist; the extracted helper is pure and trivially unit-testable.

### 3. `normalizeClaudeHook` — 7-branch dispatch + a 127-line function (O, S)

- **Location:** `hook-normalizer.ts:166-293`
- **Principle:** OCP + SRP
- **Current:** A flat sequence of `if (hookName === 'PreToolUse') {...} if (hookName === 'PostToolUse') {...} ...` returning fully-built `NormalizeHookResult`s. Each new Claude hook type appends another branch to a function that is already 127 lines. The branches share the leading `toolUseId`/`toolName` extraction.
- **Suggested:** Replace with a dispatch table `Record<HookName, (ctx) => NormalizeHookResult>` where `ctx` carries the pre-extracted `unwrapped`, `toolUseId`, `toolName`. Each handler is a small named function (`handlePreToolUse`, `handlePostToolUse`, ...). The default (`unknown`) is the table miss. This shrinks the entry point to lookup-and-call and makes each hook independently readable/testable.
- **Risk:** low — every branch already has direct test coverage in `hook-normalizer.test.ts`.
- **Effort:** M
- **API-preserving:** yes (`normalizeClaudeHook` signature unchanged).
- **Tests:** existing `hook-normalizer.test.ts` is the safety net; run before/after.

### 4. `normalizePiPayload` — same branch-per-event-name shape (O)

- **Location:** `pi-normalizer.ts:152-227`
- **Principle:** OCP
- **Current:** `if (eventName === 'tool_execution_start')... if (eventName === 'tool_execution_update')... if (eventName === 'message_start' || 'message_update' || 'message_end')... if (eventName === 'turn_start')... if (eventName === 'turn_end')...`. The three tool branches repeat the `getString(payload, 'toolUseId','tool_use_id','id','callId')` extraction verbatim.
- **Suggested:** Hoist `const toolUseId = getString(payload, 'toolUseId','tool_use_id','id','callId')` once, and convert the chain to a dispatch table keyed on `eventName` (mirrors finding #3). Combine the two `turn_*` notice branches into a small map of `eventName → message`.
- **Risk:** low — covered by `pi-normalizer.test.ts`.
- **Effort:** S–M
- **API-preserving:** yes (`normalizePiHookEvent` is the only export; this is its internal helper).
- **Tests:** `pi-normalizer.test.ts`.

### 5. `normalizeCodexOtelEvent` — branch-per-event-name dispatch (O)

- **Location:** `otel-normalizer.ts:123-221`
- **Principle:** OCP
- **Current:** Four `if (eventName === 'codex.*')` blocks each returning a `NormalizeOtelResult`. Adding a mapped Codex event appends another branch.
- **Suggested:** Dispatch table keyed on `eventName`; default returns `{ events: [], eventName }`. Lower priority than #1–#4 because the function is comparatively flat and each branch is short.
- **Risk:** low — covered by `otel-normalizer.test.ts`.
- **Effort:** S
- **API-preserving:** yes.
- **Tests:** `otel-normalizer.test.ts`.

### 6. `events.ts` ↔ `schemas.ts` shape duplication (DRY, drift risk)

- **Location:** `events.ts:17-127` and `schemas.ts:14-113`
- **Principle:** DRY / single source of truth
- **Current:** Every event interface in `events.ts` is hand-mirrored by a Zod schema in `schemas.ts` (e.g. `NoticeEvent` ↔ `NoticeEventSchema`, the full union ↔ `HookDerivedEventSchema`). Two definitions of the same contract must be kept in lockstep manually; a field added in one and not the other silently drifts. Additionally `isHookDerivedEvent` (`events.ts:118-127`) hardcodes the same six discriminant strings a **third** time.
- **Suggested:** Make Zod the single source of truth and derive the TS types via `z.infer<typeof XSchema>` (re-export the inferred types from `events.ts` to preserve the public type names). Derive `isHookDerivedEvent` and `HookDerivedEventType` from the schema's discriminant set rather than a literal array.
- **Risk:** medium — this changes how the public *types* are produced. Inferred Zod types are structurally compatible but not always nominally identical (e.g. `.optional()` → `T | undefined` matches the existing `?: T | undefined` style here, so it should be clean — but it touches the public type surface, so verify downstream `tsc` across consumers).
- **Effort:** M
- **API-preserving:** no — it alters how exported types are defined (even if structurally equivalent, this is a public-symbol change and must be type-checked across all consumers; out of scope for the automated low/medium apiPreserving apply step).
- **Tests:** add a type-level assertion test (e.g. `expectTypeOf` or a compile-time `satisfies` round-trip) plus run the full monorepo `tsc`.

### 7. Magic numbers in summary/preview truncation (smell)

- **Location:** `hook-normalizer.ts:54-104` (truncation limits 80/60), `tool-output-formatter.ts:240-242` (preview `slice(0, 10)`, `> 10`), `otel-normalizer.ts:188` (`> 200`)
- **Principle:** code smell — magic numbers
- **Current:** Display limits are inline literals scattered across functions (`truncate(command, 80)`, `truncate(filePath, 60)`, `lines.slice(0, 10)`, `prompt.length > 200`).
- **Suggested:** Hoist to named module constants (`CMD_TRUNCATE = 80`, `PATH_TRUNCATE = 60`, `WRITE_PREVIEW_LINES = 10`, `PROMPT_TRUNCATE = 200`). Documents intent and centralizes tuning.
- **Risk:** low
- **Effort:** S
- **API-preserving:** yes.
- **Tests:** existing normalizer tests.

## Code Smells

| Smell | Location | Detail | Severity |
|-------|----------|--------|----------|
| Long function | `tool-output-formatter.ts:176-269` | `formatToolOutput` ~94 lines, 3 concerns | high |
| Long function | `hook-normalizer.ts:166-293` | `normalizeClaudeHook` 127 lines, 7 branches | medium |
| Long function | `pi-normalizer.ts:152-227` | `normalizePiPayload` ~75 lines | medium |
| Switch/if-chain keyed on name | `hook-normalizer.ts` (formatToolSummary 48-108 + normalize), `otel`, `pi` | grows one branch per case (OCP) | medium |
| Duplicated block | `tool-output-formatter.ts:111-120` vs `164-172` | identical edit-summary builder | medium |
| Duplicated extraction | `pi-normalizer.ts:154,168,181` | same 4-key `toolUseId` lookup ×3 | low |
| Duplicated contract | `events.ts` vs `schemas.ts` (+ `isHookDerivedEvent` literal list) | three hand-synced copies of the event shape | medium |
| Magic numbers | hook/otel/formatter (80/60/10/200) | inline display limits | low |
| Nesting depth ≥4 | `tool-output-formatter.ts:208-262` | `if(!isError){ if(tool===Write){ if(filePath&&content){...}}}` | low |
| Primitive obsession (string keys) | `formatToolOutput` 219-238 langMap, response key probing | string-typed routing throughout (inherent to normalizer role; acceptable) | info |
| Missing test coverage | `tool-output-formatter.ts` | no dedicated test for the most complex pure logic | high |

No long parameter lists (>4) found — all multi-arg functions use an options object. No feature envy (pure functions, no cross-object reaching). No LSP/DIP issues.

## Quick Wins

- Extract `summarizeEdit(added, removed)` to kill the duplicated 10-line block in `tool-output-formatter.ts` (#2).
- Hoist truncation/preview magic numbers to named constants (#7).
- Hoist the repeated `toolUseId` 4-key lookup to a single `const` at the top of `normalizePiPayload` (part of #4).
- Add `tool-output-formatter.test.ts` characterization tests — closes the biggest coverage gap and unblocks the safe refactor of #1.

## Technical Debt Notes

- The three normalizers (`hook`, `otel`, `pi`) independently re-implement the same defensive accessor helpers: `asRecord`/`asToolInputRecord`, `getString`, `getBoolean`, `getRecord`. `getString` exists in all three with slightly different signatures (single-key vs variadic-key). These could live in a shared `internal/record-access.ts` to stop the drift, but doing so couples the normalizers; weigh against keeping each normalizer self-contained. Low priority.
- `events.ts` / `schemas.ts` duplication (#6) is the highest-value structural cleanup but the riskiest because it touches the public type surface; treat as a deliberate, separately-reviewed change rather than part of an automated pass.
- The OCP dispatch-table refactors (#3, #4, #5) are individually low-risk because each branch already has direct test coverage; they are the cleanest improvements per unit of risk.

## Safety Checklist

- [ ] Add `tool-output-formatter.test.ts` (characterization) BEFORE touching #1/#2.
- [ ] Run `bun test` in `packages/hrc-events` before and after each change (suite is fast, fully unit-level).
- [ ] Keep all exported signatures in `index.ts` byte-identical for #1–#5 and #7 (apiPreserving).
- [ ] Treat #6 (events/schemas unification) as a separate change: run full-monorepo `tsc` to confirm no consumer type breakage; it is NOT apiPreserving.
- [ ] No IO/DI/process state involved — no integration or daemon-restart validation needed for #1–#5, #7.
- [ ] Verify `diff` (`diffLines`) output ordering is unchanged after the #1 extraction (the line-diff fallback is order-sensitive).
