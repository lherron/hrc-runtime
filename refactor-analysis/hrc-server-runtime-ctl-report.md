# 🔧 Refactoring Analysis — packages/hrc-server/src/runtime-control-handlers

**Target:** `packages/hrc-server/src/runtime-control-handlers/` · **Files read:** 2/2 source + aggregator `runtime-control-handlers.ts` + 3 consuming tests · **Lines:** 711 (interrupt-terminate 357, session-rotation 354) · **Package type:** general (server-side handler mixin; `this`-bound methods composed onto `HrcServerInstanceForHandlers`)

## 🧭 Summary
Two cohesive `this`-bound handler modules (interrupt/terminate lifecycle; session rotation + context invalidation). Code is clean, well-commented, and the public surface is a fixed re-exported function set wired into a method-bag (`runtimeControlHandlersMethods`) consumed by `index.ts`. Findings are small, internal-only quality refactors: duplicated event-scaffolding, a duplicated broker-dispose+classify block, and a duplicated transport-string derivation. No races (no shared mutable state here — all state lives in `this.db`/broker controller behind the facade), no illegal-state or boundary problems worth the M02 cost.

## 🚪 Public boundary (assess first)
**API surface:** 13 exported `this`-bound functions, re-exported verbatim from `runtime-control-handlers.ts` (lines 51–65) and surfaced through `runtimeControlHandlersMethods` (lines 398–418), then mixed onto the server instance and re-exported from `index.ts:74`. Consumers reach them as `this.terminateRuntime(...)`, `this.rotateSessionContext(...)`, etc. — the names and signatures are the contract.

**T07 (align interface to usage):** No leaky/fat surface. Every export is reached via `this.` dispatch or the method-bag; signatures match usage. No narrowing/widening warranted.

**M02 (expand/contract):** Not applicable. This is an internal server module — there are no external/versioned consumers, but the `this`-bound shape is depended on by the whole server instance, so renames/signature changes still ripple through `runtimeControlHandlersMethods` and `index.ts`. Any signature change is therefore "public-surface" for grading purposes.

**Verdict:** 🟢 Boundary is sound. Keep all exported function names/signatures stable; confine refactors to function bodies.

## 🎯 Findings by mechanism (outside-in, highest impact first)

### F1 — Duplicated broker-dispose + error-classification block
- **Location:** `interrupt-terminate.ts:220–239` and `session-rotation.ts:297–320`
- **Technique:** [T15] extract missing abstraction
- **Mechanism repaired:** duplicated intent — two copies of "call `getHarnessBrokerController().dispose(runtimeId)`, catch→wrap non-`BrokerControllerError` into `BrokerControllerError('broker_dispose_failed', …)`, then `writeServerLog('WARN', …)` unless code is `broker_runtime_not_active`". The only deltas are the optional `{ reason }` arg and the log message string.
- **Direction:** consolidate (extract a private `disposeBrokerRuntime(controller, runtimeId, { reason?, logContext })` helper in a shared module, e.g. `broker/controller.ts` or a new `runtime-control-handlers/broker-dispose.ts`).
- **Preservation rung:** test-suite — both call sites are exercised (`runtime-terminate-operator-reap.test.ts`, `broker-lease-teardown.red.test.ts`, `stale-generation-auto-rotate.test.ts`).
- **Falsifiable signal:** the two literal catch/classify blocks collapse to one helper; behavior identical (same log levels, same `broker_runtime_not_active` suppression).
- **Risk:** Low · **API-impact:** internal-only · **Effort:** S
- **Contraindication:** the two log message strings ("dispose failed during tmux terminate" vs "during context invalidation") must remain distinct — pass them as a parameter, don't unify them away.

### F2 — Duplicated HRC-event scaffolding (session field spread)
- **Location:** `interrupt-terminate.ts` lines 49–61, 92–104, 142–155, 257–276, 298–311, 336–349; `session-rotation.ts` 110–125, 200–221, 224–234 (18 repetitions of `hostSessionId/scopeRef/laneRef/generation` from `session`)
- **Technique:** [T15] extract missing abstraction (parameter object / projection helper)
- **Mechanism repaired:** primitive-obsession data-clump — the `{ ts, hostSessionId, scopeRef, laneRef, generation }` envelope is rebuilt by hand at every `appendHrcEvent` call. A small `sessionEventBase(session, ts)` projection (returning exactly that field set) would remove the clump.
- **Direction:** consolidate (a tiny projection helper, likely alongside `appendHrcEvent` in `hrc-event-helper.ts`).
- **Preservation rung:** type/compiler-proof — the helper's return type must be the exact field set; spreading it preserves payload shape. Tests assert event payloads, so test-suite backs it too.
- **Falsifiable signal:** call sites shrink from 5 literal lines to one `...sessionEventBase(session, now)` spread; event rows in tests unchanged.
- **Risk:** Low · **API-impact:** internal-only · **Effort:** S
- **Contraindication:** MUST preserve the exact field set per call — some events add `runId`/`runtimeId`/`transport`; the helper covers only the common 5, the rest stay inline. Do not fold `runtimeId` in (terminate events carry it, but `context.cleared`/`session.created` shapes differ). This is a projection refactor — verify no field is dropped or added.

