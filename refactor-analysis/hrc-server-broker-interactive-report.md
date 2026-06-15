# 🔧 Refactoring Analysis — packages/hrc-server/src/broker-interactive-handlers

**Target:** `packages/hrc-server/src/broker-interactive-handlers/` (general profile)
**Files read:** 2 / 2 — `substrate-allocator.ts` (357), `controller-factory.ts` (264). Plus consumers (`broker-interactive-handlers.ts`, `index.ts`, `broker/controller.ts`, `tmux.ts`) and tests to assess the boundary.
**Lines:** 621 total. **Package type:** general (broker substrate allocation + controller wiring; some concurrency-adjacent tmux/IPC, but no shared-mutable state in these two files).

## 🧭 Summary
Two small, well-documented files. `substrate-allocator.ts` is the substrate/presentation allocation primitive plus two thin `BrokerTmuxAllocator` adapters; `controller-factory.ts` lazily builds the singleton `HarnessBrokerController` and a best-effort headless viewer. The code is in good shape — the only real structural finding is a duplicated `sub → BrokerTmuxAllocation` projection across the two adapters (T15, internal-only). Everything else is either deliberate (the `presentation='none'` arm wired-but-route-unselected is a documented expand/contract staging point, NOT dead code) or below the bar.

## 🚪 Public boundary (assess first)
**Exported surface** (re-exported via `broker-interactive-handlers.ts` → `index.ts`):
- Values: `allocateBrokerSubstrate`, `createBrokerDurableTmuxAllocator`, `createBrokerDurableHeadlessAllocator`, `getHarnessBrokerController`, `spawnHeadlessClaudeViewer`.
- Types: `AllocateBrokerSubstrateInput`, `BrokerSubstrateAllocation`, `BrokerDurableTmuxAllocatorDeps`, `BrokerSubstratePresentationKind`, `DurableTmuxManagerLike`.

**Consumers:** all intra-`hrc-server`. The two controller-factory methods (`getHarnessBrokerController`, `spawnHeadlessClaudeViewer`) are bound onto `HrcServerInstanceForHandlers` and called from `turn-dispatch-handlers`, `broker-headless-handlers`, `runtime-control-handlers/*`, `index.ts`. The allocators/types are consumed by `controller-factory.ts` and exercised directly by characterization tests (`broker-durable-allocator.red.test.ts`, `broker-substrate-presentation-characterization.test.ts`, `broker-durable-activation.red.test.ts`, `broker-headless-durable.red.test.ts`). No external-package consumer.

**T07 (align interface to usage):** `DurableTmuxManagerLike` is a structural subset of the real `TmuxManager` (`tmux.ts`), declared exactly to the methods `allocateBrokerSubstrate` calls — already a correctly-narrowed seam, not leaky. `BrokerSubstrateAllocation` carries "in-process extras for the legacy flat mapping" — these are genuinely consumed by both adapters, so the surface is not fat. No T07 action.

**M02 (expand/contract):** the `presentation: BrokerSubstratePresentationKind` input + the two-arm return shape is the in-progress contract widening (Ph2/Ph3 of the durable cutover). The `presentation='none'` headless adapter is now wired and selected (`headlessSubstrateAllocator` in controller-factory). No contract change recommended.

**Verdict:** 🟢 Boundary is healthy and tightly aligned to usage. No public-surface refactor warranted.

## 🎯 Findings by mechanism (outside-in, highest impact first)

### F1 — Duplicated `sub → BrokerTmuxAllocation` projection across the two adapters
- **Location:** `substrate-allocator.ts:266-307` (`createBrokerDurableTmuxAllocator.allocate`) and `:325-355` (`createBrokerDurableHeadlessAllocator.allocate`).
- **Technique:** [T15] extract missing abstraction (duplicated intent).
- **Mechanism repaired:** a single mapping of `BrokerSubstrateAllocation → BrokerTmuxAllocation` instead of two copies that must be kept field-synchronised. Both copies repeat the identical `socketPath / allocatedAt / generation / brokerIpcSocketPath (with the `endpoint.kind === 'unix-jsonrpc-ndjson' ? … : ''` guard) / attachToken / conditional attachTokenRef spread / brokerCommand / conditional brokerPid spread / brokerWindow` block; the tmux variant then appends `lease + tuiWindow + legacy single-pane mirror fields`.
- **Direction:** extract (consolidate) — a shared `toBaseAllocation(sub)` helper returning the common fields, with each adapter spreading the presentation-specific tail.
- **Symptom → Current → Suggested:** today a field added to `BrokerTmuxAllocation` (e.g. another endpoint-derived field) must be edited in both arms or they silently diverge. Suggested: one internal `function projectBaseAllocation(sub: BrokerSubstrateAllocation): <common subset>` consumed by both adapters.
- **Preservation rung:** test-suite — `broker-durable-allocator.red.test.ts` + `broker-substrate-presentation-characterization.test.ts` assert the exact allocation shape for both arms; the projection must reproduce the identical field set (spread-preservation: keep the conditional `attachTokenRef`/`brokerPid` spreads exactly, do not materialise them as `undefined`).
- **Falsifiable signal:** the two literal object bodies collapse to one helper call + a small tail; `git diff` shows the duplicated ~9-field block removed once. Tests stay green.
- **Risk:** Low. **API-impact:** internal-only (return shape unchanged). **Effort:** S.
- **Contraindication:** the duplication is small and the two tails differ (tmux adds 7 fields, headless adds 0). If extraction forces an awkward partial-object type or an `as` cast to satisfy `BrokerTmuxAllocation`'s required-vs-optional fields, the helper is not worth it — keep the two literals. Verify the extracted base typechecks cleanly against `BrokerTmuxAllocation`'s optional fields before committing.

