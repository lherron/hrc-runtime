# Refactor Analysis — `packages/hrc-cli/`

Behavior-preserving refactor audit. Source read in full: `cli.ts` (3967), `cli-runtime.ts` (854),
`monitor-render.ts` (1042), `monitor-watch.ts` (815), `monitor-wait.ts` (533), `monitor-show.ts` (384),
plus trivial `print.ts`, `runtime-args.ts`. Tests in `src/__tests__/` were read for coverage mapping only.

## Package surface note (drives API-impact tagging)

`package.json` declares **only** `bin: { hrc: ./src/cli.ts }` and `files: ["dist"]`. There is **no library
`exports`/`main`** field — no other package imports from `hrc-cli`. The `export`ed functions in `cli.ts`
(`main`, `chooseDefaultProjectId`, `selectLatestUsableRuntime`, `attachOpenAiRuntime`, `resolveAgentHarness`,
`harnessStringToHarnessId`, `explainScopeCommandError`) and in `cli-runtime.ts` are consumed **only by this
package's own tests**. Therefore:

- The **true public surface is the CLI command/flag/exit-code/stdout-JSON contract** (argv in, bytes out).
  Anything that changes a flag name, exit code, JSON shape, or human output is `public-surface`.
- The exported helper functions are an **internal-to-package test seam**. Renaming/moving them is `internal-only`
  but DEFERRED-by-policy when a test imports the symbol (a rename/move forces a test edit). Pure-internal
  (non-exported) extraction is freely applicable.

---

## SOLID Scorecard

| Principle | Grade | Notes |
|-----------|-------|-------|
| **S** — Single Responsibility | **D** | `cli.ts` is a 3967-line god-file: env loading, arg-parsing glue, scope resolution, intent building, ~40 command handlers, dry-run preview rendering, error explanation, two giant usage blobs, AND the full commander tree. `monitor-render.ts` (1042) mixes 5 renderer strategies + ~30 tool-formatting free functions. |
| **O** — Open/Closed | **B** | Renderer factory + per-format classes are genuinely open/closed. Weak spots: `formatToolDisplayName`/`formatToolSummary`/`formatToolCallBody` are parallel `if (toolName === …)` ladders that grow per tool; `--transport` validation duplicated as inline `!== 'tmux' && !== 'headless' && !== 'sdk'`. |
| **L** — Liskov | **A** | Renderer classes share `MonitorRenderer` and substitute cleanly; no throwing/no-op overrides. |
| **I** — Interface Segregation | **B** | `ServerRuntimeStatus` carries redundant flattened+nested mirrors (`pid`+`daemon.pid`, `socketPath`+`socket.path`); not a fat interface but duplicative. Renderer interface is minimal/good. |
| **D** — Dependency Inversion | **C** | Command handlers call `createClient()` (concrete `HrcClient` over a discovered socket) directly; fine for a CLI but no seam, so handlers are integration-tested only. `monitor-watch.ts` *does* model the seam well (`MonitorWatchDeps`); `monitor-wait.ts` and `monitor-show.ts` do not, and duplicate the live-state builder instead. |

Code-smell density: **High** — driven by `cli.ts` size, the `toLegacyArgv`/`toLegacyArgvForScopeCommand`
duplication, the commander↔legacy-argv double-encoding of every command, and triplicated monitor helpers.

---

## Priority Refactorings

### P1 — Split `cli.ts` (3967 lines) into cohesive command-group modules
- **Location:** `src/cli.ts` (whole file)
- **Principle:** S (Single Responsibility), file > 300 lines by 13×.
- **Current:** One module holds env loading, arg helpers, the commander→legacy argv bridge, scope/intent
  resolution, ~40 `cmd*` handlers (server, session, runtime, broker, launch, run/start/attach, surface, bridge,
  inflight, sweep/reconcile), dry-run preview rendering, error explanation, two multi-hundred-line usage strings,
  and `buildProgram()`.
