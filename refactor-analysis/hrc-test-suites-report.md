# Refactoring Analysis — HRC test suites

**Target:** repository test corpus (`packages/**` and `scripts/**`)<br>
**Files inventoried:** 447 executable TypeScript test files<br>
**Deep-review focus:** 15 files above 1,000 lines, 22,504 lines total<br>
**Generated:** 2026-08-24  ·  **Package type:** general

## Summary

The test corpus has a clear size problem rather than a coverage problem: 15 test files exceed the requested 1,000-line ceiling, by 7,504 lines in aggregate, and another 13 sit between 800 and 999 lines. The largest suites combine unrelated behavioral contracts behind copied, stateful harnesses. The highest-leverage repair is to extract two narrow fixture seams (CLI invocation and server/fake-harness lifecycle), then split by production behavior. Several task-named red-gate suites should be dissolved into those behavioral homes rather than merely renamed.

No production API change is required. The observable boundary to preserve is the same set of assertions, subprocess/in-process routing decisions, environment restoration, daemon cleanup, and wire-level fixtures that the current files exercise.

## Public boundary

- **API surface under test:** the `hrc` CLI command surface, `HrcClient`, server HTTP routes, broker lifecycle/projection contracts, SQLite repositories, capture-verifier adapters, `hrc-pi-top`, and the retention script.
- **Finding:** the production boundaries are mostly explicit, but the tests do not mirror them. Test files are organized by implementation task or historical campaign as often as by current public behavior.
- **Verdict:** 🟡 needs care. This is an internal-only refactor, but copied global environment and daemon setup make naive file splitting risky.

## Hard ceiling inventory and concrete split map

The following plan brings every current violation below 1,000 lines. Proposed files are behavioral destinations, not mandatory exact names.

