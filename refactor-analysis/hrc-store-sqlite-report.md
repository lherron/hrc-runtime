# Refactor Analysis — `packages/hrc-store-sqlite/src`

Date: 2026-06-07
Methodology: SOLID violations, code smells, complexity (analysis only, no edits)

## Scope

Production source (excluding `__tests__/`): **6,119 lines** across 5 files.

| File | Lines | Role |
| --- | --- | --- |
| `repositories.ts` | 4,246 | **All 20 repository classes** + row types + column-list constants + row-mapper functions |
| `migrations.ts` | 1,405 | 22 migration definitions + legacy HRC-event backfill normalization logic |
| `message-repository.ts` | 333 | `MessageRepository` (cleanly separated, the model for the rest) |
| `database.ts` | 109 | `openHrcDatabase` factory + `HrcDatabase` facade type |
| `index.ts` | 26 | Public barrel re-exports |

Test view: 15 test files, **6,982 lines** of tests — coverage is broad but tied to the monolithic file (no per-repository test module boundary).

The package is a textbook SQLite repository layer. The code is *consistent and disciplined* within each unit (column-list constants centralize SELECTs; mappers are pure; `buildSetClause` factors PATCH assembly). The dominant problem is not local quality — it is **file-level SRP**: one 4,246-line module holds 20 unrelated aggregate repositories.

## SOLID Scorecard

| Principle | Status | Notes |
| --- | --- | --- |
| **S — SRP** | 🔴 red | `repositories.ts` (4,246 LOC) bundles 20 repository classes for 20 distinct aggregates; `migrations.ts` (1,405 LOC) mixes migration registry with ~700 LOC of legacy-event backfill normalization. |
| **O — OCP** | 🟢 green | No type-keyed switch chains in business logic. The repeated `if (patch.x !== undefined)` update builders are mechanical column mapping, not behavioral branching. Migration list is append-only (open for extension). |
| **L — LSP** | 🟢 green | No inheritance hierarchies, no overrides, no `throw "not implemented"`, no type-checks-before-call. Repositories are flat siblings. |
| **I — ISP** | 🟡 yellow | The `HrcDatabase` facade type exposes 22 repository members; consumers depend on the whole surface. Individual repository classes are appropriately small and focused. The DI seam is the whole DB object, not interfaces. |
| **D — DIP** | 🟡 yellow | `openHrcDatabase` hard-`new`s all 20 concrete repositories (acceptable for a composition root). But the repositories are concrete classes with no extracted interface, so downstream code (hrc-server) couples to concrete types; testing requires a real `bun:sqlite` Database, not a seam. |

## Priority Refactorings

Ranked by impact × confidence.

