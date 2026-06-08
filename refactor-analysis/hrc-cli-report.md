# Refactor Analysis — `packages/hrc-cli/src`

Analysis only. No source files were modified. Production scope: 8 `.ts` files, **7,654 lines** (excluding `__tests__/`). The package is a flat directory with one dominant file (`cli.ts`, 4,005 lines) and a four-file monitor sub-system (`monitor-render.ts` 1,042, `monitor-watch.ts` 817, `monitor-wait.ts` 533, `monitor-show.ts` 384), plus two leaf helpers (`print.ts` 9, `runtime-args.ts` 8).

Test coverage is substantial (12 test files incl. a 90 KB `cli.test.ts`), so most refactors below have a regression net — but several `cmd*` handlers are exercised only end-to-end via the smoke/cli tests, not in isolation, because they are not exported.

---

## SOLID Scorecard

| Principle | Grade | Notes |
|-----------|-------|-------|
| **S**RP | 🔴 red | `cli.ts` (4,005 lines) is parser-glue + ~40 command handlers + human/JSON formatters + daemon lifecycle + .env loader + usage text, all in one module. `monitor-render.ts` mixes 5 renderer classes with ~50 free formatting functions. |
| **O**CP | 🟡 yellow | Renderer selection is a clean factory (good). But adding any bridge/runtime subcommand requires editing the monolithic `buildProgram()` AND adding a parallel `cmd*` + `toLegacyArgv` schema; per-tool formatting in `monitor-render.ts` is an extendable-by-edit `if (isShellTool) … formatReadInput … formatEditInput` chain. |
| **L**SP | 🟢 green | The `MonitorRenderer` interface (`push`/`flush`) is honored uniformly by all four implementors; no throwing/no-op overrides found. |
| **I**SP | 🟡 yellow | `MonitorRenderer` interface itself is small/clean. But `ServerRuntimeStatus` (cli-runtime.ts) is a fat 30+-field record with redundant shapes (`pid`+`daemon.pid`, `socketPath`+`socket.path`, `running`+`daemon.running`) — consumers depend on overlapping projections. |
| **D**IP | 🔴 red | Every handler calls a module-private `createClient()` that hard-codes `discoverSocket()` + `new HrcClient()`. No injection seam → handlers are not unit-testable without a live daemon socket. Same pattern in `cli-runtime.ts` (`new Database(path)`, `new HrcClient(paths.socketPath)`). |

---

## Priority Refactorings

Ranked by impact × confidence. Risk and `apiPreserving` flags are set for the downstream apply step (only low/medium + apiPreserving items will be auto-applied).

### 1. Split `cli.ts` into command modules
- **Principle:** SRP / module cohesion
- **Location:** `cli.ts:1-4005` (whole file)
- **Current:** One 4,005-line file holds: `.env.local` loader, arg helpers, scope resolution, intent builders, ~40 `cmd*` handlers, ~12 `print*Human`/`print*Ndjson` formatters, daemon-lifecycle commands, the `INFO_TEXT`/usage blobs, and the entire commander `buildProgram()` wiring.
- **Suggested:** Extract by command group into sibling modules that mirror the already-separate monitor files: `commands/server.ts`, `commands/session.ts`, `commands/runtime.ts`, `commands/bridge.ts`, `commands/surface.ts`, `commands/scope.ts` (run/start/attach), plus `formatters.ts` (the `print*` pair functions) and `usage-text.ts` (the two large string constants). `cli.ts` becomes the commander wiring + `main()` only. Internal-only move — exported symbols (`main`, `harnessStringToHarnessId`, `resolveAgentHarness`, `chooseDefaultProjectId`, `selectLatestUsableRuntime`, `attachOpenAiRuntime`, `explainScopeCommandError`) keep their signatures and can be re-exported from `cli.ts`.
- **Risk:** medium
- **Effort:** large
- **apiPreserving:** true (pure file split + re-export; no public signature changes)
- **Tests:** `cli.test.ts`, `smoke.test.ts`, `cli-intent.test.ts`, `choose-default-project-id.test.ts`, `explain-scope-command-error.test.ts` already cover the surface; run full suite after each extracted module.

