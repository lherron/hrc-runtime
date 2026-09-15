# Host participant lifecycle — HRC architecture contract

**Revision 2 — PROPOSED, pending Daedalus review.** Not approved, not
implementable, and not an acceptance record. Rev 2 resolves the navigator
findings in EN-12258 and EN-12261 and re-baselines the consumed foundations onto
`5f1a302d`.

| Field | Value |
| --- | --- |
| Contract id | `hrc-runtime.host-participant-lifecycle` |
| Status | proposed (rev 2) |
| Author | Clod, under T-08501, for `astra@hrc-runtime:primary` |
| HRC source baseline | `e5ef5781c5ad531279afa6f5632beb32e16c653d` for §2's absence findings; re-checked against `5f1a302d` (T-08349 closure items 2 and 3 landed), which this revision consumes rather than restates |
| Arris proposal baseline | `9f5e700cc46cbc9c87bf8bb78ce3acd967f82030` (`architecture/proposals/arris-hrc-federation.md`) |
| Author readback consumed | `EN-12217` in `R-00093` |
| Foundation closure coordinated with | `var/wrkq-artifacts/T-08349/CLOSURE-2026-09-15.md` rev 1 (same baseline) |
| Amends | `architecture/records/invariants/hrc-runtime.participant-session-lifecycle.yaml` |
| Leaves unchanged | legacy EPR (`POST /v1/registrations`), every existing `address: permanent-keyed` / `continuity: key-scoped` participant class |

This contract is **product-neutral**. It names no application, no vendor and no
harness. Arris is the first *configured consumer* of the policies defined here;
nothing in HRC may branch on its identity. Every behavior below is selected by a
declared class policy value, and any application that declares the same policy
gets the same behavior.

---

## 0. Executive summary

HRC already has a generic participant registration path
(`POST /v1/participants/register`) that admits a participant through a trusted
ASP adapter, freezes an immutable dispatch, establishes a broker invocation and
activates one runtime. That path binds a participant to a *machine-minted*
address and deliberately keeps one session and one generation forever.

This contract adds the missing concept: a participant whose HRC address denotes
**one application process**, where the application process can die and be
replaced while the address survives. That requires four things the current path
does not have:

1. an address the operator *selects* rather than one HRC mints;
2. a **host incarnation** identity, distinct from the participant key, the
   broker instance and the controller;
3. a **succession** transition that retires a prior incarnation's write
   authority and mints the next session generation atomically; and
4. a **host lifecycle owner** that is declared policy, not inferred from who
   spawned the broker.

It also fixes both launch modes now — externally launched (participant-served
bridge) and HRC-managed — so the external MVP cannot hard-code a layout the
managed mode must tear out.

And it specifies the **minimum missing producer seam** (§3.6). At the locked ASP
tuple there is no callable way to learn that a writer's write path is closed,
that a writer is dead, or that its prior evidence was recovered — and those are
three different facts. Without them **no** successor exit is implementable in
either the existing key-scoped policy or the new one, so §3.6 is the gating
dependency, filed as T-08510.

**Control surface is queue and steer only.** No interrupt, no preempt, no raw
thread API, no new env-gated flag, and no new mail transport.

---

## 1. Terminology

These terms are load-bearing. Section 4 depends on holding them apart.

| Term | Definition | Issued by | Lifetime |
| --- | --- | --- | --- |
| **Host participant** | A participant whose HRC address denotes one application process. | — | logical |
| **Participant key** | The stable logical identity of the participant across every process lifetime. Today's `participantKey`. | adapter (`admit`) | permanent |
| **Host** | The application process HRC addresses. It owns the application, its embedded runtime and their process lifecycle. | OS | one process |
| **Host incarnation** | One actual lifetime of that application process, named by `hostIncarnationId`. | host, validated by the adapter | one process lifetime |
| **Bridge** | The participant-owned or HRC-owned broker process/endpoint serving `harness-broker/0.2` for the host. Transport infrastructure. | — | one broker process |
| **Broker instance** | Today's `brokerInstanceId` from the install acknowledgement. Identifies one bridge process. | broker | one bridge process |
| **Controller** | HRC's attaching client, today `hrc-server:<pid>`, fenced by `attachEpoch`. | HRC | one daemon attachment |
| **Helper** | Any other process the host owns or spawns — a TUI, a tool child, an internal subagent worker. | host | arbitrary |
| **Host lifecycle owner** | Who may start, stop or replace the *application* process: `external` or `hrc-managed`. | declared class policy | class |
| **Broker join** | Who spawns the *bridge*: `hrc-hosted` or `participant-served`. Today's `join`. | declared class policy | class |

**A helper is never a host incarnation, never a participant and never an
address.** A helper PID change is not a host change; a host PID change is not a
helper change.

**Broker ownership is not host ownership.** `join: 'hrc-hosted'` means HRC
spawned a broker process. It conveys no authority over the application. This is
the single most important separation in this contract and it is enforced by
making `hostLifecycleOwner` an independent declared field (§3.2).

---

## 2. What the source actually has, and what is actually absent

Every claim in this section was read at `e5ef5781` and cites the line that
establishes it. `EN-12228` independently confirms the T-08349 findings remain
open and that its prior writer is terminated.

### 2.1 Present and reusable — do not rebuild

| Mechanism | Source | Reused as |
| --- | --- | --- |
| Adapter `admit` / `prepare` seam and its two validators | `spaces-runtime-contracts/dist/participant-adapter.d.ts` (`ParticipantAdapterAdmissionRequest/Result`, `ParticipantAdapterPreparationRequest/Result`, `validateParticipantAdapterAdmission`, `validateParticipantAdapterPreparation`) | unchanged; §3.3 extends the admission *result*, not the seam's shape |
| Class-policy config and its exact-key validator | `packages/hrc-server/src/registration-classes-config.ts:29-40, 78-160` | amended additively in §3.2 |
| Registration endpoint, request parsing, unsupported-field refusal | `packages/hrc-server/src/participant-registration-handlers.ts:124-170` | amended additively in §3.1 |
| Roster mutex serialization of registration | `participant-registration-handlers.ts:217` (`roster:<agent>:<project>`) | reused verbatim as the succession mutex (§5) |
| Three freeze boundaries: prepared profile → hosting intent → realized hosting → frozen dispatch | `participant-registration-handlers.ts:355-371`; `participant-hosting-intent.ts:86-197`; `participant-realization.ts:37-47`; attempt columns `participant-registration-repository.ts:76-100` | unchanged |
| `installIdentity` → `hello` → `ensureInvocation` receipt fencing, at-most-once driver start | `participant-establishment.ts:64-99, 218-310` | unchanged |
| Staged attach + activation compare-and-set | `participant-establishment.ts:503-577`, `participant-registration-repository.ts:378-407` (`confirmInitialActivation`, `confirmReattachment`) | unchanged; §6 adds a precondition, not a new CAS |
| External-ownership fence (`lifecycleOwner: 'external'`) read across sweep, startup reconcile, dispose, interrupt/terminate, rotation, GC, controller | `external-participant-lifecycle.ts:16-18` plus ~30 call sites | unchanged; §3.2 changes only *how the value is chosen* |
| Operator eviction without process signals | `external-participant-lifecycle.ts:44-120` | unchanged; it is the only external-mode stop (§8.4) |
| Submission doors and their driver mapping | `broker/submission-doors.ts:10-57` (`steer`→`controller.steer`, `enqueue`→`controller.enqueue`) | unchanged; §7 adds no HRC surface |
| Declared-capability admission gate | `broker/capabilities.ts:23-59` (`BrokerAdmissionClass`, `brokerCapabilitiesSupportAdmissionClass`) | unchanged; §7 constrains what the driver may advertise |
| Continuation invalidation barriers (4 kinds) | `session-resume-continuation.ts:63-102` (`detectResumeInvalidationBarrier`) | consumed by §9's eligibility predicate |
| Continuation reuse suppression column | `hrc-store-sqlite/src/repositories/session-repositories.ts:435-465` (`setContinuationReuseDisabled`, `isContinuationReuseDisabled`) | consumed by §9 |
| Status-neutral explicit resume selector | `session-resume-continuation.ts:300-334` (`selectResumeContinuationCandidate`) | **explicitly not** the automatic selector (§9.3) |
| Successor session minting | `session-successor.ts:6-44` (`createSessionSuccessorFromContinuation`) | called from inside §5's transaction, never on its own |
| Placement home resolution used by exact claim | `exact-claim.ts:99-110`; `federation/summon-gate-server.ts:251-281` (`resolveImplicitScopeHome`) | required by §4.2 |
| Shared claim FREE predicate | `scope-claim-core.ts:152-173` (`isClaimScopeFree`) | extended by §4.3 |
| Durable establishment work chain with boot rediscovery | landed at `5f1a302d`: `establishment_work_*` columns on the attempt row, `idx_participant_attempts_establishment_work`, `recoverParticipantEstablishmentWork` at startup | successor work is enqueued on this chain (§5.4); no second scheduler |
| Durable recovery disposition | landed at `5f1a302d`: `recovery_disposition` / `recovery_reason` with DB-enforced non-empty reason | read by §3.6.5 and §10.1; no second record |

### 2.2 Absent — confirmed by reading, with the discriminator used

| # | Absent foundation | Discriminator |
| --- | --- | --- |
| A1 | **Host lifecycle owner is derived from broker join.** `participantLifecycleOwner()` returns `'external'` iff `join === 'participant-served'`; an HRC-hosted bridge in front of an external application is silently HRC-owned. | `participant-establishment.ts:313-315`, consumed at `:383` and `:415` |
| A2 | **Prior-recovery gate accepts a lifecycle state as recovery evidence.** It requires only that prior attempts be in `ABANDONED`/`SUPERSEDED`/`TERMINAL`; no recovery-complete and no explicit recovery-abandoned(reason) fact exists. | `participant-establishment.ts:654-666` |
| A3 | **Establishment scheduling is in-memory only.** `scheduleParticipantEstablishment` has exactly one caller — the register handler — and the operation map is a plain `Map` that shutdown drains and nothing re-populates at boot. A daemon restart between acknowledgement and activation strands the attempt until the participant registers again. | one call site at `participant-registration-handlers.ts:452`; map declared `index.ts:847`, drained `index.ts:1732-1734`; **no** call from `startup-reconcile*` (grep over `packages/hrc-server/src` returns only those two files) |
| A4 | **No successor or resume classification.** `participantActivationClassification` returns only `'attached' \| 'attached_unknown'`. | `participant-establishment.ts:648-652` |
| A5 | **`SUPERSEDED` is unreachable.** It is declared as a state and given an empty outbound list, but it is not a target of any transition in the table, so `transitionAttempt` can never write it. | `participant-registration-repository.ts:18`, `:26-41` — `'SUPERSEDED'` never appears in any value array |
| A6 | **`processToken` is completely inert.** It is parsed and returned, never passed to `admit`, never persisted, never compared. No `process_token` column exists. | occurrences in `participant-registration-handlers.ts` are lines 25, 136, 142, 166 only; `grep process_token` over `hrc-store-sqlite/src` returns nothing |
| A7 | **No selected address.** Registration mints `taskId: participant-<uuid>`; class config carries only `scopeTemplate {agent, project}`. | `participant-registration-handlers.ts:245-249`; `registration-classes-config.ts:11-14, 29-40` |
| A8 | **No placement gate on registration.** The handler never resolves a home node; it serializes on the roster mutex and allocates locally. Exact claim, by contrast, resolves home before allocating. | no `resolveImplicitScopeHome` / `evaluateSummonGate` import in `participant-registration-handlers.ts`; compare `exact-claim.ts:99` |
| A9 | **A reserved-but-absent address reads free.** `isClaimScopeFree` returns true once every runtime on the host session is in an unavailable status, and `terminated`/`detached` are unavailable statuses. It never consults participant registrations. | `scope-claim-core.ts:160-173`; `server-util.ts:121-129` |
| A10 | **No host incarnation identity of any kind.** `ParticipantRegistration` carries participant key, scope, session, generation, workspace and socket — nothing naming the application process lifetime. | `participant-registration-repository.ts:55-73` |
| A11 | **A replaced bridge under a live host cannot reattach.** `brokerIdentityJson` is written once via `setSnapshotIfAbsent`, and a differing `brokerInstanceId` is raised as a conflict rather than treated as a new bridge incarnation. Separately, `assertExistingParticipantRuntime` requires the runtime's `activeOperationId`/`activeInvocationId` to equal the attempt's, so a new attempt against the same runtime is refused. | `participant-establishment.ts:85-99, 128-141`; `:322-340` |
| A12 | **No managed application launch.** The only spawn in the participant path builds a *broker* argv and runs it in tmux. Nothing launches an application host. | `participant-hosting-intent.ts:151-197`; `participant-realization.ts:200-247` |

