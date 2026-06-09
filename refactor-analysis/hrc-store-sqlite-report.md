# Refactor Analysis — `packages/hrc-store-sqlite`

Behavior-preserving refactor audit. Report only; no source edited.

Scope inspected (non-test):
- `src/repositories.ts` — 4228 lines, 21 exported repository classes + shared helpers/mappers
- `src/migrations.ts` — 1277 lines, migration registry + runner
- `src/message-repository.ts` — 333 lines
- `src/migrations/legacy-hrc-event-backfill.ts` — 146 lines
- `src/database.ts` — 109 lines, factory + `HrcDatabase` facade type
- `src/index.ts` — 26 lines, public re-exports

Test coverage: 15 test files in `src/__tests__/` exercise the repositories broadly
(store.test, broker-persistence, hrc-events, messages, surface-bindings, app-sessions,
continuity-chain, fk-rejection, json-corruption/crash, generation-isolation,
lifecycle-persistence, local-bridges, etc.). Tests import only the public surface
(`from '../repositories'`, `from '../database'`), so private intra-file helpers are
safe to extract/rename without touching tests.

---

## SOLID Scorecard

| Principle | Grade | Notes |
|-----------|-------|-------|
| **S** — Single Responsibility | **C** | `repositories.ts` is one 4228-line file holding 21 distinct table repositories + all row types + all mappers + all SQL helpers. Per-method SRP is good (most methods are small, one SQL op). The file itself is the violation: effectively 21 modules glued together. `migrations.ts` (1277 lines) similarly concatenates 22 migration definitions + the runner. |
| **O** — Open/Closed | **B** | Largely additive: new table = new repo class; new migration = new const + array entry. No growing type-keyed switch chains in business logic. The `update(patch)` methods are long `if (patch.x !== undefined)` ladders that grow per column — a data-mapping ladder, not an OCP polymorphism gap. |
| **L** — Liskov | **A** | No inheritance among repositories (all flat, constructor-injected `db`). `BrokerInvocationEventConflictError extends Error` is faithful. No "not implemented"/no-op overrides. |
| **I** — Interface Segregation | **A−** | No fat interfaces. `HrcDatabase` is a record-of-repositories facade (24 members) but a composition root, not an interface implementors must stub. Each repo exposes a small, cohesive method set (mostly 3–8 methods). |
| **D** — Dependency Inversion | **B** | Repositories take `Database` via constructor (good seam). `openHrcDatabase` `new`s every concrete repo — acceptable composition root. `new Date().toISOString()` inline in `MessageRepository.insert` and `runMigrations` (un-injected clock); minor testability gap, behavior-correct. |

---

## Priority Refactorings

### P1 — Split `repositories.ts` (4228 lines) into per-domain modules
- **Location:** `src/repositories.ts:1-4228` (21 classes: `ContinuityRepository`@982, `SessionRepository`@1080, `AppSessionRepository`@1237, `AppManagedSessionRepository`@1416, `RuntimeRepository`@1556, `RunRepository`@1869, `LaunchRepository`@2097, `EventRepository`@2339, `HrcLifecycleEventRepository`@2462, `LocalBridgeRepository`@2654, `SurfaceBindingRepository`@2743, `ActiveInputDeliveryRepository`@2849, `RuntimeBufferRepository`@3021, broker cluster `LifecyclePolicyRepository`@3474 … `PermissionDecisionRepository`@4134).
- **Principle/smell:** SRP / long file / low cohesion in one compilation unit.
- **Current:** All row types, `*_COLUMNS` constants, mappers, shared SQL helpers, and 21 repository classes live in a single file.
- **Suggested:** Carve into cohesive modules — e.g. `repositories/sql-helpers.ts` (execute, buildSetClause, buildEventWhere, buildLifecycleWhere, parseJson, serializeJson, requireRecord, boolean/sessionRef helpers), `repositories/session.ts`, `repositories/runtime.ts`, `repositories/run.ts`, `repositories/launch.ts`, `repositories/events.ts`, `repositories/broker.ts`, etc. Keep `repositories.ts` (or `repositories/index.ts`) as a barrel re-exporting the exact symbols `index.ts`/`database.ts` already consume, so the package's exported surface stays byte-identical.
- **Risk:** **Med** — large multi-file move; high chance of an import/cycle slip mid-flight while N packages refactor in parallel.
- **API-impact:** **public-surface** — these classes/types are re-exported by `index.ts`. A barrel keeps it behavior-preserving, but the operation is large and ambiguous enough to need human sign-off.
- **Effort:** Large (mechanical but wide).
- **Tests:** Existing 15 suites import only public names; with the barrel they stay green. Run full `hrc-store-sqlite` suite + global typecheck (`hrc-server` consumes the barrel).
- **Disposition:** **DEFER.**