### 2. Collapse the `toLegacyArgv` round-trip glue
- **Principle:** SRP / DRY / accidental complexity
- **Location:** `cli.ts:180-309` (`toLegacyArgv`, `toLegacyArgvForScopeCommand`, `camelCase`) and every `.action()` in `buildProgram()` (cli.ts:3140-3939)
- **Current:** Commander parses options, then each action *re-serializes* opts back into a `string[]` legacy argv via `toLegacyArgv(..., {strings, booleans, negatedBooleans})`, which the `cmd*` handler then *re-parses* with `parseFlag`/`hasFlag`. Every handler re-parses flags it already had structured. Plus an 8×-duplicated `while (root.parent) root = root.parent; const fullRaw = root.rawArgs ?? process.argv; const idx = fullRaw.indexOf(<verb>)` block (cli.ts:3509, 3580, 3611, 3622, 3632, 3654, 3671, 3691) to recover negated booleans commander collapses.
- **Suggested:** Make `cmd*` handlers accept a typed options object instead of `string[]`. Delete the parse→serialize→reparse trip. If a full cutover is too large, first factor the duplicated raw-argv walk-up into one `rawArgvForVerb(cmd, verb)` helper (low risk, immediate dedupe).
- **Risk:** high for the full handler-signature cutover; **low** for the `rawArgvForVerb` helper extraction alone
- **Effort:** large (full) / small (helper)
- **apiPreserving:** true (all of this is module-internal)
- **Tests:** `cli.test.ts` exercises flag parsing per command; the `terminate --no-drop-continuation` and `run`/`start` mutual-exclusion paths are the highest-value cases to keep green.

### 3. Inject the HRC client (DIP seam)
- **Principle:** DIP / testability
- **Location:** `cli.ts:119-122` (`createClient`) used by ~30 handlers; `cli-runtime.ts:334, 579` (`new HrcClient`, `new Database`)
- **Current:** `function createClient() { return new HrcClient(discoverSocket()) }` is called inside each handler. Handlers cannot be unit-tested without a live daemon socket; tests must go through the full process.
- **Suggested:** Thread a `{ client?: HrcClient }` (or a `createClient` factory) through the handler signatures, defaulting to the current behavior. Pairs naturally with refactor #2 (typed handler options). For `cli-runtime.ts`, accept the `Database`/`HrcClient` as optional params (some functions like `listInFlightWork` already accept `dbPath` — extend that seam).
- **Risk:** medium
- **Effort:** medium
- **apiPreserving:** true if the new param is optional with a default; the exported `cli-runtime` functions keep working with current call sites.
- **Tests:** would *enable* new isolated handler tests; existing `in-flight-gate.test.ts` already injects `dbPath`, confirming the pattern.

### 4. Extract repeated `--expected-generation` validation
- **Principle:** DRY / primitive obsession
- **Location:** `cli.ts:2791-2797, 2822-2828, 2884-2890, 2924-2930` (4 identical copies in `cmdBridgeRegister`, `cmdBridgeDeliver`, `cmdBridgeTarget`, `cmdBridgeDeliverText`)
- **Current:** The same `Number.parseInt(raw,10)` + `!Number.isFinite || <0 → fatal('--expected-generation must be a non-negative integer')` block is copy-pasted four times.
- **Suggested:** `function parseExpectedGeneration(args: string[]): number | undefined` (or reuse `parseIntegerFlag` with min:0) in one place.
- **Risk:** low
- **Effort:** small
- **apiPreserving:** true (internal helper)
- **Tests:** add a focused unit; bridge commands covered in `cli.test.ts`.

### 5. Collapse the `print*Ndjson` / `print*Human` formatter triplets
- **Principle:** DRY / OCP
- **Location:** `cli.ts:1793-1905` (`printSweepNdjson`/`printSweepHuman`, `printZombieSweepNdjson`/`printZombieSweepHuman`, `printReconcileActiveNdjson`/`printReconcileActiveHuman`)
- **Current:** Three near-identical pairs. Each Ndjson printer is byte-for-byte the same shape (`for row → JSON.stringify; then summary`). The three host commands (`cmdRuntimeSweep`, `cmdRunSweepZombies`, `cmdRunReconcileActive`) also share an identical `--dry-run`/`--yes`/TTY gating preamble (cli.ts:1754-1759, 1819, 1865).
- **Suggested:** One generic `printResultsNdjson<T>({results, summary})` and one shared `resolveMutationDryRun(args)` gate. Keep the per-command Human formatter (the only part that legitimately differs).
- **Risk:** low
- **Effort:** small
- **apiPreserving:** true (internal)
- **Tests:** covered indirectly via `cli.test.ts`; add a small table test for the generic ndjson printer.

