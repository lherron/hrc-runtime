# HRC Test-Suite Refactor and Cull Proposal

**Target:** authored TypeScript tests in `packages/**` and `scripts/**`<br>
**Baseline:** 447 files, 3,957 static `it`/`test` declarations<br>
**Generated:** 2026-08-24<br>
**Constraint:** no authored test file may exceed 1,000 lines; decomposed files should target 800 lines or fewer

## Decision

Run this as a behavior-preserving campaign in four stages:

1. Cull 116 high-confidence redundant, subsumed, or non-observing tests.
2. Extract canonical CLI and server lifecycle fixtures.
3. Split the remaining oversized files by production behavior.
4. Enable a blocking 1,000-line test-source gate with an 800-line pressure report.

The cull removes approximately 1,100 source lines and lowers the static declaration count from 3,957 to **3,841**. Assertion-preserving consolidation can then remove about 33 more declarations, for a planning target near **3,808**, without deleting a behavior claim. Only `t04219-p2-command-surface.red.test.ts` falls below the ceiling from culling alone; fourteen other oversized suites still require structural decomposition. Culling is therefore the first cleanup pass, not the complete size fix.

No production behavior or public API should change.

Four thousand tests is not inherently unreasonable for HRC's breadth—daemon lifecycle, broker admission, persistence, two CLIs, rendering, and multiple transports justify substantial coverage. It is unreasonable in its present shape: 146,335 authored test lines slightly exceed 144,306 production TS/TSX lines, 15 files exceed 1,000 lines, many CLI declarations rerun the same subprocess for one assertion, and historical task suites duplicate behavior-owned suites. The right target is a smaller, faster set of owned contracts, not an arbitrary round-number quota.

## Cull audit method

The cull ledger combines four forms of evidence:

- TypeScript-AST inventory of all 447 authored test files and 3,957 static tests.
- SHA-256 comparison of normalized test callback bodies to find exact repetitions.
- Normalized-title and assertion-shape comparison to find likely semantic overlaps.
- Manual comparison of setup, invoked public boundary, assertions, and stronger surviving coverage.

Three Terra agents independently audited CLI, server/broker, and remaining package/script suites. Their focused baselines covered 478 tests with zero failures:

- CLI and messaging candidates: 153 passing.
- Server and broker candidates: 203 passing.
- SDK, store, and script candidates: 122 passing.

A second, more aggressive pass reviewed repeated command invocations, identical titles, source-text assertions, type-only tests, and the full server filename inventory. Its focused checks were also green: 70 server tests, 111 SDK/store/core/top tests, and 12 CLI files. Candidates were rejected whenever a superficially repeated case crossed a different endpoint, state transition, transport, storage adapter, or failure phase.

The ledger distinguishes deletion from relocation. Similar-looking tests were retained whenever they exercise different routes, repository methods, transport modes, parser entry points, state transitions, or integration layers.

## High-confidence cull ledger

### CLI and messaging — 53 tests

