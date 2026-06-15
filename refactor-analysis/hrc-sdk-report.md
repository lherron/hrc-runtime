# 🔧 Refactoring Analysis — packages/hrc-sdk/src

**Target:** packages/hrc-sdk/src · **Files read:** 4/4 (client.ts, types.ts, index.ts, discover.ts) + cross-ref into hrc-server (sdk-turn-handlers.ts, parsers/runtime.ts) and consumers (hrc-cli handlers-control.ts) · **Lines:** 929 · **Package type:** general (HTTP-over-unix-socket SDK; NOT a leaf — 6+ consumer packages)

## 🧭 Summary
The SDK is a thin, well-disciplined typed client: a `HrcClient` class with ~50 one-line method wrappers over `postJson`/`getJson`, a shared NDJSON streaming loop, and a single-source-of-truth event-filter projection (`EVENT_FILTER_FIELDS`). It has already absorbed most of the obvious refactors (dedup'd wire DTOs via re-export, centralized filter fields, shared streaming). Remaining findings are small and mostly internal; the only public-surface item is the long-deprecated `input` field on `SendInFlightInputRequest`.

## 🚪 Public boundary (assess first)
**API surface:** `discoverSocket()`, `HrcClient` class (~50 async methods), and a large re-exported type barrel (`index.ts` / `types.ts`). Consumers: hrcchat-cli, hrc-cli, hrc-server tests, agent tooling. **204 `HrcClient` references** across the repo — this is a heavily-used, fan-out boundary. Contract changes are EXPENSIVE and must go through M02 expand/contract.

**T07 (align interface to usage):** The method surface maps 1:1 to server routes and is genuinely used. No fat/leaky interface to narrow. The type barrel in `index.ts` re-exports a curated subset of `types.ts` (e.g. `BrokerInspectRequest`, `SweepRuntimesRequest`, `DropContinuationRequest` are in `types.ts` but NOT re-exported from `index.ts`) — these are reachable via the client methods' inferred types, so the asymmetry is intentional, not leaky. Leave alone.

**M02 (contract change):** One genuine candidate — the `@deprecated input` field on `SendInFlightInputRequest` (types.ts:99) plus its forwarding in `sendInFlightInput` (client.ts:271–279). The server (`parsers/runtime.ts:373`) reads `prompt` and only falls back to `input`. Removing `input` is a contract contraction requiring a deprecation cycle. DEFERRED.

**Verdict: 🟢** — boundary is healthy, aligned to usage, and well-typed. One deferred deprecation-cleanup.

## 🎯 Findings by mechanism (outside-in, highest impact first)

### F1 — `sendInFlightInput` manual spread duplicates the deprecated-field plumbing (DEFERRED)
- **Location:** client.ts:271–279, types.ts:96–103
- **Mechanism repaired:** B/M02 contract contraction — collapse the dual `input`/`prompt` field into a single canonical `prompt`, removing the partial-total branch that carries a deprecated alias forward.
- **Symptom:** `SendInFlightInputRequest` carries both `prompt` (required) and `input` (`@deprecated`); the method spreads each conditionally and ships BOTH on the wire when a caller (hrc-cli handlers-control.ts:73–79) passes both. The server already prefers `prompt`.
- **Current → Suggested:** Keep `input` accepted for one release but stop forwarding it once all in-repo callers pass `prompt` (hrc-cli already does); eventually drop the `input` field. Schedule via expand/contract.
- **Direction:** DE-abstract (remove a deprecated alias).
- **Preservation:** test-suite (sdk.test.ts + hrc-server in-flight handler tests) + observational (server prefers `prompt`).
- **Falsifiable signal:** grep shows zero remaining callers passing only `input`; wire payload no longer contains `input`.
- **Risk:** Med · **API-impact:** public-surface · **Effort:** S · **Tests:** sdk.test.ts, hrc-server sdk-turn-handlers tests.
- **Contraindication:** `input` is load-bearing for any out-of-repo/older-server consumer; the server fallback exists precisely for wire compatibility. Do NOT drop unilaterally.

### F2 — Per-call manual `|| undefined` normalization in list filters is repeated 5×
- **Location:** client.ts:233–238 (listSessions), 418–429 (listRuntimes), 431–439 (listRuns), 453–459 (listLaunches), 467–474 (listTargets)
- **Mechanism repaired:** C/T15 — extract the recurring "empty-string-to-undefined" intent that's open-coded as `filter?.x || undefined` at every query-string boundary.
- **Symptom:** The idiom `field: filter?.field || undefined` appears ~12 times to coerce `''`/`null` to `undefined` so `buildPath` drops it. Duplicated intent (treat falsy string as absent).
- **Current → Suggested:** A small helper `emptyToUndefined(v)` OR have `buildPath` itself skip empty strings (`if (value === '') continue`) so call sites can pass `filter?.field` directly. The latter centralizes the rule in one place.
- **Direction:** Extract abstraction (modest).
- **Preservation:** type/compiler + test-suite (existing buildPath behavior must still drop empties).
- **Falsifiable signal:** removing `|| undefined` at call sites leaves generated query strings byte-identical in sdk.test.ts.
- **Risk:** Low · **API-impact:** internal-only · **Effort:** S · **Tests:** sdk.test.ts buildPath/list assertions.
- **Contraindication:** If any endpoint must distinguish `''` (explicit empty) from absent, centralizing the coercion in `buildPath` would change behavior — verify none does (none observed; all are string identifiers/scopes).

### F3 — `getStatus`/`listTargets` repeat the `? 'true' : undefined` boolean-flag idiom
- **Location:** client.ts:411–415 (includeArchived), 467–474 (discover), 568 (follow in watch)
- **Mechanism repaired:** C/T15 — extract the "boolean → 'true'|undefined' query flag" projection.
- **Symptom:** `options?.x ? 'true' : undefined` is hand-written at 3 sites. Meanwhile `buildPath` already supports a real `boolean` `QueryValue` (used by `stale`/`json` in listRuntimes), which renders `true`/`false` via `String(value)` — an INCONSISTENCY: some flags emit `'true'`/absent, others emit `'true'`/`'false'`.
- **Current → Suggested:** Decide one convention. If "presence = true, absence = false" is the wire contract for these flags, a `boolField(v)` helper makes it explicit and uniform.
- **Direction:** Extract abstraction + remove inconsistency.
- **Preservation:** char-test — server-side parsing of each flag must be confirmed before unifying (the two conventions may both be intentionally honored server-side).
- **Falsifiable signal:** query strings unchanged for the existing convention each endpoint already uses.
- **Risk:** Med · **API-impact:** internal-only (wire-shape-sensitive) · **Effort:** S · **Tests:** sdk.test.ts + server parser tests for status/targets/runtimes.
- **Contraindication:** Do NOT mechanically unify to `String(boolean)` — `?'true':undefined` and `boolean` render DIFFERENTLY (absent vs `'false'`); unifying could silently change a request. This is a re-read-confirmed real inconsistency but the fix is contract-sensitive, so keep it as a documented internal cleanup, not an auto-apply.

### F4 — `streamNdjson` duplicates the parse-line block for the trailing flush
- **Location:** client.ts:614–628 (loop body) vs 632–644 (trailing flush)
- **Mechanism repaired:** E/T23-ish — collapse the near-identical "trim → JSON.parse (swallow) → predicate → yield" logic into one local closure.
- **Symptom:** The same 8-line try/parse/predicate/yield sequence is written twice (once per-line, once for the buffered remainder).
- **Current → Suggested:** Inline a `function* emit(raw: string)` (or `tryYield`) closure used by both the loop and the flush. Pure mechanical dedup.
- **Direction:** DE-duplicate.
- **Preservation:** type/compiler-proof + test-suite (sdk-watch-generation-filter.test.ts, sdk-phase6-bridge.test.ts exercise streaming).
- **Falsifiable signal:** streaming tests still pass byte-for-byte; same events yielded for split-chunk inputs.
- **Risk:** Low · **API-impact:** internal-only · **Effort:** S · **Tests:** sdk-watch-generation-filter.test.ts, sdk-phase6-bridge.test.ts.
- **Contraindication:** The two blocks differ subtly — the loop `continue`s on malformed lines, the flush `return`s. A shared generator-closure must preserve that "flush stops on first malformed remainder" semantic (it's the last chunk, so `return` vs `continue` is observationally identical there, but keep the early-exit explicit).

### F5 — `RequestInit` cast `as RequestInit` repeated for the `unix:` extension
- **Location:** client.ts:181, 192–193, 542, 577, 596 (every fetch carries `{ unix: this.socketPath } as RequestInit`)
- **Mechanism repaired:** C/T01-adjacent — introduce a single typed `unixFetch(path, init)` seam so the Bun-specific `unix` field and `BASE_URL` concatenation live in ONE place instead of being cast at 5 sites.
- **Symptom:** Bun's non-standard `unix` socket field forces an `as RequestInit` cast at each fetch; `${BASE_URL}${path}` is also repeated 5×. `postJson`/`getJson` already centralize two of them, but `streamNdjson`, `watch`, and `watchMessages` re-implement the cast and URL join.
- **Current → Suggested:** A private `private unixFetch(path: string, init: Omit<RequestInit,'unix'> & { unix?: never })` or a typed `BunRequestInit = RequestInit & { unix?: string }` so the cast happens once and the socket is injected centrally. This also makes the socket a true substitution seam (testability).
- **Direction:** Extract seam (consolidate hardcoded transport detail).
- **Preservation:** type/compiler-proof (the type alias removes casts) + test-suite.
- **Falsifiable signal:** zero `as RequestInit` casts remain; all fetches route through one method; tests unchanged.
- **Risk:** Low · **API-impact:** internal-only · **Effort:** S · **Tests:** full sdk.test.ts suite.
- **Contraindication:** `watch`/`watchMessages` need the streaming body, not a parsed JSON — the seam must return the raw `Response` (or be parameterized), so don't fold streaming into `getJson`/`postJson`. Keep `unixFetch` returning `Response`.

## 🪶 Deliberately left alone (where-NOT)
- **`EVENT_FILTER_FIELDS` projection (client.ts:103–164):** already the ideal single-source-of-truth pattern (T15 done) shared by `watch`, `listLatestEventBySession`, `matchesWatchOptions` with a `satisfies` compiler guard. Do not touch.
- **The ~50 one-line method wrappers:** these are NOT a "middle man" (T23). Each adds a typed request/response contract and a stable route binding — collapsing them would re-leak HTTP route strings to callers. Pass-throughs are load-bearing.
- **`types.ts` re-export barrel:** the asymmetry between `types.ts` and `index.ts` exports is a deliberate curated public surface, not an omission.
- **`throwTypedError` clone/text-excerpt dance (client.ts:201–225):** correct error-handling structure (typed domain error vs truncated text excerpt). Not a swallowed catch — the inner `catch {}` around `cloned.text()` is a legitimate best-effort fallback. Leave.
- **`discover.ts`:** 15 lines, single responsibility, correct fail-fast. Nothing to do.
- **`getLatestRunForSession` (client.ts:441–451):** thin convenience over `listRuns` with `limit:1`; clear intent, keep.

## 🔭 If applying: outside-in sequence
1. **F5** first (typed `unixFetch` seam) — removes casts and gives a single transport choke-point that the rest build on.
2. **F4** (streamNdjson dedup) — localized, independent.
3. **F2** (empty-string coercion in `buildPath`) — but ONLY after confirming no endpoint distinguishes `''` from absent; verify with server parser tests.
4. **F3** (boolean-flag convention) — document/decide convention; do NOT mechanically unify (wire-shape risk). Treat as a tracked internal cleanup, not a blind auto-apply.
5. **F1** (`input` deprecation) — DEFERRED, schedule via M02 across releases.

## ✅ Safety checklist
- [ ] Re-run full hrc-sdk suite (sdk.test.ts, sdk-watch-generation-filter.test.ts, sdk-phase6-bridge.test.ts).
- [ ] For F2/F3: confirm generated query strings are byte-identical (assert in test) before/after — these are wire-shape changes masquerading as cleanups.
- [ ] For F1: grep all consumers (hrc-cli, hrcchat-cli, hrc-server) for `input:`-only callers before any contraction; do not drop the server `prompt ?? input` fallback in the same change.
- [ ] No behavior change to `streamNdjson` malformed-line swallowing (M-10 invariant) — F4 must preserve continue-vs-return semantics.
- [ ] Spread/projection refactors (F2) preserve the exact emitted field set.