### P2 — Collapse repeated `update(patch)` column-ladders into a shared patch applier
- **Location:** `RuntimeRepository.update` `src/repositories.ts:1677-1793` (~115 lines, 37 `if` blocks); `RunRepository.update` `:1998-2057`; `LaunchRepository.update` `:2165`+; `RuntimeOperationRepository.update` `:3665`+; `BrokerInvocationRepository.update` `:3809-3867`; `BrokerInvocationEventRepository.updateProjection` `:4028-4058`; `MessageRepository.updateExecution` `src/message-repository.ts:283-332`.
- **Principle/smell:** Duplicated structural block / long method.
- **Current:** Each method hand-rolls an `entries: Array<[column, value]>` accumulator with one `if (patch.x !== undefined) entries.push([...])` per column, then funnels through the shared `buildSetClause` + `execute` + reload.
- **Suggested:** Add a private helper, e.g. `collectPatchEntries(patch, spec)` where `spec` is a per-repo array of `{ key, column, transform? }` (transform handles `serializeJson` / `toSqliteBoolean` / `?? null`). Each `update` shrinks to a `spec` table + the existing empty-guard + `buildSetClause`/`execute` tail. Behavior identical (same columns, same order, same null coercion).
- **Risk:** **Low** per method; the transform-bearing fields (runtime `tmuxJson`/`adopted`, etc.) need careful spec entries, so do them one at a time and diff bound values.
- **API-impact:** **internal-only** — method signatures unchanged; helper private.
- **Effort:** Medium (simple-value `update`s trivial; `RuntimeRepository.update` with JSON/boolean transforms is the careful one).
- **Tests:** `store.lifecycle-persistence`, `store.broker-persistence`, `store.test`, `store.messages`. Re-run after each method.
- **Disposition:** **APPLY** (low/internal). Apply pure simple-value methods first (`RunRepository.update`, `RuntimeOperationRepository.update`); transform-bearing ones only if the spec faithfully reproduces the transforms.

### P3 — Extract shared "insert-then-reload" tail for verbatim column INSERTs
- **Location:** `RuntimeRepository.insert` `:1559-1646`, `LaunchRepository.insert` `:2100-2157`, `BrokerInvocationRepository.insert` `:3720-3787`, `RuntimeOperationRepository.insert` `:3584-3643`, `RuntimeArtifactRepository.insert` `:4064`, `PermissionDecisionRepository.insert` `:4137`.
- **Principle/smell:** Repeated boilerplate (`execute(INSERT …)` → `requireRecord(this.getByX(id), 'failed to reload …')`).
- **Current:** Each insert writes the literal column list + `VALUES(?,…)` then reloads via its own `getByX` + `requireRecord`.
- **Suggested:** Keep the explicit INSERT column lists (the write contract — order must stay pinned). The `execute(...) ; return requireRecord(this.getBy…(id), msg)` tail is mechanically identical and could be a tiny private `insertAndReload` helper, or left as-is.
- **Risk:** **Low.**
- **API-impact:** **internal-only.**
- **Effort:** Small.
- **Tests:** insert paths covered by nearly every suite.
- **Disposition:** **APPLY** only if it de-duplicates without obscuring the column contract; otherwise leave. Marginal/optional.

### P4 — Migration ID ordering / duplicate-id hazard
- **Location:** `src/migrations.ts:1209-1232` (`phase1Migrations` array) + `id:` fields: `interactiveSurfaceJsonMigration id:'0015'`@325 declared before `hrcEventsMigration id:'0008'`@353; `runtimeBuffersScopedByRunMigration id:'0010'`@560 and `activeInputDeliveriesMigration id:'0010'`@641 **share id `0010`**; `hrcchatMessagesMigration id:'0007'`@583 ordered after the `0010`s.
- **Principle/smell:** Hidden invariant / misleading identifiers. `runMigrations` (`:1255-1277`) applies in **array order**, NOT id-sorted, recording each id in `hrc_migrations` (PRIMARY KEY). Duplicate `0010` is latent: a fresh DB applying both `0010`s as pending in one tx would hit a PK conflict; existing DBs survive because they were applied across releases.
- **Current:** Array order is authoritative; ids are decorative and inconsistent.
- **Suggested:** Do NOT renumber — renaming a migration id corrupts the applied-set check against existing production/worktree DBs (a behavior change with the shared-worktree blast radius). Best handled as a deliberate migration-aware task: add a unique-id assertion + document that array order is the source of truth. (Even the assertion changes runtime behavior, so out of scope here.)
- **Risk:** **High** — touches the migration applied-set contract against persisted data.
- **API-impact:** internal-only by symbol, but **behavior-load-bearing at runtime** against persisted databases.
- **Effort:** N/A for this pass.
- **Tests:** migration application is exercised implicitly by every `openHrcDatabase`, but there is no explicit "ids unique / order" guard.
- **Disposition:** **DEFER** (document only; do not touch).