| Remove | Count | Stronger survivor / reason |
| --- | ---: | --- |
| `packages/hrc-cli/src/__tests__/selector-resolve.commands.test.ts:385–501` | 16 | The “per-command adapter” table never invokes a command handler. Every row directly calls `resolveRuntimeArg` or `resolveSessionArg`, repeating the actual resolver tests at lines 161–196 and 290–305. Delete the whole section; it does not prove its advertised wiring contract. |
| `packages/hrc-cli/src/__tests__/selector-resolve.unit.test.ts:121–136` and `:233–245` | 2 | The raw-ID success is already pinned at 112–119; the `msg:` type-mismatch contract is stronger at 189–206. |
| `packages/hrc-cli/src/__tests__/t04219-p2-command-surface.red.test.ts:402–413` | 1 | Raw `show` JSON type assertions are subsumed by the exact kind/ID assertions at 365–376. |
| Same file, `:545–567` | 3 | `ls runtimes` and `ls sessions` are subsumed by seeded parity tests at 593–644. `ls launches` is duplicated by `cli.test.ts:2943–2948`. |
| Same file, `:585–591` | 1 | A second `list sessions` alias invocation adds nothing beyond the alias registration and single alias proof at 577–583. |
| Same file, `:648–664` | 3 | Runtime/session list smoke assertions are weaker than `cli.test.ts:2909–2915` and `:2483–2488`; the second `ls launches` assertion duplicates `cli.test.ts:2943–2948`. |
| Same file, `:724–734` | 2 | Exact callback-body duplicates of `cli.test.ts:891–901` for the two removed `hrc run` admin commands. |
| Same file, `:781–786`, `:908–912`, `:922–932`, `:964–981` | 6 | Help/exit subsets already covered by stronger command-surface assertions in `cli.test.ts:1004–1050`; the start rotation behavior at 934–957 is stronger than its exit-only precheck at 922–932. |
| Same file, `:991–1026` | 3 | Subsumed by `cli.test.ts:1766–1790`, `:1023–1028`, and `:2054–2077`, which assert the same dry-run/no-mutation contracts with more output detail. |
| `packages/hrc-cli/src/__tests__/t04219-p3-did-you-mean.red.test.ts:267–271` | 1 | Exit-only `resume --help` check is weaker than the P2 help/Usage contract at 840–844. |
| `packages/hrcchat-cli/src/__tests__/t04219-p3-did-you-mean.red.test.ts:190–204` | 3 | Exact exit-code retests of `msg`, `seq`, and `mesagges`; stronger earlier tests at 76–98, 122–152, and 160–166 also verify output and suggestion behavior. |
| `packages/hrc-cli/src/__tests__/t06575-monitor-until-red.test.ts:430–454` | 1 | Direct `writeEarlyTimeout` helper test repeats all terminal fields asserted through the real command path in `monitor-watch.test.ts:783–825`. |
| `packages/hrc-cli/src/__tests__/cli-intent.test.ts:126–146` | 1 | Reads source text and searches import/identifier strings, but cannot prove delegation. Real profile-to-intent behavior is exercised at 186–223 and through CLI start paths. Move the ownership rule to the boundary checker if it remains required. |
| `packages/hrc-cli/src/__tests__/t04219-p3-did-you-mean.red.test.ts:116–125`, `:172–177` | 3 | Generic unknown exit/stdout is stronger in `smoke.test.ts:243–249`; the second `runtiem` test repeats global double-print suppression already covered by `montior` at 143–163. Keep the distinct runtime suggestion test at 165–170. |
| `packages/hrc-cli/src/__tests__/cli.test.ts:3058–3063` | 1 | Claims stderr routing but never checks stdout; weaker than `smoke.test.ts:243–249` and `cli.test.ts:1073–1078`. |
| `packages/hrcchat-cli/src/__tests__/show.test.ts:27–44` | 1 | Exact-ID `{ messageId, limit: 1 }` request is repeated by the shared selector matrix at `t06970-message-selector-matrix.test.ts:239–245`. |
| `packages/hrcchat-cli/src/__tests__/t04733-char-isturnend.test.ts:382–389` | 1 | Bare non-stacked `turn_end` exit check is subsumed by the realistic queued-turn command path in `turn.test.ts:260–284`. |
| `packages/hrcchat-cli/src/__tests__/t04219-p3-did-you-mean.red.test.ts:102–118` | 3 | The claimed phantom-map precedence is unobservable: Commander's fuzzy match yields the same visible `message → messages` result. The ordinary fuzzy contract at 160–166 owns observable suggestion behavior. |
| Same file, `:206–211` | 1 | Generic unknown-command exit/stdout repeats the stronger smoke contract at `smoke.test.ts:465–472`. |

### Server and broker — 46 tests