### 6. Decompose `cli.ts:printLocalRunPreview` (long method)
- **Principle:** SRP / long method
- **Location:** `cli.ts:2325-2474` (~150 lines)
- **Current:** Single async function builds the broker preview branch AND the full invocation/argv/env/system-prompt/priming render branch with deep nesting and many local `betweenLines.push(...)` mutations.
- **Suggested:** Split into `printBrokerRunPreview(...)` and `printInvocationRunPreview(...)`; lift the env-truncation + system-prompt extraction into named helpers (`extractSystemPromptFromArgv`/`extractPrimingFromArgv` already exist — move the rest beside them).
- **Risk:** low
- **Effort:** medium
- **apiPreserving:** true (internal; `printLocalRunPreview` is not exported)
- **Tests:** `--dry-run` output asserted in `cli.test.ts`/`cli-intent.test.ts`.

### 7. Split `monitor-render.ts` rendering from tool-formatting
- **Principle:** SRP / module cohesion
- **Location:** `monitor-render.ts:1-1042` (renderer classes at 152-510; ~50 `format*`/`parse*`/`extract*` free functions at 511-1042)
- **Current:** Renderer classes (`Json/Compact/Verbose/TreeMonitorRenderer`) coexist with a large library of tool-call body formatters (`formatShellCommand`, `formatReadInput`, `formatEditInput`, `formatTaskUpdateInput`, …) and payload parsers in one 1,042-line file.
- **Suggested:** Move the tool-call/payload formatting helpers to `monitor-tool-format.ts`, leaving the renderer classes + factory in `monitor-render.ts`. The per-tool `if (isShellTool) … else formatGenericToolInput` dispatch (monitor-render.ts:685-776) could become a small registry map keyed by tool name to satisfy OCP, but that is optional.
- **Risk:** medium
- **Effort:** medium
- **apiPreserving:** true (the exported renderer API stays; helpers are currently file-private)
- **Tests:** `monitor-watch.test.ts` (38 KB) exercises tree/compact/verbose output extensively.