---

## Code Smells

| # | Location | Smell | Note | Risk | API |
|---|----------|-------|------|------|-----|
| 1 | `repositories.ts` whole file | Large module (4228 LOC, 21 classes) | See P1 | Med | public-surface |
| 2 | `RuntimeRepository.update` `:1677-1793` | Long method (~115 lines, 37 ifs) | See P2 | Low | internal |
| 3 | `RunRepository.update` `:1998-2057` | Duplicated patch-ladder | See P2 | Low | internal |
| 4 | `BrokerInvocationRepository.update` `:3809-3867` | Duplicated patch-ladder | See P2 | Low | internal |
| 5 | `MessageRepository.updateExecution` `message-repository.ts:283-332` | Duplicated patch-ladder | Same shape as P2 (separate file) | Low | internal |
| 6 | `migrations.ts:1209` + ids | Duplicate id `0010`, non-monotonic ids | See P4 | High | runtime data |
| 7 | `MessageRepository.insert` `message-repository.ts:122` & `runMigrations` `migrations.ts:1271` | Un-injected clock (`new Date().toISOString()`) | Minor DI/testability gap; behavior-correct | Low | internal (defer — injecting a clock alters a signature ⇒ public) |
| 8 | `repositories.ts` `*_COLUMNS` vs inline INSERT column lists | Mild duplication | Column order pinned twice (SELECT const + INSERT literal). Intentional write contract. | Low | internal |
| 9 | `parseJson` `:355-369` | `console.error` side-effect in a mapper | Logs corrupt JSON inline; pinned by `store.json-corruption`/`json-parse-crash` — do not change behavior | Low | internal |
| 10 | `mapAddress` `message-repository.ts:52` | Primitive `as 'human' \| 'system'` cast | Documented pre-validated trust boundary; leave | Low | internal |

No dead code found. No long parameter lists (>4) — wide inputs passed as single options objects. No deep nesting (>=4) — methods early-return. No feature envy across repos.

---

## Quick Wins (safe, internal-only — APPLICABLE)

1. **P2 simple-value `update`s** — refactor `RunRepository.update` (`:1998`) and `RuntimeOperationRepository.update` (`:3665`) to a spec-driven `collectPatchEntries` helper. No transforms ⇒ lowest risk, clear readability gain.
2. **P2 transform-bearing `update`s** — `RuntimeRepository.update` (`:1677`), `LaunchRepository.update` (`:2165`), `BrokerInvocationRepository.update` (`:3809`), `BrokerInvocationEventRepository.updateProjection` (`:4028`), `MessageRepository.updateExecution` (`message-repository.ts:283`): same helper with per-field transform fns. Apply one at a time, diffing bound-value order.
3. **P3 insert-reload tail** — optional micro-helper for `execute(INSERT) → requireRecord(getBy…)` (keep explicit column lists).

All Quick Wins are intra-file private helpers; the 15 test suites import only public names and stay untouched.

---

## Technical Debt Notes (DEFER — human decision)

- **P1 file split (Med / public-surface):** Biggest structural debt. Safe in principle via an export-preserving barrel, but too large/ambiguous to auto-apply in a parallel multi-package pass. Recommend a dedicated follow-up.
- **P4 migration id integrity (High / runtime-data):** Duplicate id `0010` and non-monotonic ids are a real latent hazard, but any id rename or added assertion changes behavior against persisted databases. Handle with a deliberate migration-aware plan, not a refactor pass.
- **Clock injection (smell #7):** `new Date()` inline in `MessageRepository.insert` and `runMigrations`. Injecting a clock changes a constructor/function signature (public). Defer.
- **Trust-boundary casts** (`parseJson<T>` unchecked cast, `mapAddress` entity cast): intentional and documented; no action.
