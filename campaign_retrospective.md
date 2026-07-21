# Federation v1 campaign retrospective

Date: 2026-07-21

Campaign root: `T-06597`

Status: completed. The implementation, ratification, and fresh behavioral E2E bundles
are closed; origin contains the landed changes; and the installed `svc`, `lab`, and
`max3` nodes are healthy and dependency-current. The fresh campaign corrected the
close-out audit's over-reliance on protocol evidence by completing a native
`wrkf-task-loop` room, exercising bilateral native messaging and cross-node task
claim refusals, and testing the installed credential-error path on every node.

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

The fresh behavioral close-out found a second class of failures in the test and
operator path rather than federation itself: a room coordinator ended its own turn
while the crank still needed parent authority; Bun loaded a stale cwd `.env.local`
token ahead of the intended token file; the crank's arm check could false-pass when
authenticated reads returned `undefined`; and the remote stdio bridge decoded an HTTP
401 body as a successful JSON-RPC result. Each mechanism was reproduced separately,
fixed at its owning boundary, installed, and rerun before the records were reconciled.

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
- `b691b7a` makes an explicit wrkqd token file authoritative over implicit dotenv
  residue; `82ea18d` preserves upstream HTTP/auth/transport failures as explicit,
  safe `WorkRpcError` envelopes while keeping genuine `WRKQ_NOT_FOUND` unchanged.
- agent-loop `2db3c75` makes `wrkf-crank` ignore cwd dotenv files and fails arm-check
  when the unified client's service reads are empty. Dependency pin `fad8c7a` carries
  `@wrkq/client@0.1.0-dev.20260721081252`.

### Close-out support changes

- HRC `dbc4895`, `ef3e5bb`, and `bab6269` project the canonical RPC locator and token
  file into claim-born runtimes without leaking or mutating an inline token.
- agent-spaces `165eec2`, `6aa6188`, and `db1c30f` expose task defaults through the
  compiled policy contract, keep tmux launch environment fencing intact, and align
  the globally installed harness broker with the published snapshot.
- Agents `8a7a22a` records the parent-turn lifetime rule for room coordinators.

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

## Fresh behavioral E2E closure

- Real taskboard task `T-06721` ran from a fresh `wrkq-simple-task@5` room through
  tester, test-review, implementer, observer verification, gate, landing, and engine
  completion. Instance `wfi_t06721_1784630452304299000` closed `done`; origin landed
  at `06fd911`; the gated taskboard `just verify` passed, including 81 Playwright
  tests. The coordinator runtime retained a live `activeRunId` for the whole room.
- A prior independent native room, `T-06723`, closed and landed `55285dd`; its older
  ambient-token workaround was not counted as the final credential proof.
- svc acquired a generation-1 claim on real open task `T-06725`; lab's simultaneous
  claim was refused with `already_claimed` naming the svc holder. svc released it and
  the task was restored to its original open state. Lab's later claim on completed
  `T-06721` was refused with `wrong_state: completed`.
- Lab sent `LAB_NATIVE_TO_SVC_1784638969110`; it arrived as this live svc agent turn,
  not merely a polled store row, and the reply was readable from lab. Independent
  svc→lab and lab→svc native DMs also had bilateral durable message IDs.
- The installed `wrkf-crank` on svc, max3, and lab now exits nonzero and explicitly
  reports `remote workrpc authentication failed (HTTP 401)` for a bad token. With
  each node's token file, `identity_room.services` passes; a real absent task remains
  the typed `WRKQ_NOT_FOUND` case.
- `agent-loop`, taskboard, and ACP consumed the new immutable client snapshot at
  `fad8c7a`, `209ddb2`, and `f2a7d99`. Their full verification gates passed; taskboard
  and ACP were installed and restarted healthy. max3 and lab report installed `wrkf`
  from `82ea18d`, `wrkf-crank` from `fad8c7a`, and fresh Verdaccio pins.

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

### Bun dotenv loading is an executable property

