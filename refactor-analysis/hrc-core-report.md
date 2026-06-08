# Refactor Analysis — `packages/hrc-core/src`

_Analysis only. No source files were modified. Date: 2026-06-07._

## Scope

| Metric | Value |
| --- | --- |
| Production `.ts` files (excl. `__tests__`) | 10 |
| Production lines | 4,114 |
| Test files / lines | 8 / 2,235 |
| Largest files | `http-contracts.ts` (902), `contracts.ts` (656), `monitor/index.ts` (560), `monitor/condition-engine.ts` (552), `selectors.ts` (466) |

### Nature of the package

`hrc-core` is the **shared contract / pure-logic** layer consumed by `hrc-server`, `hrc-sdk`, `hrc-cli`, and `hrcchat`. Three of the four largest files are **declaration-only** DTO modules with zero runtime logic:

- `http-contracts.ts` (902) — wire request/response DTOs
- `contracts.ts` (656) — domain records / enums
- `hrcchat-contracts.ts` (290) — semantic-messaging DTOs

The genuine *logic* lives in four small, well-factored modules: `monitor/condition-engine.ts`, `monitor/index.ts`, `selectors.ts`, `errors.ts`, `fences.ts`, `paths.ts`. **There is no IO in this package** (no DB, no network, no fs except `paths.ts` reading env). Pure functions + Proxy. This is a healthy boundary package; findings are mostly polish, not structural rot.

## SOLID Scorecard

| Principle | Status | Notes |
| --- | --- | --- |
| **S** (SRP) | yellow | Logic modules are clean. But `contracts.ts` and `http-contracts.ts` are 600–900-line "everything" type buckets mixing semantic-core, broker, sweep/reconcile, bridge, and app-session concerns in one file. |
| **O** (OCP) | yellow | Several parallel `switch (selector.kind)` / `switch (condition)` chains duplicated across `monitor/index.ts`, `condition-engine.ts`, and `selectors.ts`. Adding a selector kind touches 4+ switches with no compiler exhaustiveness guard in some. |
| **L** (LSP) | green | No throwing overrides, no no-op overrides, no downcast-before-call. Error class hierarchy (`HrcDomainError` subclasses) is clean and substitutable. |
| **I** (ISP) | yellow | `InspectRuntimeResponse` (~100-line single type) and `HrcLaunchArtifact` are fat aggregates; `HrcCapabilityStatus.capabilities` is a deeply nested 4-group interface. Consumers depend on the whole blob. |
| **D** (DIP) | green | `createMonitorReader` / `createMonitorConditionEngine` are factory functions taking injected readers — exemplary seam. `paths.ts` reads `process.env` directly but that is the intended config edge. |

## Priority Refactorings

### 1. Split `http-contracts.ts` (902 lines) by concern

- **Location**: `packages/hrc-core/src/http-contracts.ts:1-903`
- **Principle / smell**: SRP — one file holds session, runtime-lifecycle, dispatch, active-run-contribution, attach, inspect, sweep/reconcile, surface-binding, bridge, and app-session DTO families.
- **Current**: A single module re-exported wholesale through `index.ts`.
- **Suggested**: Split into `http-contracts/{session,runtime,dispatch,attach,sweep,bridge,app-session}.ts` with a barrel `http-contracts/index.ts` re-exporting all. `index.ts` import path (`./http-contracts.js`) stays valid if the barrel keeps the filename, or update the one import site. No type *signatures* change.
- **Risk**: low (type-only move; `tsc` proves completeness).
- **Effort**: M (mechanical but ~50 type moves).
- **API-preserving**: yes (no exported symbol signature changes; same names re-exported).
- **Tests**: `tsc --noEmit` across the workspace + existing `windows-contracts.test.ts`, `bridge-contracts.test.ts` compile checks.

### 2. Split `contracts.ts` (656 lines) — separate broker-persistence records

- **Location**: `packages/hrc-core/src/contracts.ts:413-591` (the `Hrc*Broker*Record` / `HrcRuntimeOperation*` block) and `:593-657` (status views).
- **Principle / smell**: SRP / cohesion — broker-persistence DTOs are explicitly marked "additive and inert, written only by the harness-broker controller" yet sit in the core domain file mixed with `HrcSessionRecord` etc.
- **Current**: Single 656-line bucket.
- **Suggested**: Extract `contracts/broker-records.ts` (lines ~413–591) and `contracts/status.ts` (lines ~593–657); keep a barrel. Improves change isolation for the actively-churning broker work (per memory notes, broker DTOs change frequently).
- **Risk**: low.
- **Effort**: M.
- **API-preserving**: yes (type-only re-export; names unchanged).
- **Tests**: `tsc --noEmit` workspace-wide.