### 2.3 Disjointness — foundations owned by the T-08349 closure

The closure at `var/wrkq-artifacts/T-08349/CLOSURE-2026-09-15.md` rev 1 takes
A1, A2, A3, same-session successor admission, and permanent-address reservation.
**This contract does not restate a fix for any of them and no downstream task
below may implement them.** They are consumed as preconditions:

| Absent item | Owner | How this contract consumes it |
| --- | --- | --- |
| A1 | closure item 1 — ownership becomes `external` for existing generic classes in **both** joins | §3.2 defines the only declared way ownership becomes something else (`hostLifecycleOwner: 'hrc-managed'`). After the closure lands, "external" is the default and "managed" is an explicit opt-in. |
| A2 | closure item 2 — **landed at `5f1a302d`**: `recovery_disposition ∈ ('unresolved','reconciled','abandoned')` with a DB-enforced non-empty reason | §10.1 and §3.6.5 read that column. This contract defines no second disposition record. |
| A3 | closure item 3 — **landed at `5f1a302d`**: durable `establishment_work_*` columns plus `recoverParticipantEstablishmentWork` at startup | §5.4 enqueues successor work on that same chain. No second scheduler, no second table. |
| **A4** (classification) | closure item 4 — `none→known` attaches, `same known` replaces, `changed known` resumes exactly once, unknown preserves and emits no resume | §5.1 row **L**. This contract adds only the host-succession classification, not a second classifier. |
| **A5** (`SUPERSEDED` unreachable) | closure item 4 — "old attempts remain absorbing" is unreachable without an inbound edge | this contract requires the edge but does not specify or implement it. |
| same-session successor (**new runtime + new invocation**, same scope/session/generation) | closure item 4 | §5.1 row **L**. This contract does not redefine it and does not change its runtime allocation. |
| permanent-keyed address reservation vs exact/suffix claim and cold start | closure item 5 | §4.3 adds the selected-scope case to the *same* predicate. If the closure's predicate is already registration-aware, §4.3 is a data change only. |

A6, A7, A8, A10, A11 and A12 are **not** in the closure and are settled by this
contract. A4 and A5 were previously listed here as ours; that was wrong, and
correcting it also removes a prerequisite correction this draft had claimed for
the `SUPERSEDED` edge, which belongs to the closure.

---

## 3. Declared policy and wire contract

### 3.1 `POST /v1/participants/register` request

The parser's exact-key refusal
(`participant-registration-handlers.ts:135-139`) is retained; the allowed set
grows by three keys.

| Field | Type | Required | Validation |
| --- | --- | --- | --- |
| `classId` | string | yes | existing: non-empty, trimmed, no NUL |
| `processToken` | string | yes | existing shape; **semantics settled in §3.4** |
| `evidence` | JsonValue | no | existing: JSON-serializable |
| `socketPath` | string | conditional | existing: absolute, required iff `join: 'participant-served'`, forbidden otherwise |
| `participantKey` | string | no | existing: non-empty when present |
| `requestedSessionRef` | string | conditional | **new.** Required iff `address: 'selected-scope'`; forbidden otherwise. Parsed as `<scopeRef>[/lane:<lane>]`. Its `agentId`/`projectId` must equal `scopeTemplate`; its `taskId` must be a member of `selectableTasks`; `roleName` is forbidden. A malformed or out-of-policy value is `malformed_request` on `requestedSessionRef`. |
| `hostIncarnationId` | string | conditional | **new.** Required iff `continuity: 'host-incarnation'`; forbidden otherwise. Non-empty, trimmed, no NUL, ≤ 200 bytes. Opaque to HRC — never parsed for a PID, a path or a timestamp. |
| `expectedPredecessor` | object | no | **new.** Only permitted with `continuity: 'host-incarnation'`. Exact keys `{ hostIncarnationId: string; runtimeId: string; generation: number }`, all required when the object is present. Any extra key is `malformed_request`. |
| `launchNonce` | string | conditional | **new.** Required iff the class declares `hostLifecycleOwner: 'hrc-managed'`; **forbidden** otherwise, so an external class can never be handed one. Non-empty, trimmed, no NUL. Correlates the registration with HRC's pre-committed launch record (§8.3). |

Validation ordering is unchanged and matters: shape → class lookup → join/socket
coherence → adapter availability → adapter admission → **placement (§4.2)** →
roster mutex → allocation. Placement is resolved *before* the mutex so a
wrong-home registration is refused without taking a roster lock.

### 3.2 Class policy amendment (`registration-classes-config.ts`)

`ParticipantRegistrationClassConfig` gains four optional fields. The existing
exact-key validator is extended; every existing configuration file remains valid
and behaviorally identical.

```ts
export type ParticipantRegistrationClassConfig = {
  classId: string
  adapterId: string
  join: 'hrc-hosted' | 'participant-served'          // broker process ownership
  address: 'permanent-keyed' | 'selected-scope'      // widened
  continuity: 'key-scoped' | 'host-incarnation'      // widened
  replaySemantics: 'none' | 'full-source-replay'
  scopeTemplate: { agent: string; project: string }
  maxInstances: number
  defaultTtl: number

  /** NEW. Application-process authority. Independent of `join`. */
  hostLifecycleOwner?: 'external' | 'hrc-managed'
  /** NEW. Required iff address === 'selected-scope'. Non-empty, unique tokens. */
  selectableTasks?: string[]
  /** NEW. Required iff hostLifecycleOwner === 'hrc-managed'. See §8.2. */
  managedLaunch?: ManagedHostLaunchPolicy
  /** NEW. Required iff hostLifecycleOwner === 'hrc-managed'. See §8.4. */
  managedStop?: ManagedHostStopPolicy
}
```

Coherence rules, all enforced at daemon startup by the existing validator:

1. `hostLifecycleOwner` **absent** selects the legacy compatibility default:
   HRC behaves exactly as the T-08349 closure leaves it. Absent is legal **only**
   with `continuity: 'key-scoped'`.
2. `continuity: 'host-incarnation'` **requires** an explicit `hostLifecycleOwner`.
   There is no inferred value for a host participant.
3. `address: 'selected-scope'` requires `selectableTasks` with ≥ 1 token; each
   token must pass the existing `requireToken` check and must produce a valid
   ScopeRef against `scopeTemplate` in the existing startup probe
   (`registration-classes-config.ts:117-123`).
4. `hostLifecycleOwner: 'hrc-managed'` requires `managedLaunch` and
   `managedStop`, and requires `maxInstances` ≥ the number of `selectableTasks`
   the class intends to serve concurrently.
5. `hostLifecycleOwner: 'hrc-managed'` with `join: 'participant-served'` is
   **legal** (HRC launches the application; the application serves its own
   bridge) and must be accepted. The four combinations are all expressible:

   | `join` | `hostLifecycleOwner` | Meaning | Status |
   | --- | --- | --- | --- |
   | `participant-served` | `external` | Application and bridge both external. | **MVP configuration** |
   | `hrc-hosted` | `external` | HRC spawns a bridge in front of an external application. HRC has broker authority only. | legal; this is the combination A1 got wrong |
   | `participant-served` | `hrc-managed` | HRC launches the application; the application serves its own bridge. | legal; managed follow-on |
   | `hrc-hosted` | `hrc-managed` | HRC launches both. | legal; managed follow-on |

6. The value written to `runtimeStateJson.lifecycleOwner` is
   `hostLifecycleOwner === 'hrc-managed' ? undefined : 'external'`. It is
   **never** derived from `join`.

   **This is sufficient for `external` and insufficient for `hrc-managed`.**
   Omitting the field makes `isExternalLifecycleOwner` false, which re-authorizes
   the existing readers — sweep, dispose, interrupt/terminate, rotation, GC,
   startup reconcile. Those readers are **broker-aware, not host-aware**: they
   can dispose an invocation, reap a runtime or terminate a process without ever
   asking the host to save. Applying them to a managed *application* host would
   be exactly the silent data loss §8.4 forbids.

   Therefore:

   | Class | `lifecycleOwner` | Existing readers | Status |
   | --- | --- | --- | --- |
   | `hostLifecycleOwner: 'external'` | `'external'` | unchanged, sufficient | **supported** |
   | `hostLifecycleOwner: 'hrc-managed'` | omitted | **not sufficient** | **unsupported until the host-aware guard of §8.6 exists** |

   A class declaring `hrc-managed` is **refused at daemon startup** until §8.6's
   guard is implemented. Managed mode is specified now and unsupported now; it is
   not silently half-enabled by an omitted field.

### 3.3 Adapter admission extension (ASP)

`ParticipantAdapterAdmissionRequest` gains one optional field and
`ParticipantAdapterAdmissionResult`'s `admitted` variant gains one:

The admission call has exactly one subject: **the incarnation that is
registering right now**. It has no predecessor subject and returns no verdict
about one. Predecessor fate is asked separately, by `WriterRef`, in §3.6.

```ts
// ---- request additions ----------------------------------------------------
export type ParticipantAdapterAdmissionRequest = {
  classId: string
  join: ParticipantAdapterJoin
  participantKey?: string | undefined
  evidence?: JsonValue | undefined
  /** NEW. The caller's opaque token, passed through verbatim (§3.4). */
  processToken?: string | undefined
  /** NEW. The CURRENT subject: the incarnation claimed by this call. Present
   *  iff the class declares continuity: 'host-incarnation'. Without it the
   *  adapter has nothing to echo, so the identity verdict is impossible. */
  hostIncarnationId?: string | undefined
  /** NEW. Continuation the caller may inherit, so the adapter can rule on
   *  eligibility for THIS incarnation. Identity only — never a fate claim. */
  continuationCandidate?: { key: string; priorHostSessionId: string } | undefined
}

// ---- admitted result additions --------------------------------------------
{
  status: 'admitted'
  participantKey: string
  workspaceCwd: string
  preparation: JsonValue
  continuityEvidence?: JsonValue | undefined     // unchanged; NOT retirement authority
  /** NEW. Identity verdict about the CURRENT subject, and nothing else. */
  hostIncarnation?: {
    hostIncarnationId: string    // MUST equal request.hostIncarnationId
    verifiedAt: string           // ISO-8601
    evidenceRef?: JsonValue      // opaque; HRC persists, never interprets
  } | undefined
  /** NEW. The §9.1 clause-3 verdict, previously prose-only. Present iff the
   *  request carried a continuationCandidate. */
  continuationEligibility?: {
    eligible: boolean
    reason: string               // non-empty in both directions
  } | undefined
}
```

Rules:

| Condition | HRC behavior |
| --- | --- |
| `hostIncarnation` absent for a `host-incarnation` class | `pending / participant_host_evidence_absent` |
| `hostIncarnation.hostIncarnationId !== request.hostIncarnationId` | `rejected / participant_host_evidence_invalid` |
| `continuationCandidate` sent, `continuationEligibility` absent | treated as **not eligible**, reason `adapter_gave_no_verdict`; never as eligible |
| `continuityEvidence` present | governs continuation eligibility inputs only; it is **never** read as retirement or death authority |
| anything about a predecessor appears in this result | ignored; §3.6 is the only predecessor channel |

