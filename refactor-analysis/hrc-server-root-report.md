# Refactor Analysis — `packages/hrc-server/src` (root `*.ts` only)

MECHANISM-FIRST, outside-in. Subdirectories (`broker/`, `agent-spaces-adapter/`,
`startup-reconcile/`, `parsers/`, `launch/`, `__tests__/`) are explicitly OUT OF
SCOPE and analyzed separately.

## Summary

The root of `hrc-server` is a deliberately decomposed HTTP daemon. `index.ts`
(959 lines) is a thin Bun.serve facade: a single `HrcServerInstance` class whose
~150 handler methods are split across ~16 `*-handlers.ts` modules and merged onto
the prototype via `Object.assign(HrcServerInstance.prototype, …)`. The
decomposition is healthy and recent (H-00039 / T-01807). Most root files are
already cohesive single-responsibility modules with strong inline rationale
comments tied to task IDs.

This is mature, heavily-tested infrastructure with subtle invariants (broker
reaper socket scoping, ask-bracket authority, continuation capture). The honest
finding count is LOW. The smells that exist are:

1. **Dead doc-comment structure in `index.ts`** — a block of ~10 orphaned JSDoc
   comments (lines 677–817) describing methods that were relocated to other
   modules during decomposition. They document nothing in their current location.
   (T16, Low, internal-only — AUTO-APPLICABLE.)
2. **Duplicated `sessionRef` string construction** — `${scopeRef}/lane:${normalizeTargetLane(laneRef) ?? laneRef}`
   appears inline 4× in `target-message-handlers.ts` (plus equivalents in
   `target-view.ts`/`messages.ts`) with no shared `formatSessionRef` helper,
   even though `normalizeTargetSessionRef` already lives in `messages.ts`.
   (T15, Low, internal-only — AUTO-APPLICABLE.)
3. **`HrcServerInstanceForHandlers` is a hand-maintained `any`-typed mirror** of
   the class surface (~150 members typed `(...args: any[]) => any`). A real
   type-safety erosion, but it is the load-bearing seam that makes the prototype
   split compile; reshaping it is high-effort and risks the public method
   contract. (T07, High effort, internal-only-but-pervasive — DEFERRED.)
4. **`planActiveRunReconcile` status→action ladder** (`sweep-reconcile.ts`) is a
   long sequence of `if (runtime.status === …) return { action: 'reap', … }`
   branches — a hand-rolled state machine. Honestly contraindicated for
   refactor: ordering between branches is invariant-critical (ask-bracket and
   broker-substrate checks MUST precede the status ladder per T-01941/T-01946),
   and each branch carries a distinct error code. Left alone.

No non-Anthropic LLM provider SDKs are present. The `provider === 'openai'`
references in `broker-decisions.ts` / `turn-dispatch-handlers.ts` are
harness-frontend routing constants (`openai → codex-cli`, `anthropic →
claude-code`), not LLM API calls; no provider-pricing/model logic lives here.

## Public boundary (`index.ts`)

The public surface is the re-export block (lines 147–200) plus `createHrcServer`
and the `HrcServer` interface. It re-exports:
- Server factory + types (`createHrcServer`, `HrcServer`, `HrcServerOptions`).
- Pure decision predicates from `broker-decisions.js` (~18 functions + ~10 types).
- Runtime selection (`selectDispatchInteractiveRuntime`, …).
- Manager factories (`createTmuxManager`, `createGhostmuxManager`) + option types.
- CLI invocation builder (`buildCliInvocation`) and `buildBrokerRunPreview`
  (consumed by `hrc-cli` for dry-run previews).

This surface is broad but each export has a named downstream consumer
(`hrc-cli`, broker cutover unit tests). **No dead exports were identified by
inspection**; the predicate re-exports exist specifically so the routing logic
is unit-testable outside the daemon. Treat the entire re-export block as
public-surface: any change is DEFERRED.

The route table (`exactRouteHandlers`, lines 253–353) is a clean data-driven
dispatch — no conditional sprawl. One observation (not a defect):
`POST /v1/bridges/local-target` and `POST /v1/bridges/target` both map to
`handleRegisterBridgeTarget` (intentional alias).

## Findings by mechanism

