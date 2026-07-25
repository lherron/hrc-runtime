# Proposed remediation plan — overnight HRC defect-fix audit

Date: 2026-07-25
Status: **proposed; not ratified; no execution authority implied**
Inputs:

- [Combined audit and comparison](2026-07-25-overnight-defect-fix-audit.md)
- [Clod independent audit and correction](2026-07-25-overnight-defect-fix-audit-clod.md)
- Clod plan verdict: **confirm with amendments**, HRC DM 1385

## Current decision

Both reviewers converge on an overall **C** and T-05439 **F**. The remediation shape is:

1. Contain the unsafe actuator path immediately.
2. Reconcile the overnight branch with `origin/main`.
3. Repair critical/high findings on the integrated baseline.
4. Repair medium findings and observability gaps.
5. Run adversarial, fault-injection, merged-tree, installed, and fleet acceptance before lifting containment.

This document authorizes nothing. In particular, it does not authorize:

- creating or changing wrkq records;
- editing code or runtime configuration;
- terminating or fencing a runtime;
- removing a worktree;
- deleting a local or remote branch;
- installing, restarting, or deploying HRC.

## Read-only blast-radius evidence

Clod measured the current estate before confirming the plan:

- Exactly one nonterminal runtime has persisted `authority.actuatorSplit`: `rt-13f43ad8-e326-47db-8bef-bddde675fe79`, scope `cody@hrc-runtime:smoke-t05439-actuator`. It is a disposable T-05439 validation runtime.
- No caller outside hrc-runtime sets `actuatorSplit` in the searched Praesidium source/config trees.

The high-risk path therefore has no known production consumer. This is a pre-adoption containment window, but the evidence does not itself authorize fencing the smoke runtime or changing the server.

## Phase 0 — P0 containment

### Server guard

Temporarily reject every non-off actuator-split policy at the common policy chokepoint in `packages/hrc-server/src/actuator-split.ts`. The rejection must cover every route and every downstream reader, including fresh admission, preparation, interactive/headless broker paths, runtime I/O, and reuse.

Requirements:

- Hard rejection, not an environment-controlled kill switch.
- Rejection before launch or input delivery.
- Ordinary no-policy and `mode: "off"` behavior remains unchanged.
- Existing matching runtime reuse cannot bypass rejection.
- The guard remains until both T-05439 repair tracks are complete.
- The guard is lifted only by the final T-05439 repair commit, never by a standalone revert or environment change.

### Existing authority-bearing runtimes

Before deployment, enumerate every nonterminal runtime with persisted non-off actuator-split authority. With explicit execution authority, terminate or mechanically fence each one and record before/after counts. Current evidence predicts one disposable smoke runtime, but execution must use fresh readback rather than the recorded ID alone.

### Immediate operator unblock

The detached worktree at:

`/Users/lherron/praesidium/under-construction/hrc-runtime-T-06602`

currently causes placement to fail closed for `@hrc-runtime:T-06602`. Clod verified it read-only as detached, clean, merged, and associated with a completed task. Removing it is recommended as an operator unblock, separate from the janitor code repair. It still requires explicit execution authority and a fresh pre-removal safety check.

### Containment validation

- Red proof at the audited pre-fix commit: a caller-authored “manual operator” approval is admitted.
- Green proof: the same request is rejected before launch.
- Live installed proof that low-risk turns still work.
- Before/after authority-bearing runtime inventory.
- Exact release/source readback.

## Phase 1 — Integrated main baseline

The P0 guard may land as a deliberate minimal hotfix on the current production line. All subsequent work must move to an integrated `main` baseline:

1. Merge/reconcile `cody/handoff-00291` with `origin/main`.
2. Resolve `bun.lock` through the normal dependency workflow.
3. Regenerate `.public-surface-baseline.json` from the merged tree.
4. Diff the regenerated public-surface baseline against both parents. A baseline that merely auto-merges proves only self-consistency.
5. Explicitly re-run the high-risk refusal on the merged tree; a green general suite is not proof that the containment survived the merge.
6. Run the complete repository bar.
7. Land on `main`.
8. Require every later remediation branch/session to start from that integrated `main`.

