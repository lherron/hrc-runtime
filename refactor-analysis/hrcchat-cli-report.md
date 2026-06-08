# Refactor Analysis — `packages/hrcchat-cli/src`

Methodology: SOLID violations, code smells, complexity. Analysis only — no source edited.

## Scope

- Production TypeScript (excluding `__tests__/`): **3,251 lines** across 20 files.
- Largest / most-central units:
  - `stacked-aggregator.ts` — 537 lines (1 class, ~15 methods + 11 module helpers)
  - `render-frame.ts` — 507 lines (terminal + ndjson render, 15+ functions)
  - `commands/turn.ts` — 485 lines (1 command function, `cmdTurn`, ~330-line body)
  - `main.ts` — 334 lines (CLI wiring, dotenv loader, error mapping)
  - `stacked-summary.ts` — 274 lines (LLM summarizer + digest building)
  - `commands/dm.ts` — 160, `resolve-intent.ts` — 155, `commands/doctor.ts` — 135, `normalize.ts` — 115, `stacked-types.ts` — 100.
- Test coverage: most core modules have tests. **`resolve-intent.ts` has NO test** despite doing nontrivial TOML parsing, profile merging, and provider/harness resolution. Commands other than `turn` have no per-command test (only `smoke.test.ts` + `help-text.test.ts`).

## SOLID Scorecard

| Principle | Status | Notes |
|-----------|--------|-------|
| S — SRP | yellow | 4 files > 300 lines; `cmdTurn` mixes arg-parsing, validation, scope resolution, dispatch, streaming, exit-code policy in one 330-line body. `render-frame.ts` mixes terminal styling, layout, ndjson serialization, and a stateful renderer. |
| O — OCP | green | Phase/Flush switches are exhaustive (`never`-checked in one spot) and keyed on closed enums; new cases are rare and centralized. No problematic growing if/else chains. |
| L — LSP | green | No throwing/no-op overrides; no inheritance hierarchies beyond `extends Error`. `as HrcClient & {...}` duck-type in turn.ts is mild but guarded. |
| I — ISP | green | Interfaces are small (`Summarizer` 1 method, `TerminalFrameRenderer` 1 method). `HrcClient` is external. No fat local interfaces. |
| D — DIP | yellow | Good DI seams in `stacked-aggregator`/`stacked-summary` (timers, summarizer, anthropic-factory injected). But `main.ts` `createClient()` hardcodes `new HrcClient(discoverSocket())`; commands call `process.env`/`process.stdout`/`process.exit` directly; `resolve-intent.ts` reads filesystem inline with no injection seam (untestable). |

## Priority Refactorings

### 1. Extract duplicated `redactSecrets` / `mechanicalSummary` / `isRecord` / `stringValue` helpers
- **Location:** `stacked-aggregator.ts:512-537` and `stacked-summary.ts:232-273`
- **Principle/Smell:** DRY / duplicated blocks. `redactSecrets` is a byte-for-byte copy (4 identical regex replaces). `mechanicalSummary`, `isRecord`, `stringValue` are also duplicated verbatim. Drift here is a security risk: a redaction-rule fix applied to one copy silently leaves the other leaking secrets.
- **Current:** Two private copies of secret-redaction and event-summary logic.
- **Suggested:** New internal module `stacked-shared.ts` (or `redact.ts`) exporting `redactSecrets`, `mechanicalSummary`, `isRecord`, `stringValue`; both files import it.
- **Risk:** low. **Effort:** small. **Tests:** existing aggregator + summary tests cover both call sites; add one direct redaction test.
- **apiPreserving:** true (pure internal restructuring; no exported symbol changes).

### 2. Decompose `cmdTurn` (330-line function, mixed concerns)
- **Location:** `commands/turn.ts:65-398`
- **Principle/Smell:** SRP / long method / deep nesting. One function does: body-source mutex resolution, duration parsing, mutex validation, scope resolution, `--dry-run` branch, `--new` clearContext, handoff dispatch, sink-format resolution, renderer/aggregator construction, the watch loop, and terminal exit-code policy. The watch `try/catch/finally` plus inner conditionals reach 4+ nesting levels.
- **Current:** Single `cmdTurn` with deeply branched `stacked` vs `terminal` paths interwoven.
- **Suggested:** Extract pure helpers: `resolveTurnBody(opts, positionals)`, `validateTurnOptions(opts)`, `buildSinkPipeline(...)` (returns either an aggregator or a manager+renderer behind one `receive`/`finish` interface), and `classifyTurnExit(state)`. Collapses the two-path branching into one polymorphic sink.
- **Risk:** medium (this is the hottest path; exit codes are a tested contract). **Effort:** large. **Tests:** `turn.test.ts` exists; expand around exit-code matrix before refactor, then refactor under green.
- **apiPreserving:** true (exported surface is `cmdTurn`, `TurnExitError`, and the `TURN_EXIT_*` constants — all preserved; internal-only restructuring).