| Remove | Count | Stronger survivor / reason |
| --- | ---: | --- |
| `packages/hrc-server/src/__tests__/broker-runtime-hosting.red.test.ts:347–350`, `:429–431`, `:508–511`, `:883–885` | 4 | Defined/parse-only assertions are implied by immediately following field assertions; the normalized-headless leased-substrate test is exactly repeated at 891–893, where the title captures the transport-independence invariant. |
| Same file, `:1261–1263` | 1 | Exact callback-body duplicate of the `requireBrokerRuntimeHostingState` unparseable-runtime test at 806–808. |
| `packages/hrc-server/src/__tests__/broker-substrate-presentation-characterization.test.ts:262–304` and `:331–385` | 18 | Flat parser shape, field identity, distinctness, and predicate contracts are covered by the dedicated hosting suite at 352–404 and 839–1,028. Retain 306–329 because synthesized attach target/command composition is unique. |
| Same file, `:427–430` | 1 | Endpoint/substrate path distinctness is already asserted in the same suite at 336–349. Retain the socket-budget assertions at 395–425. |
| Same file, `:441–515` | 13 | Flat, normalized interactive, and normalized headless round-trip/predicate assertions are all covered by hosting parser and predicate matrices at 352–486 and 934–1,036. |
| Same file, `:538–540`, `:557–559`, and `:674–690` | 3 | Parse success is implied by the field assertion at 542–545; attachability is covered by hosting 1,005–1,016; the paired absent-TUI characterization repeats the same A4 contract. Retain 542–567 except 557–559 because endpoint/substrate preservation is unique. |
| `packages/hrc-server/src/__tests__/broker-admission-gates.red.test.ts:386–426` | 1 | Despite its title, it sends no dispatch and adds only untouched-count checks to the already-tested ask-client error code. |
| Same file, `:442–475` and `:644–688` | 2 | Both busy-rejection cases are subsumed by 523–571, which asserts the same 409/runtime-busy result plus zero broker input and zero new run. Retain 573–614 because it uniquely preserves the named preexisting run. |
| `packages/hrc-server/src/__tests__/t05095-daedalus-review-fixes.red.test.ts:585–596` | 1 | Pure defer predicate duplicates `defer-headless-to-interactive-broker.test.ts:78–82`. Other T-05095 cases exercise distinct admission, routing, ownership, persistence, or DTO boundaries and should relocate rather than disappear. |
| `packages/hrc-server/src/__tests__/broker-event-mapper-queued-attribution.red.test.ts:484–528` | 1 | Weaker duplicate of `broker-event-mapper-unwedge-fails-active-run.test.ts:87–109`, whose canonical outcome additionally requires the fossil run to fail with `RUN_MISMATCH`. |
| `packages/hrc-server/src/__tests__/server-sdk-dispatch.test.ts:1110–1129` | 1 | Sends the same non-broker interactive start request and asserts the same 503/code/message/no-launch outcome as 1131–1152. The fake binary name and delay do not create an observed precondition; retain the better-named survivor. |

### SDK and SQLite — 13 tests

| Remove | Count | Stronger survivor / reason |
| --- | ---: | --- |
| `packages/hrc-sdk/src/__tests__/sdk.test.ts:995–1022` | 3 | The status test at 932–978 already asserts API version, the complete platform capability object, and conditional tmux availability/version. The legacy T-00998 test also incorrectly hardcodes tmux availability. |
| Same file, `:1347–1356` | 2 | `HrcClient` and `discoverSocket` are imported from the package index and exercised throughout the file. Removing either export already fails compilation or earlier behavior tests; the two `typeof` checks add no independent contract. |
| `packages/hrc-store-sqlite/src/__tests__/store.json-corruption.test.ts:62–81`, `:97–183` excluding the unique tests at 184 onward | 4 | The parsed-scope, continuation, tmux, and event corruption cases duplicate `store.json-parse-crash.test.ts:69–188`. Keep the latter because it asserts the precise corruption diagnostic. Retain corruption tests for `last_applied_intent_json`, detailed log content, and multirow listing; retain parse-crash coverage for `app_sessions.metadata_json`. |
| `packages/hrc-store-sqlite/src/__tests__/store.local-bridges.test.ts:122–130` | 1 | Exact migration-ID duplicate of `store.app-sessions.test.ts:86–95`; both tables arrive in `0003_phase5_app_sessions_and_bridges`. Keep each repository-exposure and schema/index test. |
| `packages/hrc-sdk/src/__tests__/sdk.test.ts:98–102` | 1 | Constructor-defined smoke is implied by every client-method test that constructs and successfully uses `HrcClient`, beginning at 122. |
| `packages/hrc-store-sqlite/src/__tests__/store.surface-bindings.test.ts:118–126` | 1 | Repeats the `db.surfaceBindings` repository-exposure assertion in `store.test.ts:65–78`. |
| `packages/hrc-store-sqlite/src/__tests__/store.test.ts:1342` | 1 | Umbrella bind/find coverage is weaker than specialist assertions in `store.surface-bindings.test.ts:132` and 335. |

### Core contract no-ops — 4 tests

| Remove | Count | Stronger survivor / reason |
| --- | ---: | --- |
| Entire `packages/hrc-core/src/__tests__/bridge-contracts.test.ts` | 2 | Imports HRC only with `import type`; Bun erases the import and every expectation inspects a self-created literal. Tests are excluded by the package tsconfig, so these do not even act as compile-time contract checks. Replace with a real declaration/typecheck fixture if downstream type compatibility is valuable. |
| Entire `packages/hrc-core/src/__tests__/windows-contracts.test.ts` | 2 | Same defect: no production runtime code is observed, and the type-only assignments are outside normal TypeScript compilation. |

