# Refactor Analysis — `packages/hrc-sdk/src`

**Methodology:** refactor-analysis (SOLID violations, code smells, complexity). Analysis only — no source edited.
**Date:** 2026-06-07
**Scope:** production source only (`__tests__` excluded from the "production" view; coverage gaps noted).

## Scope

| File | Lines | Role |
|------|------:|------|
| `client.ts` | 646 | `HrcClient` — single class, 57 methods, all HTTP endpoints over a unix socket |
| `types.ts` | 201 | SDK-only DTOs + re-exports of `hrc-core` wire DTOs |
| `index.ts` | 67 | barrel: re-exports `HrcClient`, `discoverSocket`, types |
| `discover.ts` | 15 | socket-path discovery |
| **Total (prod)** | **929** | |

Tests: 3 files, 1411 lines (`sdk.test.ts` 976, `sdk-phase6-bridge.test.ts` 228, `sdk-watch-generation-filter.test.ts` 207).

Consumers: `hrc-cli` (cli.ts, cli-runtime.ts, monitor-wait/show/watch), `hrcchat-cli` (all commands). The exported surface (`HrcClient`, `discoverSocket`, types) is broadly depended on — **public-API changes have a wide blast radius**, internal restructuring does not.

This is a thin transport/adapter library. There is essentially no business logic — it marshals requests, posts JSON over a Bun unix-socket `fetch`, and parses responses. The findings are therefore about structural duplication and testability, not algorithmic complexity.

## SOLID Scorecard

| Principle | Status | Notes |
|-----------|--------|-------|
| **S** (SRP) | 🟡 yellow | `HrcClient` is a 57-method fat class spanning 8 resource domains (sessions, runtimes, runs, bridges, surfaces, targets, messages, events). Defensible for a transport SDK, but it is the only unit that grows on every endpoint addition. |
| **O** (OCP) | 🟢 green | No type/enum switch chains. New endpoints are added by appending a method (additive), not editing a dispatcher. |
| **L** (LSP) | 🟢 green | No inheritance, no overrides, no `not implemented` stubs. |
| **I** (ISP) | 🟡 yellow | No interface is published, so consumers must depend on the whole 57-method concrete class. There is no narrow port (e.g. `MessageClient`, `EventWatcher`) a consumer can depend on. |
| **D** (DIP) | 🔴 red | `fetch` (a global) is called directly in 5 places with no injection seam. No transport abstraction. Result: only ~16 of 57 methods are unit-tested because exercising any method requires a live unix socket. |

## Priority Refactorings

Ranked by impact × confidence.

### 1. Extract a transport seam for `fetch` (DIP)
- **Location:** `client.ts:145-192` (`postJson`/`getJson`/`throwTypedError`), plus raw `fetch` in `watchMessages` (`:508`) and `watch` (`:595`).
- **Principle:** DIP (and testability).
- **Current:** Every request calls the global `fetch` directly with `unix: this.socketPath` smuggled via `as RequestInit`. There is no way to substitute a fake transport, so the bulk of methods are untested.
- **Suggested:** Introduce an internal `Transport` type — `{ request(path, init): Promise<Response> }` — created once in the constructor (defaulting to a Bun-fetch implementation that injects `unix`). Optionally accept it as a second constructor arg defaulting to the real one. All five `fetch` sites go through it. This isolates the `as RequestInit` cast to one place and lets the 41 untested methods be covered with a fake.
- **Risk:** medium (touches the request hot path; the optional ctor arg is additive so the public ctor signature is preserved if defaulted).
- **Effort:** M (~half day incl. test migration).
- **apiPreserving:** true (default-param ctor; no exported signature changes).
- **Tests:** existing `sdk.test.ts` must still pass against the default transport; add fake-transport tests for previously-uncovered methods.

