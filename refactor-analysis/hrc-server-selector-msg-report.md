# 🔧 Refactoring Analysis — packages/hrc-server/src/selector-message-handlers

**Target:** `packages/hrc-server/src/selector-message-handlers/` · **Files read:** 2 of 2 (`selector-input.ts` 444, `sdk-dispatch.ts` 374) + barrel `selector-message-handlers.ts` and `index.ts` wiring for boundary context · **Lines:** 818 (in-dir) · **Package type:** general (HTTP request handlers on an `hrc-server` instance, bound via `this: HrcServerInstanceForHandlers`).

## 🧭 Summary
Two cohesive handler files: `selector-input.ts` (capture / literal-input / broker-literal / dispatch-turn HTTP handlers) and `sdk-dispatch.ts` (SDK turn provisioning + execution + detached-failure recovery). Code is already well-decomposed (`resolveSdkDispatchTarget` was deliberately extracted). The dominant smell is a **duplicated request-validation prologue** (selector/sessionRef parsing repeated 3×, identical to N more sites across the package) and a **duplicated success-response builder** for `DeliverLiteralBySelectorResponse` (4× in one function). Both are internal-only [T15] extractions. No concurrency races and no public-contract problems found.

## 🚪 Public boundary (assess first)
**API surface:** all symbols are re-exported through `selector-message-handlers.ts` and registered into `selectorMessageHandlersMethods`, then mounted as `this`-methods on the server instance and called from `index.ts` route table (lines 320–324) plus internal call sites (`handleBrokerLiteralInputBySelector` from `handleLiteralInputBySelector`; `recordDetachedSemanticTurnFailure` from the SDK detached path; `handleSdkDispatchTurn` from `sdk-turn-handlers`). The observable contract is the **HTTP JSON shape** (`CaptureBySelectorResponse`, `DeliverLiteralBySelectorResponse`, `DispatchTurnBySelectorResponse`, `DispatchTurnResponse`, all `satisfies`-checked against `hrc-core` types) and the **HrcError codes/fields** on the validation throws.

**T07 (align interface to usage):** Handler signatures are appropriate — `Request`-in / `Response`-out for the HTTP four; the internal helpers take precise structural inputs. No fat/leaky interface. The `handleBrokerLiteralInputBySelector` `input` object is a clean parameter object already.

**M02 (expand/contract):** Not required for the internal `resolveSdkDispatchTarget` helper (no external consumers). Any change to the wire response shapes or error `field`/`code` values is a contract change and is **out of scope for refactoring** (would be a redesign).

**Verdict: 🟢** — boundary is sound; all proposed work is behind it.

## 🎯 Findings by mechanism (outside-in, highest impact first)

### F1 — Duplicated selector/sessionRef validation prologue [T15 extract missing abstraction]
- **Location:** `selector-input.ts:33-47` (capture), `:97-111` (literal), `:346-360` (dispatch). Each is the identical sequence: `parseJsonBody` → `isRecord(body) && isRecord(body['selector'])` guard → extract `selector.sessionRef` → string/non-empty guard with the same `MALFORMED_REQUEST` code and `field: 'selector.sessionRef'`.
- **Mechanism repaired:** duplicated intent / missing abstraction — a single `requireSelectorSessionRef(body): string` (or `parseSelectorRequest(request)`) names the "every by-selector request must carry a non-empty `selector.sessionRef`" rule once.
- **Direction:** extract (consolidate).
- **Current → Suggested:** replace the three inline blocks with one helper returning `{ body, sessionRef }`; helper throws the exact same `HrcBadRequestError`s.
- **Preservation:** type/compiler-proof on the response `satisfies`, plus characterization test on the two error throws (code + `field`) — must assert byte-identical error code/message/field for the empty-string and missing-selector cases.
- **Falsifiable signal:** the three prologues collapse to one call; a malformed-selector request returns the same `MALFORMED_REQUEST` body as before (char-test green).
- **Risk:** Low · **API-impact:** internal-only · **Effort:** S · **Tests:** none currently in-dir — must add a characterization test before extracting.
- **Contraindication:** the `app-sessions.ts` parser sites (lines 251–431) emit `'selector is required'` with a *different* shape (`field` differs); do **not** fold those into the same helper blindly — keep the helper scoped to the by-selector handlers whose error contract is identical. The dup here is *not* load-bearing (all three are literally the same).