### 3. Split `render-frame.ts` into render-core vs sink/IO
- **Location:** `render-frame.ts` (whole file, 507 lines)
- **Principle/Smell:** SRP. The file owns pure formatting (`renderFrameToTerminalText`, block renderers, `styleFor`), ndjson serialization (`renderFrameToNdjsonEvent/Line`), and stateful stream IO (`createTerminalFrameRenderer`, `writeRenderFrame*` touching `process.stdout`/ANSI). The IO concerns make the pure renderers harder to reason about and the module hard to tree-shake.
- **Current:** One module mixing pure render, serialization, and stdout/ANSI writers.
- **Suggested:** `render-frame-terminal.ts` (pure text), `render-frame-ndjson.ts` (serialization), `render-frame-sink.ts` (writers + stateful renderer + format resolution). Re-export from `render-frame.ts` to preserve imports.
- **Risk:** medium (many importers; `main.ts`/`turn.ts` consume several exports). **Effort:** medium. **Tests:** `render-frame.test.ts` covers it; keep the barrel re-export so test imports are unchanged.
- **apiPreserving:** true (barrel re-export keeps every exported symbol path identical).

### 4. Add an injection seam to `resolve-intent.ts` (filesystem + env)
- **Location:** `resolve-intent.ts:27-155`
- **Principle/Smell:** DIP / untestability. `loadProjectTarget`, `resolveAgentHarness`, and `resolveRuntimeIntentForTarget` call `existsSync`/`readFileSync`/`process.env`/`getAgentsRoot()` directly. There is no test for this file precisely because it cannot be exercised without a real agents-root on disk.
- **Current:** Hardcoded `node:fs` + env reads inline in business logic.
- **Suggested:** Accept an optional `deps` param (`{ readFile, exists, env, agentsRoot }`) defaulting to the real implementations; or split the pure "merge profile → intent" step from the IO step. Then add the missing unit test.
- **Risk:** low-medium (adding optional params is non-breaking; reordering merge logic carries the only behavioral risk). **Effort:** medium. **Tests:** none today — add fresh tests against injected fakes.
- **apiPreserving:** true (add an optional trailing parameter; existing `resolveRuntimeIntentForTarget(targetInput)` call sites unaffected).

### 5. Centralize the `ASP_PROJECT ?? inferProjectIdFromCwd()` + scope-resolution idiom
- **Location:** `turn.ts:121`, `resolve-intent.ts:97`, `normalize.ts:37`
- **Principle/Smell:** Duplicated block / feature envy. The same `process.env['ASP_PROJECT'] ?? inferProjectIdFromCwd()` then `resolveQualifiedScopeInput(input, { defaultLaneId:'main', ...projectId })` pattern is repeated in three places with subtly different option spreads (one adds `taskId`).
- **Current:** Three near-identical resolution call sites.
- **Suggested:** One helper in `normalize.ts`, e.g. `resolveScope(input, { withCallerTaskId?: boolean })`, returning the resolved bundle. Reduces drift between turn-path and dm-path scope resolution.
- **Risk:** low. **Effort:** small. **Tests:** `normalize.test.ts` exists; extend it.
- **apiPreserving:** true (new internal helper; existing exports unchanged).

### 6. Inject client/IO seams in `main.ts` and commands (`process.exit`, `process.stdout`)
- **Location:** `main.ts:68-71`, `commands/doctor.ts:134`, command stdout writes throughout
- **Principle/Smell:** DIP / hidden global coupling. `createClient()` hardcodes `new HrcClient(discoverSocket())`. `cmdDoctor` calls `process.exit(1)` directly (every other command throws a typed error to `main.ts`). Commands write to `process.stdout` directly rather than an injected sink.
- **Current:** Concrete construction + direct process calls scattered.
- **Suggested:** Pass a client factory and an output sink into the command layer; have `cmdDoctor` throw a typed exit error (mirroring `TurnExitError`) so exit policy lives only in `main.ts`.
- **Risk:** medium (touches CLI wiring + the doctor exit contract). **Effort:** medium. **Tests:** add doctor command test; smoke test guards wiring.
- **apiPreserving:** false (changing `cmdDoctor` to throw instead of `process.exit`, and adding required injected params, alters the command signatures / observable exit behavior).

## Code Smells