| Current file | Lines / tests | Recommended decomposition |
| --- | ---: | --- |
| `packages/hrc-cli/src/__tests__/cli.test.ts` | 3,064 / 101 | Extract `fixtures/cli-runner.ts` and `fixtures/cli-server.ts`; split into `cli-help.test.ts` (lines 643–1071), `cli-server-lifecycle.test.ts` (1072–1453), `cli-session.test.ts` (1454–1759 and 2426–2592), `cli-start.test.ts` (1760–2025), `cli-attach-run.test.ts` (2026–2425), and `cli-diagnostics.test.ts` (2593–3064). |
| `packages/hrc-server/src/__tests__/broker-controller.test.ts` | 2,117 / 43 | Keep start/input/abort lifecycle in `broker-controller.lifecycle.test.ts`; move the already-named inspection groups at 1481, 1647, and 1702 to `broker-controller.inspect.test.ts`; move capability gating at 1789 to `broker-controller.capabilities.test.ts`; extract the fixture currently beginning at 1998. |
| `packages/hrc-server/src/__tests__/server-hrcchat-minimal.test.ts` | 1,746 / 24 | Split route contracts into `server-hrcchat.targets.test.ts` (165–311), `server-hrcchat.messages.test.ts` (312–532), `server-hrcchat-handoff.test.ts` (533–1344), and `server-hrcchat-literal.test.ts` (1345–1746). Reuse one fake-Codex/server fixture rather than copying the embedded executable. |
| `packages/hrc-store-sqlite/src/__tests__/store.test.ts` | 1,683 / 37 | Split exactly along repository boundaries already expressed by `describe`: `store.database.test.ts`, `store.continuity-session.test.ts`, `store.runtime-run.test.ts`, `store.launch-event.test.ts`, and `store.surface-buffer.test.ts`. WAL concurrency (1642) belongs with database behavior. |
| `packages/hrc-server/src/__tests__/broker-endpoint-substrate-reconcile.red.test.ts` | 1,558 / 18 | Extract the 175–690 seed/controller fixture. Group scenarios 1–5 as `broker-startup-reconcile.test.ts`, scenarios 6–7 as `broker-substrate-sweep.test.ts`, and scenarios 8–10 plus T-01996 as `broker-dispatch-reattach.test.ts`. |
| `packages/hrc-capture-verifier/src/__tests__/capture-verifier.test.ts` | 1,474 / 25 | Split at the existing top-level boundaries: `provider-transcript-adapters.test.ts` (41), `capture-verifier.test.ts` (401), `sqlite-adapter.test.ts` (935), and `package-boundaries.test.ts` (1129). Move helpers at 1147–1473 to `fixtures/capture-verifier-fixture.ts`, importing only the helpers each suite needs. |
| `packages/hrc-server/src/__tests__/broker-event-mapper.test.ts` | 1,397 / 39 | Split into `broker-event-mapper.lifecycle.test.ts` (91), `broker-event-mapper.atomicity.test.ts` (474–710), `broker-event-mapper.projections.test.ts` (711–1136), and `broker-event-mapper.replay.test.ts` (1137 onward). Keep a small mapper/database fixture shared by these files. |
| `packages/hrc-sdk/src/__tests__/sdk.test.ts` | 1,359 / 39 | Split by public client surface already named by `describe`: discovery/constructor, lifecycle requests, typed errors, watch streaming, diagnostics integration, and export surface. Fold the historical “Step 4 red-gate” cases at 1081 into lifecycle/errors/watch destinations by behavior. |
| `packages/hrc-cli/src/__tests__/monitor-watch.test.ts` | 1,318 / 24 | Keep snapshot/format/terminal-result behavior (369–845) in `monitor-watch.test.ts`; move the polling reader contract (846 onward) to `monitor-watch-polling.test.ts`. Extract the fixture state and event factories at 237–367. |
| `packages/hrc-server/src/__tests__/broker-runtime-hosting.red.test.ts` | 1,280 / 107 | Convert the repeated predicate cases into typed table matrices. Split parser/normalization (344–785), predicate policy (786–1071), lease identity (1072–1234), and the source-scan guard (1235 onward). This file should shrink materially, not merely be divided. |
| `packages/hrc-server/src/__tests__/server-sdk-dispatch.test.ts` | 1,178 / 17 | Split start/reuse/continuation cases from attach/fail-closed cases. Replace its local `fetchSocket`, `postJson`, session resolver, and fake-Codex installer with shared fixtures. |
| `packages/hrc-server/src/__tests__/t05095-daedalus-review-fixes.red.test.ts` | 1,174 / 19 | Dissolve the task bucket. Move admission/reuse tests (539–1007, including later T-05177/T-07397 cases) to broker admission suites; move wire-authority and repair-correlation tests (1008–1128) to broker-event persistence/mapper suites; move malformed DTO parsing (1129 onward) to dispatch parser tests. |
| `packages/hrc-pi-top/src/index.test.ts` | 1,117 / 27 | Split restore lifecycle (340–403), input/help/confirmation (404–584), action/message overlays (585–713), ambiguity/inspect (714–899), and event-tail/detail overlays (900 onward). Share app/target builders from a local test fixture. |
| `packages/hrc-cli/src/__tests__/t04219-p2-command-surface.red.test.ts` | 1,028 / 59 | Dissolve the stale red gate into `cli-show.test.ts`, `cli-list.test.ts`, `cli-admin-runs.test.ts`, and lifecycle command suites. First deduplicate help/regression assertions already present in `cli.test.ts`; reuse the canonical CLI fixture instead of its copied 1–333 setup. |
| `scripts/prune-hrc-event-deltas.test.ts` | 1,011 / 28 | Split retention policy (240–594), backlog purge (595–739), and writer-lock/bounded-vacuum behavior (740 onward). Extract store seeding and CLI execution helpers at 24–238. |

## Findings by mechanism

### 1. Establish and enforce the 1,000-line invariant — [T12] Make illegal states unrepresentable

- **Location:** the 15 files in the inventory above; the next pressure point is `t4922-presentation-aware-predicates.red.test.ts:1` at 989 lines.
- **Mechanism repaired:** file-size policy currently exists only as reviewer intent, so continued growth is always representable.
- **Current → Suggested:** informal ceiling → a repository check over authored test sources, excluding `node_modules`, `dist`, generated declarations, and non-test docs. Fail at `>1000`; warn or report at `>=800` so splits occur before a feature lands.
- **Direction:** add.
- **Preservation:** test-suite — the gate changes no production or test behavior.
- **Falsifiable signal:** `bun run`/`just` verification fails on a deliberately-created 1,001-line test and all authored tests pass the check after decomposition.
- **Risk:** Low  ·  **API-impact:** internal-only  ·  **Effort:** Small.
- **Tests:** unit-test the path exclusions and both boundary values (1,000 allowed, 1,001 rejected).
- **Contraindication:** do not count generated/vendor files or Markdown specs; that would enforce a different policy from the requested test-suite cleanup.