### F1 — Dead doc-comment structure in `index.ts` (T16 collapse premature/dead structure)
- **Location:** `index.ts:677–817` (the run of JSDoc blocks between
  `handleGetSessionByHost` and `handleClearContext`, and the orphan stubs at
  881–893 `// -- hrcchat: … ----`).
- **Smell:** Block comments documenting `GET /v1/events/latest-by-session`, the
  headless-codex provisioning method, the interactive-broker block method, the
  Anthropic-headless SDK method, `resolveTmuxForRuntimePane`, and the
  stale-generation rotation policy — none of which are *defined* at that location
  anymore (they moved to `event-handlers.ts`, `broker-*-handlers.ts`,
  `sdk-turn-handlers.ts`, `runtime-io-handlers.ts`). The comments now float
  above unrelated methods.
- **Direction:** Delete the orphaned comment blocks (or, where a one-line
  routing note is still useful, collapse to a single line). Pure comment
  removal; zero behavior change.
- **Preservation rung:** Compile-only (comments).
- **Falsifiable signal:** After deletion, each surviving doc-comment sits
  immediately above the method it describes; `bun run build`/typecheck unchanged.
- **Risk:** Low. **API-impact:** internal-only. **Effort:** ~15 min.
- **Contraindication:** none. AUTO-APPLICABLE.

### F2 — Duplicated `sessionRef` formatting (T15 extract missing abstraction)
- **Location:** `target-message-handlers.ts:173, 501, 581(via local), 680`;
  cross-refs `target-view.ts:194`, `messages.ts:102` (`normalizeTargetSessionRef`).
- **Smell:** The expression `` `${session.scopeRef}/lane:${normalizeTargetLane(session.laneRef) ?? session.laneRef}` ``
  is open-coded ≥4 times. `messages.ts` already owns the lane-format vocabulary
  (`normalizeTargetLane`, `normalizeTargetSessionRef`) but exposes no
  `formatSessionRef(scopeRef, laneRef)` for the record→ref direction.
- **Direction:** Add `export function formatSessionRef(scopeRef, laneRef)` in
  `messages.ts` (one line, reusing `normalizeTargetLane`), and replace the inline
  occurrences. `normalizeTargetSessionRef` can delegate to it.
- **Preservation rung:** Characterization by existing semantic-DM / handoff tests
  (the produced `sessionRef` is asserted in responses); behavior identical.
- **Falsifiable signal:** Grep for the inline template literal returns the
  `messages.ts` definition only; semantic-dm + turn-handoff tests stay green.
- **Risk:** Low. **API-impact:** internal-only. **Effort:** ~30 min.
- **Contraindication:** none. AUTO-APPLICABLE.

### F3 — `option-resolvers` flag resolution is near-identical 4× (T15/T21, marginal)
- **Location:** `option-resolvers.ts:48–67` (`resolveHeadlessCodexBrokerEnabled`,
  `resolveClaudeCodeTmuxBrokerEnabled`, `resolveCodexCliTmuxBrokerEnabled`) +
  `resolveBrokerDurableIpcEnabled` (74–79).
- **Smell:** Each is `options.<flag> boolean override ?? env feature-flag`. Three
  share `!isFalsyFeatureFlag(env)` (default-ON); the durable-IPC one uses
  `isTruthyFeatureFlag` (default-OFF). A parameterized
  `resolveBooleanFlag(override, envName, { defaultOn })` would collapse them.
- **Direction:** Extract one helper; keep the four named wrappers as thin
  call-throughs (callers and exports unchanged).
- **Preservation rung:** Pure functions; unit-testable directly.
- **Risk:** Low. **API-impact:** internal-only. **Effort:** ~20 min.
- **Contraindication:** The default-ON vs default-OFF asymmetry is *intentional
  and load-bearing* (broker cutover flags default ON; durable-IPC dark). The
  current explicit form makes that asymmetry obvious at each call site; a single
  helper with a `defaultOn` boolean slightly obscures it. Net value is marginal —
  flag this as AUTO-APPLICABLE-but-optional; recommend only if touching the file
  for another reason.

### F4 — `HrcServerInstanceForHandlers` is an `any`-typed surface mirror (T07 align interface to usage) — DEFERRED
- **Location:** `server-instance-context.ts:30–232`.
- **Smell:** ~150 members typed via `HandlerMethod = (...args: any[]) => any`.
  Handler modules receive `this: HrcServerInstanceForHandlers`, so the entire
  cross-handler call graph is effectively untyped (`any` in/out). The biome
  suppressions acknowledge this. The decomposition traded type safety for the
  prototype split.