Deleting `origin/cody/remaining-agent-spaces-backlog-2026-07-24` is recommended after integration because Clod found it content-duplicative. That is separate destructive housekeeping and requires explicit authority.

## Phase 2 — Critical and high repairs

### T-05439 track A — approval authenticity

Replace caller-mintable approval files with authoritative approval resolution.

The contract must:

- resolve wrkf/operator approval from an authoritative store or signed issuer;
- bind approving principal, artifact identity/hash, target paths, base revision/tree, task/workflow correlation, and approval time;
- reject self-authored `approvedBy`/`source` strings as authority;
- prove required credential absence or scoping from trusted compile/profile facts;
- remain fail closed across runtime reuse and every dispatch route.

Required adversarial cases:

- caller authors both artifact and approval;
- caller claims `approvedBy: human:lance`;
- approval correlation references a nonexistent or mismatched wrkf action;
- artifact, target set, or base differs from the authoritative approval;
- replay/reuse attempts to downgrade or replace persisted authority.

### T-05439 track B — mechanical write containment

This is a new architectural surface and requires a Daedalus consult before implementation.

Choose and specify one enforceable model:

- HRC applies the approved artifact itself in a bounded operation; or
- the actuator process is mechanically confined to approved target paths.

The design must include:

- mutation-time artifact and base revalidation;
- elimination of mutable-path time-of-check/time-of-use exposure;
- atomic or safely fenced application;
- rejection of writes outside approved targets;
- postcondition/diff verification;
- credential boundary;
- crash and partial-apply recovery behavior.

Track B follows track A. The temporary P0 rejection remains until both tracks are delivered. The commit completing track B must also be the commit that removes the temporary rejection, with the complete combined adversarial suite green.

### T-06592 — atomic dispatch idempotency

- Reserve `(hostSessionId, idempotencyKey, requestHash, runId)` transactionally before dispatch.
- Enforce durable uniqueness.
- Make terminal replay independent of a retained runtime row.
- Define recovery for a reserved request that has not yet submitted.
- Inject crashes between reservation, run creation, broker submission, acceptance persistence, and response.
- Prove one caller key produces one run/turn across daemon restart.

### T-06809 — federated semantic-turn timeout and ordering

- A timeout returns pending/unknown while durable delivery remains eligible.
- Use a durable semantic-turn idempotency identity across retries.
- Report failure only after authoritative cancellation/fencing or terminal delivery failure.
- Enforce started-before-terminal projection.
- Prove a peer that sleeps beyond the timeout and later wakes executes exactly once.
- Prove a retry after an uncertain response does not create a second turn.

### T-06579/T-06830 — shared message-selector contract

Use one resolver across `show`, `thread`, and `trace`.

Define every syntax explicitly:

- `@<collectiveSeq>`;
- `#<messageSeq>`;
- `msg:<uuid>`;
- bare UUID;
- bare numeric selector;
- existing `seq:` syntax, either as a documented alias or an actionable rejection.

Acceptance is the complete selector/command matrix:

`{bare collective, seq:, bare message, #, @, bare UUID, msg:UUID} × {show, thread, trace}`

Every cell must have defined behavior. Include fixtures where `collectiveSeq` is absent. Every identifier a command prints must be accepted by that same command.

## Phase 3 — Medium repairs

### T-06802 — bounded collective-history queries

- Push filter, ordering, cursor, and limit work into indexed SQL.
- Batch-load observations; prohibit N+1 observation reads.
- Ensure `limit` bounds rows decoded and memory retained.
- Add query-plan/query-count assertions and a large-corpus performance regression.
- Preserve collective ordering, parent-before-child semantics, and cursor compatibility.