### 2. Deduplicate the two NDJSON streaming generators (`watch` / `watchMessages`)
- **Location:** `client.ts:501-551` (`watchMessages`) and `client.ts:580-645` (`watch`).
- **Principle:** SRP / DRY (code smell: duplicated block, ~45 near-identical lines each).
- **Current:** Both methods independently: open a streaming `fetch`, check `res.ok`, grab `res.body`, create a `TextDecoder`, accumulate a `buffer`, split on `\n`, `pop()` the trailing partial line, `JSON.parse` each line with a swallow-and-continue catch, honor an `AbortSignal`, then flush the remainder. The only differences are the typed yield and `watch`'s `matchesWatchOptions` filter.
- **Suggested:** Extract a private `async *streamNdjson<T>(path, init, opts, onItem?)` that owns the decode/buffer/split/flush/abort loop. `watch` passes a `matchesWatchOptions` predicate; `watchMessages` passes none. Removes ~40 duplicated lines and makes the malformed-line / abort / flush semantics single-sourced.
- **Risk:** medium (streaming + abort + partial-line edge cases are subtle; well covered by `sdk-watch-generation-filter.test.ts` for `watch`, less so for `watchMessages`).
- **Effort:** M.
- **apiPreserving:** true (private helper; `watch`/`watchMessages` signatures unchanged).
- **Tests:** `sdk-watch-generation-filter.test.ts` covers `watch` filtering; add a `watchMessages` streaming/abort test before extracting.

### 3. Extract a query-string builder for the six `list*`/`get*` methods
- **Location:** `client.ts:200-207` (`listSessions`), `:379-385` (`getStatus`), `:387-399` (`listRuntimes`), `:401-410` (`listRuns`), `:424-431` (`listLaunches`), `:439-447` (`listTargets`).
- **Principle:** DRY (duplicated `new URLSearchParams()` … `const qs = params.toString(); const path = qs ? \`${base}?${qs}\` : base` boilerplate, repeated 6×).
- **Current:** Each method hand-rolls the same param-set-then-conditionally-append-`?qs` dance with per-field `if (filter?.x) params.set(...)`.
- **Suggested:** A `buildPath(base, params: Record<string, string|number|boolean|undefined|string[]>)` helper that skips `undefined`, joins arrays, and appends `?` only when non-empty. Each method shrinks to one `getJson(buildPath('/v1/runs', {...filter}))` call.
- **Risk:** low (pure string assembly; behavior is mechanical and individually testable).
- **Effort:** S.
- **apiPreserving:** true (internal helper; method signatures unchanged).
- **Tests:** unit-test `buildPath` directly (ordering, omission, array join, empty → no `?`).

### 4. Single-source the 8-field event-filter projection
- **Location:** `client.ts:107-134` (`matchesWatchOptions`), `:563-578` (`listLatestEventBySession`), `:580-593` (`watch` query build). The field list `hostSessionId, generation, scopeRef, laneRef, runtimeId, runId, category, eventKind` is written out three times.
- **Principle:** DRY / shotgun surgery (adding one event filter field requires editing three places + two `types.ts` types).
- **Current:** Triplicated field enumeration: once as 8 `appendOptionalEventQueryParam` calls in `listLatestEventBySession`, again as 8 calls in `watch`, again as 8 `if` comparisons in `matchesWatchOptions`.
- **Suggested:** Define one `EVENT_FILTER_FIELDS` array of keys and drive both the query-param append loop and the `matchesWatchOptions` equality loop from it (typed via `keyof`). One edit point per new field.
- **Risk:** low.
- **Effort:** S.
- **apiPreserving:** true (internal; the `WatchOptions`/`LatestEventBySessionFilter` types are the public contract and stay as-is).
- **Tests:** `sdk-watch-generation-filter.test.ts` already asserts filter behavior; extend to cover each field.

### 5. (Optional, larger) Split `HrcClient` into resource-scoped mixins/sub-clients (SRP/ISP)
- **Location:** `client.ts:136-646` (whole class).
- **Principle:** SRP + ISP — the class owns 8 unrelated resource domains and there is no narrow port to depend on.
- **Current:** One concrete 57-method class; consumers import the whole thing.
- **Suggested:** Keep `HrcClient` as the facade but compose it from focused units sharing the transport — e.g. `sessions`, `runtimes`, `runs`, `bridges`, `messages`, `events` namespaces, or keep flat methods but back them with per-domain modules. Publish narrow interfaces (`MessageApi`, `EventWatchApi`) so consumers can depend on a port.
- **Risk:** high (re-shapes the public surface unless done as pure internal composition behind identical flat methods; high churn; wide consumer blast radius).
- **Effort:** L.
- **apiPreserving:** false if the call shape changes (`client.messages.create` vs `client.createMessage`); only apiPreserving if implemented as internal composition leaving all 57 flat methods intact — not recommended as a quick apply.
- **Tests:** full SDK suite + consumer smoke (hrc-cli, hrcchat-cli).