| Smell | Location | Detail |
|-------|----------|--------|
| Long method | `turn.ts:65-398` (`cmdTurn` ~330 lines) | Far over the 50-line guideline; multiple concerns. |
| Long method | `render-frame.ts:285-372` (`renderFrameToTerminalText` ~87 lines) | Sequential layout sections; candidate for section helpers. |
| Duplicated block | `stacked-aggregator.ts:512-537` vs `stacked-summary.ts:232-273` | `redactSecrets`+`mechanicalSummary`+`isRecord`+`stringValue` copied. |
| Duplicated block | `turn.ts:483`, `stacked-aggregator.ts:535`, `stacked-summary.ts:272` | `isRecord` defined 3×. |
| Duplicated idiom | `turn.ts:121`, `resolve-intent.ts:97`, `normalize.ts:37` | `ASP_PROJECT ?? inferProjectIdFromCwd()` + `resolveQualifiedScopeInput`. |
| Magic numbers | `render-frame.ts` (96, 200, 48, 120, 8, 3), `stacked-aggregator.ts:496` (4096), `:509` (1000) | Several extracted to consts already; truncation caps (4096/1000) are inline magic. |
| Primitive obsession | `stacked-aggregator.ts:238` etc. (`FlushReason | \`${FlushReason}\`` everywhere) | The string-literal union shadowing the enum is threaded through ~8 signatures; pick one representation. |
| Deep nesting | `turn.ts:296-361` (watch loop try/catch + inner ifs) | 4+ levels; the abort/stall/sigint disambiguation is hard to follow. |
| Feature envy | `dm.ts:129-160` (`buildHandoffEnvelope`) | Reaches deep into `SemanticDmResponse` shape (3-level `??` fallbacks); arguably belongs nearer the response type. |
| Inconsistent exit policy | `doctor.ts:134` `process.exit(1)` vs typed errors elsewhere | One command bypasses the central error mapper in `main.ts`. |
| Repeated truncation logic | `truncateFinalBody`/`truncateText`/`boundString`/`truncateToolOutput` across 3 files | 4 distinct truncate helpers with overlapping intent. |

## Quick Wins

- Extract `redactSecrets` (and the 3 other duplicated helpers) into one shared module — eliminates the security-relevant divergence risk. (Refactoring #1)
- Hoist the two inline truncation caps in `stacked-aggregator.ts` (`4_096` final-body, `1_000` redact-and-truncate) to named constants alongside the others.
- Collapse the triple `isRecord` definition into the shared module.
- Add the missing `resolve-intent.ts` unit test (currently the only core module with zero coverage).
- Make `cmdDoctor` throw a typed exit error instead of `process.exit(1)` so exit handling is uniform (small, but note it changes observable behavior — see #6).

## Technical Debt Notes

- The `FlushReason | \`${FlushReason}\`` / `Phase | \`${Phase}\`` dual representation (string-literal union *and* enum) appears in `stacked-types.ts`, `stacked-aggregator.ts`, and `stacked-summary.ts`. It exists to accept both enum members and raw strings at boundaries, but it forces casts (`input.flush as FlushReason`) and complicates every signature. Consider normalizing at the boundary once and using the enum internally.
- `buildLine` in `stacked-aggregator.ts:350-405` documents that JSON key order is load-bearing (downstream truncates ~500 chars). This is a fragile implicit contract — worth a serialization test that asserts key ordering so a future reorder is caught.
- `findDurableReply` in `turn.ts:459` does a runtime `typeof client.listMessages !== 'function'` duck-type because the SDK type may not expose it. This is a DIP smell rooted in the external `HrcClient` surface; track upstream to make `listMessages` a guaranteed method.
- No per-command tests for `dm`, `doctor`, `send`, `messages`, `who`, `show`, `peek`, `summon`, `info` — only smoke + help-text. The handoff-envelope and reply-anchor self-heal logic in `dm.ts` is untested business logic.

## Safety Checklist

- [ ] Run `bun test` in `packages/hrcchat-cli` before and after each refactor; keep green.
- [ ] For #2/#3 (apiPreserving via barrel/internal-only), confirm no exported symbol path changes — grep importers across the monorepo (`turn.ts`, `main.ts`, downstream packages).
- [ ] For #1, add a direct redaction test (AKIA / sk-ant / Bearer eyJ / key=val) before merging shared module.
- [ ] For #4, default the new `deps` param so all existing `resolveRuntimeIntentForTarget(targetInput)` call sites compile unchanged.
- [ ] Do NOT bundle #6 (doctor exit-policy change) with the apiPreserving items — it changes observable exit behavior and needs its own review.
- [ ] Add a key-order assertion test for `buildLine` before touching `stacked-aggregator.ts`.
- [ ] Verify the `--stacked`/`--follow` ndjson line shape is byte-stable (golden test) before decomposing `cmdTurn`.
