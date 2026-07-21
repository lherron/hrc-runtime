# Federation v1 campaign retrospective

Date: 2026-07-21

Campaign root: `T-06597`

Status at retrospective cut: the implementation and original ratification bundles are
closed, origin contains the landed changes, and the installed `svc`, `lab`, and `max3`
nodes are healthy. A fresh behavioral E2E campaign follows this retrospective because
the close-out audit over-weighted protocol-level and recorded evidence and did not
personally exercise every operator workflow end to end.

## Narrative

Federation v1 began as an attempt to make one Praesidium collective operate across
three logical nodes without forking agent identity or inventing a distributed control
plane. The architecture stayed deliberately narrow:

- `svc` owns always-on ingress, canonical shared wrkq data, the binding registry, and
  durable services.
- `lab` is the development node, isolated from the always-on estate even though it is
  currently co-hosted with `svc`.
- `max3` is the workstation node and is expected to sleep or disappear.
- Scope identity remains node-free. Placement epochs, birth provenance, wrkq claim
  generations, and accepted-request records provide the fences.

The campaign crossed several repositories: HRC supplied placement, federation,
outbox, observability, and rebind behavior; wrkq supplied canonical task claims and
generation fencing; agent-loop supplied claim-aware wrkf cranking and verified
landing; ACP supplied the operator/gateway-facing liveness surfaces. The important
achievement is not that nodes can exchange an HTTP request. It is that the collective
can route conversations, establish exactly one scope, run work on multiple nodes,
integrate concurrent changes, and change authority without permitting two writers.

The final stretch started from handoff `H-00274`, which described a restart gate, two
stranded ACP commits, and a large field of purported open defects. That handoff was
useful but stale as a status report. Several records were already fixed, duplicated,
or contradicted by later operator rulings. The close-out work therefore began with an
evidence audit rather than treating every filed defect as current truth.

The campaign then moved through the ratification bundles in specification order:

1. Birth and cutover proved one globally linearized birth class and one home for
   policy-born, claim-born, and child-born scopes.
2. Verified-origin testing bound child authority to the current parent run and proved
   logical-node identity at the canonical wrkqd.
3. Native federation messaging replaced the temporary backchannel for the product
   path and proved durable cross-node request/response behavior.
4. Claim and landing work closed the path from server-derived task ownership through
   crank admission, post-rebase verification, pre-push fencing, and settlement.
5. Rebind introduced the sole authority-changing operation for an established scope
   and made every partial state fail closed.

Ratification found real defects. Those were forward-fixed rather than waived. The
most important were an operator projection that falsely displayed authority during a
rebind gap and a message lookup path that could not find an older message by ID after
the store exceeded its scan window. The resulting code and the live reruns were more
valuable than a clean first pass would have been.

## What landed

### HRC

- `7c2e560` — fenced federation rebind: REVOKE, registry CAS, ACTIVATE,
  serialization against summon paths, typed CLI/SDK/server surfaces, structured logs,
  and the operator runbook.
- `1347649` — correct authority projection for REVOKE→CAS and CAS→ACTIVATE gaps,
  including visible `rebind-revoked` and `rebind-activation-pending` states.
- `2eecb49` — exact server-side chat message lookup by `messageId`.
- Earlier federation/outbox/claim-birth changes, including `c46a410`, `77bd578`,
  `1592d02`, `bfee310`, and `040e594`, are ancestors of `origin/main`.

### ACP

- `35b9d66` and companion `7dddda9` landed the H-00274 ACP compile/runtime closure.
- The stranded max3 liveness change `3edc414` was rebased and landed as
  `558c1f3431c4f5d8a34c888e8f40c19c377bf77a`.

### wrkq and agent-loop

- wrkq gained authenticated logical-node claims, release/takeover, monotonic claim
  generations, holder-guarded completion, and server-derived `claimed_node`.
- agent-loop gained claim validation before Git and at every crank/action admission,
  the bounded fetch→rebase→re-verify→validate-claim→push landing path, and terminal
  settlement fencing.
- The repeatable live claim/landing harness landed in agent-loop as `a8ee932`.

## Live evidence already obtained

