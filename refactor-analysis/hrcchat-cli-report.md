# Refactor Audit — `packages/hrcchat-cli/`

Behavior-preserving refactor pass. Read of all non-test `src/*.ts` and `src/commands/*.ts`.
No source files were edited in this phase; report only.

## Package shape

- Bin entry: `src/main.ts` (commander program; the `hrcchat` CLI). The package
  exposes **no `index.ts` barrel** and `package.json` ships only `dist` with a
  single `bin`. The exported functions in `render-frame.ts`, `stacked-aggregator.ts`,
  `stacked-summary.ts`, `stacked-types.ts`, `normalize.ts`, `resolve-intent.ts`,
  `domain-error-format.ts`, `consul-secrets.ts` are consumed by **in-package tests**
  (and `cmdTurn` re-uses them). No other package imports `hrcchat-cli` except one
  `hrc-server` acceptance test that shells the CLI, not its symbols.
- Practical consequence for safety: there is no published module API map, but the
  emitted **NDJSON/`turn_stacked` JSON contract** (field order, key names, exit
  codes) IS a runtime/public contract for downstream hosts (Monitor tool, `hrc
  monitor wait`). Anything that changes those shapes is `public-surface` and DEFERRED.

## SOLID scorecard

| Principle | Grade | Notes |
|-----------|-------|-------|
| S — Single Responsibility | C+ | `stacked-aggregator.ts` (511) and `render-frame.ts` (507) each mix several concerns; `cmdTurn` (479, one function ~330 lines) interleaves arg-parse, dispatch, watch-loop, exit-code policy. |
| O — Open/Closed | B | A few enum-keyed switch/if-chains for `eventKind`/`phase`/`flush` but they are exhaustive and small; growth pressure is low. |
| L — Liskov | A | No bad overrides, no "not implemented" throws, no base-behavior drops. |
| I — Interface Segregation | A- | Interfaces are small (`Summarizer` has 1 method; `TerminalFrameRenderer` 1). No fat interfaces. |
| D — Dependency Inversion | A- | Strong seams: timers, `now`, summarizer, anthropic client, consul `kvGet`, streams all injectable. Only `main.ts` `createClient()` hardcodes `new HrcClient` (acceptable at composition root). |

Overall the package is well-factored for a CLI. Findings are mostly **local extractions** and **named constants**, all internal-only and low risk. The two genuinely large units (`cmdTurn`, the aggregator) are the meaningful S-targets.

---

## Priority Refactorings

### P1 — `cmdTurn` is a ~330-line function with 5 distinct responsibilities
- **Location:** `src/commands/turn.ts:63` (`cmdTurn`, lines 63–392)
- **Principle/smell:** S (Single Responsibility); long method; deep nesting in the watch loop.
- **Current:** One function does: (1) body-source mutex + read, (2) duration/flag validation, (3) scope resolution + `--dry-run` print, (4) project-required guard, (5) `--new` clearContext, (6) handoff dispatch, (7) sink-format resolution, (8) the `for await` watch loop with stacked-vs-frame branching, (9) terminal-event/exit-code determination across `catch`/`finally` and post-loop blocks.
- **Suggested:** Extract private helpers within the file (no signature change to `cmdTurn`):
  `resolveTurnBody(opts, positionals)`, `validateStackedFlags(opts)`,
  `buildDryRunPlan(...)`, `runWatchLoop(...)`, `finalizeExitCode(lastPhase, turnCompleted, stackedAggregator)`.
  Keep all exports and behavior identical; this is pure decomposition.
- **Risk:** Med (logic-dense; stall/SIGINT/abort interplay must be preserved exactly).
- **API-impact:** internal-only (no exported-signature change; exit codes preserved).
- **Effort:** M (2–3h, careful).
- **Tests:** `src/__tests__/turn.test.ts` exercises this path — run after each extraction.