### 2. Replace copied CLI harnesses with one explicit fixture — [T15] Extract missing abstraction

- **Location:** `cli.test.ts:45–320` and `t04219-p2-command-surface.red.test.ts:55–332`.
- **Mechanism repaired:** the same CLI capture, `process.exit` interception, environment mutation, temp layout, daemon setup, and tmux cleanup are independently maintained. Their `shouldUseSubprocess` policies have already diverged.
- **Current → Suggested:** two suite-global harness copies → `createCliTestFixture({ subprocessPolicy })` returning `run`, `env`, `startServer`, seed helpers, and an idempotent `cleanup`.
- **Direction:** isolate.
- **Preservation:** characterization-test — copy the current routing decision matrix into fixture tests before migrating callers.
- **Falsifiable signal:** no test file patches `process.stdout`, `process.stderr`, `process.exit`, or `PATH` directly; the two large suites lose roughly 500 duplicated lines.
- **Risk:** Medium  ·  **API-impact:** internal-only  ·  **Effort:** Medium.
- **Tests:** cover environment restoration on success, expected `CliExit`, unexpected throw, and partial server startup; verify tmux/broker sockets are killed before temp removal.
- **Contraindication:** do not hide command-specific seeding or assertions in the fixture; it should own lifecycle, not test intent.

### 3. Reuse the existing server fixture and extract fake harness processes — [T03] Relocate by affinity

- **Location:** `server-hrcchat-minimal.test.ts:57–164`, `server-sdk-dispatch.test.ts:61–243`, `cli.test.ts:407–562`; existing shared base at `packages/hrc-server/src/__tests__/fixtures/hrc-test-fixture.ts:1`.
- **Mechanism repaired:** Unix fetch/post helpers, temp runtime roots, database seeding, tmux cleanup, and fake Codex protocols belong to server-test infrastructure, but are embedded in behavioral suites.
- **Current → Suggested:** local server lifecycle plus three embedded fake-Codex variants → compose `createHrcTestFixture` with a narrow `installFakeCodexDriver(options)` fixture that records argv/stdin and emits configured broker events.
- **Direction:** relocate.
- **Preservation:** test-suite — preserve exact executable argv parsing, event sequence, exit timing, and cleanup behavior as fixture contract tests.
- **Falsifiable signal:** server route suites contain scenario setup and assertions only; fake driver protocol changes touch one fixture file.
- **Risk:** Medium  ·  **API-impact:** internal-only  ·  **Effort:** Medium.
- **Tests:** fixture self-tests for resume/new-session argv, delayed exit, emitted thread IDs, and leaked-process cleanup.
- **Contraindication:** retain genuinely scenario-specific driver behavior as explicit fixture options; an over-generic scripting DSL would be harder to understand than the current copies.

### 4. Dissolve task-era conglomerates into current behavioral ownership — [T03] Relocate by affinity

- **Location:** `t05095-daedalus-review-fixes.red.test.ts:539–1174`, `t04219-p2-command-surface.red.test.ts:334–1028`; repository-wide, 140 test files are task-prefixed and 115 still use `.red.test.ts`.
- **Mechanism repaired:** historical work-item identity is being used as the primary module boundary. Later fixes accumulate in the same file even when their production owners differ, as shown by T-05177 and T-07397 cases inside T-05095.
- **Current → Suggested:** campaign/task buckets → behavior-owned files; retain task IDs only in individual test descriptions or comments when they provide useful provenance.
- **Direction:** relocate and remove stale naming.
- **Preservation:** observational-equivalence — move assertions unchanged first, then deduplicate only exact overlapping contracts.
- **Falsifiable signal:** searching a production concept (admission, broker event persistence, CLI show) leads to one neighboring suite cluster; no “red” file is green in normal CI.
- **Risk:** Low for moves, Medium for deduplication  ·  **API-impact:** internal-only  ·  **Effort:** Medium.
- **Tests:** compare test counts/names before and after; run old files and their new destination glob during migration.
- **Contraindication:** do not bulk-rename all 140 task files. Small, single-contract regression files can retain task provenance without causing structural harm.