`validateParticipantAdapterAdmission` verifies structure and the
`hostIncarnationId` echo. It interprets neither `evidenceRef` nor
`continuityEvidence`.

**Owner:** agent-spaces (T-08503). HRC may not compile against these symbols
until a coherent ASP tuple is published and pulled.

### 3.4 `processToken` — settled semantics

`processToken` is **admission input, not a fence.** Exactly:

- HRC passes it verbatim to `adapter.admit` as `processToken` and does nothing
  else with it.
- HRC does **not** persist it as identity, does **not** include it in the
  duplicate-registration lookup, does **not** compare it across calls, and does
  **not** accept it as takeover, replacement or write authority.
- The field stays required for wire compatibility with the existing parser.
- The fence HRC enforces is `hostIncarnationId`, which HRC persists and compares
  and which the adapter must have validated (§3.3).

Any document, test or task that treats `processToken` as a host fence is wrong
and must be corrected to name `hostIncarnationId`.

### 3.5 Response

The `registered` variant gains two members; the refusal variant's shape is
unchanged and only its `reason` vocabulary grows.

```ts
{
  status: 'registered'
  scopeRef, hostSessionId, generation, created, resumed, observation  // existing
  hostBinding: {                       // NEW; present iff continuity === 'host-incarnation'
    state: HostBindingState            // §5.2
    hostIncarnationId: string
    runtimeId: string
    attachEpoch: number
    boundAt?: string
    predecessor?: { hostIncarnationId: string; runtimeId: string; generation: number }
  }
  continuation: { carried: boolean; reason?: string }   // NEW; §9
}
```

`resumed` is **not** redefined for existing classes. A `key-scoped` class keeps
whatever the T-08349 closure's same-session classification produces — its
`changed known evidence resumes` case legitimately reports `resumed: true`, and
this contract neither overrides nor re-specifies it. This contract adds only the
host-incarnation cases:

| Transition (§5.1) | `resumed` |
| --- | --- |
| **L** key-scoped same-session successor | as the closure's classification decides — unchanged here |
| **H1** same-host bridge replacement | `false` — always; a transport change is not a resume |
| **H2** host succession carrying continuation | `true` |
| **H2** host succession not carrying continuation | `false` |

New `reason` values, all within the existing `'pending' | 'rejected'` union:

| `status` | `reason` | Meaning |
| --- | --- | --- |
| rejected | `participant_scope_not_home` | placement resolved another node; `detail` names `homeNodeId` |
| rejected | `participant_scope_not_selectable` | `requestedSessionRef` outside `scopeTemplate`/`selectableTasks` |
| rejected | `host_binding_conflict` | a different incarnation is live at this address |
| rejected | `host_binding_precondition_failed` | `expectedPredecessor` does not match the observed binding; `detail` names observed values |
| rejected | `participant_host_evidence_invalid` | adapter's `hostIncarnation` failed structural validation |
| pending | `participant_host_evidence_absent` | adapter returned no `hostIncarnation` for a host-incarnation class |
| pending | `host_retirement_unproven` | succession requested, retirement receipt not yet present (§5.3) |
| pending | `participant_prior_recovery_unresolved` | T-08349's recovery disposition is still unresolved (§10.1) |
| pending | `managed_host_not_ready` | managed host launched, readiness not yet reported (§8.3) |

`pending` means *retry this later, nothing has been lost*. `rejected` means *do
not retry unchanged*. A host that receives `host_binding_conflict` must not
begin writing.

---

### 3.6 Writer evidence boundary — the minimum missing producer seam

This section exists because the seam it describes **does not exist at the locked
producer tuple**, and no HRC policy that admits a successor can be implemented
without it.

#### 3.6.1 What is actually absent, verified at the locked tuple

Read from the published tarballs of `0.1.1-dev.20260914194358` fetched directly
from `http://mini:4873/`, not from `node_modules` — the physical tree in this
checkout is stale at `0.1.1-dev.20260909165248` and inspecting it would have been
inspecting a guess. (`participant-adapter.d.ts` happens to be byte-identical
across the two, but nothing else may be assumed to be.)

| Surface | Locked reality | Why it is not evidence |
| --- | --- | --- |
| `ParticipantAdapter` | `adapterId`, `admit`, `prepare` — nothing else | no callable retirement, quiescence, writer-liveness or recovery interface exists |
| `continuityEvidence` | opaque `JsonValue` on the admitted result | **expressly not retirement authority** — it describes continuation eligibility, not write paths |
| `invocation.stop` → `{ accepted: boolean; state: InvocationState }` | an acknowledgement that a *request* was accepted | receipt-as-proof; `accepted` says a message was taken, not that a write path closed |
| `invocation.dispose` → `{ disposed: true }` | disposes the broker's invocation record | says nothing about the driver's or host's ability to write; and for a participant-served bridge, HRC calling it violates external ownership |
| `seat.probe` → `SeatState` incl. `'terminal'` | the broker's view of a seat | a broker's seat view is not a writer's write-path state |
| `invocation.status` with `probeLiveness` → `process.{pid,exitCode,signal}` | the bridge's view of a driver process | this is a *bridge* process fact, never a host fact; using it for host death would be exactly the native probing this contract forbids |

None of these yields any of the three facts below. They must not be substituted
for them, individually or in combination.

#### 3.6.2 Three facts, never collapsed

| Fact | Question | Owner | Why separate |
| --- | --- | --- | --- |
| **Write-path retirement** | Is there any remaining path by which this writer can produce a **new** native write? | the writer's owner — adapter for participant-served, committed instance evidence for HRC-owned | a writer can be retired while still alive (quiesced), so this is not liveness |
| **Writer liveness** | Is the writer process/engine itself gone? | adapter (native evidence) | a writer can die without ever being retired, and a dead writer's tail may still be undelivered |
| **Prior event recovery** | Has the writer's committed prior evidence been delivered and projected? | producer reports its undelivered tail; HRC owns its own projection/disposition | a retired, dead writer can still have an unrecovered tail |

Collapsing any two of these is the defect this section exists to prevent.

#### 3.6.3 Proposed exported types (`spaces-runtime-contracts`)

Names are this contract's proposal; the producing repository settles them.

```ts
/** WHICH writer is being asked about. Without this the same tuple could answer
 *  "the bridge died" to a question about the host, and bridge death would
 *  authorize host replacement. The subject is required and never inferred. */
export type WriterSubject = 'host' | 'bridge'

/** Identifies the writer being asked about. Product-neutral, and sufficient for
 *  BOTH the key-scoped same-session policy and the host-incarnation policy. */
export type WriterRef = {
  subject: WriterSubject
  classId: string
  participantKey: string
  attemptId: string
  invocationId: InvocationId
  attachEpoch: number
  /** Required when subject === 'bridge'; identifies WHICH bridge. */
  brokerInstanceId?: string | undefined
  /** Required when subject === 'host' for a host-incarnation class. */
  hostIncarnationId?: string | undefined
}

export type WriterPathState  = 'retired' | 'writable' | 'unknown'
export type WriterLiveness   = 'dead' | 'live' | 'unknown'
export type PriorRecovery    = 'recovered' | 'outstanding' | 'unknown'

/** One point-in-time observation by the writer's owner. Each axis is
 *  independent and each is three-valued. `unknown` is a first-class answer and
 *  is never an error. */
export type WriterEvidence = {
  schemaVersion: 'writer-evidence/v1'
  writerRef: WriterRef
  observedAt: string                       // ISO-8601, the owner's clock
  writePath:     { state: WriterPathState; reason: string; detail?: JsonValue }
  liveness:      { state: WriterLiveness;  reason: string; detail?: JsonValue }
  priorRecovery: { state: PriorRecovery;   reason: string; detail?: JsonValue }
}

export type WriterRetirementRequest = { writerRef: WriterRef; reason: string }
export type WriterInspectionRequest = { writerRef: WriterRef }

export declare function validateWriterEvidence(
  request: WriterRetirementRequest | WriterInspectionRequest,
  value: unknown
): ParticipantAdapterValidationResult<WriterEvidence>

export interface ParticipantAdapter {
  readonly adapterId: string
  admit(...): ...        // unchanged
  prepare(...): ...      // unchanged

  /** OPTIONAL. Ask the owner to close every remaining path by which `writerRef`
   *  can produce a NEW native write, then report the RESULTING state. Idempotent.
   *  Never signals, never kills, never touches a process. A `writePath.state`
   *  of `'retired'` is an assertion about the state after the attempt, not an
   *  acknowledgement that the request was received. */
  retireWriter?(request: WriterRetirementRequest): Promise<WriterEvidence> | WriterEvidence

  /** OPTIONAL. Report what the owner currently knows, changing nothing. */
  inspectWriter?(request: WriterInspectionRequest): Promise<WriterEvidence> | WriterEvidence
}
```

**Both methods are optional, and their absence breaks nothing.** This is an
additive capability, not a migration:

| Adapter | Daemon startup | Effect |
| --- | --- | --- |
| existing adapter, neither method | **starts normally** — no refusal, no config change | every path that does not need evidence behaves exactly as today |
| existing adapter, neither method, successor exit reached | **starts normally** | the exit **holds** at `pending / host_retirement_unproven` forever until the adapter gains a method — it never silently gains authority, and it never fails closed into a forced outcome |
| adapter with the methods | starts normally | the gate can be satisfied |

A missing method is read as `unknown` for every axis (§3.6.4 item 2), which is
the hold state. It is never read as `retired`, `dead`, or an error.

**No startup refusal is added for successor-capable classes.** The only
capability requirement this contract imposes at startup is on the **newly
declared** policy — `continuity: 'host-incarnation'` is new configuration that
cannot exist before this contract, so requiring its adapter to expose both
methods changes no existing class and breaks no existing deployment. Existing
`key-scoped` classes keep their current startup behavior unconditionally.

#### 3.6.4 Uncertainty semantics

**The retirement truth table.** This is the single authority; nothing elsewhere
may state a different rule.

| `writePath` | `liveness` | Retirement branch | Rationale |
| --- | --- | --- | --- |
| `retired` | `dead` | **satisfied** | both |
| `retired` | `live` | **satisfied** | a quiesced but living writer is legitimately retired |
| `retired` | `unknown` | **satisfied** | the write path is closed; liveness is then irrelevant |
| `unknown` | `dead` | **satisfied** | a dead writer has no write path whatever the owner can assert |
| `writable` | `dead` | **satisfied** | death dominates a stale write-path reading |
| `unknown` | `unknown` | **hold** | nothing is known |
| `writable` | `unknown` | **hold** | a write path may be open |
| `unknown` | `live` | **hold** | a live writer with an unknown write path |
| `writable` | `live` | **refuse** | a healthy live writer; §5.5 |

1. **`retired` OR `dead` satisfies; neither-and-some-unknown holds; writable AND
   live refuses.** `unknown` never satisfies and never refuses.
2. **`unknown` is never an error and never a default-to-safe-looking value.** An
   owner that cannot answer answers `unknown` with a `reason`; it must not answer
   `retired` or `dead` to unblock a caller, and HRC must not read a thrown error,
   a timeout or an absent method as any state.
3. **Process inspection boundary.** HRC may verify a process **it launched and
   owns** against its own committed launch identity — this is the HRC-owned
   broker-process evidence the T-08349 closure explicitly permits, and this
   contract does not withdraw it. HRC must **not** inspect a process it does not
   own: no PID, lock file, socket, native store or process table of an external
   host or a participant-owned bridge, and no
   `invocation.status { probeLiveness: true }` used to derive host fate. External
   native evidence is adapter-owned; HRC's own children are HRC's to verify.
4. **Receipts are not proof.** `accepted: true`, `disposed: true`, a `2xx`, a
   delivered notification and a successful RPC round-trip are acknowledgements of
   *requests*. The evidence is the owner's separate assertion about the resulting
   *state*.