### F2 — Duplicated `DeliverLiteralBySelectorResponse` success builder [T15 extract missing abstraction]
- **Location:** `selector-input.ts:212-218`, `:261-267`, `:292-298`, `:331-339` — the same `json({ delivered: true, sessionRef: ${scopeRef}/lane:${laneRef}, hostSessionId, generation, runtimeId, ...})` projection, built four times (three identical, one adds `runId`/`status`).
- **Mechanism repaired:** duplicated projection — a `deliverLiteralResponse(session, runtime, laneRef, extra?)` builder centralizes the exact field set so a future field addition can't drift across the four sites.
- **Direction:** extract (consolidate).
- **Current → Suggested:** one local builder taking the session/runtime and an optional `{ runId, status }`; callers pass only the variant fields.
- **Preservation:** type/compiler-proof — the builder returns `DeliverLiteralBySelectorResponse` via `satisfies`; the spread must preserve the **exact** field set (do not add/drop keys). Char-test the four delivery paths' JSON.
- **Falsifiable signal:** four `json({...})` literals become one builder call each; response bytes unchanged on all four delivery kinds (buffered / empty-enter / dispatch / direct).
- **Risk:** Low · **API-impact:** internal-only · **Effort:** S · **Tests:** add char-tests for each delivery branch first.
- **Contraindication:** the three plain variants and the dispatch variant differ (`runId`/`status` present only in the last). Keep those as explicit optional fields — do not unconditionally spread `runId` (it would add an `undefined` key and could alter JSON output ordering/shape).

### F3 — Repeated laneRef normalization + sessionRef formatting [T15 extract missing abstraction]
- **Location:** `selector-input.ts:85`, `:211`, `:234`, `:430` — `const laneRef = normalizeTargetLane(session.laneRef) ?? session.laneRef` followed by `${session.scopeRef}/lane:${laneRef}`.
- **Mechanism repaired:** duplicated derivation — a `formatSelectorRef(session)` helper names the canonical "scopeRef/lane:normalizedLane" rendering once.
- **Direction:** extract (consolidate).
- **Preservation:** type/compiler-proof + the same char-tests as F1/F2 cover the output string.
- **Falsifiable signal:** one helper; identical `sessionRef` strings in all responses.
- **Risk:** Low · **API-impact:** internal-only · **Effort:** XS.
- **Contraindication:** trivial enough that folding into the F2 builder may be cleaner than a standalone helper — pick one home, not two.

### F4 — `handleBrokerLiteralInputBySelector` is an implicit 3-state dispatch [T19 conditional→dispatch / T10 reify state machine]
- **Location:** `selector-input.ts:221-340`. Three branches: `!enter` → buffer; `enter && prompt.trim()===''` → empty-enter; else → dispatch input turn. Each branch repeats `updateActivity` + `appendHrcEvent('target.literal-input', …, delivery: <tag>)` + `notifyEvent` + the F2 response, differing only by the `delivery` tag, `payloadLength`, and `enter` flag.
- **Mechanism repaired:** the implicit state machine (buffered-accumulate vs flush-empty vs flush-dispatch) is reified once: each branch computes its `{ delivery, payloadLength, enter, runId? }` then falls through to a single shared "emit event + respond" tail.
- **Direction:** extract/flatten (consolidate the tail; keep the three decision arms explicit).
- **Current → Suggested:** keep the branch logic that decides *what* happens to the pending map and *whether* to run a turn, but funnel all three into one event-emit + F2-response epilogue.
- **Preservation:** characterization test on all three broker paths (buffer-then-enter accumulation, empty-enter, non-empty dispatch) asserting event `delivery` tag + `payloadLength` + response shape; then refactor.
- **Falsifiable signal:** the three near-identical `appendHrcEvent(...'target.literal-input'...)` blocks collapse to one; events emitted are byte-identical per path.
- **Risk:** Med (event payloads are observable on the event stream and consumers key off `delivery`) · **API-impact:** internal-only (events are internal but observable) · **Effort:** M · **Tests:** none in-dir — char-tests are a hard prerequisite.
- **Contraindication:** the three `delivery` tags (`broker-buffered-literal`, `broker-empty-enter`, `broker-dispatch-input`) and the `ts` recomputation in the dispatch arm (`timestamp()` at line 314 vs reused `now`) are *deliberate* — do not "simplify" them to one tag or one timestamp; that would change observable event data. This is the riskiest of the four and should be done last (or deferred) — its value is lower than F1/F2.