### 5. Turn broker hosting predicate repetition into executable decision tables — [T19] Conditional ↔ dispatch

- **Location:** `broker-runtime-hosting.red.test.ts:344–1234` (107 tests).
- **Mechanism repaired:** one input-shape/predicate axis is encoded as many hand-written tests, obscuring the truth table and inflating the suite.
- **Current → Suggested:** repeated object construction and one-off assertions → typed case tables for flat/normalized parsing, malformed combinations, presentation policy, and lease identity; keep a few named narrative tests for boundary cases.
- **Direction:** remove repetition.
- **Preservation:** test-suite — each current case must map to a named table row with the same expected value or error.
- **Falsifiable signal:** a new hosting shape or predicate rule is added as one row per affected matrix, and the suite drops comfortably below 800 lines without reducing case coverage.
- **Risk:** Low  ·  **API-impact:** internal-only  ·  **Effort:** Medium.
- **Tests:** assert table row names are unique and preserve exact malformed-combination reasons where those are contractual.
- **Contraindication:** do not table-drive multi-step stateful scenarios whose setup/assertion differences carry the meaning; tables are appropriate here because these are mostly pure shape predicates.

### 6. Split mega-suites at lifecycle boundaries, not arbitrary line counts — [T03] Relocate by affinity

- **Location:** `cli.test.ts:643–3064`, `broker-controller.test.ts:286–1997`, `server-hrcchat-minimal.test.ts:165–1746`, `store.test.ts:64–1683`, and the remaining inventory.
- **Mechanism repaired:** a single file owns several independent reasons to change, so every feature addition expands an already-global setup and makes focused test execution difficult.
- **Current → Suggested:** one broad suite with shared mutable state → files matching production command, route, repository, projection phase, or UI mode, backed by lifecycle fixtures.
- **Direction:** relocate.
- **Preservation:** test-suite — perform move-only commits first; do not rewrite assertions while changing ownership.
- **Falsifiable signal:** each file can be named in a focused `bun test <path>` invocation, stays under 800 lines after the split, and no feature edit normally touches more than one behavioral suite plus a fixture.
- **Risk:** Medium because file-level concurrency can expose global env/process coupling  ·  **API-impact:** internal-only  ·  **Effort:** Large across all 15 files.
- **Tests:** run each destination file alone, its package suite, then the root suite. For CLI/server splits, also check repeated execution and parallel execution for cleanup races.
- **Contraindication:** do not split a file until its global lifecycle is encapsulated or proven safe per file; otherwise the refactor can create nondeterministic process/environment interference.

### 7. Separate fast contract tests from live lifecycle acceptance — [T01] Introduce substitution seam

- **Location:** `cli.test.ts:643–1071` mixes in-process help parsing with daemon/tmux lifecycle beginning around 1105; `t04219-p2-command-surface.red.test.ts` similarly mixes help and live-server blocks.
- **Mechanism repaired:** cheap command-shape tests inherit expensive global server setup, while subprocess selection is decided by a growing conditional in the harness.
- **Current → Suggested:** universal heavyweight setup → a pure `invokeMain` capture seam for parsing/output tests and an explicit installed/subprocess fixture for lifecycle acceptance.
- **Direction:** isolate.
- **Preservation:** characterization-test — pin stdout, stderr, exit code, and subprocess routing before separating tiers.
- **Falsifiable signal:** help/validation suites run without temp server roots or tmux; lifecycle tests declare their external-process dependency in the filename/setup.
- **Risk:** Medium  ·  **API-impact:** internal-only  ·  **Effort:** Medium.
- **Tests:** direct equivalence cases for representative help, invalid command, dry-run, child-process command, and daemon lifecycle commands.
- **Contraindication:** keep true re-exec behavior (for example `hrc turn`) in subprocess acceptance; an in-process mock would stop testing the observable contract.

### 8. Retire brittle source-scan guards when a boundary check can own the rule — [L2] Extract facts from hot files