### 3. Centralize selector-kind dispatch (OCP)

- **Location**: `monitor/index.ts:184-219` (`resolveParts`), `:369-398` (`eventMatchesSelector`), `:507-560` (`notFoundDetail`); `selectors.ts:401-421` (`formatSelector`); `condition-engine.ts:361-379` (`messageResponseMatchesSelector`).
- **Principle / smell**: OCP / shotgun surgery — adding a selector kind requires editing ≥5 separate switches across 3 files. Note `host` and `concrete` cases are identical in `resolveParts` (lines 197–201) — duplicated arms.
- **Current**: Parallel hand-maintained switches; only some have exhaustive `never` coverage.
- **Suggested**: Introduce a per-kind descriptor table (e.g. `SELECTOR_KIND_META: Record<HrcSelector['kind'], {...}>`) that the switches consult, OR collapse the identical `host`/`concrete` arms. At minimum add an exhaustiveness `assertNever` default to each switch so a new kind fails to compile rather than silently falling through.
- **Risk**: medium (behavior-sensitive; selector resolution is hot-path and well tested, but the table refactor changes control flow).
- **Effort**: M.
- **API-preserving**: yes (internal restructuring; exported function signatures unchanged).
- **Tests**: `monitor.acceptance.test.ts`, `selectors.test.ts`, `monitor-condition-engine.acceptance.test.ts` — strong existing coverage.

### 4. Collapse duplicated `runtime.dead` / `runtime.crashed` evaluation

- **Location**: `condition-engine.ts:274-300` — `evaluateRuntimeDead` and `evaluateRuntimeFailure` contain near-identical `runtime.dead`/`runtime.crashed` blocks (lines 278–284 vs 293–299).
- **Principle / smell**: DRY / duplicated block. The only difference is `evaluateRuntimeFailure` early-returns for `condition === 'runtime-dead'`.
- **Current**: Two functions with copy-pasted body.
- **Suggested**: Extract a private `runtimeDeathOutcome(context, event)` helper returning the dead/crashed outcome; have both call sites delegate.
- **Risk**: low.
- **Effort**: S.
- **API-preserving**: yes (internal helpers; no export changes).
- **Tests**: `monitor-condition-engine.acceptance.test.ts`.

### 5. Replace hand-written `isConditionResult` type guard

- **Location**: `condition-engine.ts:522-542` — a 19-arm `||` chain enumerating every `HrcMonitorConditionResult`.
- **Principle / smell**: DRY / OCP — the literal union is declared once at `:19-37` and re-enumerated by hand in the guard; the two drift independently when a result is added.
- **Current**: Manual `value === 'x' || value === 'y' || ...`.
- **Suggested**: Derive from a single `const CONDITION_RESULTS = [...] as const` `Set` (the file already uses this pattern for `DEAD_RUNTIME_STATUSES`, `FAILURE_KINDS` at :92-95). Type the union from the array (`type X = typeof CONDITION_RESULTS[number]`) so the guard and the union cannot diverge.
- **Risk**: low.
- **Effort**: S.
- **API-preserving**: yes (the exported `HrcMonitorConditionResult` type stays structurally identical; guard is internal).
- **Tests**: `monitor-condition-engine.acceptance.test.ts`.

### 6. Slim `InspectRuntimeResponse` (ISP)

- **Location**: `http-contracts.ts:331-434` (~100 lines, single type with nested `control.{brokerIpc,operatorAttach,brokerProcess}` + `broker`/`substrate`/`presentation`).
- **Principle / smell**: ISP / primitive-and-blob obsession — every consumer of inspect depends on the entire control/broker/substrate/presentation surface even when they read one field.
- **Current**: One mega-type.
- **Suggested**: Extract the three control sub-objects and the substrate/presentation discriminated unions to named types (`RuntimeControlChannels`, `RuntimeSubstrate`, `RuntimePresentation`) and compose. Purely improves readability and lets consumers reference sub-types; does not change the wire shape.
- **Risk**: low (composition only; structural type identity preserved).
- **Effort**: M.
- **API-preserving**: yes (composed type is structurally identical to the inlined one; new named sub-types are additive exports).
- **Tests**: `tsc --noEmit` + any inspect consumers in `hrc-server`.

## Code Smells