### F5 — `transport` re-cast as string-union after it's already typed [T16 collapse premature/typed-around structure — minor]
- **Location:** `selector-input.ts:417` (`const transport = turnBody.transport as 'sdk' | 'tmux' | 'headless' | 'ghostty'`) and `:431` (`turnBody.status as 'completed' | 'started'`).
- **Mechanism repaired:** primitive-obsession-via-cast — `DispatchTurnResponse` should already type `transport`/`status`; the inline `as`-unions duplicate the source-of-truth type and will silently drift if `hrc-core` adds a transport.
- **Direction:** de-cast (lean on the already-declared type).
- **Preservation:** type/compiler-proof — if `DispatchTurnResponse.transport` is already the union, the cast is removable with zero behavior change; if it's `string`, this is a *type* tightening best done in `hrc-core` (defer).
- **Falsifiable signal:** casts removed, `tsc` green.
- **Risk:** Low · **API-impact:** internal-only (if the field is already unioned) · **Effort:** XS.
- **Contraindication:** if `hrc-core`'s `DispatchTurnResponse.transport` is actually `string`, do **not** widen behavior locally — that's a cross-package type change (defer). Verify the source type before touching.

## 🪶 Deliberately left alone (where-NOT)
- **`resolveSdkDispatchTarget` extraction (sdk-dispatch.ts:30-148):** already a clean, documented, behavior-preserving extraction. Leave it.
- **The `execute`-closure + `waitForCompletion === false` detached pattern (sdk-dispatch.ts:170-315):** intentional fire-and-forget with `recordDetachedSemanticTurnFailure` as the compensator. Nesting is ≤3 and the closure capture is load-bearing. Not a guard-clause candidate.
- **The duplicated `turn.*` lifecycle event emission in `resolveSdkDispatchTarget`:** each event has a distinct `eventKind`/payload; parameterizing them would obscure the lifecycle and risk drift. The repetition is intentional and readable.
- **`recordDetachedSemanticTurnFailure` early-returns (sdk-dispatch.ts:335-337, 349):** already guard-clause-flat. Leave.
- **Error-handling in the detached `.catch` (sdk-dispatch.ts:291-302):** the nested try/catch around `recordDetachedSemanticTurnFailure` is a deliberate belt-and-suspenders log; not a swallowed catch (it `writeServerLog`s). Leave.

## 🔭 If applying: outside-in sequence
1. **A [T40] make-safe first:** add a characterization test file for the four selector handlers and the three broker-literal delivery paths (response JSON + `target.literal-input` event `delivery`/`payloadLength` + the two `MALFORMED_REQUEST` field errors). There are currently **no tests in this dir** — this gate is mandatory before any edit.
2. **F1** (validation prologue) — lowest risk, highest dup count.
3. **F2 + F3** (response/laneRef builder) — fold F3 into F2's builder.
4. **F5** — only after confirming `hrc-core` already unions the field; else defer.
5. **F4** (broker state-machine epilogue) — last, Med risk; only with the char-tests from step 1 green.

## ✅ Safety checklist
- [ ] Characterization tests added on the 4 HTTP handlers + 3 broker delivery paths BEFORE any edit (no in-dir tests exist today).
- [ ] Response field sets preserved exactly (no added/dropped keys; `runId`/`status` stay conditional — F2).
- [ ] Error `code` + `field` byte-identical for malformed-selector cases (F1).
- [ ] Event `delivery` tags / `payloadLength` / `ts` semantics unchanged (F4).
- [ ] `tsc` green after F5 (no local widening of a cross-package type).
- [ ] Full `hrc-server` suite + lint (watch for biome `useValidTypeof`-style lints only if a literal gets parameterized — none expected here).
