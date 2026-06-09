# Refactor Analysis — `packages/hrc-events`

Behavior-preserving refactor audit. Report only; no source edited in this phase.

## Package shape

| File | LOC | Role |
|---|---|---|
| `src/tool-output-formatter.ts` | 312 | Coerce/render tool responses (Write/Edit diff rendering) |
| `src/hook-normalizer.ts` | 298 | Claude Code hook payload → `HookDerivedEvent[]` |
| `src/pi-normalizer.ts` | 267 | Pi hook envelope → derived + semantic events |
| `src/otel-normalizer.ts` | 225 | Codex OTEL record → `HookDerivedEvent[]` |
| `src/monitor-schema.ts` | 168 | Zod schema for `hrc monitor` output (`MonitorEvent`) |
| `src/events.ts` | 127 | Event type interfaces + `isHookDerivedEvent` guard |
| `src/schemas.ts` | 112 | Zod schemas mirroring `events.ts` |
| `src/index.ts` | 65 | Public barrel |

This is a small, pure, well-documented package: every public function is a pure normalizer/formatter with no IO or DI collaborators. There is no DIP/Liskov/ISG exposure of note (no classes, no inheritance, no fat interfaces). Findings are concentrated in three structurally identical long if-chain dispatchers and some helper duplication.

## SOLID scorecard

| Principle | Grade | Notes |
|---|---|---|
| SRP | B | Files are reasonably scoped, but three normalizer entrypoints (`normalizeClaudeHook` 127 LOC, `normalizeCodexOtelEvent` 99 LOC, `normalizePiPayload` 74 LOC) each mix dispatch + per-case construction in one long function. |
| OCP | B- | Three `if (name === ...)`/`switch (toolName)` chains keyed on an event/tool name that grow one branch per new case. Acceptable for a closed vocabulary; flagged as the dominant structural smell. |
| LSP | A | No inheritance, no overrides, no type-narrowing-before-call. N/A in practice. |
| ISP | A | No interfaces > 10 members; the exported types are plain data DTOs. |
| DIP | A | All functions pure; `diffLines` from `diff` and `z` from `zod` are leaf deps, not injected collaborators — no concrete-collaborator `new` in business logic. |

Overall: **B+**. Healthy package; the work is dedupe + extracting per-case handlers out of long dispatchers, all internal-only.

## Priority refactorings

### P1 — Duplicated `asToolInputRecord` helper across two files
- **Location:** `src/tool-output-formatter.ts:51-54` and `src/hook-normalizer.ts:37-40`
- **Current:** Byte-identical private helper `asToolInputRecord(value): Record<string,unknown> | undefined` defined twice.
- **Suggested:** Extract to a private internal helper module and import. Keep it un-exported from the barrel so the public surface is unchanged.
- **Risk:** Low
- **API-impact:** internal-only
- **Effort:** S (~10 min)
- **Tests:** No direct test; both call sites are exercised by `hook-normalizer.test.ts` and the Edit/Write paths in tool-output formatting. Behavior identical.

### P2 — `normalizeClaudeHook` is a 127-line if-chain dispatcher (SRP/OCP)
- **Location:** `src/hook-normalizer.ts:171-298`
- **Current:** One function reads the hook name, then a flat `if (hookName === 'PreToolUse') {...} if (hookName === 'PostToolUse') {...}` chain, each block ~15-30 lines building a `NormalizeHookResult`.
- **Suggested:** Extract each branch to a private `handlePreToolUse(unwrapped, ctx)`, `handlePostToolUse(...)`, etc., returning `NormalizeHookResult`; the entrypoint becomes a thin dispatch table `Record<string, Handler>` (mirrors the existing `toolRenderers` table pattern already in `tool-output-formatter.ts`). Pure mechanical extraction — same inputs/outputs.
- **Risk:** Low
- **API-impact:** internal-only (entrypoint signature unchanged)
- **Effort:** M (~30-40 min)
- **Tests:** `__tests__/hook-normalizer.test.ts` covers the branches; re-run after extraction.

### P3 — `normalizeCodexOtelEvent` is a 99-line if-chain dispatcher (SRP/OCP)
- **Location:** `src/otel-normalizer.ts:126-225`
- **Current:** Flat `if (eventName === 'codex.tool_decision') {...} if (eventName === 'codex.tool_result') {...}` chain, each ~15-30 lines.
- **Suggested:** Extract per-event handlers (`handleToolDecision`, `handleToolResult`, `handleUserPrompt`, `handleConversationStart`) and dispatch by name; entrypoint stays thin. Behavior-preserving.
- **Risk:** Low
- **API-impact:** internal-only
- **Effort:** M (~30 min)
- **Tests:** `__tests__/otel-normalizer.test.ts` covers the mapped events; re-run.

### P4 — `normalizePiPayload` is a 74-line if-chain dispatcher (SRP/OCP)
- **Location:** `src/pi-normalizer.ts:152-226`
- **Current:** Flat `if (eventName === 'tool_execution_start') {...}` chain; the message_start/update/end branch (lines 195-215) builds two near-identical objects differing only by `role`.
- **Suggested:** Extract per-event handlers and dispatch by name. Within the message branch, collapse the user/assistant ternary to a single object literal with a computed `role` (the two arms are structurally identical — see Quick Win QW2).
- **Risk:** Low
- **API-impact:** internal-only
- **Effort:** M (~30 min)
- **Tests:** `__tests__/pi-normalizer.test.ts`; re-run.