Bun loads `.env.local` from process cwd before application code. Deleting or
overwriting `process.env` inside a CLI is too late for consumers that already observed
the injected value. Operator CLIs that require explicit transport authority should
start with `bun --env-file=/dev/null`. Tests and one-off `bun -e` probes need the same
isolation unless dotenv behavior is the subject under test.

### Parent authority lives only for the parent turn

A background crank cannot outlive the coordinator's current agent turn and still
birth seats. A later wake is a different run and cannot retroactively supply the old
`activeRunId`. Start one background crank, block on that exact tool result within the
same turn until it reaches a typed halt, and only then return.

### Repository context can contaminate cross-repo verification

This cody runtime correctly carries `ASP_PROJECT=hrc-runtime`. Running ACP's full gate
from that shell made one refactor-helper test observe the wrong default project. The
repo-correct rerun with `ASP_PROJECT=agent-control-plane` passed, as did ACP's own
pre-push gate. Cross-repo campaign commands must set target context explicitly.

### Immutable snapshots must exist on every node registry

Pulling a lockfile is insufficient when max3 and svc/lab use distinct local Verdaccio
registries. The exact immutable HRC and wrkq client tarballs were mirrored before
installing new locks. Re-running a producer's publish-oriented `just install` on every
node would create timestamp churn; remote nodes can build/install the same pushed
source while consuming the already-published immutable snapshot.

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
- `T-06730` was cancelled as an erroneous omnibus. Its child-birth diagnosis was the
  parent-turn lifetime error closed by `T-06735`; its transport pieces were split and
  closed by `T-06729` through `T-06734`; cwd dotenv/arm-check behavior was closed by
  `T-06736`; and HTTP-401 preservation was closed by `T-06737`. The distinct wrkf CLI
  transport mismatch remains the pre-existing `T-06190`, not a duplicate here.
- max3's wrkq branch carried two unpushed architecture-record commits (`ba044db`,
  `d5d98b0`) whose content had already landed upstream in newer form through
  `10e75fe`/`aee6b86`. They were skipped during the evidence-backed rebase rather
  than reintroducing older provenance. Their hashes/reflog remain recoverable; the
  unrelated untracked backup file was left untouched.
- `H-00274` remains pending in `agent:mable`'s handoff queue. Cody consumed it at
  Lance's direction but did not impersonate mable to acknowledge a foreign-scope
  handoff.

## Remaining work

There is no Federation v1 campaign blocker or open close-out defect. The fresh room,
native messaging, claim refusal, installed auth diagnostics, fleet dependency sync,
and cleanup are complete. The original ratification's same-task takeover,
post-rebase concurrent landing, birth/origin, rebind, and gateway evidence remain the
durable source for those expensive matrices; the fresh pass did not pretend to rerun
them when it did not.

### Parked release/promotion work

The svc pinned-artifact release manifest, frozen lock closure, promotion, and rollback
exercise remain explicitly parked. They require a new operator ruling before work.
The behavioral E2E campaign treated them as excluded rather than silently counting
them as passed or failed.

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
8. Run Bun operator probes with dotenv disabled unless dotenv behavior itself is the
   subject under test.

## Primary references

- Federation specification: `~/praesidium/docs/systems/federation.md`
- Campaign root and ratification evidence: `T-06597`, `T-06628`, `T-06629`,
  `T-06630`, `T-06635`
- Handoff audit source: `H-00274`
- Rebind implementation and runbook: `T-06633`
- Native product-claim validation: `T-06622`
- Claim/landing implementation: `T-06623`, `T-06625`, `T-06626`
- Fresh behavioral closure and split fixes: `T-06721`, `T-06723`, `T-06726`,
  `T-06729` through `T-06737`
- agent-loop live claim/landing harness:
  `loops/wrkf-task-loop/tests/live-claim-landing-harness.ts`
- agent-loop live-runtime runbook: `~/praesidium/agent-loop/docs/E2E_RUNBOOK.md`
