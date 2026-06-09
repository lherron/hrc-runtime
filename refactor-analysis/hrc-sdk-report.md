# Refactor Analysis — `packages/hrc-sdk/`

Scope: `packages/hrc-sdk/src` (excluding `__tests__`). Behavior-preserving audit only; no source edited.

## Package shape

| File | Lines | Role |
|------|-------|------|
| `src/client.ts` | 638 | `HrcClient` — typed RPC façade over the HRC Unix-socket HTTP API |
| `src/types.ts` | 201 | SDK type re-exports from `hrc-core` + SDK-only filter/option types |
| `src/index.ts` | 67 | Public barrel (re-exports `HrcClient`, `discoverSocket`, types) |
| `src/discover.ts` | 15 | Socket discovery helper |

Tests: `src/__tests__/{sdk,sdk-phase6-bridge,sdk-watch-generation-filter}.test.ts` (~1.4k lines). Coverage includes `throwTypedError` non-JSON excerpt path (m-22), watch generation filtering, and bridge methods.

This package is already in good shape: a prior pass extracted the shared helpers `buildPath`, `eventFilterParams`, `matchesWatchOptions`, `streamNdjson`, and the `EVENT_FILTER_FIELDS` single-source-of-truth array. There are no long methods, no deep nesting, no obvious dead code, and no concrete-collaborator instantiation. Findings below are minor and mostly DEFERRED because the package's entire purpose is its public surface.

## SOLID scorecard

| Principle | Grade | Notes |
|-----------|-------|-------|
| S — Single Responsibility | B | `HrcClient` has ~45 public methods (well over the 10-method guideline) but each is a thin, single-statement RPC delegate. The class genuinely owns one responsibility (talk to the daemon); the count is a façade artifact, not mixed concerns. IO + transport + error mapping are cleanly separated into private primitives (`postJson`/`getJson`/`throwTypedError`/`streamNdjson`). |
| O — Open/Closed | A | No type-keyed switch/if-else chains. New endpoints = new methods; the `EVENT_FILTER_FIELDS` array is an explicit OCP seam for filter fields. |
| L — Liskov | A | No inheritance; no overrides; no throwing stubs. |
| I — Interface Segregation | C | `HrcClient` is a single fat class (~45 methods) with no role interfaces; consumers depend on the whole class even if they only call `dispatchTurn`. This is the only real, but low-value, structural issue — splitting it is a public-surface change and is DEFERRED. |
| D — Dependency Inversion | B | `fetch` and `BASE_URL` are module-level constants; `socketPath` is injected via constructor. No `new Concrete()` of collaborators. The hard dependency on global `fetch` (Bun unix-socket fetch) is the only un-injected seam; acceptable for an SDK. |

## Priority refactorings

### P1 — Named constants for magic numbers in `throwTypedError`
- **Location**: `src/client.ts:205-206` — `text.length > 200`, `text.slice(0, 200)`, `'…'`.
- **Principle/smell**: Magic number; duplicated literal `200`.
- **Current**: `excerpt = text.length > 200 ? \`${text.slice(0, 200)}…\` : text`.
- **Suggested**: Introduce a module-level `const ERROR_BODY_EXCERPT_MAX = 200` (and optionally `ELLIPSIS = '…'`) and use it in both spots. Pure internal rename of a literal; output is byte-identical, and the m-22 test (`sdk.test.ts:860`) keeps passing.
- **Risk**: Low
- **API-impact**: internal-only
- **Effort**: ~5 min
- **Tests**: Covered by `sdk.test.ts` m-22 case; no test change needed.