The original campaign evidence includes:

- policy/claim/child birth races with one winning class and home;
- invalid, missing, spoofed, and stale origin credentials refusing as designed;
- native svc/lab/max3 peer health and cross-node request/response delivery;
- canonical wrkqd deriving `claimed_node` from per-node credentials despite spoofed
  caller hints;
- a same-task max3→lab takeover where max3 was fenced at pre-push and settlement and
  lab alone landed;
- concurrent distinct-task landings where the second node rebased and reran the full
  verification gate after the remote advanced;
- a live max3→lab rebind race, injected CAS mismatch, visible fail-closed gaps,
  idempotent convergence, stale-epoch rejection, and late completion of a request
  accepted before authority moved;
- final cleanup to `max3@epoch 3`, with only terminated historical runtimes, no
  temporary profile pins, and no deployment worktrees.

The final repository audit reran `just verify`: boundary, manifest, CLI/public-surface,
suppression, lint, typecheck, and all package tests passed. In particular, hrc-cli
reported 497 passing / 0 failing tests and hrcchat-cli reported 162 passing / 0
failing tests. The audit also confirmed that HRC and ACP local heads matched
`origin/main` and that all three installed HRC daemons reported healthy peers.

## Gotchas and lessons

### Protocol proof is not workflow proof

The largest close-out mistake was treating a successful rebind/claim-fencing matrix as
equivalent to the human-visible workflow: claim a task, perform the test/fix/verify
cycle, land it, and then attempt the same claim from another node. The mechanisms
overlap, but the behavioral claim is broader. The new E2E campaign must run the actual
`wrkf-task-loop` room and grade task, workflow, Git, HRC, and node readback together.

### A logical node is not a machine

`svc` and `lab` can share a host while retaining distinct users, roots, ports, tokens,
databases, and install prefixes. Tests must assert logical `nodeId`, not infer identity
from hostname or IP address. IP-derived wrkq claim identity would have been wrong by
construction.

### Native federation and backchannel delivery are different facts

Each node has its own message store. The temporary relay prefixes messages with
`[backchannel from <node>]`; those messages never prove native federation. Native E2E
evidence needs the federation ingress metadata, bilateral message IDs, delivery state,
and authoritative-node readback. Duplicate relay delivery is expected under its
at-least-once contract and must not be confused with a federation dedupe defect.

### Placement policy is not authority

Editing a pin creates intent and potentially visible skew; it never moves an
established scope. The registry and active local ledger row are authority. Rebind is
the only operation that changes it. Tests that edit a pin and then observe a lab start
must expect refusal until the fenced transition completes.

### Fail-closed behavior must also be visible

The summon gates correctly refused during the first live rebind gap, but `target
locate` initially projected the old registry row as active local authority. That was
operationally dangerous even though no second runtime could start. Control-plane
diagnostics are part of the safety contract, not decoration.

### Placement epochs and claim generations fence different things

Placement epochs fence scope authority and new request acceptance. Claim generations
fence task-crank ownership, pushes, and task settlement. Accepted-request records let
a response finish after placement changes. Mixing these counters produces attractive
but incorrect fixes.

### Post-rebase verification is load-bearing

A clean textual rebase is not proof that two independently valid changes compose.
Every landing retry must rerun the project verification gate, recheck the resulting
HEAD, validate the current claim, and only then push. A superseded room may comment,
but it must not land or complete.

### One room per checkout remains dispatcher discipline

The loop has no universal mechanical guard against two rooms mutating one checkout.
Cross-node parallelism is valid because nodes use separate checkouts. Within one
checkout, rooms are serialized. A second dispatch after a timeout is particularly
dangerous; inspect live runtimes before retrying.

### Build, publish, install, and restart are separate states

Source at HEAD, a Verdaccio snapshot, linked CLI code, and the launchd service can all
name different bits. Every runtime-affecting validation must record the source commit,
installed release/snapshot, daemon binary/package path, restart, and post-restart peer
health. A successful `just install` is not itself proof that the daemon is running it.

### Exact readback matters at campaign scale

