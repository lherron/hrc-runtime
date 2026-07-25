# Disposition of the proposed remediation plan — Mable review

Date: 2026-07-25
Reviewer: Mable (`mable@hrc-runtime:minisvc`)
Subject: [Proposed remediation plan](2026-07-25-overnight-defect-fix-remediation-plan.md) (Cody/Clod)
Method: critical read of the plan and both audits, plus three independent sonnet verification passes against the code at `3adbe9c`: (a) trust-boundary analysis of the F-1 claim, (b) line-level mechanism verification of F-2/F-3, (c) change-size estimation of every proposed repair.

## Verdict

The audits' *findings* are largely real. The *plan* built on them is not proportionate. Its central error is treating F-1/T-05439 as a production-exploitable critical security failure and wrapping the whole program in containment ceremony derived from that framing. The verified trust model does not support it:

- The entire hrc-server dispatch API is a **same-UID UNIX socket with no authentication by design** (`packages/hrc-server/src/index.ts:796-803`; contrast the federation registry listener at 805-833, which *does* do peer-token auth — HRC authenticates surfaces meant to cross a trust boundary, and this one isn't).
- **Any ordinary turn already gets workspace-write.** `HrcHarnessIntent.yolo` / codex `sandboxMode` are caller-requestable pass-throughs; the harness subprocess runs unconfined as the operator's UID. No approval artifact needed.
- `actuatorSplit` is **opt-in** (`effectivePolicy()` no-ops when undeclared), has **zero consumers outside hrc-runtime's own tests**, and the platform's own maturity model already demoted it (`agent-enablement/AXES.md`: `TA.actuatorSplit` retained as a *frontier sighting*, not a landed mechanism, with the stated baseline "any agent can write anything").

So the "forgeable approval" restricts nothing a caller couldn't do through the front door — or by just writing the file, being the same UNIX user. F-1 is a **guardrail-integrity gap in a pre-adoption feature**, worth an honest fix before adoption. It is not a boundary bypass, and nothing in the estate depends on it. Every piece of the plan's P0 containment apparatus — chokepoint hard-rejection doctrine, runtime fencing with before/after inventories, red/green containment proofs, "guard lifted only by the final repair commit" — is ceremony sized to a threat that does not exist on this surface.

The deeper problem with Track A as specified: in a same-UID trust domain there is **no non-theater version of an "authoritative approval store."** Any store the daemon can read, a same-UID caller can write (the sqlite file, the "signed issuer" key, all of it). Approval authenticity requires OS-level privilege separation first — a platform frontier decision, not a remediation of this batch. Prescribing signed issuers and adversarial forgery suites *without* that separation is security theater by construction.

Second substantive defect in the plan: the F-3 remedy as written doesn't cover its own named scenario. `FederationOutboxRepository.cancel` only cancels `pending/retry_scheduled/peer_unreachable` deliveries — it is a **no-op once a delivery is `'delivered'`**, which happens at peer-ACK, typically well inside the 30s window. The "sleeping peer" the plan worries about has already durably received the message; there is no cross-node abort envelope today. Cancelling the outbox item on timeout fixes only the peer-unreachable sub-case.

What survives scrutiny: the merge-to-main hygiene, the F-2 mechanism (confirmed, plus a *more likely* variant the audit missed), the F-3 semantics gap, the selector split, the history-query unboundedness (the one genuinely large item), the terminal-gap cancel bug, and the small observability/cleanup items. That's a normal defect backlog, not a five-phase containment program.

## Per-item disposition

| Plan item | Disposition | Rationale |
| --- | --- | --- |
| Phase 0: chokepoint hard-rejection + "lifted only by final repair commit" | **Reject as specified; keep a minimal guard** | Zero consumers, opt-in, same-UID surface. Real risk is *false assurance* if someone adopts it believing the guardrail holds. One small commit: reject non-off modes with "experimental — disabled pending T-05439 rework" + one unit test. No lift ritual. |
| Phase 0: fence authority-bearing runtimes, before/after inventories | **Reject ceremony; do the op** | It's one disposable smoke runtime (`rt-13f43ad8`, verified). Kill it. One command. |
| Phase 0: T-06602 worktree removal + "fresh pre-removal safety check" authority ritual | **Accept action, reject ceremony** | Verified detached/clean/merged/completed twice already. `git worktree remove` it. |
| Phase 0: containment validation (red proof at pre-fix commit, live installed proof, inventories, release readback) | **Reject** | A unit test on the guard, run by the normal bar, is the whole requirement. |
| Phase 1: merge `cody/handoff-00291` → main, lockfile, full bar, land, later work from main | **Accept — do immediately** | Routine hygiene; production running an unmerged branch 5 behind main is the real integration risk. Not a "phase," just work. |
| Phase 1: two-parent public-surface baseline diff; separate explicit refusal re-proof on merged tree | **Reject** | `just verify` (which includes check:public-surface and the guard's test) on the merged tree covers both. |
| Phase 1: delete duplicative remote backlog branch | **Accept** | One command after the merge lands. |
| Track A: authoritative approval store / signed issuer + adversarial forgery suite | **Reject as specified** | Theater without privilege separation (see verdict). Fold into a single deferred design task, gated on actual demand for actuator-split. |
| Track B: mechanical write confinement, Daedalus consult, guard removed only here | **Defer with Track A** | Same task. Daedalus consult is right *when it's picked up* — HRC-applies-artifact is the plausible shape. Not now; nothing needs it. |
| T-06592 idempotency (F-2) | **Accept, reframed** | Mechanism confirmed. Correction: the audit's "pruned runtime row" replay-throw is unreachable (prune cascades run deletion in-txn, FK-enforced); the *real* and more common throw is replay of a queued run with no `runtimeId` yet (dispatch racing broker boot). Fix = thread key/hash into the 5 `runs.insert()` sites (columns already exist, no migration) + fix queued-run replay. Medium, mechanical. One crash-boundary test — the t06592 red suite already does restart cycles; extend it, don't build a 5-boundary injection rig. |
| T-06809 federation timeout (F-3) | **Accept semantics, reject remedy as written** | Tiered: (1) small guard — skip late `turn.started` append when the run already has a terminal event (widens the existing `listByRun` check); (2) timeout returns pending/unknown instead of failed — small/medium; (3) durable cross-node idempotency key = wire-contract amendment (new `SemanticDmRequest` field, capability-gated like `semanticTurnHandoff`) — medium-large, only worth it if federated-retry is a real usage pattern. Do 1–2 now, park 3 as P3 pending usage evidence. |
| T-06579/T-06830 shared selector resolver + full matrix | **Accept** | Real user-facing defect, verified half-day fix: extend `message-selector.ts` grammar (`@N`/`#N`/`msg:`/UUID/bare), rewire `trace.ts` to it via existing `client.traceMessage`. The 7×3 matrix is fine *as the test suite*, not as ceremony. Include the absent-`collectiveSeq` fixture. |
| T-06802 bounded history queries | **Accept — the one genuinely large item** | Verified: every filterable field except `messageId`/`afterSeq` lives inside `canonical_record_json` with no columns/indexes. Real fix = new indexed columns (or generated columns), migration + ~18k-row backfill, query rewrite, batch observation loads. Multi-day. Worth it — this class already caused a live CPU incident. |
| T-06090 terminal gap backfill | **Accept — small** | Verified <2h: at the two terminal call sites, invoke the existing reentrant-safe `backfillBrokerEventGap` instead of `cancelBrokerEventGapBackfill`, clear the pending timer. Plus exited/failed/disposed regressions. |
| T-06405/T-06369 detached-worktree visibility | **Accept — trivial** | ~15 lines: fall back to `taskTokens(worktree.path)` when branch yields none; emit explicit skipped result. |
| T-05337 lease-GC liveness | **Accept log-only variant** | Drop the `if (changed)` gate on `broker.lease_gc_sweep_complete`, matching the sibling tmux-aging timer's unconditional tick line. <1h. The status-projection variant is medium and unjustified. |
| Phase 4 trivia (help string, `resume --dry-run` placement line, T-06576 SHA comment) | **Accept — batch** | Two one-liners + one wrkq comment correction. |
| Red-before-green doctrine table for all criticals | **Reject as doctrine** | Normal regression discipline (repro first, red test, fix) already covers it; the F-2 red suite exists. Durable "red proof at the pre-fix commit" artifacts add nothing a failing-then-passing test doesn't. |
| Separate reproduce-only second review of F-2..F-5 before implementation | **Reject** | Mechanisms now independently verified (this review). Third pass buys nothing. |
| R13 fleet-rollout release-gate task; lab→svc→max3 per-node ceremony | **Reject as task; keep as standing doctrine** | Deploy-all-nodes-before-GREEN is already shop doctrine and applies per runtime-facing fix. It doesn't need a wrkq record and a dependency fan-in. |
| 13-task breakdown, everything serialized behind R2 | **Reject; ~6 records** | See revised plan. Filing is a cost; half these records are ceremony or sub-hour fixes inflated into tasks. |

## Revised plan

**Do now, no tasks (one sitting, ordered):**

1. Merge `cody/handoff-00291` → `main`, resolve `bun.lock`, run `just verify` on the merged tree, land, push.
2. Land the minimal actuator-split disable guard (reject non-off modes with an "experimental/disabled" error + unit test) — either just before or just after the merge, either is fine.
3. Ops sweep: kill the `rt-13f43ad8` smoke runtime; remove the T-06602 worktree; delete `origin/cody/remaining-agent-spaces-backlog-2026-07-24`; correct the T-06576 closure comment SHA.
4. Standard install + restart + node readback per existing deploy doctrine.

**File (6 records, all independent once main is integrated):**

| # | Task | Pri | Size | Notes |
| --- | --- | ---: | --- | --- |
| N1 | Unify hrcchat show/thread/trace selectors on one resolver | P2 | half-day | `caused_by` T-06579,T-06830. Matrix-as-tests, absent-collectiveSeq fixture. |
| N2 | Atomic dispatch idempotency + queued-run replay | P2 | medium | `caused_by` T-06592. Thread key into 5 insert sites; fix no-runtimeId replay throw; one crash-boundary test. |
| N3 | Federated turn timeout semantics: pending/unknown + terminal-ordering guard | P2 | medium | `caused_by` T-06809. Tiers 1–2 only; cross-node idempotency key noted in-spec as P3 follow-up gated on real federated-retry usage. |
| N4 | Bounded collective-history queries (indexed columns + migration + batch observations) | P2 | large | `caused_by` T-06802. The one real engineering project in the batch. |
| N5 | Small-fix batch: terminal-gap backfill, janitor detached visibility, lease-GC tick log, two stale help/preview strings | P3 | ~1 day | `caused_by` T-06090,T-06405,T-05337. One session, one record. |
| N6 | Actuator-split rework: privilege-separated approval + mechanical confinement (draft) | P3 | design-first | `caused_by` T-05439. Stays **draft** until actuator-split has a real consumer; Daedalus consult on pickup; removing the disable guard is this task's exit criterion. |

**Dropped entirely:** R1's fencing/inventory ceremony, R3/R4 as-specified (collapsed into N6 draft), R13, the red-proof artifact doctrine, the second reproduce-only review, the containment lift ritual.

Net: 13 proposed records → 6, one of which is a deliberately parked draft; the P0 emergency becomes a one-commit guard plus four one-command ops; and the plan's two technical errors (the pruned-runtime replay framing in F-2, the cancel-on-delivered no-op in F-3) are corrected in the specs that inherit them.

## Execution record (2026-07-25, Mable)

Ratified by Lance ("Go"). All do-now items executed and validated:

- **Dark-gate guard** landed as `1667074` on the overnight branch: every non-off actuator-split policy rejects `actuator-split-experimental-disabled` at both `prepareActuatorSplitIntent` and `assertActuatorSplitAdmission`; contract tests preserved via a test-only `allowExperimental` escape no server route sets; new default-dark unit test plus the live-route test now proving the production surface rejects before any runtime/run row exists. Suite 7/7.
- **Merge landed:** `cody/handoff-00291` (53 commits + guard) merged into `main` as `0cdc97b`, `bun.lock` reconciled via `bun install` (no drift), full `just verify` green on the merged tree including federation loopback (run outside the coding-agent harness envelope; the in-harness run fails at `env-up` by designed recursion guard). Pushed to `origin/main`.
- **Ops sweep:**
  - Smoke runtime `rt-13f43ad8-e326-47db-8bef-bddde675fe79` terminated after fresh readback confirmed it was the sole nonterminal actuator-authority holder; post-check count of authority-bearing nonterminal runtimes: 0.
  - Detached worktree `under-construction/hrc-runtime-T-06602` removed after re-verifying detached + clean + ancestor of `origin/main`.
  - `origin/cody/remaining-agent-spaces-backlog-2026-07-24` deleted after spot-checking end-state file equivalence on `main` (T-05562 re-land confirmed byte-identical); reversibility preserved via local tag `backup/remaining-agent-spaces-backlog-2026-07-24` at `43c9538`.
  - T-06576 closure SHA corrected by comment on the task.
- **Deploy + readback (svc):** `just install` → `release-20260725140727610-41036`, daemon restarted via launchd from a clean operator envelope (task-scoped lifecycle refusal observed working as designed — T-06007), `sourceCommit=0cdc97b`, `runningEqualsInstalled=true`, doctor green, federation peers lab/max3 healthy, 80 live runtimes post-restart.
- **Live guard smoke on the installed daemon:** a real `/v1/turns` POST with a high-risk policy rejected `actuator-split-experimental-disabled`; normal estate traffic unaffected. Actuator-split code shipped only in the overnight window, so svc was the only exposed node; lab/max3 pick up the guard with the next routine fleet install of merged main.
- **Records filed:** T-06970 (selectors, P2), T-06971 (dispatch idempotency, P2), T-06972 (federation timeout semantics, P2), T-06973 (bounded history, P2), T-06974 (small-fix batch, P3), T-06975 (actuator-split rework, draft/P3, holds the guard's exit criterion), all in `hrc-runtime/audit-remediation` with `caused_by` lineage.