5. **These are not evidence of retirement or death, individually or together:**
   transport loss, a closed socket, an absent socket file, lease or TTL expiry,
   retry exhaustion, an empty unresolved-write store, a changed attach token, a
   superseded epoch, a `seat.probe` of `terminal`, `continuityEvidence`, and the
   absence of any of the above.
6. **Freshness, per axis.** HRC persists the consumed evidence verbatim as the
   retirement receipt and re-reads it inside the succession transaction. Later
   evidence voids an uncommitted succession **only on the axis the receipt rested
   on**:

   | Receipt rested on | Voided by later | Not voided by later |
   | --- | --- | --- |
   | `writePath: 'retired'` | `writePath: 'writable'` | `liveness: 'live'` — retired-but-live is valid |
   | `liveness: 'dead'` | `liveness: 'live'` | `writePath: 'writable'` — irrelevant to a dead writer |

   A voided succession returns to `pending`, never to a forced outcome.
7. **Asymmetric durability.** `retired` and `dead` are durable once observed —
   a retired write path does not reopen and a dead writer does not revive. HRC
   may persist them. `writable`, `live` and every `unknown` are point-in-time only
   and are never cached as a verdict.
8. **Subject discipline.** Evidence answers only about its `writerRef.subject`.
   `subject: 'bridge'` evidence may authorize a bridge replacement (§6.1.1) and
   **never** a host succession; `subject: 'host'` evidence may authorize a host
   succession (§5.3) and is not required for a bridge replacement. A request
   whose response echoes a different subject is invalid evidence.
9. **Asking is not authority.** Calling `retireWriter` against a healthy live
   writer neither retires it nor licenses displacing it. The owner is free to
   answer `writable` + `live`, and that answer refuses (§5.5). There is no
   takeover of a healthy live host or bridge.

#### 3.6.5 The successor-admission gate

One predicate, used by **both** policies and by both subjects. It differs only in
which `writerRef.subject` the evidence must carry (§3.6.4 item 8).

```
// §3.6.4's truth table, expressed once:
retirementSatisfied = writePath === 'retired' || liveness === 'dead'
retirementRefused   = writePath === 'writable' && liveness === 'live'
// anything else HOLDS.

priorAbsorbing      = prior attempt state is absorbing — SUPERSEDED | ABANDONED |
                      TERMINAL, each with its required disposition reason (C.4)

recoverySatisfied   = (evidence.priorRecovery === 'recovered'
                       && attempt.recoveryDisposition === 'reconciled')
                   || attempt.recoveryDisposition === 'abandoned'   // non-empty reason

admitSuccessor      = retirementSatisfied && priorAbsorbing && recoverySatisfied
```

| Condition | Outcome |
| --- | --- |
| `retirementRefused` | **refuse** — `rejected / host_binding_conflict` |
| not `retirementSatisfied` and not refused | **hold** — `pending / host_retirement_unproven` |
| not `priorAbsorbing` | **hold** — `pending / participant_prior_disposition_unresolved` |
| not `recoverySatisfied` | **hold** — `pending / participant_prior_recovery_unresolved` |
| all three | admit |

`priorAbsorbing` is C.4's absorbing-disposition requirement stated explicitly:
retirement evidence alone is not admission. An absorbing prior and a satisfied
retirement branch are independent conditions and both must hold.

**HRC's disposition record is the one that landed**, not a new one. At
`5f1a302d` the attempt row carries
`recovery_disposition ∈ ('unresolved','reconciled','abandoned')` with a
database-enforced non-empty `recovery_reason` for the two non-default values
(migration `0066_participant_recovery_and_work`, repository field
`recoveryDisposition` / `recoveryReason`). This contract reads that column and
defines no second record.

**Explicit recorded abandonment is a distinct authorized disposition, not a
producer answer.** It is written by the authorized recovery path with a non-empty
reason and an attributed actor; it is never inferred, never a fallback from a
timeout, and never something an adapter can return. It exists precisely so the
full historical reader — Phase 4 — is **not** dragged into the MVP merely to
define this gate: an MVP whose producer honestly reports
`priorRecovery: 'unknown'` reaches the successor exit only through an explicit,
attributed, reasoned abandonment, and that abandonment is visible as such
forever.

#### 3.6.6 Delivery slice and ordering

This slice is filed as **T-08510 — participant-producer-retirement-seam**. Its
**only** prerequisite is an approved T-08501. It is not behind the consumer
product's listener, not behind the completed HRC foundation, and not behind the
resident driver — those depend on **it**.

| Item | Package | Owner | Blocking |
| --- | --- | --- | --- |
| `WriterSubject`, `WriterRef`, `WriterEvidence`, the three state unions, `validateWriterEvidence`, optional `ParticipantAdapter.retireWriter` / `inspectWriter` | `spaces-runtime-contracts` | **T-08510**, agent-spaces | **blocks T-08349's participant-served successor acceptance and T-08503's resident driver**, and the successor exit of both policies |
| **a controlled reference adapter implementing both methods**, able to produce each cell of §3.6.4's truth table on demand for **both** subjects (`host` and `bridge`) and each `priorRecovery` value | `spaces-runtime-contracts` test/controlled-adapter surface | **T-08510** | **required inside T-08510.** Exported interfaces alone are not a usable gate: T-08349's installed both-join proof needs a real adapter that can answer, and it must not have to wait on the consumer product's host (T-08502) or resident driver (T-08503) to get one. The controlled adapter is what breaks that cycle. |
| product adapter implementations of the two methods | consumer product adapter | T-08502 / T-08503 | downstream of T-08510; **not** a prerequisite of T-08349's proof |
| broker-side `broker.writerEvidence` returning the same `WriterEvidence` | `spaces-harness-broker-protocol` | agent-spaces | **deferred, not in the minimum slice.** For `join: 'hrc-hosted'` HRC already has committed instance evidence, which the T-08349 closure names as sufficient for that join. Recorded here so nobody builds it speculatively; it becomes necessary only if an HRC-owned writer must assert retirement it cannot assert from committed instance facts. If added it is additive (`BrokerMethodV5`), keeping the negotiated protocol version unchanged exactly as `broker.installIdentity` / `broker.ensureInvocation` did. |

**Acyclic ordering.** This contract may be reviewed and closed before the slice
exists. HRC work that does not reach a successor exit is not blocked by it:
placement (§4.2), reservation (§4.3), the binding table and its constraints
(§5.2), bridge reconnection (§6.1), controller reconnect (§6.2), the queue/steer
mapping (§7) and continuation eligibility (§9) all proceed against the seam's
*absence* by holding `pending`. Only the successor exit waits, and it waits in a
state that loses nothing.

Sequence: **T-08501 approved → T-08510 dispatched → T-08510 published/pulled →**
the served-successor exits of T-08349 and T-08504. T-08510 must land before the
HRC foundation claims a both-join exit.

## 4. Address: selection, placement, reservation

### 4.1 Selection

For `address: 'selected-scope'`, the address is the ordinary scope the caller
named in `requestedSessionRef`, subject to the class allowlist. HRC mints no
`participant-<uuid>` task token for such a class. The lane defaults to `main`
when the ref carries none, matching the existing registration default
(`participant-registration-handlers.ts:259`).

One class may serve several selectable tasks; each selected scope is an
independent address with its own binding. `maxInstances` continues to cap
registrations per class.

### 4.2 Canonical placement

A selected scope is an ordinary scope and therefore has a federation home. Before
allocating anything, registration resolves it exactly as exact claim does:

```
resolveImplicitScopeHome(server, { scopeRef, capabilityHint })   // summon-gate-server.ts:251
```

- home === this node → proceed.
- home !== this node → `rejected / participant_scope_not_home`, `detail` naming
  the `homeNodeId`. HRC **does not** proxy the registration and **does not**
  mint a local alternate identity. The callback surface is node-local by trust;
  a host registering against the wrong node is told where its home is.
- placement refuses → surface the refusal unchanged.

`address: 'permanent-keyed'` classes are unaffected: they keep today's
mutex-only allocation.

### 4.3 Reservation against cold birth

An address bound to an *absent* host must not be taken by an ordinary claim or a
cold birth. The T-08349 closure owns making the permanent-keyed address
reservation real; this contract adds only the selected-scope case to the same
predicate.

**Requirement R-4.3.1.** `isClaimScopeFree` returns `false` for a session whose
scope+lane carries a **held reservation** (§5.2.1) — regardless of runtime
status and regardless of whether any binding row exists. Runtime status is the
wrong signal here: `terminated` and `detached` are both "unavailable"
(`server-util.ts:121-129`), and an absent external host is exactly a terminated
runtime whose address must survive.

**Requirement R-4.3.2.** Every door that can create a runtime or a successor
session for a scope must consult the reservation. The doors verified at this
baseline are:

| Door | Source | Required behavior |
| --- | --- | --- |
| exact claim-and-start | `exact-claim.ts` → `scope-claim-core.ts:160` | refuse with the existing conflict shape |
| suffix roster claim | `roster-claim.ts` → `scope-claim-core.ts:160` | skip the reserved slot; do not rotate it |
| target-message birth / successor | `target-message-handlers.ts:559, 621` | no substitute birth; mail stays pending/retryable |
| selector-message successor | `selector-message-handlers.ts:272` | same |
| startup reconcile | `startup-reconcile.ts` external-owner branches (`:165, :286, :349, :661, :965`) | leave the reservation held; never recycle the address |

A downstream implementation must re-run this enumeration at its own baseline
rather than trusting this table — it is a source reading, not a guarantee that
no fifth door exists.

**Requirement R-4.3.3.** Mail or a kicker addressed to a reserved, unbound
address yields a truthful pending/undeliverable outcome with the reason
`host_absent`. It never births a substitute runtime, never invents a reply, and
never marks the envelope delivered. The obligation stays open.

**Requirement R-4.3.4.** A reservation is an **address-level** fact that exists
independently of any incarnation (§5.2). It has no TTL and never expires.

| Event | Effect on the reservation |
| --- | --- |
| no incarnation has ever registered | held, `state: 'held'`, no binding row exists |
| establishment fails, retries, or exhausts | held |
| binding reaches any terminal state | held |
| succession | **transferred atomically inside TX-6** to the successor binding — never released and never momentarily free |
| operator eviction of the attachment (§8.5) | **held.** Eviction detaches HRC's attachment; it does not release the address, and an evicted external selected scope must not become cold-birthable |
| daemon restart, transport loss, lease expiry | held |
| explicit operator **reservation release** | released — the only release, and it is a distinct, attributed operation, never a side effect of eviction, stop, terminal or GC |

EPR grant linger/finalization semantics are unrelated and must not be reused as a
host address lifetime.

---

## 5. Host binding and succession

### 5.1 Three transitions, deliberately different

These are three distinct transitions on three distinct triggers. Two of them
look alike and are not.

| | **L** — key-scoped same-session successor | **H1** — same-host bridge replacement | **H2** — host succession |
| --- | --- | --- | --- |
| Policy | `continuity: 'key-scoped'` | `continuity: 'host-incarnation'` | `continuity: 'host-incarnation'` |
| Trigger | a new attempt is admitted for the same participant key | the bridge is replaced under an **unchanged** `hostIncarnationId` | a **different** `hostIncarnationId` claims the address |
| Scope | unchanged | unchanged | unchanged |
| Session / generation | **unchanged** | **unchanged** | **new session, generation + 1** |
| Runtime | **new runtime** | **same runtime** | **new runtime** |
| Invocation / attempt / epoch | new | new | new |
| Classification | closure item 4's `attached` / `replaced` / `resumed` / unknown | none — emits no resume | host-succession, §9 decides continuation |
| Retirement evidence required | yes — prior attempt writer (§3.6.5) | yes — prior **bridge** writer (§6.1) | yes — prior **host** writer (§5.3) |
| Owner | **T-08349 closure item 4** | this contract → T-08504 | this contract → T-08504 |