### T-06090 — terminal broker-event gap recovery

- A terminal event that reveals a gap must trigger an immediate final backfill.
- Do not cancel recoverable missing events before replay.
- Define ordering between recovered events and terminal projection.
- Cover `invocation.exited`, `invocation.failed`, and `invocation.disposed`.
- Preserve bounded retries and explicit unrecoverable evidence.

### T-06405/T-06369 — detached-worktree visibility

- Report detached task-associated worktrees explicitly instead of silently skipping them.
- Preserve the placement tripwire.
- Optionally support guarded detached removal only behind explicit confirmation.
- Reuse completed-task, clean-tree, merged-ancestry, canonical-root, and repeated live-runtime occupancy checks.
- Keep operator cleanup separate from code acceptance.

### T-05337 — recurring lease-GC liveness

Expose at least:

- last attempted run time;
- last successful run time;
- scanned/changed/error counts;
- last error, if any.

A safe periodic summary or status projection must distinguish a healthy no-op timer from a dead timer without recreating prior stderr/log-volume defects.

## Phase 4 — Low-risk cleanup

- Correct T-06576's final comment to the real commit `7b3afbd84d709b45a6d43755ea9136c8efcd7779`.
- Update `hrc server tmux kill --help` to include claimed orphan handling.
- Add placement output to `hrc resume --dry-run`.
- Treat migration-capable read-only database access as a separate repo-wide concern; do not patch only the janitor.

## Evidence and acceptance doctrine

### Red-before-green

Each critical/high finding must have a durable red proof at the pre-fix commit:

| Finding | Required red evidence |
| --- | --- |
| F-1 / T-05439 | Caller-authored approval admitted and write lane not mechanically confined. |
| H1 / selectors | Exact installed selector matrix showing mutually inconsistent resolution. |
| F-2 / T-06592 | Crash at the key-persistence boundary permits duplicate durable dispatch. |
| F-3 / T-06809 | Timed-out origin reports failure while the durable request later executes, or terminal projects before started. |

Each proof records the exact source commit, command/test, observed failure, and why the test exercises the contract rather than implementation shape.

Clod independently reproduced F-1 and H1. Clod confirmed the task boundaries and acceptance shape for F-2 through F-5 but did not reproduce their technical mechanisms. If independent second-eye confirmation of those prescriptions is required, schedule a separate reproduce-only review before implementation.

### Per-task bar

Every implementation task requires:

- reproduction first;
- focused red/green regression;
- ordered build before typecheck;
- lint, boundaries, manifests, public surface, and relevant package suites;
- full `just verify`;
- exact commit/push evidence;
- installed/manual smoke when the changed surface is installed or runtime-facing.

### Final integrated bar

- Full bar on the merged `main` tree.
- P0 refusal still proven before containment is lifted.
- Complete T-05439 adversarial suite.
- Crash-injected idempotency proof.
- Sleeping-peer exactly-once proof.
- Complete selector matrix and printed-identifier round trips.
- Large-corpus bounded history proof.
- Terminal-gap backfill proof.
- No open critical/high audit findings.
- Release commit reachable from `origin/main`.

### Fleet rollout

Deploy in order:

1. lab;
2. svc;
3. max3.

At each node:

- verify zero unsafe busy-runtime conflicts before restart;
- install and restart through node-appropriate supervision;
- confirm node identity;
- confirm exact source/release tuple and `runningEqualsInstalled=true`;
- run the node-relevant smoke;
- stop the rollout on any mismatch.

The temporary actuator rejection is lifted only with the final T-05439 repair, using the same lab → svc → max3 readback.

## Proposed wrkq task breakdown if ratified

No tasks have been created. If Lance ratifies this plan, create the following records with complete specifications, acceptance criteria, validation commands, and `caused_by` lineage.