## Assertion-preserving consolidation — about 33 declarations

These are declaration/process reductions, not coverage culls. Merge the assertions into one test per identical invocation before deleting the split declarations:

- `hrc-cli/t04219-p3-did-you-mean.red.test.ts`: consolidate `montior`, `runtime insepct`, `session reslove`, and `resume --help` groups (about 8 declarations saved after the true culls).
- `hrcchat-cli/t04219-p3-did-you-mean.red.test.ts`: consolidate the surviving `msg` and `seq` groups (about 10 saved subprocesses).
- `hrc-cli/t04219-p2-command-surface.red.test.ts`: consolidate repeated `show --help`, `ls --help`, `admin --help`, `admin runs --help`, `run --attach-only`, `resume --help`, and `start --help` invocations (about 12 declarations).
- Move the unique assertions from `monitor-surface-polish.red.test.ts:113–122` into the real info/help contract, then remove its direct formatter test.
- Add `stderr === ''` to `cli.test.ts:2786–2798`, then remove the overlapping `smoke.test.ts:146–161` monitor snapshot declaration.
- Fold the useful help tokens from `cli.test.ts:876–889` into the preceding real `runtime sweep --help` test and remove its source-text assertion.

Treat 3,808 as a planning estimate, not an acceptance count: the implementation should record the exact declaration delta after mechanically combining each group.

## Explicit retain ledger

Do not cull these superficially similar cases:

- `t4922-presentation-aware-predicates.red.test.ts`: projection fields, capabilities, transport, reconciliation, lifecycle, and reap tests cross distinct seams.
- `t07118-suffix-roster.test.ts` versus `t07302-exact-scope-claim.test.ts`: identical request-shape assertions protect two separate externally reachable claim modes.
- `server-bridges.test.ts` versus `server-bridge-phase2.test.ts`: legacy and canonical endpoints remain separate public routes; removal requires an actual legacy API retirement, not a test refactor.
- Event mapper no-start attribution versus queued attribution: one proves owner fallback without `turn.started`; the other proves open-bracket precedence.
- Store surface-binding `findByRuntime` versus `listActive`: both exclude unbound rows through independent SQL predicates.
- Store rebind tests: one checks active-query visibility; the other checks reset fields on the binding row.
- SDK list-runtime/list-run live smoke versus stub request-shape tests: daemon route integration and client serialization are different boundaries.
- Monitor bounded reads, cursor/filter high-water behavior, membership, quantifiers, single-cut, and watch/wait parity: overlaps are across distinct mechanisms.
- HRC Mail tests: exact command roster and executable entrypoint smoke are separate claims.
- Remaining core selectors/fences/errors, event normalizers, frame rendering, capture verification, Pi top, and retention/reaper scripts: no further assertion-level cull was established; similar cases exercise distinct inputs or layers.
- Broker malformed-TUI matrix: missing identity, wrong type, and empty object are distinct parser inputs. Keep them.

## Structural refactor after culling

### 1. Enforce the invariant

Add a test-source size check that:

- Scans authored test sources only.
- Excludes `node_modules`, `dist`, generated declarations, and documentation.
- Fails above 1,000 lines.
- Reports pressure at 800 lines.
- Starts non-blocking and becomes blocking only after the baseline is clean.

### 2. Extract lifecycle fixtures

Create two narrow seams before splitting process-heavy suites:

- `packages/hrc-cli/src/__tests__/fixtures/cli-test-fixture.ts`
  - In-process stdout/stderr/exit capture.
  - Explicit subprocess routing.
  - Environment restoration.
  - Temporary server roots and seed helpers.
  - tmux, broker-server, socket, and process cleanup.

- `packages/hrc-server/src/__tests__/fixtures/fake-harness-driver.ts`
  - Compose with the existing `createHrcTestFixture`.
  - Install a configurable fake Codex executable.
  - Record argv/stdin and emit selected broker events.
  - Model resume/new-session, delayed exit, and thread identity as explicit options.

Fixture contract tests must prove cleanup after success, expected CLI exit, unexpected throw, partial server startup, and child-process failure.

### 3. Split oversized suites by behavior

Use the detailed split map in `refactor-analysis/hrc-test-suites-report.md`. Recommended delivery waves:

1. Store, SDK, capture verifier, Pi top, and retention script.
2. CLI help, lifecycle, session, start, attach/run, and diagnostics.
3. Server hrcchat routes and SDK dispatch.
4. Broker controller, hosting, event mapping, and reconciliation.