- **Location:** `broker-runtime-hosting.red.test.ts:1235` (“no-second-parser guard”) and repository boundary scripts/tests.
- **Mechanism repaired:** architectural ownership is asserted by scanning a large behavioral test file rather than by a dedicated machine-readable boundary predicate.
- **Current → Suggested:** source-text assertion colocated with predicate behavior → a narrow boundary test/check that names permitted parser imports/exports; keep behavioral equivalence in parser tests.
- **Direction:** relocate.
- **Preservation:** test-suite — prove the same forbidden second-parser examples fail the new guard before deleting the old scan.
- **Falsifiable signal:** parser ownership can be checked without running the 1,280-line behavior suite, and formatting/comment changes cannot break the guard.
- **Risk:** Low  ·  **API-impact:** internal-only  ·  **Effort:** Small.
- **Tests:** positive canonical-parser usage and negative local re-parser fixture.
- **Contraindication:** if the current scan is semantic rather than textual after deeper inspection, preserve it and only move it; do not weaken an architectural gate for tidiness.

## Near-ceiling pressure

These 13 files are not current violations but should be held to a no-growth rule until split: `t4922-presentation-aware-predicates.red.test.ts` (989), `broker-headless-viewer.red.test.ts` (980), `monitor-watch-filtering.red.test.ts` (963), `broker-operator-inspect.red.test.ts` (960), `ghostmux-manager.test.ts` (920), `server-otel-ingest.test.ts` (896), `broker-forensics.red.test.ts` (887), `server-hook-lifecycle.test.ts` (873), `runtime-mutations.char.test.ts` (859), `t06613-target-locate.test.ts` (849), `t06575-monitor-until-red.test.ts` (845), `t06608-summon-gate.test.ts` (815), and `t06613-locate.test.ts` (803).

The 989-line and 980-line files should be included in the first decomposition campaign; otherwise the first substantive addition recreates the violation.

## Deliberately left alone

- Small task-named regression suites: task provenance is not itself a defect when the file has one cohesive contract and remains easy to locate through production terminology.
- Repeated setup values inside SQLite repository tests: after files are split, a small local setup can be clearer than a generic repository testing framework. Extract only database lifecycle and truly co-traveling builders.
- Existing characterization and acceptance suffixes: these communicate preservation level. Only stale `.red` naming is suspect once a test is part of the passing suite.
- Exact low-level broker cases: do not deduplicate similar-looking event sequences unless their expected projection and failure atomicity are genuinely identical.

## Thermonuclear blockers / task seeds

1. **Enforce authored-test size ceiling** — owner `hrc-runtime`; suggested title: “Enforce 1k test-file ceiling with 800-line pressure report”; labels `refactor,test-infrastructure`.
2. **Canonical CLI test fixture and suite split** — suggested title: “Extract CLI lifecycle fixture and decompose CLI command suites”; labels `refactor,hrc-cli`.
3. **Canonical fake harness/server fixture** — suggested title: “Unify server route test lifecycle and fake Codex driver”; labels `refactor,hrc-server`.
4. **Broker contract suite decomposition** — suggested title: “Decompose broker controller, hosting, mapper, and reconcile suites by contract”; labels `refactor,broker`.
5. **Dissolve stale task red-gate conglomerates** — suggested title: “Relocate T-04219 and T-05095 regressions to behavioral suites”; labels `refactor,test-ownership`.

## Applying sequence

1. Add the size check in reporting mode and capture the baseline test-name/count manifest.
2. Extract and self-test the CLI fixture; split the two oversized CLI command files without changing assertions.
3. Extend the existing HRC server fixture with fake-driver composition; split server route/dispatch suites.
4. Perform move-only splits for store, SDK, capture verifier, Pi top, event mapper, broker controller, and prune script.
5. Convert only the pure broker-hosting predicate repetitions to tables.
6. Relocate task-era cases, compare overlap, then remove only proven duplicate assertions.
7. Run build before typecheck, each affected package suite, the root suite, and the repository size gate; then enable the gate as blocking.

## Safety checklist

- [ ] Record test file/name counts before moving cases.
- [ ] Preserve assertion bodies in move-only commits.
- [ ] Pin fixture cleanup and environment restoration before sharing fixtures.
- [ ] Run every destination file alone and as part of its package.
- [ ] Exercise CLI/server suites repeatedly to detect leaked daemons, tmux servers, sockets, or environment.
- [ ] Build before typecheck per repository policy.
- [ ] Run the complete root test suite after all moves.
- [ ] Confirm every authored test file is at most 1,000 lines; target under 800 for decomposed files.