### F3 — Duplicated `transport` derivation for headless/sdk
- **Location:** `interrupt-terminate.ts:119` (`interruptHeadlessRuntime`) and `:335` (`terminateHeadlessRuntime`): `const transport = runtime.transport === 'headless' ? 'headless' : 'sdk'`
- **Technique:** [T15] extract missing abstraction
- **Mechanism repaired:** duplicated intent — same ternary normalizing `runtime.transport` into the audit `transport` discriminant. Also appears in `terminateRuntime`'s branch selection logic conceptually.
- **Direction:** consolidate (a one-line `headlessAuditTransport(runtime)` or a typed const helper).
- **Preservation rung:** type/compiler-proof — narrow union return.
- **Falsifiable signal:** single source of the `'headless' | 'sdk'` mapping.
- **Risk:** Low · **API-impact:** internal-only · **Effort:** XS
- **Contraindication:** only 2 occurrences — borderline rule-of-three. Fold in with F2 or skip; not worth a standalone module.

### F4 — `terminateRuntime` conditional opts re-spread
- **Location:** `interrupt-terminate.ts:175–188` — the `{ reason, source, actor }` triple is conditionally re-spread when forwarding to `terminateTmuxRuntime`, then `terminateTmuxRuntime` re-spreads the same triple again into the event payload (lines 272–274).
- **Technique:** [T21] introduce parameter object
- **Mechanism repaired:** data-clump — `{ reason?, source?, actor? }` travels together through 3 functions, each manually rebuilding the conditional spread. A named `OperatorAttribution` type + a `pickDefined()` helper removes the triple-spread boilerplate.
- **Direction:** introduce parameter object (the values already travel together; name them).
- **Preservation rung:** type/compiler-proof + test-suite (`runtime-terminate-operator-reap.test.ts` asserts the attribution lands on the event).
- **Falsifiable signal:** the `...(opts.x !== undefined ? { x } : {})` pattern (repeated 6×) collapses to one helper application; reap event payload unchanged.
- **Risk:** Low · **API-impact:** internal-only (type is internal) · **Effort:** S
- **Contraindication:** the conditional-spread is deliberate (avoids writing `undefined` keys into the event JSON / `exactOptionalPropertyTypes`). The helper must preserve "omit undefined keys" semantics exactly, not write `{reason: undefined}`.

### F5 — `terminateRuntime` transport dispatch is a conditional ladder
- **Location:** `interrupt-terminate.ts:175–188` (and `interruptRuntime` 25–35)
- **Technique:** [T19] conditional → dispatch (observe only)
- **Mechanism repaired:** transport branching repeated across `interruptRuntime`, `terminateRuntime` — each hand-routes `tmux | ghostty | headless/sdk`.
- **Direction:** **DE-prioritize / leave.** Only 3 arms, each forwards to a differently-shaped method (different opts), and a dispatch table would obscure the per-transport opts plumbing. The current explicit ladder is clearer than a map here.
- **Risk:** n/a · **Contraindication:** a dispatch table would force a uniform method signature the three terminators don't share. Honoring the contraindication — **not a finding to apply.**

## 🪶 Deliberately left alone (where-NOT)
- **Idempotency guard** (`interrupt-terminate.ts:206–213`, with its long comment): a deliberate, load-bearing invariant guard on `status === 'terminated'`. Do not "simplify."
- **Per-runtime lease-socket teardown** (`240–254`): the `harness-broker` vs default-`this.tmux` split is a real behavioral distinction (per-runtime lease socket vs shared server), not duplication — keep both arms.
- **`maybeAutoRotateStaleSession` live-tmux skip** (`session-rotation.ts:69–89`): comment-documented behavioral invariant; leave intact.
- **No premature abstraction to collapse [T16]:** no one-implementor interfaces, no unused flags, no generics-with-one-instantiation in this dir.
- **No race surface [T31/T32]:** all mutable state is behind `this.db` / broker controller; these handlers do read-modify-write on DB rows but that atomicity belongs to the store layer, not here.

## 🔭 If applying: outside-in sequence
1. Confirm green baseline: run `runtime-terminate-operator-reap`, `broker-lease-teardown.red`, `stale-generation-auto-rotate` tests (characterization safety net already exists — no new [T40] needed).
2. F1 (broker-dispose helper) — highest dedup payoff, both call sites tested.
3. F2 (`sessionEventBase` projection) — mechanical, type-guarded; verify each event payload field-for-field.
4. F3 + F4 fold in opportunistically (XS/S).
5. Skip F5.

## ✅ Safety checklist
- [ ] All exported function names/signatures unchanged (boundary 🟢).
- [ ] F2 projection preserves the EXACT field set per event (no dropped/added keys).
- [ ] F1/F4 preserve "omit-undefined-key" semantics (no `{reason: undefined}` leaking into JSON).
- [ ] F1 keeps the two distinct WARN log messages.
- [ ] Three named tests stay green; no new behavior.