- **Suggested:** Extract into siblings mirroring the existing monitor split: `cli-args.ts` (argv helpers +
  `toLegacyArgv*`), `scope-intent.ts` (`resolveManagedScopeContext`, `buildManaged*Intent`, `resolveAgentHarness`),
  `commands/server.ts`, `commands/runtime.ts`, `commands/bridge.ts`, `commands/scope.ts` (run/start/attach +
  previews), `commands/sweep.ts`, `usage.ts` (the two big strings). `cli.ts` keeps only `buildProgram()` + `main()`.
  Move symbol-by-symbol with no signature changes.
- **Risk:** **Med** — large mechanical move; risk is in import re-wiring and the `import.meta.main` guard, not logic.
- **API-impact:** **internal-only** (no package exports consumed externally) BUT several moved symbols
  (`chooseDefaultProjectId`, `selectLatestUsableRuntime`, `attachOpenAiRuntime`, `resolveAgentHarness`,
  `harnessStringToHarnessId`, `explainScopeCommandError`, `main`) are imported by tests via `'../cli'`, so a move
  forces test-import edits — outside the "no test edits" safety rule.
- **Effort:** L.
- **Tests:** `cli.test.ts`, `cli-intent.test.ts`, `choose-default-project-id.test.ts`,
  `explain-scope-command-error.test.ts`, `smoke.test.ts` import from `'../cli'`.
- **DEFER** — too broad to be a behavior-preserving auto-apply; forces test edits.

### P2 — De-duplicate `toLegacyArgv` vs `toLegacyArgvForScopeCommand`
- **Location:** `src/cli.ts:252-355`
- **Principle:** Code smell (duplicated block), DRY.
- **Current:** `toLegacyArgvForScopeCommand` (312-355) is `toLegacyArgv` (252-295) copied verbatim — identical
  string-flag, boolean-flag, and negated-boolean loops — plus a trailing `-p` short-flag emit. The negated-boolean
  block differs only in `rawArgv ?? process.argv` vs a required `rawArgv`.
- **Suggested:** Have `toLegacyArgvForScopeCommand` call `toLegacyArgv(positionals, opts, schema, rawArgv)` then
  append `-p`, OR add an optional `shortFlags?` param to `toLegacyArgv`. Both private.
- **Risk:** **Low** — pure internal dedupe, both functions private (not exported, not imported by tests).
- **API-impact:** **internal-only**.
- **Effort:** S.
- **Tests:** Covered indirectly by `cli.test.ts` (drives `main()` through commander for run/start). **APPLY.**

### P3 — Extract triplicated `stringField`/`numberField` (+`booleanField`) monitor field readers
- **Location:** `monitor-render.ts:1024-1037`, `monitor-watch.ts:807-815`, `monitor-wait.ts:521-529`
- **Principle:** Code smell — three byte-identical `stringField`/`numberField` definitions; render also has
  `booleanField`.
- **Current:** Each monitor file re-declares the same `typeof value === 'string' ? value : undefined` readers.
- **Suggested:** A private `monitor-fields.ts` (`stringField`, `numberField`, `booleanField`) imported by all three.
- **Risk:** **Low** — all private, behavior identical.
- **API-impact:** **internal-only**.
- **Effort:** S.
- **Tests:** Exercised via `monitor-watch.test.ts`, `monitor-wait.acceptance.test.ts`, `monitor-show.test.ts`. **APPLY.**

### P4 — Hoist duplicated monitor condition constants
- **Location:** `monitor-watch.ts:84-96` and `monitor-wait.ts:37-47`
- **Principle:** Code smell (duplicated literal sets / magic constants).
- **Current:** `VALID_CONDITIONS`, `MSG_REQUIRED_CONDITIONS`, `POLL_MS` defined identically in both files. The two
  `--until` validations (`monitor-wait.ts:178-182`, `monitor-watch.ts:147-151`) duplicate the "invalid condition: …
  (valid: …)" message.