| Ref | Proposed task | Priority | Project/state | Lineage | Depends on | Scope |
| --- | --- | ---: | --- | --- | --- | --- |
| R1 | Hard-disable unsafe actuator split and fence existing authority-bearing runtimes | P0 | hrc-runtime/open | T-05439 | none | Common-chokepoint rejection, current-runtime inventory/fence, install and low-risk proof. |
| R2 | Integrate overnight HRC line onto main with containment preserved | P0 | hrc-runtime/open | audit batch | R1 | Merge main, lock reconciliation, two-parent public-surface review, explicit refusal proof, full bar, land main. |
| R3 | Replace caller-mintable actuator approval with authoritative approval resolution | P0 | hrc-runtime/open | T-05439 | R2 | Approval authenticity, correlation binding, credential proof, adversarial forgery tests. |
| R4 | Design and implement mechanically confined actuator application | P0 | hrc-runtime/draft until Daedalus approval | T-05439 | R3 | HRC-owned apply or confinement, TOCTOU/base fencing, postcondition proof; remove P0 guard only here. |
| R5 | Make dispatch idempotency atomic across daemon crashes | P1 | hrc-runtime/open | T-06592 | R2 | Transactional reservation, unique key, durable replay, crash injection. |
| R6 | Fence federated semantic-turn timeout and lifecycle ordering | P1 | hrc-runtime/open | T-06809 | R2 | Pending/unknown timeout, cancellation fence, durable idempotency, exactly-once sleeping-peer proof. |
| R7 | Unify hrcchat show/thread/trace message selectors | P1 | hrc-runtime/open | T-06579, T-06830 | R2 | Shared resolver, explicit grammar, absent-collective fixture, exhaustive matrix. |
| R8 | Bound collective-history filtering, pagination, and observation loading | P2 | hrc-runtime/open | T-06802 | R2 | Indexed SQL, bounded decode/memory, no N+1, large corpus. |
| R9 | Recover broker-event gaps revealed by terminal events | P2 | hrc-runtime/open | T-06090 | R2 | Immediate final replay, terminal ordering, exited/failed/disposed regressions. |
| R10 | Report and safely handle detached completed-task worktrees | P2 | hrc-runtime/open | T-06405, T-06369 | R2 | Explicit visibility and optional guarded pruning; no silent skip. |
| R11 | Expose recurring broker lease-GC liveness | P3 | hrc-runtime/open | T-05337 | R2 | Last-run/status facts and no-op/error observability. |
| R12 | Align stale HRC help and resume placement preview | P3 | hrc-runtime/open | T-05337, T-06367 | R2 | `tmux kill` help and `resume --dry-run` placement output. |
| R13 | Audit-remediation integrated release acceptance and fleet rollout | P1 release gate | hrc-runtime/draft until dependencies complete | audit batch | R4–R12 | Merged-main bar, installed adversarial/fault proofs, lab→svc→max3 rollout and exact readback. |

### Task creation rules after ratification

- One implementation task per scoped agent session.
- R4 remains draft until the required Daedalus design approval is incorporated into its specification.
- R5–R12 may proceed independently from the integrated R2 baseline where their files do not conflict.
- R13 is a release/acceptance record, not a substitute for per-task validation.
- Do not close R1 when the temporary guard lands; retain it through R4 or explicitly link its final disposition to R4's guard removal.
- Use `caused_by` exactly as listed; do not rewrite original audit records to disguise follow-up work as the original closure.

## Evidence-backed recommendations that remain unauthorized

These actions are intentionally outside the proposed task mutations until separately approved:

1. Fence/terminate the currently observed actuator smoke runtime after fresh readback.
2. Remove the stale detached T-06602 worktree after repeating clean/merged/completed/unoccupied checks.
3. Delete the duplicative remote backlog branch after the integrated main landing is verified.
4. Correct the T-06576 comment SHA in place.

Read-only evidence supports each action. Evidence of safety is not execution authority.