| Smell | Location | Detail | Severity |
| --- | --- | --- | --- |
| Long file (type bucket) | `http-contracts.ts` (902), `contracts.ts` (656) | Mixed-concern DTO buckets | med |
| Duplicated switch arms | `monitor/index.ts:197-201`, `:381-384` | `host` and `concrete` arms identical | low |
| Duplicated block | `condition-engine.ts:274-300` | dead/crashed eval copy-paste | low |
| Manual union re-enumeration | `condition-engine.ts:522-542` | `isConditionResult` 19-arm chain | low |
| Magic number | `monitor/index.ts:359` (`matching.slice(-100)`) | un-named replay cap "100" | low |
| Magic numbers (exit codes) | `condition-engine.ts` throughout (`exitCode: 0/1/2/3/4`) | exit-code semantics scattered as literals; no named map | med |
| Reflection / Proxy complexity | `monitor/index.ts:470-494` (`protectStreamCursor`) | a Proxy purely to make one field read-only; `Object.freeze` of just that descriptor or `Object.defineProperty(..., {writable:false})` would be simpler | low |
| Stale-generation magic default | `contracts.ts:80-88` doc references `HRC_STALE_GENERATION_HOURS` default 24 | the env name/default is documented but enforced elsewhere (server) — fine, noted | info |
| Hardcoded fallback root | `paths.ts:23` (`praesidium/var`) | hard-coded `praesidium/var` path segment; acceptable as a deployment convention but couples the lib to a directory layout | low |
| Deprecated alias retained | `errors.ts:10-12` (`CONFLICT`) , `http-contracts.ts:722` (`hostSessionId @deprecated`) | dead-aliases kept for compat; track for removal | info |

## Quick Wins

- Collapse the identical `host`/`concrete` switch arms in `monitor/index.ts` (`resolveParts` and `parsePrefixedMonitorSelector` analog) — pure dedup, low risk.
- Extract `runtimeDeathOutcome` helper in `condition-engine.ts` (refactoring #4).
- Replace `isConditionResult` `||` chain with a `Set`-backed guard derived from one source array (refactoring #5).
- Name the `100` replay cap in `monitor/index.ts:359` as `const DEFAULT_REPLAY_TAIL = 100`.
- Introduce a `const EXIT_CODE = { success: 0, timeout: 1, failure: 2, monitorError: 3, contextChanged: 4 } as const` and replace literal exit codes in `condition-engine.ts`.

## Technical Debt Notes

- **Type buckets vs. churn**: per the agent's memory, broker DTOs change frequently (T-01690/T-01876/T-01946 series). Keeping `Hrc*Broker*Record` inside the 656-line `contracts.ts` maximizes merge-conflict blast radius in a *shared worktree* (a known pain point in this repo). Splitting them (refactoring #2) is the highest-leverage SRP move for this team's workflow.
- **Exhaustiveness gaps**: most `switch (selector.kind)` blocks rely on the union being closed but a few lack a `default: assertNever` guard (e.g. `eventMatchesSelector`, `formatSelector` return-covers via TS but `resolveParts` returns `undefined` implicitly for unhandled — currently safe because all kinds are handled). Adding `assertNever` is cheap insurance against the OCP problem in #3.
- **Proxy for immutability** (`protectStreamCursor`) is heavier machinery than the requirement (one read-only field). Low priority but worth simplifying when touched.
- **No detected DIP/LSP violations** — the factory + injected-reader pattern is a model to preserve; do not regress it during the type-file splits.

## Safety Checklist

- [ ] Run `tsc --noEmit` for the entire workspace after any type-file split (downstream `hrc-server`/`hrc-sdk`/`hrc-cli` import these contracts).
- [ ] Keep `index.ts` the single public barrel; verify every moved type is still re-exported (the `export type { ... }` lists in `index.ts:64-272` are the contract surface — diff them before/after).
- [ ] Run `hrc-core` test suite: `monitor.acceptance`, `monitor-condition-engine.acceptance`, `selectors`, `fences`, `errors`, `paths`, `bridge-contracts`, `windows-contracts`.
- [ ] For logic refactors (#3, #4, #5) confirm no behavior change via the acceptance suites before/after.
- [ ] Do NOT alter wire-shape of any DTO (server/SDK serialize these); structural identity must be preserved on every "split" item.
- [ ] Remember this is a shared worktree — a broken build here breaks all agents (per MEMORY). Verify build green before committing.
- [ ] No test coverage gap of note: logic modules are well covered. `http-contracts.ts`/`contracts.ts`/`hrcchat-contracts.ts` are type-only (covered by `tsc`, not unit tests) — acceptable.