### P5 — Inline `langMap` magic table + 38-line `Write` renderer
- **Location:** `src/tool-output-formatter.ts:237-256` (langMap), renderer `227-265`
- **Current:** A 17-entry extension→language map is allocated inline on every `Write` render call, inside a ~38-line arrow renderer.
- **Suggested:** Hoist `langMap` to a module-level `const LANG_BY_EXT` (also avoids per-call allocation) and optionally split the preview-building into a small private helper. Pure internal change.
- **Risk:** Low
- **API-impact:** internal-only
- **Effort:** S (~10 min)
- **Tests:** No dedicated test for the Write renderer path; covered indirectly via PostToolUse formatting. Output string must remain byte-identical — verify the hoisted map has identical entries.

### P6 — Duplicated diff-output construction between structured-patch and line-diff builders
- **Location:** `src/tool-output-formatter.ts:89-131` (`buildEditOutputFromStructuredPatches`) and `142-177` (`buildEditOutputFromLineDiff`)
- **Current:** Two builders independently emit the `${line}|c|`, `${line}|+|`, `${line}|-|` format, both compute `added`/`removed`, both finish with `summarizeEdit(...)` + `[summary, ...outputLines].join('\n')`.
- **Suggested:** Extract a shared private `renderEditLines(lines, added, removed)` tail that produces the final `{output, added, removed}` envelope; keep the two prefix-emitting loops distinct (they walk different shapes). Modest dedupe only.
- **Risk:** Low
- **API-impact:** internal-only
- **Effort:** S (~15 min)
- **Tests:** Edit-path behavior — output format is load-bearing (consumed downstream for diff rendering). Keep strings identical; re-run hook-normalizer Edit cases.

## Code smells

| # | Location | Smell | Note |
|---|---|---|---|
| CS1 | `hook-normalizer.ts:37-45`, `otel-normalizer.ts:52-59`, `pi-normalizer.ts:71-77` | Duplicated `getString` helper (3 variants) | Three slightly different `getString`/`getAttrString` helpers (single-key vs variadic vs attrs-aware). Could consolidate the two single-key ones; the variadic Pi one and attrs one differ enough to leave. Low value. |
| CS2 | `hook-normalizer.ts:53-113` | Long method + switch chain | `formatToolSummary` 60 LOC `switch (toolName)`; OCP grows per tool. **Public export** — could become a `Record<tool, (input)=>string>` table internally, but it is exported, so any refactor must preserve the exact signature/output. Defer the riskier table swap. |
| CS3 | `tool-output-formatter.ts:237-256` | Magic data inline | `langMap` allocated per call (see P5). |
| CS4 | `pi-normalizer.ts:200-214` | Duplicated block | user/assistant arms differ only by literal `role`; collapse (QW2). |
| CS5 | `pi-normalizer.ts:51-63` | Nested ternary | `extractPiEventName` triple-nested ternary; readable but could be a loop over key candidates. Cosmetic. |
| CS6 | `hook-normalizer.ts:269-272` | Awkward conditional | `(agentType ?? agentId) ? ... : 'subagent'` — grouped-coalesce-as-boolean is hard to read; an early `if (!agentType && !agentId)` would be clearer. Cosmetic, Low. |
| CS7 | `events.ts:118-126` & `schemas.ts:105-112` | Parallel maintenance | `isHookDerivedEvent`'s string array and `HookDerivedEventSchema`'s union must be kept in sync by hand with the `HookDerivedEvent` union. No bug today; note as drift risk. Changing it touches the public guard/schema → defer. |

## Quick wins (safe, internal-only)

- **QW1 (P1):** Dedupe `asToolInputRecord` into one private helper. ~10 min, Low.
- **QW2 (CS4):** Collapse the Pi message user/assistant ternary (`pi-normalizer.ts:200-214`) into one object literal with computed `role`. Output unchanged. ~5 min, Low.
- **QW3 (P5):** Hoist `langMap` to module-level const. ~5 min, Low.
- **QW4 (CS6):** Replace the grouped-coalesce boolean in `subagent_start` label with an explicit early return. Cosmetic, Low.

## Technical debt notes

- **Triple normalizer parallelism (OCP):** `normalizeClaudeHook`, `normalizeCodexOtelEvent`, and `normalizePiPayload` are three independent dispatch-by-string-name functions producing overlapping `HookDerivedEvent` shapes. There is a latent opportunity for a shared `handler-table` micro-pattern, but unifying them across harness vocabularies (Claude hooks vs Codex OTEL vs Pi) would be a design change, not a behavior-preserving refactor — **out of scope for this pass.** Keep each per-harness; only do the per-file table extraction (P2/P3/P4).
- **events.ts ↔ schemas.ts ↔ guard drift (CS7):** the type union, the Zod union, and the `isHookDerivedEvent` literal array encode the same set three times. A single source of truth (deriving the array from the schema, or the schema from a const tuple) would remove drift, but it changes the exported guard/schema surface → **defer (public-surface).**
- **Edit/Write output format is a downstream contract:** the `|c|`/`|+|`/`|-|` line format and the "Created … with N lines" string are consumed by UI/event-store renderers in hrc-server. Any P5/P6 dedupe must keep the emitted strings byte-identical. Treated as Low because the suggested refactors are pure extraction, but call out in review.

## Auto-apply vs defer summary

- **Safe to auto-apply (Low, internal-only):** P1, P2, P3, P4, P5, P6 (six distinct refactorings); QW1–QW4 are subsumed by these.
- **Defer (public-surface):** CS2 (`formatToolSummary` is an exported function) and CS7 (events↔schemas↔`isHookDerivedEvent` single-source-of-truth) — both touch the public exported surface and require human sign-off. The per-file dispatcher extractions (P2/P3/P4) keep their public entrypoint signatures intact and are therefore safe.