- **Direction (honest, long-horizon):** Replace `HandlerMethod` entries with the
  actual method signatures (the concrete functions already have them), generated
  or hand-derived; or invert to `this: HrcServerInstance` where the class type is
  available. This is the *right* direction but large and easy to get subtly
  wrong (a mistyped `this` param breaks compilation across many modules).
- **Risk:** High (broad blast radius, touches every handler module). **API-impact:**
  internal-only *but pervasive*. **Effort:** large (days). **DEFERRED.**

### F5 — `planActiveRunReconcile` status ladder (T10 reify state machine / T19) — DEFERRED, leaning "leave alone"
- **Location:** `sweep-reconcile.ts:543–719`.
- **Smell:** ~10 sequential `if` branches mapping runtime status / launch status /
  substrate liveness → `{ action, reason, errorCode, nextRuntimeStatus }`. Reads
  as a hand-rolled decision table.
- **Why DEFERRED (and probably untouched):** The *ordering* is the invariant —
  the ask-bracket check (T-01946) and the `harness-broker + hasLeasedBrokerSubstrate`
  per-runtime socket probe (T-01941) MUST run before the generic status ladder,
  or a live parked/durable broker is wrongly reaped. The branch bodies are not
  uniform (distinct error codes, an `await` probe with side-effecting
  `killServer`). A table-driven rewrite would have to encode precedence + the
  async probe anyway, yielding little clarity for real regression risk in the
  most safety-critical reaper path.
- **Risk:** High. **API-impact:** internal-only (but behavior is observable via
  reap reason codes / events). **Effort:** large. **DEFERRED.**

## Deliberately left alone

- **`broker-decisions.ts`** — large but exemplary: pure predicates, each with a
  task-ID rationale, all unit-tested and publicly re-exported. The `provider ===
  'openai'` checks are routing constants, not LLM calls.
- **`hrc-event-helper.ts`** — the `KIND_CATEGORIES` map and the
  `deriveSemanticTurnEventFrom*` family are intentionally explicit; the
  per-source derivations differ enough that a unifying abstraction would obscure.
- **`index.ts` route table** — already data-driven; the prototype `Object.assign`
  merge is the chosen decomposition pattern, not a smell to undo.
- **The whole `index.ts` re-export block** — public surface, every export has a
  consumer. Out of scope for behavior-preserving internal refactor.
- **`reconcileActiveRunsOnce` / `sweepZombieRunsOnce`** — duplicated result-shape
  assembly exists but each carries distinct semantics (zombie vs reap vs suspect
  vs corrupt-awaiting); merging risks conflating the two reaper policies.

## If-applying sequence (AUTO-APPLICABLE only)

1. **F1** — delete orphan doc-comments in `index.ts`. (Pure comments; do first,
   zero risk.)
2. **F2** — add `formatSessionRef` to `messages.ts`; replace inline occurrences
   in `target-message-handlers.ts` (+ optionally `target-view.ts`); delegate
   `normalizeTargetSessionRef` to it.
3. **F3** (optional) — only if already editing `option-resolvers.ts`; preserve
   the default-ON/OFF asymmetry explicitly in the extracted helper's call sites.

Do NOT touch F4 / F5 in an auto-apply pass.

## Safety checklist

- [ ] `bun run build` (workspace) green — hrc-server runs from source, so
      typecheck is the real gate.
- [ ] `bun test packages/hrc-server` full suite green, run with `TMPDIR=/tmp`
      (per known-flake memo); re-run any timing-sensitive
      `dispatch-turn-live-harness-literal` / `server-bridge-phase2` failures in
      isolation before treating as regressions.
- [ ] For F2: semantic-DM, semantic-turn-handoff, and target-view tests assert
      `sessionRef` strings — confirm byte-identical output.
- [ ] Lint (`biome`) clean — F1 must not orphan a now-misplaced biome-ignore.
- [ ] No change to `index.ts` re-export block (public surface) in the
      auto-apply pass.
- [ ] If the daemon is exercised live, `hrc server restart` (source picked up on
      restart) and a smoke `hrc run` / semantic DM round-trip.