`hrcchat show <message-id>` used a bounded row scan and failed once the live store was
large. A ratification proof that cannot retrieve its own durable message is not
durable evidence. Exact identifiers should be queried exactly at the storage/API seam.

### Task records are hypotheses until reconciled with code and origin

H-00274 named work that later landed, a defect duplicated by `T-06001`, and work whose
scope had been explicitly parked. Closing the campaign required comparing task state,
comments, origin ancestry, installed behavior, and operator rulings. Filing more tasks
without this reconciliation would have continued the defect spiral.

### Restarts need node-aware supervision

Before a force restart, inspect busy runtimes. Waiting for a drain that includes the
current supervising runtime deadlocks; force-restarting over another agent's work is
also wrong. One restart immediately after the final install, followed by daemon,
peer, and runtime-reattachment checks, is the reliable cycle.

## Erroneous and intentionally retired records

- `T-06679` was archived as a duplicate; canonical `T-06001` is completed.
- `T-06634` was archived because its artifact-pinning/release-manifest/promotion
  premise conflicts with the explicit operator ruling recorded on `T-06601`. It is
  not an unfinished federation implementation task.
- An apparent post-parent-completion birth defect was cancelled after run-ledger
  review showed that background shell work occurred after the agent run had already
  ended; zombie refusal was correct.
- `H-00274` remains pending in `agent:mable`'s handoff queue. Cody consumed it at
  Lance's direction but did not impersonate mable to acknowledge a foreign-scope
  handoff.

## Remaining work

### Fresh behavioral E2E campaign

The immediate next work is a new evidence run using five real taskboard refactor
tasks. It must include:

- at least one complete `wrkq-simple-task@5` room on node A through test, fix,
  verification, landing, and settlement;
- a normal claim attempt from node B while A is active (`already_claimed`) and after
  completion (`wrong_state`), with no second room minted;
- an explicit cross-node takeover with the predecessor fenced before push and at
  settlement;
- two distinct taskboard tasks landing concurrently from separate max3/lab checkouts,
  forcing a remote-head advance and mandatory rebase/re-verification;
- native conversation and outage-recovery checks that do not use the backchannel;
- rerun of the birth/origin and rebind authority invariants on disposable scopes;
- gateway ingress from svc to a remote-homed agent;
- durable evidence and cleanup for every task, scope, runtime, claim, worktree, and
  temporary config edit.

### Parked release/promotion work

The svc pinned-artifact release manifest, frozen lock closure, promotion, and rollback
exercise remain explicitly parked. They require a new operator ruling before work.
The behavioral E2E campaign must report them as excluded, not silently count them as
passed or failed.

### Longer-term deferred items

Live relocation without teardown, artifact/continuation migration, claim-affinity
routing, warm estate manifests, offline wrkq mutation, continuous presence gossip,
emergency failover lanes, cross-node interactive attach, and cross-node event
streaming remain outside Federation v1.

## Forward operating rules

1. Reproduce before fixing, and preserve the first failing artifact.
2. Grade from durable task/workflow/message/Git readback, never coordinator prose or
   a command's exit code alone.
3. Keep detailed federation and landing logs during the campaign.
4. File a defect only after separating product failure, test harness failure,
   environment failure, and correct refusal.
5. Forward-fix a confirmed defect, install it on every affected node, and rerun the
   failed behavior plus its neighboring fence cases.
6. Keep one room per checkout; use max3 and lab for real concurrency.
7. Do not call the campaign complete until all disposable state is removed and the
   cleanup itself has durable readback.

## Primary references

- Federation specification: `~/praesidium/docs/systems/federation.md`
- Campaign root and ratification evidence: `T-06597`, `T-06628`, `T-06629`,
  `T-06630`, `T-06635`
- Handoff audit source: `H-00274`
- Rebind implementation and runbook: `T-06633`
- Native product-claim validation: `T-06622`
- Claim/landing implementation: `T-06623`, `T-06625`, `T-06626`
- agent-loop live claim/landing harness:
  `loops/wrkf-task-loop/tests/live-claim-landing-harness.ts`
- agent-loop live-runtime runbook: `~/praesidium/agent-loop/docs/E2E_RUNBOOK.md`
