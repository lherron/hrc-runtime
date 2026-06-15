# HRC Fork — Design Proposal & Lane Impact Audit

**Status:** Draft for review
**Date:** 2026-06-14
**Author:** clod (hrc-runtime)
**Decisions locked:** (1) addressing axis = **lane** (with lane-impact audit completed); (2) continuation correctness bar = **provider-native duplication only**.

---

## 0. TL;DR

Add a first-class **fork** concept to hrc, modeled on codex's `thread/fork`.

- A fork = **mint a fresh continuity chain under a new lane, seed its `continuation` from a *provider-duplicated copy* of the source's, and record lineage.**
- Addressing rides the existing **lane** axis: `clod@hrc-runtime:primary` → `clod@hrc-runtime:primary~fork.1`.
- The hard, net-new work is **not addressing** — the entire hrc handle/dm/turn chain is *already* lane-aware (audited below). The real work is a broker `forkContinuation` RPC that asks the harness/provider to clone the underlying session (codex `thread/fork`; claude-code = copy session file → new id), plus a `fork.N` lane allocator and a `forked_from` lineage column.
- **Correctness trap:** naively pointing two lanes at the *same* `continuation` ref corrupts provider history (both append to one store). Fork v1 therefore requires provider-native dup and fails loudly if the harness can't do it.

---

## 1. How codex implements fork (reference model)

**What it is:** fork creates a new independent thread (conversation) by copying an existing thread's history up to a fork point. The fork diverges freely without mutating the source — branch-a-conversation, not fork-a-process.

**Entry points**
- API: JSON-RPC `thread/fork` (`ThreadForkParams` → `ThreadForkResponse`)
- Python SDK: `Codex.thread_fork(thread_id, params)` / async variant

**Flow** (`codex-rs/app-server/src/request_processors/thread_processor.rs:431`, `:3251`):
1. Load source thread by `threadId`/`path` with full rollout history.
2. Resolve config — start from source's config, apply overrides (`model`, `provider`, `cwd`, `approvalPolicy`, `sandbox`, instructions).
3. Create fork via `thread_manager.fork_thread_from_history` (`core/src/thread_manager.rs:903`), passing `ForkSnapshot::Interrupted` + `InitialHistory::Resumed(source history)`.
4. Transform history — `fork_history_from_snapshot` (`thread_manager.rs:1656`): `Resumed → Forked` (copies items). Mid-turn ⇒ appends a `TurnAborted` marker. `TruncateBeforeNthUserMessage` variant supports branch-at-point.
5. Persist or stay ephemeral (`:3413`): materialized forks get their own `rollout-*.jsonl`; ephemeral forks stay `path: None`, memory-only.
6. Respond + notify: `thread/fork` response, then `thread/tokenUsage/updated` (replays source usage unless `excludeTurns`), then `thread/started`.

**Copied vs new vs persisted**
- *Copied:* full conversation history, config snapshot (as baseline), cwd, workspace roots, source name (if explicitly set).
- *New per-fork:* thread ID, session ID, plus `forkedFromId` lineage pointer.
- *Persisted:* materialized = on disk, listed, survives restart; ephemeral = memory-only, not listed, rebuilt-or-discarded.

**Notable decisions**
- Materialize-now (not lazy) for durable forks.
- `Interrupted` snapshot default injects synthetic `TurnAborted` when forking mid-turn.
- Override-on-inherit: "fork but with a different model/sandbox" is first-class.
- Token-usage replay keeps cumulative counts continuous.
- Forking a not-yet-materialized source fails.

**Key files:** `app-server/src/request_processors/thread_processor.rs:431,3251`; `core/src/thread_manager.rs:903,1656`; tests `app-server/tests/suite/v2/thread_fork.rs`, `core/tests/suite/fork_thread.rs`.

---

## 2. Mapping codex → hrc

| codex | hrc analog |
|---|---|
| thread (conversation + history) | a continuity chain, keyed `(scopeRef, laneRef)` |
| thread history (rollout items) | `continuation` (provider session ref: claude conv id / codex rollout) |
| new thread id + session id | new `(scopeRef, laneRef)` → new `hostSessionId` |
| `forkedFromId` | a `forked_from` lineage pointer on the new continuity/session |
| ephemeral vs materialized | durable continuity record vs marked-ephemeral lane |
| config overrides on fork | the start-time overrides hrc already supports |

**Definition (hrc):** a fork mints a fresh continuity chain under a new handle, seeds its `continuation` from a *duplicate* of the source's, and records lineage.

---

## 3. Addressing decision: lane (not taskId-suffix)

**Chosen: lane.** Rationale:
- The handle grammar already defines lane as *"parallel branch within a scope (e.g. `~repair`)"* — a fork **is** a parallel branch.
- Continuity is already keyed `(scopeRef, laneRef)` → a new lane is a brand-new chain with **zero schema change**.
- taskId is metadata-only (baked into the `scopeRef` *string*, no DB column). Suffixing `task → task#2` muddies taskId's meaning and ripples into `role:` sub-refs and every scopeRef-keyed lookup. Strictly more blast radius, no benefit.