**L allocates a new runtime.** That is the closure's approved shape and this
contract does not change it. **H1 keeps the runtime** because the application
process did not change; only its transport did. Reading H1's rule onto L, or L's
rule onto H1, is the specific confusion this table exists to prevent.

All three require writer evidence about the writer being displaced. A binding is
never authority to start a second live writer of any kind.

### 5.2 Two entities: reservation and binding

A reservation must be able to exist with **no** incarnation, no runtime and no
session, so it cannot be a state of a row that requires them. They are two
tables, not one table with nullable identity columns.

#### 5.2.1 `participant_address_reservations` — address level

One row per selectable address. Created by operator/class provisioning, before
anything registers.

| Column | Null? | Notes |
| --- | --- | --- |
| `reservation_id` | no | primary key |
| `class_id` | no | the class that may serve this address |
| `scope_ref`, `lane_ref` | no | **unique together** — the address |
| `home_node_id` | no | resolved at provisioning (§4.2); an address is reserved on its home only |
| `state` | no | `'held'` \| `'released'` |
| `released_at`, `released_by`, `release_reason` | yes | set together, only by the explicit release operation |

No incarnation, runtime, session or generation column exists here. A held
reservation is exactly "this address is not free" (R-4.3.1) and needs nothing
else to be true.

#### 5.2.2 `participant_host_bindings` — incarnation level

One row per incarnation. Created only when an incarnation is admitted, so every
column below is non-null from birth.

| Column | Null? | Notes |
| --- | --- | --- |
| `binding_id` | no | primary key |
| `reservation_id` | no | FK; a binding cannot exist without a held reservation |
| `registration_id` | no | FK to the participant registration |
| `host_incarnation_id` | no | **unique** across all rows |
| `host_session_id`, `generation` | no | the session this incarnation serves |
| `runtime_id` | no | incarnation-scoped (§6.1.3 P-6.1.a) |
| `state` | no | `BINDING` \| `BOUND` \| `DETACHED` \| `RETIRING` \| `RETIRED` |
| `predecessor_binding_id` | yes | null for the first incarnation only |
| `admitted_at` | no | |
| `bound_at`, `retired_at` | yes | set on entering `BOUND` / `RETIRED` |
| `retirement_receipt_json` | yes | required non-null on entering `RETIRING` |
| `disposition_reason` | yes | required non-null on entering `RETIRED` |

Constraints — both uniqueness directions enforced by the database, not by
application logic:

- unique `host_incarnation_id` → **one host → at most one address**;
- **partial unique on `reservation_id` where `state IN ('BINDING','BOUND','DETACHED','RETIRING')`**
  → **one address → at most one live host**.

#### 5.2.3 Binding transitions

| From | To | Cause | Guard |
| --- | --- | --- | --- |
| — | `BINDING` | incarnation admitted | held reservation; inside TX-1 |
| `BINDING` | `BOUND` | activation committed | activation CAS succeeded |
| `BINDING` | `RETIRED` | establishment abandoned | attempt `ABANDONED`; reservation **held** |
| `BOUND` | `DETACHED` | controller or bridge lost | **no** host-death inference |
| `DETACHED` | `BOUND` | same incarnation reattached | §6.1 |
| `BOUND`/`DETACHED` | `RETIRING` | a different incarnation admitted | matching `expectedPredecessor` **and** a §5.3 receipt |
| `RETIRING` | `RETIRED` | TX-6 committed | atomic with the successor's `BINDING` row and the reservation transfer |
| `BOUND`/`DETACHED`/`RETIRING` | `RETIRED` | operator retirement | explicit, attributed, reason recorded; reservation **held** |
| `RETIRED` | — | terminal | — |

Every path out of a binding leaves the reservation `held`. There is no binding
transition that releases an address.

`DETACHED` is explicitly **not** evidence of host death. Transport loss, socket
absence, lease expiry, retry exhaustion and an empty unresolved-write store are
each individually and jointly insufficient — this restates the active invariant's
retirement clause and is not a new rule.

### 5.3 Retirement receipt

A binding may leave `BOUND`/`DETACHED` for `RETIRING` only with a **retirement
receipt**: a `WriterEvidence` (§3.6.3) obtained from the predecessor's owner
through `retireWriter` or `inspectWriter`, whose `WriterRef` names the
predecessor's `hostIncarnationId`, `attemptId`, `invocationId` and `attachEpoch`,
and which satisfies `retirementSatisfied` (§3.6.5):

| Axis | Sufficient value | Meaning |
| --- | --- | --- |
| `writePath.state` | `'retired'` | no remaining path to a new native write |
| `liveness.state` | `'dead'` | the writer process/engine is gone |

Either alone suffices; they are independent (§3.6.2). HRC persists the evidence
verbatim into `retirement_receipt_json` and re-reads it inside TX-6 under the
freshness rule (§3.6.4 item 6). HRC never produces either fact itself, never
reads a PID, a lock file or a native store, and never derives one from transport.

Absent a satisfying receipt the successor registration returns
`pending / host_retirement_unproven`; the predecessor stays bound and the address
stays reserved. **An indefinitely unprovable retirement is a truthful stall, not
a reason to relax the gate.** Operator retirement is the escape hatch, and it is
explicit, attributed and recorded.

**PID reuse.** A new process that happens to reuse an OS PID carries a different
`hostIncarnationId` and is therefore a different incarnation. HRC's comparison is
on the opaque incarnation id only, so PID reuse cannot be mistaken for
continuity. Conversely a host that keeps its PID across an application-internal
runtime replacement keeps its incarnation id and stays the same binding.

### 5.4 Transaction and work-chain boundaries

Named atomic units. TX-2 … TX-5 exist today and are unchanged.

| Unit | Contents | Notes |
| --- | --- | --- |
| **TX-1 admit + bind** | held-reservation check, binding row created in `BINDING`, registration row, attempt identity, opaque preparation, session/continuity rows | inside the roster mutex, after placement; extends today's `participant-registration-handlers.ts:268-285` transaction |
| TX-2 | freeze prepared profile + dispatch env | `freezePreparedBoundaryIfAbsent` |
| TX-3 | persist hosting intent | `setSnapshotIfAbsent('hostingIntentJson')` |
| TX-4 | persist realized hosting, then frozen dispatch | unchanged |
| TX-5 | install acknowledgement, then activation CAS + runtime state + `runtime.ensured` | unchanged; §10.1 adds a precondition |
| **TX-6 succession** | **all of**: predecessor attempt → `SUPERSEDED`(reason); predecessor runtime → terminal `host_replaced`; predecessor binding `RETIRING`→`RETIRED` with receipt and `disposition_reason`; **reservation transferred** — the same `reservation_id` row stays `held` throughout and the successor binding takes the partial-unique slot the predecessor vacates in the same statement sequence; successor session via `createSessionSuccessorFromContinuation` (generation + 1); continuation carried iff §9 eligible; successor binding → `BINDING` with a fresh `runtime_id`; successor attempt identity; one durable work record for the successor's establishment | **one SQLite transaction**, inside the same `roster:<agent>:<project>` mutex. Partial application is forbidden: a crash mid-way must leave either the whole predecessor bound or the whole successor binding, and the address is never observably free at any point. |

**Durable work chain — the one that landed.** At `5f1a302d` the closure's item 3
landed as durable columns on the attempt row rather than a separate outbox table:
`establishment_work_state ∈ ('pending','retry_wait','exhausted','completed')`,
`establishment_attempt_count`, `establishment_next_attempt_at`,
`establishment_last_error`, indexed by
`idx_participant_attempts_establishment_work`, with
`recoverParticipantEstablishmentWork(server)` invoked at daemon startup
(migration `0066_participant_recovery_and_work`; `index.ts`). TX-6's successor
work is enqueued by creating the successor attempt in `establishment_work_state:
'pending'` on that same chain. **No second table, no second scheduler, no second
retry policy and no new work-kind column** — the earlier draft's
`host_succession_establish` kind is withdrawn as unnecessary against the landed
shape. Exhaustion exhausts the work only; it never abandons the binding, never
releases the reservation and never authorizes a forced retirement.

**Idempotency.** A duplicate succession request naming the same
`expectedPredecessor` and the same `hostIncarnationId` returns the committed
result rather than repeating TX-6. A request naming a stale `expectedPredecessor`
after TX-6 committed returns `rejected / host_binding_precondition_failed` with
the observed values — never a second succession.

### 5.5 Conflicting live hosts

Two incarnations claiming one address is resolved by the partial unique index
plus the mutex, never by timing:

- The first admitted incarnation binds.
- The second is `rejected / host_binding_conflict` naming the live
  `hostIncarnationId`. It is a rejection, not a pending: the second host must not
  begin writing and must not retry unchanged.
- Presenting a `expectedPredecessor` does not change this unless a §5.3 receipt
  exists. A process token, a newer start time, a "newer build" claim and a
  larger epoch are all **not** takeover authority.

### 5.6 Old traffic after succession

- Control and work carrying a retired `attachEpoch` or a retired
  `brokerInstanceId` cannot act on the successor: it is refused with the existing
  stale-work vocabulary and recorded.
- **Prior validated historical events remain ingestible** and are attributed to
  the retired runtime. Fencing must not silently discard the predecessor's final
  tail. Full historical recovery completeness is Phase 5 and is not claimed here.
- An event that arrives attributed to the retired runtime never closes a
  successor run, never satisfies a successor obligation and never mutates
  successor continuation.

---

## 6. Reconnection without succession

### 6.1 Same host, replaced bridge

This is the A11 case and it is the most common non-failure event in the system.

**Rule.** A bridge replacement under an unchanged `hostIncarnationId` keeps the
**registration, scope, session, generation and runtime**, and takes a **new
attempt, a new `attachEpoch`, a new `invocationId`/`operationId` and a new
`brokerInstanceId`**. It emits **no** resume, mints **no** successor session and
changes **no** continuation.

#### 6.1.1 The old-bridge guard

**A same-host binding is not authority to start a second live bridge writer.**
Two live bridges under one host are as dangerous as two live hosts, and the
generic old-*runtime* fence cannot help here because the runtime is the same.

The old bridge is therefore displaced through the **same §3.6 gate**, with a
`WriterRef` whose `brokerInstanceId` and `attemptId`/`invocationId`/`attachEpoch`
name the **old bridge**, and whose `hostIncarnationId` is unchanged:

| Old-bridge evidence | Outcome |
| --- | --- |
| `writePath: 'retired'` **or** `liveness: 'dead'` | replacement admitted |
| both `unknown` | **hold** — `pending / host_retirement_unproven`; the old attempt stays `ACTIVE`/`DETACHED`; nothing is lost |
| `writePath: 'writable'` **and** `liveness: 'live'` | **refuse** — `rejected / host_binding_conflict`; the incoming bridge must not write |

The recovery gate applies unchanged: `recoverySatisfied` (§3.6.5) must hold
before the new attempt's staged replay is released.

#### 6.1.2 Late events from the old invocation

The runtime is shared, so a retired-runtime fence does not apply. Under one
runtime:

| Event from the old invocation | Required handling |
| --- | --- |
| validated historical event | ingest, attributed to the **old `invocationId`** and its epoch; retained |
| a terminal for the old invocation | closes the **old** invocation only |
| anything naming the current invocation | refused as stale work |
| continuation update | **does not** mutate the session's or the current invocation's continuation |
| turn completion | **does not** close a current-invocation run and **does not** satisfy an obligation held by the current invocation |

The current invocation and the session's continuation are untouched by anything
arriving on a superseded epoch. Retention and authority are separate: the old
tail is kept, and it has no control.

#### 6.1.3 Prerequisite source corrections

Both are scoped to `continuity: 'host-incarnation'` and **must not** change the
key-scoped policy, which allocates a new runtime per successor (§5.1 row L).