Perform move-only commits before assertion rewrites. Every destination should remain below 800 lines to leave growth room.

### 4. Dissolve historical task buckets

Move surviving green contracts out of `t04219-p2-command-surface.red.test.ts` and `t05095-daedalus-review-fixes.red.test.ts` into behavior-owned suites. Keep task IDs in individual test descriptions when provenance remains useful. Do not bulk-rename small cohesive regression files merely because they carry a task ID.

### 5. Separate test tiers and ownership

Adopt four explicit tiers with independent commands and budgets:

| Tier | Owns | Default execution |
| --- | --- | --- |
| Unit | Pure parser, mapper, predicate, formatter, repository method | Every edit; parallel |
| Contract | Public DTOs, package exports, CLI request/response shape, migration schema | Every PR; parallel where isolated |
| Integration | Real server/socket/database plus one public boundary | Every PR; sharded |
| Installed/live | Published binaries, daemon lifecycle, tmux/Ghostty, real round-trip | Required for affected surfaces; serialized |

A behavior should have one primary owner. Higher tiers should test wiring and a representative path, not replay the lower tier's entire matrix. Tests that inspect source strings, comments, imports, or forbidden identifiers should move to `check:boundaries`/lint/declaration checks unless source text itself is the deliverable.

### 6. Make runtime and flake cost visible

- Emit per-file duration and retry/failure history in CI; review the slowest 20 files each month.
- Put process-heavy CLI tests behind shared fixtures and run identical command inputs once per test.
- Serialize only suites that mutate process environment, global stdout/stderr, daemon sockets, tmux, or launch state; keep pure suites parallel.
- Require every lifecycle fixture to register cleanup immediately after resource creation and prove cleanup on throw as well as success.
- Track test count by tier and package, but use escaped defects, branch/contract coverage, wall-clock time, and flake rate as the health measures. A raw target such as “under 4,000” is not a quality objective.

### 7. Prevent historical accumulation

- New green tests belong in behavior-owned files; `.red` and task-bucket suites are temporary staging areas.
- A defect test should name the durable behavior first and carry the task ID as metadata or suffix.
- Every compatibility test must name the public compatibility promise and its retirement trigger. Delete the test with the retired route rather than preserving a ghost API indefinitely.
- Reject tests whose only assertion is “defined,” `typeof`, a parse non-null check followed by stronger field checks, or a literal echo—unless that exact export/type/runtime-presence property is the contract and no stronger consumer exercises it.

## Application protocol

For every cull group:

1. Run the candidate and survivor files before editing.
2. Delete only one ledger group at a time.
3. Run the survivor file and affected package suite.
4. Confirm the static test-count delta equals the ledger count.
5. Review that every removed assertion exists in the named survivor at the same or stronger boundary.

After each structural split:

1. Run every destination file alone.
2. Run the package suite.
3. Run build before typecheck.
4. Run the root test suite.
5. Repeat CLI/server tests to expose leaked environment, daemon, tmux, socket, or child-process state.

## Acceptance criteria

- The 116 high-confidence removals are independently reviewed against their named survivors.
- Static declaration count after true culls is exactly 3,841; consolidation deltas are recorded separately.
- Static test count drops by exactly the accepted cull count; move-only phases do not change it.
- No authored test file exceeds 1,000 lines; decomposed files are at most 800 lines.
- No production code or public API changes.
- All destination files pass alone and in their packages.
- Build, typecheck, root tests, and the new size gate pass.
- Repeated process-heavy tests leave no daemon, tmux server, broker process, socket, temp directory, or environment mutation behind.

## Suggested task sequence

1. **Cull the 116 proven redundant/non-observing tests** — `refactor,test-cull`.
2. **Consolidate repeated CLI invocations without dropping assertions** — `refactor,test-runtime`.
3. **Extract canonical CLI lifecycle fixture** — `refactor,hrc-cli`.
4. **Extract fake harness/server lifecycle fixture** — `refactor,hrc-server`.
5. **Decompose package and CLI mega-suites** — `refactor,test-structure`.
6. **Decompose broker/server mega-suites** — `refactor,broker`.
7. **Move source-structure rules into boundary/declaration checks** — `refactor,test-contracts`.
8. **Enable tiered commands, timing telemetry, the 1k gate, and 800-line pressure report** — `refactor,test-infrastructure`.