- **Suggested:** A shared `monitor-conditions.ts` exporting the two sets + `POLL_MS`, and a
  `validateUntilCondition(value)` helper.
- **Risk:** **Low** — constants are private.
- **API-impact:** **internal-only**.
- **Effort:** S.
- **Tests:** `monitor-watch.test.ts`, `monitor-wait.acceptance.test.ts`. **APPLY.**

### P5 — De-duplicate the live-monitor-state builders
- **Location:** `monitor-watch.ts:537-643`, `monitor-wait.ts:241-410`, `monitor-show.ts:157-254`.
- **Principle:** S + DRY — three near-parallel implementations that read sessions/runtimes/events/messages and
  assemble an `HrcMonitorState`. They differ in real ways (wait normalizes runtime status + injects
  `message.response` synthetic events + renames event kinds; watch reads via `client.getStatus()`; show reads via
  `client.listRuntimes()`), so this is **not** a verbatim copy.
- **Suggested:** A `monitor-state.ts` with a single builder taking options (`{ normalizeStatus?,
  includeMessageResponses?, eventKindAliases? }`) and shared row→state mappers. Must be done with acceptance tests
  green because variants encode behavior differences.
- **Risk:** **Med** — kind aliasing (`turn.completed→turn.finished`), status normalization, synthetic message events
  must be preserved exactly; easy to regress a condition outcome.
- **API-impact:** **internal-only** (builders private), but it changes runtime data assembly feeding exit codes.
- **Effort:** M.
- **Tests:** `monitor-wait.acceptance.test.ts`, `monitor-watch.test.ts`, `monitor-show.test.ts`.
- **DEFER** — semantic-merge risk; not a safe blind auto-apply.

### P6 — Collapse the `--transport` enum validation duplicated across handlers
- **Location:** `cli.ts:1560-1567` (`cmdRuntimeList`), `cli.ts:1774-1781` (`cmdRuntimeSweep`).
- **Principle:** O / code smell — inline `transport !== 'tmux' && transport !== 'headless' && transport !== 'sdk'`
  with a duplicated fatal message. Same pattern for `'anthropic'|'openai'` provider in `cmdRuntimeEnsure`.
- **Suggested:** Private `parseTransportFlag(args): Transport | undefined` (and `parseProviderFlag`) owning the
  allowed set + message once.
- **Risk:** **Low** — private helper, message preserved verbatim.
- **API-impact:** **internal-only** (CLI error text unchanged).
- **Effort:** S.
- **Tests:** Covered by `smoke.test.ts` argument paths. **APPLY** (keep error string byte-identical).

### P7 — Split the 149-line `printLocalRunPreview` (run/start dry-run path)
- **Location:** `cli.ts:2354-2503`.
- **Principle:** S — function > 50 lines by 3×, two distinct branches (broker-plan vs spec-build preview).
- **Suggested:** Extract `renderBrokerPlanPreview(w, brokerPreview, …)` and `renderSpecBuildPreview(w, intent, …)`
  private helpers; `printLocalRunPreview` orchestrates. No output bytes change.
- **Risk:** **Low** — pure private extraction; identical writes.
- **API-impact:** **internal-only** (but the stdout text IS the dry-run contract — keep emitted lines byte-identical).
- **Effort:** S–M.
- **Tests:** dry-run output asserted in `cli.test.ts`. **APPLY** with byte-preserve care.

### P8 — Extract the repeated TTY/`--yes`/dry-run mutation-gate in sweep/reconcile handlers
- **Location:** `cmdRuntimeSweep` (`cli.ts:1786-1791`), `cmdRunSweepZombies` (`cli.ts:1854-1856`),
  `cmdRunReconcileActive` (`cli.ts:1893-1895`) + matching `dryRun: dryRunFlag || (!yes && Boolean(isTTY))` lines.
- **Principle:** Code smell (triplicated guard logic).
- **Suggested:** A private `resolveMutationGate(args, { noun }): { dryRun; yes; json }` returning resolved flags and
  fataling with the canonical message (parameterize the command noun).