### 1. Split `repositories.ts` into per-aggregate modules (SRP)
- **Location:** `repositories.ts:886-4244` (all 20 exported repository classes)
- **Principle:** S (SRP) — one module, 20 reasons to change
- **Current:** A single 4,246-line file holds `ContinuityRepository`, `SessionRepository`, `AppSessionRepository`, `AppManagedSessionRepository`, `RuntimeRepository`, `RunRepository`, `LaunchRepository`, `EventRepository`, `HrcLifecycleEventRepository`, `LocalBridgeRepository`, `SurfaceBindingRepository`, `ActiveInputDeliveryRepository`, `RuntimeBufferRepository`, plus the 6 broker-persistence repositories. Every column-list constant, row type, and mapper is co-located.
- **Suggested:** One file per aggregate (`session-repository.ts`, `runtime-repository.ts`, `run-repository.ts`, `launch-repository.ts`, `event-repository.ts`, `hrc-lifecycle-event-repository.ts`, `app-session-repository.ts`, `local-bridge-repository.ts`, `surface-binding-repository.ts`, `active-input-delivery-repository.ts`, `runtime-buffer-repository.ts`, and a `broker/` subfolder for the 6 broker repos). Keep `repositories.ts` (or `index`) as a barrel re-export so the public API is byte-identical. Move shared helpers (`serializeJson`, `parseJson`, `parseRequiredJson`, `buildSetClause`, `requireRecord`, `execute`, `to/fromSqliteBoolean`, `toSessionRef`, `allocateStreamSeq`) into a `shared.ts`/`sql-helpers.ts`.
- **Risk:** medium (large mechanical move; risk is import-path churn and accidental symbol drops, mitigated by the barrel + the existing 6,982-line test suite)
- **Effort:** L (1–2 days, mostly mechanical)
- **API-preserving:** yes (barrel keeps every exported symbol's name and signature)
- **Tests:** existing suite is the regression net; run full `hrc-store-sqlite` suite + a `tsc` check across dependents (`hrc-server`).

### 2. Extract the legacy-event backfill logic out of `migrations.ts` (SRP)
- **Location:** `migrations.ts:432-1140` (`parseLegacyEventJson`, `isRecord`, `readLifecycleTransport`, `categoryForLegacyHrcEventKind`, `normalizeLegacyHrcPayload`, `computeMigrationPermissionIdentityKey`, and the backfill migration body)
- **Principle:** S (SRP) — schema registry vs. data-transformation logic in one file
- **Current:** ~700 LOC of legacy HRC-event payload parsing/normalization (a one-time data migration concern) is interleaved with the 22 schema-DDL migration definitions and the migration runner.
- **Suggested:** Move the legacy backfill normalization helpers into `migrations/legacy-hrc-event-backfill.ts`; keep `migrations.ts` as the registry (`phase1Migrations`) + runner (`runMigrations`, `listAppliedMigrations`, `ensureMigrationTable`). Optionally split each large DDL migration into its own file under `migrations/`.
- **Risk:** low (pure function moves; the backfill helpers are internal, not exported from the package barrel)
- **Effort:** M
- **API-preserving:** yes (none of these helpers are re-exported via `index.ts`)
- **Tests:** `store.json-corruption`, `store.json-parse-crash`, and lifecycle-persistence tests cover the normalization paths.

### 3. Extract a `RepositoryUpdateBuilder` / patch-mapping table to collapse the `if (patch.x !== undefined)` runs (DRY / readability)
- **Location:** `repositories.ts:1581-1697` (`RuntimeRepository.update`, ~116 LOC), `repositories.ts:1902-1961` (`RunRepository.update`), `repositories.ts:2069-2140` (`LaunchRepository.update`), `repositories.ts:3683-3728` (`RuntimeOperationRepository.update`), `repositories.ts:3827-3885` (`BrokerInvocationRepository.update`)
- **Principle:** S (SRP at the method level — `RuntimeRepository.update` is >50 LOC) + DRY
- **Current:** Five near-identical update methods, each a long flat sequence of `if (patch.field !== undefined) entries.push(['col', value])`. `RuntimeRepository.update` alone is ~116 lines and maps 35 columns.
- **Suggested:** Declare a per-table column-mapping descriptor (array of `{ patchKey, column, transform? }`) once, and iterate it to build `entries`. This turns each 50–116-line method into a ~3-line call. `transform` handles the `serializeJson` / `toSqliteBoolean` / `?? null` cases.
- **Risk:** medium (touches the hot write path; subtle: some columns use `serializeJson`, some use `?? null`, a few `RuntimeOperation`/`BrokerInvocation` fields coerce `undefined→null` while `Runtime` passes the value through — the descriptor must preserve each field's exact coercion)
- **Effort:** M
- **API-preserving:** yes (method signatures unchanged; pure internal restructuring)
- **Tests:** lifecycle-persistence, broker-persistence, generation-isolation suites exercise updates; add explicit per-field round-trip assertions before refactoring.

### 4. Extract repository interfaces to create a DIP/testing seam (DIP / ISP)
- **Location:** `database.ts:30-57` (`HrcDatabase` facade) + each concrete repository class
- **Principle:** D (DIP) + I (ISP)
- **Current:** Repositories are concrete classes; the only injection seam is a live `bun:sqlite` `Database`. Downstream `hrc-server` depends on concrete repository types. There is no way to substitute a fake for unit tests of consumers.
- **Suggested:** Extract a read-only interface per repository (or at minimum group facade interfaces by domain) and have `HrcDatabase` expose interfaces. Low value if the team is content testing against in-memory `:memory:` SQLite (which is fast and already used). Treat as **optional / debt note**, not urgent.
- **Risk:** medium (changes the public facade type's member types; could ripple into `hrc-server` type imports)
- **Effort:** L
- **API-preserving:** no (changes the exported `HrcDatabase` member types and adds new exported interface symbols)
- **Tests:** type-level; rely on `tsc` across the workspace.

### 5. De-duplicate the WHERE-builder duplicated between `runQuery` and `listLatestPerSession` (DRY)
- **Location:** `repositories.ts:2530-2600` (`listLatestPerSession`) and `repositories.ts:2602-2669` (`runQuery`), both in `HrcLifecycleEventRepository`
- **Principle:** DRY / SRP
- **Current:** The two methods each contain a ~30-line, near-identical block of `if (filters.x !== undefined) { where.push(...); values.push(...) }` for 9 filter fields. `listLatestPerSession` omits the seq/limit predicates; otherwise the filter assembly is copy-pasted.
- **Suggested:** Extract a private `buildLifecycleWhere(filters, { includeSeqPredicates })` returning `{ where, values }`. Same pattern recurs in `EventRepository.listFromSeq` vs `EventRepository.count` (`repositories.ts:2301-2371`).
- **Risk:** low (internal helper; filter semantics are identical between the two callers)
- **Effort:** S
- **API-preserving:** yes
- **Tests:** `store.hrc-events`, `store.hrc-events-latest-per-session` cover both query shapes.

## Code Smells

| Smell | Location | Detail | Severity |
| --- | --- | --- | --- |
| God file | `repositories.ts` (whole) | 4,246 LOC, 20 classes | high |
| God file | `migrations.ts` (whole) | 1,405 LOC, registry + transform logic | high |
| Long method | `RuntimeRepository.update` `repositories.ts:1581` | ~116 LOC, 35 columns | high |
| Long method | `normalizeLegacyHrcPayload` `migrations.ts:479` + backfill body | large destructure + branch logic | medium |
| Long method | `LaunchRepository.update` `repositories.ts:2069`, `RunRepository.update` `repositories.ts:1902` | >50 LOC each | medium |
| Duplicated block | `repositories.ts:2530` vs `2602`; `2301` vs `2338` | filter-WHERE assembly copy-pasted | medium |
| Duplicated structure | 5 `update()` methods + ~13 `insert()` methods | same INSERT/SELECT-back/`requireRecord` shape repeated per table | medium |
| Long param list | `RunRepository.markCompleted` `repositories.ts:1967` (single options obj — acceptable); `SurfaceBindingRepository.unbind` `repositories.ts:2809` (4 positional) | borderline; options-object style preferred | low |
| Magic number | `RunRepository.listRuns` default `limit ?? 100` `repositories.ts:1873`; `parseJson` snippet cap `80` `repositories.ts:363`; `busy_timeout = 5000` `database.ts:71` | un-named constants | low |
| Primitive obsession | `status` columns typed as bare `string` across Runtime/Run/Launch/Session rows | loses the enum the domain types carry | low |
| Inconsistent return contract | `MessageRepository`/`RuntimeBufferRepository` throw on missing reload; most repos return `null` from getters but throw via `requireRecord` on insert reload | intentional but worth documenting | low |
| Unchecked cast | `parseJson<T>` returns `JSON.parse(value) as T` `repositories.ts:355` | documented trust-boundary; acceptable, flagged for awareness | low |

## Quick Wins

- Extract `buildLifecycleWhere` helper to kill the duplicated filter blocks in `HrcLifecycleEventRepository` (Refactoring #5) — small, low-risk, API-preserving.
- Name the magic numbers: `DEFAULT_RUN_LIST_LIMIT = 100`, `JSON_ERROR_SNIPPET_LEN = 80`, `SQLITE_BUSY_TIMEOUT_MS = 5000`.
- Move the legacy-backfill helpers out of `migrations.ts` (Refactoring #2) — pure internal moves, no public-API impact.
- Add a top-of-file index comment in `repositories.ts` listing the class order (line-jump aid) until the file is split.

## Technical Debt Notes

- The package is internally clean — the debt is *structural granularity*, not local sloppiness. `message-repository.ts` is the proof: it is the same pattern as the others, lives in its own file, and reads fine. The refactor goal is to make every repository look like `message-repository.ts`.
- The 6 broker-persistence repositories (lines 3102-4244) were added additively (T-01690 W1B) and form a natural sub-package (`broker/`); they are the cleanest candidate to extract first as a self-contained slice.
- Test files are split by concern (15 files) but all import from the single barrel; after the file split, consider co-locating each test next to its repository module.
- `runMigrations` wraps all pending migrations in a single transaction (`migrations.ts:1392`) — good. The legacy backfill is the only migration doing heavy row-by-row transformation; isolating it (Refactoring #2) makes its risk surface explicit.
- No interface seam means consumer unit tests must spin up `:memory:` SQLite. This is fast and arguably fine; only pursue Refactoring #4 if consumer tests start feeling the weight.

## Safety Checklist

- [ ] Run the full `hrc-store-sqlite` test suite (15 files) before and after any change; diff results.
- [ ] After file splits, run `tsc --noEmit` across the workspace (esp. `hrc-server`, `hrc-cli`) to catch broken imports.
- [ ] Keep `index.ts` / a barrel re-exporting every currently-exported symbol — verify the export list is byte-identical (compare `git diff` of `index.ts` exports).
- [ ] For Refactoring #3 (update-builder), assert per-field write round-trips first: each table's `update()` must preserve the exact `undefined→null` vs pass-through and `serializeJson`/`toSqliteBoolean` coercion currently applied.
- [ ] Do not alter SQL column lists or DDL during the move — column constants must travel verbatim.
- [ ] Verify migration IDs and ordering in `phase1Migrations` are untouched (any reordering corrupts applied-migration tracking).
- [ ] Restart `hrc-server` after store changes for any live e2e (per repo memory: daemon holds source resident).