### F2 — `as BrokerWindowIdentity` / `as BrokerTmuxLease` casts mask a total-vs-partial guarantee
- **Location:** `substrate-allocator.ts:282-283` — `const tuiWindow = sub.tuiWindow as BrokerWindowIdentity` and `const lease = sub.tuiLease as BrokerTmuxLease`.
- **Technique:** [T17] partial→total (remove a "can't happen" cast by encoding the invariant in the type).
- **Mechanism repaired:** the tmux adapter *knows* `presentation='tmux-tui'` always yields `tuiWindow`/`tuiLease`, but `BrokerSubstrateAllocation` types both as optional, so the adapter casts. The invariant ("tmux-tui ⇒ tuiWindow & tuiLease present") lives in a comment + a cast rather than the type.
- **Direction:** make-illegal-unrepresentable (mild) — could split `BrokerSubstrateAllocation` into a discriminated union on `presentation.kind` so the `'tmux-tui'` variant has non-optional `tuiWindow`/`tuiLease`, letting `allocateBrokerSubstrate`'s tmux return narrow without a cast at the call site.
- **Preservation rung:** type/compiler-proof (the union removes the casts).
- **Falsifiable signal:** the two `as` casts at `:282-283` disappear and `tsc` still passes.
- **Risk:** Med. **API-impact:** public-surface — `BrokerSubstrateAllocation` is an exported type consumed by tests/fixtures (`broker-headless-durable.red.test.ts:316`), so a union reshape ripples to consumers. **Effort:** M.
- **Contraindication:** this is a real redesign of an exported type for a 2-line cast saving inside one adapter; the comment + cast is honest and cheap. Likely **not worth it** — DEFERRED for human judgment only because it touches the public type. Recommend leaving as-is unless the union is wanted for other reasons.

## 🪶 Deliberately left alone (where-NOT)
- **`presentation='none'` arm in `allocateBrokerSubstrate` (`:214-216`, `:321-357`)** — NOT dead/premature abstraction. It is the headless substrate route and is now selected live (`headlessSubstrateAllocator` is wired into the controller in `controller-factory.ts:101-107`). [T16] does not apply — the variation has materialised.
- **`DurableTmuxManagerLike` narrow interface** — a correctly-scoped [T07] seam (subset of real `TmuxManager`), enabling test doubles. Leave.
- **Optional methods `inspectPaneProcess?` / `waitForAttachedClient?`** — genuinely optional capabilities probed with `typeof … === 'function'` (`:178`, `:132`); the guard is the right partial-handling, not a smell.
- **Inline stdio fallback allocator in `getHarnessBrokerController` (`controller-factory.ts:56-97`)** — a 40-line object literal inside the factory. It is the *non-durable* legacy route selected only when `durableRoute !== 'durable-ipc'`. Extracting it (e.g. `createBrokerLeaseTmuxAllocator`) is tempting for symmetry with the other two factory functions, but per MEMORY the cutover flags are default-ON and this branch is the soon-to-be-removed leg; extracting it would dignify code that is on its way out. Leave it inline; revisit when the legacy leg is deleted.
- **`getHarnessBrokerController` length/nesting** — it is long but flat (lazy-init memoised singleton assembling one big config object); nesting never reaches the ≥4 [T22] threshold. The `reapBrokerTmuxLease` closure (`:143-174`) is cohesive (Lever-2 graceful-exit teardown) and reads sequentially with early returns already. No guard-clause win.
- **`spawnHeadlessClaudeViewer` try/catch (`:200-263`)** — the outer swallow is intentional ("never throws — viewer is observational and must not gate dispatch") and every branch logs. [T18] does not apply; the swallow is documented and load-bearing.
- **`attachCommand` shell-string templates (`:220`, `:247`)** — string interpolation of socket/session into a shell command. Not primitive-obsession worth reifying here; the command shape is a deliberate mirror of the operator attach argv (7530bd4 fix is commented). Leave.

## 🔭 If applying: outside-in sequence
1. Confirm green baseline (`broker-durable-allocator.red.test.ts`, `broker-substrate-presentation-characterization.test.ts`, `broker-headless-durable.red.test.ts`).
2. Apply **F1** only (extract `projectBaseAllocation` helper) — internal, behavior-preserving. Re-run the three suites + `tsc`.
3. Do NOT touch F2 (public type reshape) without explicit human sign-off.

## ✅ Safety checklist
- [ ] F1 preserves the exact field set incl. conditional `attachTokenRef`/`brokerPid` spreads (no `undefined` materialisation).
- [ ] `tsc --noEmit` clean (the extracted base must satisfy `BrokerTmuxAllocation` optional fields without an `as` cast — if it needs one, abort F1).
- [ ] Allocator characterization tests green for BOTH `tmux-tui` and `none` arms.
- [ ] No behavior change: same broker command string, same window-creation order, same preflight ordering.
- [ ] F2 left untouched (deferred, public-surface).