- **Risk:** **Low** — private helper; preserve fatal strings exactly.
- **API-impact:** **internal-only**.
- **Effort:** S.
- **Tests:** No dedicated unit; this is the safety gate — preserve strings. **APPLY.**

### P9 — Reduce tool-formatter `if (toolName === …)` ladders in `monitor-render.ts`
- **Location:** `formatToolDisplayName` (625-631), `formatToolSummary` (633-683), `formatToolCallBody` (685-693).
- **Principle:** O — three parallel dispatch ladders keyed on `toolName`; per-tool knowledge spread across all three.
- **Suggested:** A single `TOOL_FORMATTERS: Record<string, { displayName?; summary?; body? }>` table so each tool's
  rendering lives in one entry; the three functions become lookups with current default fallbacks.
- **Risk:** **Med** — touches user-visible monitor `tree`/`verbose` output; must reproduce every branch exactly
  (`exec_command`/`command_execution`→`Bash`, `mcp:` prefix, etc.).
- **API-impact:** **public-surface** (rendered human stream is a user-facing contract; assertions in
  `monitor-watch.test.ts` may pin it).
- **Effort:** M.
- **DEFER** — output-shaping change.

---

## Code Smells (catalog)

| # | Location | Smell | Suggested fix | Risk | API |
|---|----------|-------|---------------|------|-----|
| 1 | `cli.ts` (whole) | God file 3967 lines / mixed concerns | module split (P1) | Med | internal* |
| 2 | `cli.ts:252-355` | Duplicated `toLegacyArgv*` | delegate/param (P2) | Low | internal |
| 3 | `cli.ts:1560-1567`,`1774-1781` | Triplicated `--transport` enum guard | `parseTransportFlag` (P6) | Low | internal |
| 4 | `cli.ts:1786-1895` | Triplicated mutation-gate guard | `resolveMutationGate` (P8) | Low | internal |
| 5 | `cli.ts:2354-2503` | 149-line `printLocalRunPreview` | extract 2 helpers (P7) | Low | internal |
| 6 | `cli.ts:1835-1926` | `printSweepHuman`/`printZombieSweepHuman`/`printReconcileActiveHuman` near-parallel row+summary printers | shared row/summary formatter | Low | public-surface (stdout) |
| 7 | `cli.ts:2137-2352` | `cmdRun`/`cmdStart` ~90% duplicated body | shared `runScopeCommand(kind, args)` core | Med | internal |
| 8 | `cli.ts:1218-1356` | repeated `parseIntegerFlag('--timeout-ms')` + `collectServerRuntimeStatus()` + launchd-owner branch across server cmds | `resolveServerTimeout`/`withLaunchdOwner` helpers | Low | internal |
| 9 | `monitor-render.ts:1024`,`monitor-watch.ts:807`,`monitor-wait.ts:521` | Triplicated `stringField`/`numberField` | shared module (P3) | Low | internal |
| 10 | `monitor-watch.ts:84`,`monitor-wait.ts:37` | Duplicated condition consts | shared consts (P4) | Low | internal |
| 11 | `monitor-{watch,wait,show}.ts` | Triplicated live-state builders + `toMonitor*` mappers | unified builder (P5) | Med | internal |
| 12 | `monitor-render.ts:625-693` | Parallel `toolName ===` ladders | formatter table (P9) | Med | public-surface |
| 13 | `cli-runtime.ts:32-63` | `ServerRuntimeStatus` mirrors flat+nested fields (`pid`/`daemon.pid`, `socketPath`/`socket.path`) | — (shape is the `--json` contract) | High | public-surface |
| 14 | `cli.ts:1027-1043`,`1761-1770` | duplicated duration/age formatting; magic `3600/86400/64` | named constants / shared util | Low | public-surface (text) |
| 15 | `monitor-render.ts:214,505,1086`; `cli.ts:2437,2468` | Magic numbers (`88/60/120` rule width, `width=64`, `80`/`160`/`120` truncations) | named constants | Low | internal/public |
| 16 | `cli.ts:2944-3064` (`INFO_TEXT`), `3070-3125` (`printUsage`) | Two long static blobs inside dispatch file | move to `usage.ts` | Low | public-surface (help) |
| 17 | `cli.ts:3596-3643` | `run` sub-cmd routing done BOTH via commander subcommands AND inline `positionals[0] === 'sweep-zombies'` shim | pick one routing path | Med | internal |