- **P-6.1.a** For host-incarnation classes the `runtime_id` is
  **incarnation-scoped**: the host binding owns it and each of its attempts
  copies it. Today it is minted per attempt
  (`participant-registration-handlers.ts:243`, stored at
  `participant-registration-repository.ts:82`). Key-scoped classes keep
  per-successor runtime allocation exactly as the closure defines.
- **P-6.1.b** `assertExistingParticipantRuntime`
  (`participant-establishment.ts:322-340`) must key continuity on
  `hostSessionId`/`scopeRef`/`laneRef`/`generation`/`runtimeId` and permit
  `activeOperationId`/`activeInvocationId` to advance when — and only when — a
  committed attempt with a strictly greater `attachEpoch` for the same binding,
  admitted through §6.1.1, authorizes the move. Any other move stays a conflict.
- The write-once install acknowledgement (`participant-establishment.ts:85-99`)
  stays write-once **per attempt**. The new bridge writes its own on its own
  attempt row; nothing overwrites the predecessor's.

#### 6.1.4 Unresolved writes across a bridge replacement

The host did not die, so the host — not HRC and not the new bridge — is the
authority on what it received. Submissions handed to the retired bridge whose
outcome is unknown stay `indeterminate`. HRC does not resend, cancel, fail or
complete them. They resolve when the host's own reconciliation reports their fate
through the new bridge. See §10.2.

### 6.2 Controller reconnect (HRC restart)

A daemon restart changes the controller instance (`hrc-server:<pid>`) and nothing
else. Same binding, same runtime, same generation, no resume. The durable
projection high-water mark, not the controller identity, is the ACK authority —
this is the existing behavior recorded in C-21329 and is unchanged.

### 6.3 Attach/detach of a presentation surface

A TUI or other operator presentation attaching or detaching is a transport event.
No binding transition, no generation change, no session event.

---

## 7. Control surface: queue and steer

### 7.1 Mapping — no new HRC surface

| Concern | Existing HRC surface | Driver method |
| --- | --- | --- |
| queue ordinary work | door `enqueue` → `controller.enqueue` (`broker/submission-doors.ts:41-45`) | `applyInputNow` via the broker's queue |
| steer the live turn | door `steer` → `controller.steer` (`broker/submission-doors.ts:38-39`) | `applySteerNow` |
| capture | existing broker event mapping and ledger | — |
| attach/reconnect | §6 | — |
| interrupt / preempt | **not advertised** | — |
| raw thread create/fork/reset/resume | **not exposed** | — |

The driver advertises `admission.classes` containing `queue` and `steer` and
**must not** advertise `preempt` or `exclusive`. HRC's refusal of an
unadvertised class already reports the broker's own vocabulary
(`broker/capabilities.ts:60-70`) and needs no change. Interrupt support that
exists in a product's own interactive surface is not an HRC federation capability
and is not an acceptance gate.

### 7.2 Receipts and outcomes — the truthfulness rules

1. **Accepted or queued is not presented.** Broker acceptance, queue admission
   and HRC's own delivery record are each insufficient to satisfy a mail
   obligation. Only presentation evidence satisfies it.
2. **A turn ending is not a reply.** Existing wrkc obligation semantics are
   unchanged.
3. **A truthful busy `not-written` refusal leaves the work eligible** for
   ordinary queue retry under the existing submission machinery. It must never
   become a completed envelope, and the race must not be hidden behind a second
   queue.
4. **Host admission is authoritative at execution time.** A locally originated
   turn can win the idle slot, so broker state alone cannot guarantee admission.
5. **Steer against an ended turn** returns a truthful `not-written`. It is never
   silently converted into a new turn, and there is no interrupt-then-apply
   fallback.
6. **Possible delivery followed by a lost acknowledgement** is `indeterminate`.
   It is reconciled, never resent, and a closed socket is not evidence of
   non-delivery.
7. **Duplicate submission** of an identical input identity converges on the
   first outcome; it never produces a second effect.

### 7.3 Internal children

A host's internal subagents and tool children are activity within one runtime.
They mint no HRC seat, no address, no session and no generation. Their events may
appear as correlated activity but must not close the root turn, satisfy the
parent's obligation, or be counted as a second effect when the host and the
harness both report one application call. A replay gap is reported, not repaired
by re-running a tool.

---

## 8. Launch modes

### 8.1 The two axes, restated

`join` selects who spawns the **bridge**. `hostLifecycleOwner` selects who owns
the **application process**. They are independent (§3.2 table). The MVP is
`participant-served` × `external`; the follow-on adds `hrc-managed`. Nothing in
the external MVP may hard-code a permanently external driver, a home layout, or
a path convention that the managed mode has to replace.

### 8.2 `ManagedHostLaunchPolicy`

Declared now, implemented in T-08507.

```ts
type ManagedHostLaunchPolicy = {
  /** Installed executable inside an owned release prefix. Never a global binary
   *  replacement, never a shim, never resolved from an ambient PATH. */
  executable: { prefix: string; relativePath: string }
  /** Must equal the placement home resolved for the selected scope (§4.2). */
  canonicalNode: string
  /** Explicit. Never inferred from a caller's cwd. */
  workspace:
    | { mode: 'existing'; path: string }
    | { mode: 'create'; path: string; template?: string }
  /** Opaque to HRC; passed to the adapter's preparation. */
  settingsRef: JsonValue
  /** Durable application/continuation state. Survives incarnations. */
  persistentHome: string
  /** Disposable per-incarnation credential/scratch state. Never the same path
   *  as persistentHome, never a parent or child of it. */
  scratchHome: string
  /** No presentation resource unless explicitly declared. */
  presentation: { kind: 'none' } | { kind: 'tmux-tui' }
}
```

Refused by construction: a hard-coded fallback prompt, a hidden GUI, a global
binary replacement, a workspace guessed from a caller's cwd, and turning a failed
continuation resume into a blank workspace.

### 8.3 Managed launch sequence and spawn identity

**Who names the incarnation?** HRC must be able to recognize the process it
launched when that process registers, without minting a second runtime — but the
`hostIncarnationId` is host-issued by definition (§1), and HRC cannot issue one
for a process that does not exist yet. The resolution is a **launch nonce**:

| Identity | Issued by | When | Purpose |
| --- | --- | --- | --- |
| `launchNonce` | HRC | **before** spawn, committed durably | correlates the spawn with the registration that follows |
| `hostIncarnationId` | the host | at startup, after it exists | the durable incarnation fence (§5) |

The host echoes `launchNonce` in its registration. HRC **adopts** the committed
launch record — it does not mint a second runtime, a second binding or a second
attempt. A registration that carries a `launchNonce` HRC does not hold is
`rejected / managed_launch_nonce_unknown`. A registration for a managed class
that carries **no** nonce is `rejected` — a managed class does not accept an
unsolicited host.

| Step | Action | Rule |
| --- | --- | --- |
| 1 | **Persist before spawn** | launch intent, selected scope, resolved executable identity, both home paths and the `launchNonce` are committed before any process is created — the existing persist-before-spawn discipline (`participant-hosting-intent.ts:86-197`), not a new principle |
| 2 | **Spawn** | one attempt; a lost reply or crash is reconciled against the persisted `launchNonce` **before** any retry; a second launch never races an uncertain first; rediscovery validates the persisted identity rather than accepting any live process at the expected location |
| 3 | **Prime** | the host initializes itself; HRC fabricates no prompt and no rollout |
| 4 | **Ready** | the host reports attach readiness; registration before readiness is `pending / managed_host_not_ready` |
| 5 | **Adopt + establish** | the nonce binds the registration to the committed launch record; from here the path is byte-identical to external mode: admit → prepare → hosting intent → realize → freeze → install/hello → ensure → attach → activate |

**No queued work is delivered before readiness.**

### 8.4 `ManagedHostStopPolicy` — graceful stop and unsaved state

```ts
type ManagedHostStopPolicy = {
  /** Where a graceful stop asks the host to persist its state. */
  saveDestination: { mode: 'host-default' } | { mode: 'path'; path: string }
  /** Bound on the host's own save+quiesce, after which the stop REFUSES.
   *  A timeout is a refusal, never an implied force. */
  gracefulTimeoutMs: number
}
```

**Save and exit are two readbacks, not one.** `saved` says state was persisted;
it does not say the process left. A timeout says HRC learned nothing; it does not
say the host is still running. Both are three-valued and `unknown` is a real
value, not a synonym for the safe-sounding one.

```ts
type SaveReadback = 'saved' | 'nothing-to-save' | 'save-failed' | 'save-refused' | 'unknown'
type ExitReadback = 'exited' | 'running' | 'unknown'

type ManagedStopResult = {
  outcome: 'stopped' | 'stop_refused' | 'indeterminate'
  save: { state: SaveReadback; detail?: JsonValue }
  exit: { state: ExitReadback; detail?: JsonValue }
  dataLoss?: { unsaved: 'yes' | 'no' | 'unknown'; detail?: JsonValue }
}
```

Graceful stop (`force` absent) — **no forced loss by default**:

| Save readback | Exit readback | `outcome` | `dataLoss.unsaved` | Notes |
| --- | --- | --- | --- | --- |
| `saved` | `exited` | `stopped` | `no` | the only clean success |
| `saved` | `running` | `stop_refused` | `no` | saved but did not leave; HRC does not force |
| `saved` | `unknown` | `indeterminate` | `no` | state is safe; process fate unknown; HRC does not force and does not claim a stop |
| `nothing-to-save` | `exited` | `stopped` | `no` | |
| `nothing-to-save` | `running` / `unknown` | `stop_refused` / `indeterminate` | `no` | as above |
| `save-failed` / `save-refused` | any | `stop_refused` | `unknown` | **host left alone**; failure detail reported; `unknown` not `yes` |
| `unknown` (incl. `gracefulTimeoutMs` elapsed) | `unknown` | `indeterminate` | `unknown` | **HRC learned nothing.** It does not claim the host is running, does not claim it stopped, does not force, and does not retry blindly — it reports and holds |

`exit.state: 'exited'` requires a real exit observation of the launched process
identity. It is never inferred from a closed socket, a lost bridge or a lapsed
timeout.

**Forced close.** `force: true` is explicit and per call — never a class default,
never a fallback from `stop_refused`, and never implied by a timeout or an
`indeterminate`. Its result reports `dataLoss.unsaved` truthfully:

| Save readback before forcing | `dataLoss.unsaved` |
| --- | --- |
| `saved` / `nothing-to-save` | `no` |
| `save-failed` / `save-refused` | **`unknown`** — a failed or refused save does not establish that unsaved state existed; it establishes only that HRC has no confirmation |
| `unknown` | **`unknown`** |
| host explicitly reports discarded unsaved state | `yes` — the **only** source of `'yes'` |

HRC never derives `'yes'` from a failure, a refusal or a timeout. Certainty about
data loss comes from the host saying so, or not at all.

Silent discard is forbidden, and **terminal model output is never persistence
evidence**.

**Managed restart** = graceful stop (subject to the table above — an
`indeterminate` or `stop_refused` **blocks** the restart) followed by a managed
launch of a new incarnation, which is an ordinary succession (§5) and therefore
advances the generation.

### 8.5 External mode stop

HRC may detach or evict its own attachment and nothing more. The existing
`evictExternalParticipant` semantics are unchanged: durable detach/finalize,
attach-token revocation, audit event — **no broker lifecycle RPC, no process
signal, no substrate teardown, no continuation drop, no placement mutation**
(`external-participant-lifecycle.ts:36-120`). Owner policy cannot change because
a broker restarted, a controller reconnected, or an epoch advanced. The
no-kill/no-substitute-birth behavior remains an acceptance requirement **after**
managed provisioning lands, not only before it.

---

### 8.6 Managed-mode host-aware guard — the gate on supporting `hrc-managed`

`hostLifecycleOwner: 'hrc-managed'` may be accepted at daemon startup only once a
guard exists that makes every existing runtime-lifecycle reader host-aware. Until
then the class is refused (§3.2 rule 6). The guard's requirement, stated as
behavior rather than mechanism:

| Existing action | Against an `external` host | Against an `hrc-managed` host |
| --- | --- | --- |
| sweep / reap / zombie termination | refused today by `isExternalLifecycleOwner` | must be refused; a sweep must never close an application host |
| broker dispose | refused today | permitted **against the bridge only**, never against the host |
| interrupt / terminate | refused today | must route through §8.4's stop contract, never a direct signal |
| session rotation | refused today | must not change host ownership or the binding |
| startup reconcile recycling | refused today | must leave the binding and reservation intact |
| **explicit managed stop (§8.4)** | not available | the **only** path that may end a managed host |

Until a reader is proven host-aware, its current external refusal is the correct
conservative behavior, and extending "not external" to mean "freely disposable"
is the specific regression this section exists to prevent.

### 8.7 Managed callable surface — minimal operation shapes

Readiness and stop were prose in rev 1. Their minimal shapes are fixed here so
the managed half is reviewable rather than deferred-by-vagueness.

**Ownership.** HRC owns the operations and their durable records. The host owns
every answer. No operation carries a signal, and none has a force default.

| Operation | Direction | Request | Response |
| --- | --- | --- | --- |
| **readiness report** | host → HRC, on the existing node-local callback surface | `{ launchNonce, hostIncarnationId, ready: true }` | `{ acknowledged: true }` |
| **readiness query** | HRC → host, through the bridge | `{ }` | `{ ready: boolean; reason: string }` |
| **save + stop** | HRC → host, through the bridge | `{ saveDestination; gracefulTimeoutMs; force?: true }` | `ManagedStopResult` (§8.4) |
| **exit observation** | HRC-local | — | `ExitReadback` from HRC's own launched-process identity only (§3.6.4 item 3) |

Rules:

- The readiness report is the **only** thing that moves a managed launch to
  ready. HRC never infers readiness from a socket appearing, a process existing
  or a bridge connecting.
- The readiness query is advisory and may answer `false` with a reason; it never
  makes a host ready.
- `save + stop` without `force` can only ever return `stopped`, `stop_refused` or
  `indeterminate` (§8.4). `force: true` is per call and is never defaulted.
- A response HRC cannot parse or that omits a required readback is `unknown` on
  that axis — never a substituted value.

**Review scope.** §8.2 – §8.7 are the managed half. They are specified now so the
external MVP cannot foreclose them, and they are **unsupported** until §8.6's
guard exists (§3.2 rule 6). If the reviewer prefers, the managed half can be
ruled on separately from §§1–7 and §§9–13, which are complete and independently
implementable for the external mode; this contract does not require the managed
half to be approved for the external mode to proceed.

## 9. Continuation: clearing and eligibility

### 9.1 The automatic predicate

At succession (§5.4 TX-6), the predecessor's continuation is carried **iff all
three** hold:

1. `detectResumeInvalidationBarrier(db, priorSession) === undefined`
   (`session-resume-continuation.ts:63-102` — `continuation_dropped`,
   `context_cleared` with `dropContinuation` and a reason other than
   `stale-generation-auto-rotate`, `runtime_terminated` with
   `droppedContinuation`, broker `continuation.cleared`);
2. `db.sessions.isContinuationReuseDisabled(priorHostSessionId) === false`
   (`session-repositories.ts:454-465`);
3. the adapter returned `continuationEligibility.eligible === true` for the
   *new* incarnation (§3.3). HRC sends `continuationCandidate` and reads only
   that boolean plus its `reason`; it interprets `continuityEvidence` never.
   **Absence of a verdict is not eligibility** — a missing
   `continuationEligibility` is treated as `false` with reason
   `adapter_gave_no_verdict`.

Otherwise the successor starts with no continuation and records
`continuation: { carried: false, reason }`. The reason names which of the three
failed.

### 9.2 Clearing is explicit

Clearing context is an explicit lifecycle operation. It is never a side effect of
reconnect, bridge replacement, controller restart, epoch advance, detachment or
succession. This contract adds no clear operation; the first federation slices
do not need one.

### 9.3 Automatic reuse is not explicit resume

`selectResumeContinuationCandidate` deliberately ignores clear/drop/end audit
events because `hrc resume` is a user's explicit instruction backed by the
harness's own history (`session-resume-continuation.ts:9-19`). **Automatic
succession must not call it.** Doing so would resume across a barrier the user
created. §9.1's predicate is the automatic policy; §9.3's selector remains the
explicit one, unchanged.

---

## 10. Recovery: replay and unresolved writes

### 10.1 Replay release gate

Replay stays durable and unacknowledged until HRC has committed and activation
has been recorded — existing behavior
(`participant-establishment.ts:669-760`). This contract adds one precondition to
the **successor** case:

**R-10.1.** A successor's staged replay is released only after the predecessor's
recovery disposition is either `reconciled` (with evidence) or
`abandoned(reason)` (with a non-empty reason recorded by the authorized recovery
path). That disposition record **landed at `5f1a302d`** as
`participant_registration_attempts.recovery_disposition` / `recovery_reason`;
this contract only reads it and defines no second record. Until it exists,
registration returns `pending / participant_prior_recovery_unresolved` and the
address stays reserved.

A lifecycle state is not a disposition. `TERMINAL`, `ABANDONED` and `SUPERSEDED`
each say what happened to an attempt; none of them says the prior invocation's
evidence was recovered. The current gate at
`participant-establishment.ts:654-666` conflates the two and is A2.

### 10.2 Unresolved writes

- A submission whose write outcome is unknown stays **indeterminate** through
  bridge replacement, controller restart, succession and daemon restart.
- HRC never resends it, never cancels it, never infers its outcome from topology,
  and never manufactures a turn failure from a process or transport event.
- Only work that is **definitely unpresented** is eligible for ordinary
  redelivery policy.
- A lost acknowledgement is not permission to repeat an effect.
- The predecessor's final tail is preserved as prior-runtime evidence (§5.6);
  fencing controls authority, not retention.

### 10.3 What this contract does not claim

Phase 5 final-tail retention and catch-up completeness is unchanged and
unclaimed, exactly as the active invariant's `last_verified` records.

---

## 11. Invariant amendment

`architecture/records/invariants/hrc-runtime.participant-session-lifecycle.yaml`
gains the following clauses. Nothing in the existing predicate is deleted or
weakened; the clause "a permanent key retains its scope, host session, and
generation across native host restart and observer replacement" is preserved and
is explicitly scoped to `continuity: 'key-scoped'`.

1. Host lifecycle ownership is a declared class policy. It is never derived from
   the broker join direction, and HRC hosting a broker process conveys broker
   resource ownership only.
2. A class declaring `continuity: 'host-incarnation'` binds one address to one
   host incarnation. One live address has at most one host incarnation and one
   host incarnation has at most one address; both directions are enforced by
   durable constraint.
3. A selected address resolves its canonical placement home before allocation
   and is refused, naming the home, when that home is another node.
4. An address reservation is an address-level fact independent of any
   incarnation. A reserved address is not free regardless of runtime status or
   binding state, is transferred rather than released at succession, survives
   operator eviction, and is freed only by an explicit attributed release. Mail
   to an absent bound host is pending, never a substitute birth.
5. `processToken` is adapter admission input. It is not persisted as identity,
   not compared by HRC, and not replacement authority.
6a. Writer evidence answers only about its declared subject. Bridge evidence
    never authorizes host replacement and host evidence is not required for a
    bridge replacement. HRC may verify a process it launched and owns; it never
    inspects a process it does not own.
6. A bridge incarnation change under an unchanged host incarnation preserves
   scope, session, generation and runtime, advances the attach epoch, and emits
   no resume. It requires the same writer evidence as any other displacement: a
   binding is never authority to start a second live writer. Late events from a
   superseded epoch under a shared runtime are retained and attributed to their
   own invocation, and close no current run and no continuation.
7. Write-path retirement, writer liveness and prior-event recovery are three
   independent facts asserted by the writer's owner, each three-valued with
   `unknown` as a first-class answer that holds. A request acknowledgement is not
   evidence, and HRC performs no native probing. Successor admission requires
   retired-or-dead plus a satisfied recovery disposition; explicit recorded
   abandonment with a reason is a distinct authorized disposition.
8. Host succession additionally requires a compare-and-set against the observed
   predecessor. Retirement, successor session, binding movement, reservation
   transfer and replay fences commit as one recoverable transaction in which the
   address is never observably free.
9. Automatic continuation reuse at succession respects explicit clear barriers,
   the reuse-disabled flag and an explicit adapter eligibility verdict. Absence of
   a verdict is not eligibility, and the explicit historical-resume selector is
   never the automatic policy.
10. Save and exit are separate readbacks and each may be unknown. A managed
    graceful stop that cannot save refuses and leaves the host alone; a stop that
    learns nothing is indeterminate and asserts neither outcome. Forced closure is
    explicit per call and reports its data-loss disposition truthfully, including
    `unknown`. Terminal model output is not persistence evidence.
11. `hostLifecycleOwner: 'hrc-managed'` is refused until every runtime-lifecycle
    reader is host-aware. Absence of the external marker never by itself
    authorizes disposing, reaping or terminating an application host.
12. Queue and steer are the federation control contract. Interrupt and preempt
    are not advertised and are not a prerequisite. Internal children mint no HRC
    seat and do not satisfy the parent's obligation.

`reopen_when` gains: host incarnation identity, the writer-evidence axes or their
sufficiency, the reservation predicate or its release rule, the succession
transaction shape, managed launch adoption or stop readback semantics, the
managed host-aware guard, or the queue/steer advertised class set changes.

---

## 12. Source-reference and ownership matrix

| Surface | Source | Owner | Disposition |
| --- | --- | --- | --- |
| `POST /v1/participants/register` request/response | `participant-registration-handlers.ts:22-46, 124-170` | hrc-runtime | amend additively (§3.1, §3.5) — T-08504 |
| class policy validator | `registration-classes-config.ts:29-40, 78-160` | hrc-runtime | amend additively (§3.2) — T-08504 |
| `lifecycleOwner` selection | `participant-establishment.ts:313-315` | hrc-runtime | **T-08349 closure item 1** — not T-08504 |
| prior-recovery disposition | `participant-establishment.ts:654-666` | hrc-runtime | **T-08349 closure item 2** — consumed at §10.1 |
| durable establishment work chain, boot rediscovery | `participant-establishment.ts:777-819`, `index.ts:847` | hrc-runtime | **T-08349 closure item 3** — T-08504 adds one work kind only |
| same-session successor (**new runtime + invocation**) and classification (A4) | `participant-establishment.ts:648-652` and repo CAS | hrc-runtime | **T-08349 closure item 4** — §5.1 row L; not redefined here |
| `SUPERSEDED` unreachable in the transition table (A5) | `participant-registration-repository.ts:26-41` | hrc-runtime | **T-08349 closure item 4** — "old attempts remain absorbing" requires the edge |
| permanent-keyed address reservation | `scope-claim-core.ts:160-173` | hrc-runtime | **T-08349 closure item 5**; §4.3 adds the selected-scope case to the same predicate |
| `runtime_id` attempt-scoped → incarnation-scoped **for host-incarnation classes only** | `participant-registration-handlers.ts:243`; `participant-registration-repository.ts:82` | hrc-runtime | **prerequisite correction P-6.1.a** — T-08504; key-scoped allocation unchanged |
| `assertExistingParticipantRuntime` refuses invocation movement | `participant-establishment.ts:322-340` | hrc-runtime | **prerequisite correction P-6.1.b** — T-08504 |
| `participant_address_reservations` + `participant_host_bindings`, both unique directions | new | hrc-runtime | new (§5.2) — T-08504 |
| **writer evidence seam** — `WriterRef`, `WriterEvidence`, three state unions, `validateWriterEvidence`, `ParticipantAdapter.retireWriter` / `inspectWriter` | **absent at locked `0.1.1-dev.20260914194358`** (§3.6.1) | agent-spaces | **T-08510** — prerequisite is **approved T-08501 only**; see §3.6.6 |
| placement resolution on registration | `summon-gate-server.ts:251-281`; pattern at `exact-claim.ts:99` | hrc-runtime | new call site (§4.2) — T-08504 |
| succession transaction TX-6 | `session-successor.ts:6-44` composed with new binding writes | hrc-runtime | new (§5.4) — T-08504 |
| continuation eligibility predicate | `session-resume-continuation.ts:63-102`; `session-repositories.ts:454-465` | hrc-runtime | new composition (§9.1) — T-08504 |
| adapter admission `processToken` + `hostIncarnation` | `spaces-runtime-contracts/participant-adapter.d.ts` | agent-spaces | new public exports (§3.3) — T-08503; coherent published/pulled tuple required before HRC compiles |
| attach-existing resident driver, queue/steer, capture/replay | `harness-broker` drivers | agent-spaces | T-08503 |
| host identity, admission, retirement acknowledgement, input reconciliation | product host | consumer product | T-08502 |
| managed launch preparation | `harness-broker` / adapter | agent-spaces | T-08506 |
| managed spawn/readiness/stop/restart | hrc-runtime | hrc-runtime | T-08507 |
| legacy EPR (`POST /v1/registrations`), grants, TTL, handshake | `registration-handlers.ts`, `external-registration-rendezvous.ts` | hrc-runtime | **unchanged; regression gate on every slice** |
| existing key-scoped participant classes | config + `participant-*` path | hrc-runtime | **unchanged; regression gate on every slice** |