**Handle shape**
```
source:  clod@hrc-runtime:primary~main          (i.e. clod@hrc-runtime:primary)
fork:    clod@hrc-runtime:primary~fork.1         then fork.2, fork.3 …
```
`fork.N` is a derived lane name; lane is already a free-form string, so the only addition is an allocator that picks the next free `fork.N` for the scope.

> taskId-suffix remains available as an explicit fallback flag if a task-scoped fork (visible in wrkq/monitor task tooling) is ever wanted — but it is not the default.

---

## 4. Continuation duplication (the real problem)

**Correctness bar (locked): provider-native dup only.**

⚠️ Trap: hrc's `continuation` is a *provider* reference (claude conv id / codex rollout), not history hrc itself holds. If you copy the ref into a new lane and start a runtime, **both lanes resume the same provider session and append to the same store → interleaved/corrupted history.** This is exactly why codex mints a *new* rollout on fork.

A correct fork must ask the provider/harness to **duplicate** the session and return a *new* continuation ref. Provider-native first (codex `thread/fork`), capability-negotiated. If the harness can't, fork **fails loudly** — never silently shares state.

---

## 5. Broker RPC addition

Add one durable-broker method, capability-gated via `hello()`:

```ts
// broker/controller/types.ts — DurableBrokerClientLike
forkContinuation(req: BrokerForkContinuationRequest): Promise<BrokerForkContinuationResponse>

type BrokerForkContinuationRequest = {
  sourceContinuation: HrcContinuationRef     // {kind,key,metadata}
  // optional (phase 2): truncateBeforeNthUserMessage  — codex branch-at-point
}
type BrokerForkContinuationResponse = {
  continuation: HrcContinuationRef           // NEW provider session ref
  capability: 'native' | 'unsupported'
}
```

- Harness implements via provider-native fork (codex `thread/fork`; claude-code = copy session file → new id).
- `hello()` advertises `capabilities.forkContinuation: boolean`. Unsupported ⇒ fork fails with a clear error.
- **No new invocation lifecycle.** Fork operates on *continuation*; the new lane then starts a normal runtime that resumes the duplicated continuation. Reuses all existing start / attach / replay machinery.

**Where it lands:** broker RPC contract lives in `packages/hrc-server/src/broker/controller/types.ts` (`DurableBrokerClientLike`, ~`:111-117`). `forkContinuation` joins `attach`/`snapshot`/`eventsSince`/`ackEvents`/`permissionRespond` as a v0.2 durable-only method.

---

## 6. HRC endpoint + CLI

```
POST /v1/sessions/fork
  body: { sourceSessionRef, lane?, ephemeral?, overrides? {model,cwd,…} }
  flow:
    resolve source continuity (getByKey(scope, lane))
    → broker.forkContinuation(sourceContinuation)         # provider dup
    → allocate lane fork.N (or named lane)
    → continuities.upsert(scopeRef, fork-lane, newHostSessionId)
    → seed session.continuation = duplicated ref
    → write forked_from lineage
  returns: { sessionRef: <new handle>, forkedFrom: <source sessionRef> }
```

CLI:
```
hrc fork clod@hrc-runtime:primary               # → …~fork.1, prints handle
hrc fork <ref> --lane spike --model …           # named lane + override
hrc fork <ref> --ephemeral                       # non-durable branch (phase 2)
hrc start <new-handle>                            # run it (existing path)
```

> Mid-turn fork (codex `Interrupted` snapshot + `TurnAborted` marker) is **phase 2**. v1 requires the source idle / continuation settled.

---

## 7. Persistence / lineage

- Add `forked_from_session_ref` (+ optional `forked_from_continuation_key`) to the `continuities` (or `sessions`) row. One nullable column; everything else uses existing keying.
- Ephemeral fork = continuity row flagged `ephemeral` (excluded from default listings), rebuilt-or-discarded per policy. **Phase 2.**

Existing schema (no change needed for coexisting lanes):
- `continuities` PK `(scope_ref, lane_ref)`
- `sessions` index `(scope_ref, lane_ref, generation)`, carries `lane_ref`
- `runtimes` carries `lane_ref`

---

## 8. Lane Impact Audit (the part you asked to validate)

**Headline:** the lane axis needs *almost no* plumbing work. The hrc handle/dm/turn chain is already lane-aware end to end. **Two agents in the same scopeRef on different lanes can already DM and turn-handoff each other, lane-correctly, today.**

### 8.1 Linchpin confirmed — `~lane` parses

`agent-scope` `parseSessionHandle` (`agent-spaces/packages/agent-scope/src/session-handle.ts:18-38`) parses the `~` suffix:
`clod@hrc-runtime:primary~forked-lane` → `{ scopeRef: agent:clod:project:hrc-runtime:task:primary, laneRef: lane:forked-lane }`. Absent `~`, laneRef defaults to `main`; `formatSessionHandle` elides `~main`.