\* internal but test-imported (see surface note).

---

## Quick Wins (safe, low-risk — APPLY)

1. **P3** — shared `monitor-fields.ts` for `stringField`/`numberField`/`booleanField` (3 dupes → 1).
2. **P4** — shared `monitor-conditions.ts` for `VALID_CONDITIONS`/`MSG_REQUIRED_CONDITIONS`/`POLL_MS`.
3. **P2** — fold `toLegacyArgvForScopeCommand` onto `toLegacyArgv`.
4. **P6** — `parseTransportFlag`/`parseProviderFlag` private helpers (preserve error strings byte-for-byte).
5. **P8** — `resolveMutationGate` for the sweep/reconcile TTY/`--yes` guard (preserve strings).
6. **Magic-number constants (smell #15):** name `TREE_RULE_MIN/MAX`, `SUMMARY_WIDTH=64`, `MAX_SUMMARY_CHARS=80`,
   `MAX_ENV_VALUE_CHARS=160` where they sit. Internal, no output change.
7. **P7** — extract the two preview-rendering helpers from `printLocalRunPreview` (byte-preserve stdout).

All touch **private, non-exported, non-test-imported** symbols (or pure constants) — none force a test edit, none
change a flag/exit-code/stdout contract.

## Deferred (need a human decision)

- **P1** god-file split — large move; forces test-import path edits.
- **P5** unified live-monitor-state builder — semantic merge of three behaviorally-distinct builders feeding exit codes.
- **P9 / smell #12** tool-formatter table — reshapes user-facing monitor output.
- **Smell #6 / #14 / #16** human-output dedupe (sweep printers, duration/age, usage/info text) — alter or risk
  altering user-facing stdout/help bytes.
- **Smell #13** `ServerRuntimeStatus` flat+nested mirror — collapsing changes `hrc server status --json` shape.
- **Smell #7** `cmdRun`/`cmdStart` unification — Med-risk (differ in `--no-attach`/`--new-session` and
  prepare/attach vs start flows).
- **Smell #17** dual run-subcommand routing — touches dispatch correctness.

## Technical Debt Notes

- **commander↔legacy-argv double encoding.** Every command is declared twice: a commander `.command()/.option()`
  tree (`buildProgram`, ~770 lines) AND a legacy `(args: string[])` handler, bridged by `toLegacyArgv`. Explicitly
  transitional ("Phase 6"). Real cleanup: let handlers consume `cmd.opts()` typed objects directly and delete
  `toLegacyArgv*` + per-handler `parseFlag`/`hasFlag` re-parsing. High value but behavior-changing per command →
  tracked follow-up, out of scope for this pass.
- **`-p` short-flag special-casing** and the `negatedBooleans` raw-argv rescan exist only because commander
  auto-negation collapses `--x`/`--no-x`. Documented but fragile; subsumed by the argv-bridge removal above.
- **No DI seam for `HrcClient`** in most handlers (`createClient()` inline). `monitor-watch.ts` shows the intended
  pattern (`MonitorWatchDeps`); `monitor-wait`/`monitor-show` and all `cli.ts` handlers lack it → integration-tested
  only. Adding a deps seam is behavior-preserving but wide → follow-up.
- **Test coupling to internal exports.** `cli.ts`/`cli-runtime.ts` export functions solely for tests; any module
  split (P1) must update those imports — the single biggest blocker to mechanically decomposing the god-file.