### 8. Normalize the `ServerRuntimeStatus` shape (ISP)
- **Principle:** ISP / primitive-obsession / duplicated state
- **Location:** `cli-runtime.ts:32-63` and its two builders `collectServerRuntimeStatus` (318-436)
- **Current:** The type carries the same fact under multiple keys: `running` vs `daemon.running`, `pid` vs `daemon.pid`, `pidAlive` vs `daemon.pidAlive`, `socketPath`/`socketResponsive` vs `socket.{path,responsive}`. The builder fills both, and the error path duplicates the whole 30-field literal again (402-434).
- **Suggested:** Pick one canonical nesting (`daemon{}` + `socket{}`) and derive the flat aliases via a single mapper, or drop the aliases if no consumer needs the flat form (grep `status.running`/`status.pid` to confirm). This is a **public exported type**, so treat as API-affecting.
- **Risk:** medium
- **Effort:** medium
- **apiPreserving:** false (changes an exported type's member set)
- **Tests:** `shutdown-intent.test.ts`, `smoke.test.ts`; consumers in `cli.ts:cmdServerStatus`/`formatServerRuntimeStatus`.

---

## Code Smells

| Smell | Location | Detail |
|-------|----------|--------|
| God file | `cli.ts` (4,005 ln) | >13× the 300-line SRP threshold; ~40 handlers + formatters + wiring. |
| Long method | `cli.ts:2325 printLocalRunPreview` (~150 ln) | Two large branches, deep `betweenLines.push` mutation. |
| Long method | `cli.ts:1969 explainScopeCommandError` (~107 ln) | Nested error-code `if` ladder with inline detail-shape casts. |
| Long method | `monitor-render.ts:223/256` `TreeMonitorRenderer.push/flush` | push 223-255, flush 256-510 (~250 ln). |
| Duplicated block | `cli.ts` raw-argv walk-up (8×) | `while(root.parent)…rawArgs…indexOf(verb)` repeated in 8 actions. |
| Duplicated block | `cli.ts` `--expected-generation` validation (4×) | lines 2791/2822/2884/2924. |
| Duplicated block | `cli.ts` `print*Ndjson` (3×) + mutation dry-run gate (3×) | sweep/zombie/reconcile. |
| Duplicated helper | `fatal`/`hasFlag` defined in BOTH `cli.ts:124,160` and `runtime-args.ts:1,6` | two implementations of the same primitives; `cli.ts` does not import the shared ones. |
| Primitive obsession | flags passed as `string[]` everywhere | every handler re-derives typed values from raw argv. |
| Magic numbers | `cli.ts` retry/poll constants | `attempt<4`/`150ms` (980-988), `attempts=6`/`250ms` (1143-1149), `5_000`/`300_000` timeouts; `IN_FLIGHT_RECENCY_MS` in cli-runtime is named (good) — make the rest named consts. |
| Hidden side effect | `cli.ts:115 loadDotEnvLocal()` at import time | Module top-level mutates `process.env` on import; complicates testing/importing any export. |
| Reflection hack | `cli.ts` `(root as unknown as { rawArgs?: string[] })` (8×) | reaching into commander internals to recover collapsed negated booleans. |

---

## Quick Wins

- Extract `rawArgvForVerb(cmd, verb)` to kill the 8× commander walk-up duplication (cli.ts:3509…3691).
- Extract `parseExpectedGeneration(args)` to kill the 4× bridge validation copy (cli.ts:2791-2930).
- Have `cli.ts` import `fatal`/`hasFlag` from `runtime-args.ts` instead of redefining them (cli.ts:124,160).
- Add one generic `printResultsNdjson<T>()` for the three identical ndjson printers (cli.ts:1793/1839/1885).
- Name the retry/poll magic numbers (`ATTACH_REAP_POLL_MS=150`, `SESSION_SUMMARY_POLL_MS=250`, etc.).

---

## Technical Debt Notes

- **Transitional glue, never finished.** The `toLegacyArgv` bridge is explicitly documented as "transitional glue for commander → legacy handler bridge" (cli.ts:180). The migration to commander happened, but the legacy `(args: string[])` handler contract was never retired, so every command pays a parse→serialize→reparse tax and reaches into commander internals to recover what it just discarded. This is the single biggest source of accidental complexity in the package and the root enabler of several other smells. Finishing it (typed handler options) is the highest-leverage structural cleanup, but it is broad and higher-risk.
- **No DI seam** means the ~40 `cmd*` handlers are only testable through a live daemon, which is why `cli.test.ts` is 90 KB of mostly end-to-end coverage. Introducing the client seam (#3) would let those handlers be unit-tested cheaply.
- **Module-load side effects** (`loadDotEnvLocal()` runs on import) make `cli.ts` awkward to import for unit tests — another reason the test surface is end-to-end heavy.
- The monitor sub-system is already split into four files and is in noticeably better shape than `cli.ts`; `monitor-render.ts` is the only one over the 300-line line and the split there (#7) is mechanical.

---

## Safety Checklist (before applying)

- [ ] Run the full hrc-cli suite first to capture a green baseline: `bun test packages/hrc-cli` (TMPDIR=/tmp per repo memory).
- [ ] For each file-split (#1, #7): move code verbatim, re-export moved public symbols from the original module, run the suite after EACH module — do not batch.
- [ ] For the client-injection seam (#3): keep the new param optional with the current `createClient()` default; confirm zero call-site changes are forced.
- [ ] Do NOT auto-apply #2 full cutover or #8 (`ServerRuntimeStatus` reshape) — high-risk / API-affecting; land by hand with a focused review.
- [ ] After any change touching `run`/`start`/`attach` arg parsing, re-verify the negated-boolean cases (`--no-attach`, `--no-register`, `--no-drop-continuation`) and the prompt mutual-exclusion (`-p` vs positional vs `--prompt-file`).
- [ ] hrc CLI runs from source (no build step) — verify changes live with `hrc <cmd> --help` and a real `hrc runtime list`, not just the unit suite.
- [ ] Diff before committing: the shared worktree means a stray edit to a co-located file can break main (repo memory: explicit-path commit co-edit sweep).