### P2 — `StackedAggregator` mixes timer scheduling, flush queueing, event classification, and line building
- **Location:** `src/stacked-aggregator.ts:64` (class) + free functions 420–511.
- **Principle/smell:** S (SRP); class has ~14 methods spanning 3 concerns (timer lifecycle, flush pipeline, JSON line construction).
- **Current:** `buildLine` (351–406) is a 55-line method that also owns the load-bearing key-order contract; `phaseForFlush`, `summarizeSafely`, `enqueueFlush`, `flush` are all in one class.
- **Suggested:** Extract `buildLine` into a private module-level pure function `buildStackedLine(input, opts, handoff, stackSeq)` (already nearly pure — only reads `this.options`/`this.stackSeq`/`++this.stackSeq`). Pass the incremented seq in. Keeps timer/flush state in the class. Low-risk because the function is already structured as a single return object.
- **Risk:** Med (the JSON key order is a downstream truncation contract — extraction must preserve insertion order byte-for-byte).
- **API-impact:** internal-only IF the emitted line shape is unchanged; the **emitted `turn_stacked` JSON itself is public-surface**, so the extraction is safe ONLY as a behavior-preserving move. Flag the contract, do not alter it.
- **Effort:** M.
- **Tests:** `src/__tests__/stacked-aggregator.test.ts`.

### P3 — `renderFrameToTerminalText` is a 90-line orchestrator with inline section logic
- **Location:** `src/render-frame.ts:285` (`renderFrameToTerminalText`, 285–372).
- **Principle/smell:** S (SRP); long method composed of header/title/status/permission/activity/answer/footer sections inline.
- **Current:** Each `── section ──` comment block builds into a shared `lines` array; the activity-skip math and answer separator live inline.
- **Suggested:** Extract per-section private helpers returning `string[]`: `headerLines`, `titleLines`, `permissionLines` (partly exists via `renderPermissionActions`), `activityLines`, `answerLines`, then concatenate. All helpers already have the inputs to be pure.
- **Risk:** Low (pure string assembly; output identical).
- **API-impact:** internal-only (the exported function signature/output unchanged).
- **Effort:** M.
- **Tests:** `src/__tests__/render-frame.test.ts`.

### P4 — Duplicated `isRecord` (and divergent `isTurnEnd`) definitions
- **Location:** `src/commands/turn.ts:477` (`isRecord`) duplicates `src/stacked-shared.ts:34`; `src/commands/turn.ts:394` (`isTurnEnd` — matches `turn_end` OR `turn.completed`) overlaps `src/stacked-aggregator.ts:420` (`isTurnEnd` — only `turn.completed`).
- **Principle/smell:** Duplicated block; primitive-obsession on event-kind string checks scattered across files.
- **Current:** `turn.ts` defines its own private `isRecord` even though `stacked-shared.ts` already exports one. The two `isTurnEnd` functions have **subtly different** semantics (turn.ts also accepts `turn_end`), which is a latent confusion, not a bug.
- **Suggested:** Import `isRecord` from `stacked-shared.js` in `turn.ts` and delete the local copy (behavior identical). Leave the two `isTurnEnd` variants alone — do NOT unify them (semantics differ; unifying changes terminal-event detection). Dedup `isRecord` only.
- **Risk:** Low (for the `isRecord` dedup only).
- **API-impact:** internal-only.
- **Effort:** S.
- **Tests:** `turn.test.ts`.

### P5 — Repeated `err instanceof Error ? err.message : String(err)` idiom
- **Location:** `src/commands/doctor.ts:33,59,116` (3×).
- **Principle/smell:** Duplicated block.
- **Current:** The `instanceof Error ? .message : String()` idiom appears 3 times in `cmdDoctor`.
- **Suggested:** Extract a private `errDetail(err: unknown): string` helper in `doctor.ts`.
- **Risk:** Low.
- **API-impact:** internal-only.
- **Effort:** S.
- **Tests:** no dedicated doctor test found; behavior identical (noted in Tech Debt).

---

## Code Smells