## Code Smells

| Smell | Location | Detail |
|-------|----------|--------|
| Duplicated block | `client.ts:501-551` vs `:580-645` | two NDJSON stream loops (see #2) |
| Duplicated block | six `list*` methods | query-string boilerplate (see #3) |
| Shotgun surgery | `:107-134`, `:563-578`, `:580-593` | 8-field event filter triplicated (see #4) |
| Magic constant | `client.ts:95` | `BASE_URL = 'http://hrc'` — fine, but undocumented why a dummy host (unix socket carries routing) |
| Magic number | `client.ts:180` | `200` / `text.slice(0, 200)` excerpt cap — unnamed |
| Type smuggling | `:151, :163, :510, :598` | `as RequestInit` to attach the non-standard Bun `unix` field; repeated cast hides a real type gap (see #1 to localize) |
| Fat class | `client.ts:136` | 57 methods, ~510-line body, 8 domains (see #5) |
| Long import block | `client.ts:15-93` | ~78 lines of type imports — symptom of the fat class, not itself a defect |
| Missing test coverage | client.ts | only ~16 of 57 methods exercised; root cause is the missing transport seam (#1), not absent intent |
| Primitive obsession (mild) | `types.ts:96-103` | `SendInFlightInputRequest` carries both deprecated `input` and `prompt` as loose strings; ok but the deprecation is only a comment |

No findings for: long parameter lists (all methods take a single request object — good), deep nesting (max depth ~3 in the stream loops), feature envy, OCP switch chains, LSP override hazards.

## Quick Wins

- Extract `buildPath` query helper (#3) — low risk, removes ~30 lines, immediately reusable.
- Single-source the event-filter field list (#4) — low risk, kills triplication.
- Name the `200` excerpt cap as a `const ERROR_EXCERPT_MAX = 200` and add a one-line comment on `BASE_URL` explaining the unix-socket dummy host.

## Technical Debt Notes

- **Testability is gated on DIP (#1).** The single biggest leverage point: with a transport seam, the 41 currently-untested methods become trivially coverable. Everything else is cosmetic by comparison.
- The `as RequestInit` casts indicate the SDK is hard-bound to Bun's fetch (`unix` option). If portability to Node `undici`/`http.request` is ever wanted, the transport seam (#1) is the prerequisite. Flag, don't fix now.
- The fat-class split (#5) is real SRP/ISP debt but the cost/benefit is poor for a stable transport SDK with a wide consumer base; defer unless the file keeps growing past ~700 lines.
- `types.ts` re-exports many `hrc-core` DTOs and `index.ts` re-exports a subset again — there is drift risk (a type added to `types.ts` but forgotten in `index.ts`). Not a defect today; a barrel-consistency lint would prevent regressions.

## Safety Checklist (for any apply step)

- [ ] Run the full SDK test suite (`sdk.test.ts`, `sdk-phase6-bridge.test.ts`, `sdk-watch-generation-filter.test.ts`) before and after — set `TMPDIR=/tmp`.
- [ ] For #1/#2 add streaming + abort + malformed-line tests for `watchMessages` (currently thin) BEFORE refactoring.
- [ ] Verify no exported symbol signature changes for any item marked apiPreserving (diff `index.ts` and the `HrcClient` public method list).
- [ ] Smoke `hrc-cli` and `hrcchat-cli` against a live daemon — they consume the public surface directly; type-check both packages.
- [ ] Confirm `BASE_URL` / unix-socket behavior is unchanged after centralizing the transport (live `getHealth()` against a running socket).
- [ ] Do NOT apply #5 as an apply-step item — it is high-risk / not safely apiPreserving.