### P2 — Route single-param GET query strings through `buildPath`
- **Location**: `src/client.ts:292, 296, 359, 393, 470` — methods that hand-build a query string with `encodeURIComponent` (`capture`, `getAttachDescriptor`, `listSurfaces`, `listBridges`, `getTarget`).
- **Principle/smell**: Mild duplication; two idioms for the same job (`buildPath` vs inline `?x=${encodeURIComponent(...)}`).
- **Current**: e.g. `\`/v1/capture?runtimeId=${encodeURIComponent(runtimeId)}\``.
- **Suggested**: Reuse `buildPath('/v1/capture', { runtimeId })`. NOTE: `buildPath` uses `URLSearchParams.set` (percent-encodes), so encoding is equivalent but **not guaranteed byte-identical** to `encodeURIComponent` for some characters (e.g. spaces → `+` vs `%20`). Path-segment cases (`getSession:235`, `getActiveRunContribution:283` — value is in the path, not the query) must NOT be converted. Because the daemon decodes both forms in practice but the wire bytes can differ, this is a behavioral-equivalence judgment call.
- **Risk**: Med (encoding-equivalence risk on the wire)
- **API-impact**: internal-only (paths the SDK emits)
- **Effort**: ~20 min + verify against `sdk.test.ts` path assertions
- **Tests**: `sdk.test.ts` asserts exact request paths in several places — converting could require updating those expected-path strings, which the safety policy discourages. **DEFERRED** (ambiguous-to-do-safely + risk of touching tests).

### P3 — `HrcClient` method count / fat façade (ISG/SRP)
- **Location**: `src/client.ts:161-638` — `HrcClient` class, ~45 public methods spanning sessions, runtimes, runs, bridges, surfaces, targets, messages, events, diagnostics.
- **Principle/smell**: Interface Segregation / Single Responsibility (class > 10 methods, multiple domain groupings already flagged with `// --` banners).
- **Current**: One monolithic client class.
- **Suggested (human review only)**: Either (a) accept as an intentional SDK façade — recommended — or (b) split into role-grouped sub-clients (`client.sessions`, `client.runtimes`, `client.bridges`, …) via lazy getters that share the transport primitives. Option (b) changes the public call shape (`client.dispatchTurn` → `client.runtimes.dispatchTurn`) and breaks every consumer.
- **Risk**: High
- **API-impact**: public-surface
- **Effort**: Large (multi-package, all callers)
- **Tests**: Would rewrite the entire SDK test suite and every downstream caller. **DEFERRED — do not touch.**

## Code smells

| # | Location | Smell | Severity | Disposition |
|---|----------|-------|----------|-------------|
| 1 | `client.ts:205-206` | Magic number `200` duplicated; bare `'…'` literal | Low | APPLY (P1) |
| 2 | `client.ts:292,296,359,393,470` | Two idioms for query strings (`buildPath` vs inline `encodeURIComponent`) | Low | DEFER (P2 — encoding/test risk) |
| 3 | `client.ts:161-638` | Fat façade class (~45 methods) | Low (structural) | DEFER (P3 — public surface) |
| 4 | `client.ts:264-270` | `sendInFlightInput` spreads conditional `input`/`prompt`/`inputType` into body — minor object assembly, but correct and readable | Info | No action |
| 5 | `types.ts:99` | `input?` field marked `@deprecated` but still forwarded by `sendInFlightInput` | Info | No action (public type contract; DEFER any removal) |

No dead code, no truly long methods (largest is `streamNdjson` ~55 lines at 582-637, cohesive and single-purpose), no deep nesting beyond the intrinsic stream loop, no long parameter lists (>4), no feature envy.

## Quick wins (safe to auto-apply)

1. **P1** — Extract `ERROR_BODY_EXCERPT_MAX = 200` (and `ELLIPSIS = '…'`) named constants in `client.ts`. Low risk, internal-only, behavior-identical, covered by existing m-22 test.

That is the only auto-applicable finding. Everything else is either already clean or touches the public surface / wire bytes / tests and is deferred.

## Technical debt notes

- **`streamNdjson` is the one non-trivial method (~55 lines)** and is correctly factored (decode → buffer → split-on-`\n` → parse-or-skip → predicate → flush trailing). At the edge of the 50-line guideline but splitting it would fragment a single coherent algorithm and is **not** recommended.
- **Global `fetch` dependency** (Bun unix-socket `fetch`) is an un-injected seam. Tests stub it via global override. Introducing a constructor-injected fetcher would improve DI but is a public-constructor signature change → **public-surface, DEFER**.
- **`sendInFlightInput` deprecated `input` field** (`types.ts:99`): SDK still forwards `input` when present. Removing it is a public type-contract change → DEFER; track for a future major.
- The package mirrors `hrc-core` wire DTOs via re-export rather than redefining them (good — avoids duplication). No action.