| # | Location | Smell | Detail | Risk | API-impact |
|---|----------|-------|--------|------|------------|
| 1 | `stacked-aggregator.ts:497,505` | Magic numbers | `cap = 4_096`, `truncateFinalBody(text, 1_000)` inline defaults | Low | internal-only |
| 2 | `stacked-aggregator.ts:494` | Magic regex / primitive obsession | `T-\d+` task-id regex inlined in `extractTaskId`; also computed twice in `buildLine` (392–394) | Low | internal-only |
| 3 | `render-frame.ts:92,153,167-169` | Magic numbers | `100` (title cap), `120` (col clamp), `12`/`6`/`2` clamps in `renderBlockLines` — only some are named constants | Low | internal-only |
| 4 | `stacked-summary.ts:219-230` | Inefficiency | `boundString` calls `new TextEncoder().encode` repeatedly (incl. in a `while` trim loop) | Low | internal-only |
| 5 | `stacked-aggregator.ts:392-394` | Duplicated call | `extractTaskId(this.options.targetScope)` invoked twice (condition + value) | Low | internal-only |
| 6 | `commands/turn.ts:300-332` | Deep nesting (4+) | watch-loop branches: stacked vs frame, terminal-event, runtime-dead all nested in `for await` inside `try` | Med | internal-only |
| 7 | `commands/turn.ts:337-339` | Control-flow smell | `catch` block with a comment-only `if (turnCompleted) { /* fall through */ }` empty branch | Low | internal-only |
| 8 | `resolve-intent.ts:70-72` | Magic transform | `schema_version`→`schemaVersion` regex rewrite of TOML source is surprising; deserves a named helper | Low | internal-only |
| 9 | `commands/summon.ts:20` vs `commands/turn.ts:121` | Inconsistent await | `await resolveRuntimeIntentForTarget(...)` (summon) vs non-await (turn); the function is **synchronous** (returns `HrcRuntimeIntent`) — the `await` in summon is a harmless no-op but misleading | Low | internal-only |
| 10 | `stacked-summary.ts` & `stacked-aggregator.ts` | Enum/string union sprawl | `FlushReason \| \`${FlushReason}\`` accepted in many signatures (string-or-enum) — primitive obsession around the enum boundary | Low | public-surface (type contract) |

---

## Quick Wins (safe, internal-only, Low risk — recommended to auto-apply)

1. **Dedup `isRecord` in `turn.ts`** — import from `stacked-shared.js`, delete local (P4). `turn.ts:477`.
2. **Name the magic caps** — `FINAL_BODY_CAP = 4_096`, `TOOL_INPUT_CAP = 1_000` constants in `stacked-aggregator.ts` (smell #1).
3. **Hoist duplicated `extractTaskId` call** in `buildLine` to a `const taskId = extractTaskId(...)` (smell #5), `stacked-aggregator.ts:392`.
4. **Extract `errDetail` helper** in `doctor.ts` for the 3× `instanceof Error` idiom (P5).
5. **Name remaining render-frame magic numbers** (`MAX_TITLE_CHARS = 100`, `MAX_TERMINAL_WIDTH = 120`) (smell #3).
6. **Cache the `TextEncoder`** in `stacked-summary.ts boundString` to one instance (smell #4) — keep behavior identical.
7. **Remove the comment-only `if (turnCompleted)` empty branch** in `turn.ts` catch by restructuring (smell #7) — behavior-preserving de-nesting.

## Technical Debt notes

- **No `index.ts` / no exports map**: the package leans on file-path imports and tests
  for its "API". Fine for a private CLI, but means there's no single seam declaring
  what's public. Decomposing `cmdTurn`/aggregator is safe precisely because nothing
  external imports their internals.
- **`turn_stacked` JSON key order is a load-bearing contract** (documented in
  `stacked-types.ts:54` and `stacked-aggregator.ts:367`). Any aggregator refactor must
  preserve insertion order. This is the single highest-care invariant in the package —
  flagged as DEFERRED for the line-shape itself.
- **Two divergent `isTurnEnd` definitions** (turn.ts accepts `turn_end`; aggregator
  only `turn.completed`). Looks like drift; unifying would change terminal detection.
  Leave as-is, document — do not "fix" in a behavior-preserving pass.
- **`doctor.ts` has no dedicated unit test**; it also calls `process.exit(1)` directly
  (line 134) rather than throwing a typed exit error like `turn.ts` does. Inconsistent
  exit policy across commands — a future (non-preserving) cleanup, DEFERRED.
- **`resolve-intent.ts` reads TOML and rewrites `schema_version`**: an IO + parse +
  merge unit; reasonably cohesive but the regex rewrite is a smell worth a named helper.
- **`summon.ts` awaits a synchronous function** — harmless now, but the inconsistency
  invites bugs. Aligning is a 1-line change but touches a command's control flow; note only.