---

## 13. Scenario assignments

Each row is an executable scenario with an observable that distinguishes pass
from the failure it is there to catch. **This task claims no runtime acceptance**;
these are assignments, not results.

| # | Scenario | Required observable | Owner | Proof class |
| --- | --- | --- | --- | --- |
| S1 | Idle queue — mail to an idle host | envelope reaches presentation; a reply satisfies the obligation; acceptance alone does not | T-08505 | live installed, cross-node |
| S2 | Busy steer — kicker while the resident is mid-turn | `steer` lands in the current turn with correlated landing evidence; no new turn is created | T-08505 | live installed |
| S3 | Locally originated turn wins the idle slot | broker-queued work receives a truthful `not-written` busy refusal and stays eligible; it does not become a completed envelope | T-08505 | live installed |
| S4 | Bridge replaced, host alive, old bridge retired or dead | same scope/session/generation/runtime; `attachEpoch` advanced; new `brokerInstanceId` on a new attempt; `resumed: false`; **no** successor; predecessor ack row intact | T-08504 | isolated installed daemon |
| S4a | Bridge replacement with old-bridge evidence `unknown` | **held** at `pending / host_retirement_unproven`; old attempt stays `ACTIVE`/`DETACHED`; the incoming bridge never attaches | T-08504 | isolated, negative |
| S4b | Bridge replacement while the old bridge is `writable` + `live` | `rejected / host_binding_conflict`; no second live bridge writer exists at any instant | T-08504 | isolated, negative |
| S4c | Late events from the old invocation under the same runtime | ingested and attributed to the **old** `invocationId`; the current invocation's run, obligation and continuation are unchanged | T-08504 | isolated |
| S5 | Controller restart (HRC daemon) | same binding; ACK resumes from the durable high-water mark; no duplicate projection | T-08504 | isolated installed daemon |
| S6 | Host succession with receipt | generation + 1; predecessor attempt `SUPERSEDED` with reason; predecessor runtime terminal `host_replaced`; binding `RETIRED`; continuation carried per §9.1 | T-08504 | isolated installed daemon |
| S6a | Bridge-subject evidence offered for a host succession | **refused as invalid evidence**; `subject: 'bridge'` never authorizes host replacement, even when the bridge is provably dead | T-08504 | isolated, negative — the subject-confusion gate |
| S6b | Retirement truth table | each of §3.6.4's nine cells produces its stated satisfy / hold / refuse outcome, including **retired + live → satisfied** and **unknown + dead → satisfied** | T-08504 + T-08510 | isolated, one case per cell, driven by the controlled adapter |
| S6c | Retirement satisfied but prior attempt not absorbing | **held** at `pending / participant_prior_disposition_unresolved`; evidence alone does not admit | T-08504 | isolated, negative |
| S6d | Adapter without `retireWriter`/`inspectWriter` | daemon starts normally; every non-evidence path behaves as today; the successor exit holds at `pending` indefinitely and never gains authority | T-08510 + T-08504 | isolated, negative — the no-migration-break gate |
| S6e | Receipt freshness per axis | a later `liveness: 'live'` does **not** void a receipt resting on `writePath: 'retired'`; a later `writePath: 'writable'` does | T-08504 | isolated, both directions |
| S7 | Succession attempted without a receipt | `pending / host_retirement_unproven`; address stays reserved; predecessor stays bound; **nothing** succeeds | T-08504 | isolated, negative |
| S8 | Two live conflicting hosts | second gets `rejected / host_binding_conflict` naming the live incarnation; partial unique index holds; second writes nothing | T-08504 | isolated, negative |
| S9 | PID reuse | a new incarnation id at a reused PID is treated as a new incarnation (succession path); an unchanged incarnation id across an application-internal runtime replacement is treated as the same binding | T-08504 | isolated, both directions |
| S10 | Old traffic after succession | retired-epoch control refused and recorded; retired-runtime historical events still ingest, attributed to the retired runtime, closing no successor run | T-08504 | isolated |
| S11 | Lost ACK on a possibly-written submission | outcome stays `indeterminate` across bridge replacement and daemon restart; no resend, no cancel, no manufactured failure | T-08504 + T-08502 | isolated + live |
| S12 | No cold birth at a reserved absent address | exact claim, roster claim, target-message birth and selector successor each refuse/skip; mail is pending with `host_absent`; no substitute runtime | T-08504 | isolated, all four doors |
| S12a | Reservation survives every non-release event | after establishment failure, retry exhaustion, binding terminal, operator **eviction**, and daemon restart, the address is still not free and still not cold-birthable; only the explicit release operation frees it | T-08504 | isolated, one case per row of R-4.3.4 |
| S12b | Succession never frees the address | no observable instant between predecessor `RETIRED` and successor `BINDING` at which a concurrent claim sees the scope free | T-08504 | isolated, concurrent claim against TX-6 |
| S13 | Wrong-home registration | `rejected / participant_scope_not_home` naming `homeNodeId`; no local identity minted | T-08504 | isolated |
| S14 | Daemon lost between acknowledgement and activation | the acknowledged registration is rediscovered at startup with no timer; establishment completes | **T-08349** | isolated installed daemon |
| S15 | Managed launch failure | launch intent persisted before spawn; a lost reply or crash reconciles against the persisted identity before any retry; exactly one host process and one bridge exist afterwards | T-08507 | isolated installed |
| S16 | Managed graceful stop, save succeeds | `stopped`; state present at `saveDestination` | T-08507 | isolated installed |
| S17 | Managed graceful stop, save **fails or is refused** | `stop_refused`; host left alone; `dataLoss.unsaved: 'unknown'`; failure detail reported | T-08507 | isolated, negative — the headline safety gate |
| S17a | Managed graceful stop, **timeout / no readback** | `indeterminate`; `save: 'unknown'`, `exit: 'unknown'`; HRC claims neither "running" nor "stopped", does not force, does not blindly retry | T-08507 | isolated, negative |
| S17b | Save succeeded, process did not exit | `stop_refused` with `save: 'saved'`, `exit: 'running'`, `dataLoss.unsaved: 'no'` — saved and exited are reported separately | T-08507 | isolated |
| S18 | Explicit forced close | closes and reports `dataLoss.unsaved` as `yes` / `no` / **`unknown`** per the §8.4 table; `unknown` is never reported as `yes`; never reached implicitly from S17 or S17a | T-08507 | isolated |
| S18a | Managed class declared before the §8.6 guard exists | **daemon startup refuses the class**; no managed runtime is created and no existing lifecycle reader acts on a host | T-08507 | isolated, negative |
| S18b | Managed launch adoption | the host's registration echoes the pre-committed `launchNonce`; exactly one runtime, one binding and one attempt exist; an unknown or absent nonce is rejected | T-08507 | isolated |
| S19 | Managed restart | S16/S17 semantics, then a managed launch that is an ordinary succession (generation + 1) | T-08507 | isolated installed |
| S20 | External-mode regression after managed lands | no kill, no dispose, no reap, no substitute birth, continuation preserved for `hostLifecycleOwner: 'external'` | T-08508 | live installed |
| S21 | Existing key-scoped participants unchanged | both joins still register, establish, attach, activate and survive a native restart with the same scope/session/generation | T-08504, every slice | regression |
| S22 | Legacy EPR unchanged | grant/credential/TTL/handshake behavior identical; a generic participant body is still refused by `/v1/registrations` | every slice | regression |
| S23 | No helper mints a seat | a TUI, a tool child and an internal subagent produce no HRC session, address or generation; child events close no root turn | T-08505 | live installed |

---

## 14. Explicit non-goals and refusals

- No new mail transport, addressing grammar or task schema.
- No raw thread create/fork/reset/resume API, and no host thread management.
- No interrupt or preempt capability, and no interrupt-then-apply fallback.
- No new env-gated feature flag. Feature flags are introduced at spec creation by
  the designated owner, never by an implementation seat.
- No second registration engine, second queue, second scheduler, second outbox or
  second controller.
- No change to legacy EPR, and no reuse of EPR grant linger/finalization as a
  host address lifetime.
- No change to existing `permanent-keyed` / `key-scoped` participant behavior.
- No product name, harness name or vendor branch anywhere in HRC.
- No kernel extraction release.
- No cross-host or cross-uid registration, and no new auth machinery — the
  node-local callback trust surface is unchanged.
- **No takeover of a healthy live host.** A live, writable incumbent is refused,
  in every policy and both launch modes. No token, epoch, start time, build
  identity or operator urgency converts a refusal into a takeover.
- **No host kill authority in external mode.** HRC may detach and evict its own
  attachment and nothing more, before and after managed provisioning exists.
- No reuse of existing epoch/replay primitives as if they already solved
  cross-incarnation succession, bridge-writer displacement or recovery
  disposition. They are reused as mechanism; the new distinctions are new.

---

## 15. Limitations of this revision

1. **Not approved.** Rev 2 is proposed pending Daedalus. Nothing here authorizes
   implementation.
2. **No runtime acceptance is claimed.** Every statement about current behavior
   is source reading at `e5ef5781`, re-checked against `5f1a302d`, not execution. Section 13 assigns proofs; it
   does not report them.
3. **The ASP surfaces in §3.3 and §3.6 do not exist.** Verified against the
   published tarballs of the locked tuple `0.1.1-dev.20260914194358`, not against
   `node_modules`, which is stale at `0.1.1-dev.20260909165248` in this checkout.
   Field and method names are this contract's proposal; the producing repository
   settles them under T-08510.
4. **Managed mode is specified and unsupported.** §8.6's host-aware guard does
   not exist, so a managed class is refused at daemon startup. Nothing here
   authorizes half-enabling it by omitting the external marker.
5. **§4.3's door enumeration is a grep result, not a completeness proof.** The
   implementing task must re-run the enumeration at its own baseline.
6. **Every successor exit depends on T-08510 landing.** Until it does, both
   policies' participant-served successor exits hold at `pending`. If the
   delivered seam cannot express one of §3.6.2's three facts, the implementing
   seat reports the missing capability rather than substituting a local
   inference — an unprovable retirement is a stall, not a relaxation.
7. **Phase 5 final-tail completeness remains unclaimed**, unchanged from the
   active invariant.
8. **Disjointness with T-08349 depends on that closure landing as written.** If
   the closure's scope narrows, the items in §2.3 revert to being absent and this
   contract's dependent sections (§4.3, §5.4, §10.1) need re-scoping rather than
   silent adoption.