### 8.2 hrcchat dm — fully lane-aware

- CLI `resolveTargetToSessionRef` appends `/lane:<laneId>` (`hrcchat-cli/src/normalize.ts:60-63`); `resolveScope` passes `defaultLaneId: 'main'` (`:37-49`).
- Server `findTargetSession` → `continuities.getByKey(scopeRef, laneRef)` composite key (`hrc-server/src/target-view.ts:30-49`).
- `handleSemanticDm` resolves via that lane-correct session and routes to its `activeHostSessionId` runtime (`hrc-server/src/target-message-handlers.ts:433-572`). Two lanes never collide.

### 8.3 hrc/hrcchat turn — fully lane-aware

- `hrc run/start` carry the full sessionRef incl. lane (`hrc-cli/src/cli/handlers-scope-cmd.ts:116-146`).
- `/v1/sessions/resolve` → `findContinuitySession` → `getByKey(scope, lane)` (`target-view.ts:17-28`); create-path upserts continuity keyed `(scope, lane)`.
- `/v1/turns` (`turn-dispatch-handlers.ts:88-128`) resolves by `hostSessionId`, which is **already lane-scoped** (one hostSessionId per `(scope,lane)` via continuity), so the "latest runtime wins" selection in `runtime-select.ts:41-46` is implicitly lane-correct even though `listByHostSessionId` has no lane filter.
- `/v1/turns/by-selector` (`selector-message-handlers/selector-input.ts:342-444`) and `/v1/messages/turn-handoff` go through the same lane-filtered `findTargetSession`.
- Interactive "DM to busy TUI queues input" path also routes via lane-correct session → runtime invocationId (`selector-input.ts:221-340`).

### 8.4 Inter-lane sender identity — works

`HRC_SESSION_REF` is injected with the lane when a runtime launches (`hrc-server/src/agent-spaces-adapter/cli-adapter.ts:173-195`, `env['HRC_SESSION_REF'] = ${scopeRef}/lane:${laneId}`). A forked-lane agent self-identifies and sends from its own lane → the "two clods talk to each other" requirement is satisfied.

### 8.5 Persistence — no schema change for coexisting lanes

`continuities` PK `(scope_ref, lane_ref)`; `sessions`/`runtimes` carry `lane_ref`; indexes include lane. Confirmed in `hrc-store-sqlite/src/migrations/schema-migrations.ts` and the runtime/session repositories.

### 8.6 Gaps to fix (small, bounded — none are misrouting)

1. **Scope-wide listing ignores lane.** `listSessionsByScope(scopeRef)` with no laneRef returns *all* lanes (`hrc-server/src/selector-message-handlers.ts:48-58`, via `handleListSessions` when lane param omitted). Aggregation concern, not routing. **Decide:** do forks surface in scope-wide listings or stay hidden? Make this call lane-explicit either way.
2. **⚠️ Monitor/event rendering defaults missing `laneRef` → `'main'`** (`hrc-cli/src/monitor-render.ts:524`, `monitor-watch.ts:652`, `monitor-wait.ts:352`). **Must-verify-live:** confirm emitted events actually populate `laneRef` for a fork lane; if any event path drops it, fork-lane activity renders under `~main`. This is the one thing to prove on a real terminal before trusting fork observability.
3. **Cosmetic** `'default'→'main'` normalization (`hrc-server/src/messages.ts:91`, `monitor-show.ts:378`) — harmless; just never name a fork lane `default`.

### 8.7 Audit verdict

Lane is the right axis. Handle processing does **not** need lane added — it's already there. Fork's actual work is: (a) broker `forkContinuation`, (b) `fork.N` allocator + `forked_from` column, (c) close gap 8.6.1 and verify 8.6.2.

---

## 9. Phasing

1. **Phase 1** — broker `forkContinuation` (codex-backed first); `POST /v1/sessions/fork`; `hrc fork`; `fork.N` lane allocator; `forked_from` column; source-must-be-idle; durable only. Close gap 8.6.1, verify 8.6.2. **Ghoste2e:** fork an idle clod codex session, run a divergent turn in each lane, prove no cross-contamination + correct monitor lane attribution.
2. **Phase 2** — claude-code harness support; ephemeral forks; mid-turn snapshot fork (`Interrupted` + `TurnAborted`); `--truncate-at` branch-point.
3. **Phase 3** — lineage surfacing (`hrc runtime list --tree`, monitor lineage); fork-of-fork.

---

## 10. Open questions for review

- **Listing policy (gap 8.6.1):** should forks appear in scope-wide `hrc runtime list` / target listings by default, or be hidden until explicitly requested?
- **Lane naming:** `fork.N` numeric vs requiring `--lane <name>`? (Proposal: auto `fork.N`, override with `--lane`.)
- **Source-idle enforcement in v1:** hard-fail if source has an in-flight turn, or queue the fork behind it?
- **Token-usage replay:** mirror codex's `thread/tokenUsage/updated` semantics, or skip for v1?
