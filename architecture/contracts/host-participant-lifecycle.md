# Host participant lifecycle

HRC owns the participant address, continuity, registration, attempt allocation
and activation. The participant owns its native conversation. For an external
participant, the host process and its broker are externally owned. The
[self-brokered launch contract](self-brokered-seat-launch.md) defines the case
where HRC starts the process while the participant serves the broker protocol.

The [participant session lifecycle invariant](../records/invariants/hrc-runtime.participant-session-lifecycle.yaml)
records the governing approvals and acceptance requirements. Its authority
includes the direct-join revision (T-08504), key-scoped retirement (T-10146),
participant-owned continuation selection (T-11435), absence-only exhaustion
reporting (T-12431) and the self-brokered exception (T-13434).

## 1. Address and direct registration

`POST /v1/participants/register` requires `registrationMode: "direct"` and a
scope and host incarnation. The scope is reserved before a descriptor appears
or the broker attaches. Class and participant key are optional metadata, and
an absent workspace stays absent. HRC admits the join without an ASP adapter or
continuity-evidence file. `processToken` is accepted as opaque compatibility
input and grants no replacement authority. See
`crates/hrc-native/src/server/broker/participants/mod.rs#parse_registration`
and `crates/hrc-store/src/participants.rs#Store.register_direct_participant`.

Federated placement establishes authority before allocating anything locally.
On the wrong node, the join returns HTTP 409 with the placement reason and
`observed.homeNodeId`. Resolve the reported home and submit the same scope
and incarnation there. A missing or unreachable authority leaves registration
pending. A lost success response converges when the same request is repeated
at the home. See
`crates/hrc-native/src/server/broker/participants/mod.rs#join`.

The address reservation belongs to the registration. Its binding identifies
an incarnation, and its attempt identifies one invocation and attach epoch.
Succession transfers the reserved address. Eviction, detachment and a
terminal attempt leave the reservation held. An ordinary HRC birth cannot
substitute for an unavailable external participant.

## 2. Attachment and establishment

Registration reserves the runtime identity. The runtime row appears after
attachment provides real broker facts. An `IDENTITY_MINTED` attempt without a
descriptor is recoverable as an unused allocation and consumes no work retries.
The participant submits a `ParticipantBrokerDescriptor` through
`POST /v1/participants/attach`, identifying the registration, attempt and
attach epoch. The endpoint is supplied at registration or attachment.
HRC validates descriptor identity, start request, hashes and environment
before freezing it. A matching retry preserves the frozen request and retry
budget. A conflicting descriptor requires a replacement.

The first successful freeze transitions the attempt to `PREPARED` and arms
durable work. Before realization HRC persists hosting intent. It then records
actual leases and persists the composed dispatch before sending the initial
ensure. A restart can discover prepared work with hosting intent and pending
replacement intent. A missing descriptor or an unavailable hosted half never
permits HRC to invent a workspace, credential or runtime. See
`crates/hrc-native/src/server/broker/participants/mod.rs#attach_core`,
`crates/hrc-store/src/participants.rs#Store.freeze_participant_descriptor`,
`crates/hrc-store/src/participants.rs#Store.pending_participant_work` and
`crates/hrc-native/src/server/broker/participants/establishment.rs#run`.

Identity installation, resident invocation establishment, attach confirmation
and HRC activation are separate operations. The immutable tuple and the
broker's durable receipt let the owner recover a lost response without starting
the driver twice. A started receipt without a resident invocation is
indeterminate until the broker reconciles it. HRC exposes the receipt state,
failure and indeterminate reason. Activation requires the current attempt's
confirmed attach and classifies continuity as `attached_unknown`. See
`crates/hrc-native/src/server/broker/participants/establishment.rs#establish`
and `crates/hrc-store/src/participants.rs#Store.activate_participant`.

## 3. Continuation and succession

Registration persists and returns the continuation decision with the allocation.
Direct joins accept `continue` (the default) or `fresh`. Continue uses HRC's
stored continuation, clear barriers and reuse policy. Fresh selects no
continuation, leaves reuse policy available to later successions, and never
forces the participant to prove its conversation lineage. The normalized
choice binds replacement retries. A participant that cannot resume can report
`resumeUnsupported: true` with a reason. HRC keeps the selected record and
leaves addressed work pending.

The descriptor must agree with the selected continuation. Recheck its validity
before the first freeze. A mismatch or invalidated selection cannot silently
rewrite a persisted descriptor. A registration or an accepted attach can
describe a resume request. Only producer evidence can establish native resume.
The self-brokered launch contract permits that launcher to decline an offered
continuation by omitting it. See
`crates/hrc-native/src/server/broker/participants/mod.rs#continuation_agreement`
and `crates/hrc-store/src/participants.rs#registered`.

A same-host bridge replacement preserves the session, generation and runtime
while advancing the invocation, attempt and attach epoch. A host succession
allocates a new session, generation and runtime. Late committed evidence still
belongs to its old invocation. It cannot mutate a successor's run, continuation
or control state. Unresolved writes remain independently broker-fenced. HRC
does not resend them or manufacture a terminal result. Replay for the
successor is released after its activation and reconciliation or explicit
abandonment of predecessor recovery.

For an attached external predecessor, `expectedPredecessor` fences the
observed binding. HRC opens a fresh connection to its durable endpoint and
requires the published broker hello within a bounded probe. Missing or
refused transport records `transport_dead`. A successful hello refuses with
`host_binding_conflict`. An inconclusive probe leaves an inert pending
`host_retirement_unproven` disposition. Treating dead transport as writer death
for this class was a provisional ruling. Keep the durable evidence so a
live-but-disconnected host remains diagnosable. See
`crates/hrc-native/src/server/broker/participants/establishment.rs#observe_transport_evidence`
and `crates/hrc-store/src/participants.rs#register_direct`.

An unused `IDENTITY_MINTED` predecessor with no descriptor, endpoint, broker
identity or runtime can be superseded by a different incarnation. A supplied
predecessor must still match. The serialized disposition records
`pre_attach_superseded` with unknown process liveness. There is no broker
recovery to perform. A later transaction retires the old binding and allocates
the successor without exposing an unreserved intermediate address. The
disposition and recovery gates are independent. A producer-authored terminal
and a retired write path carry different evidence.

## 4. Addressed work and operator observation

Participant resolution comes before ordinary runtime intent and provisioning.
An active attempt sends queue and steer through the existing broker submission
doors using the current generation, runtime, invocation and attach epoch.
An unavailable, establishing or detached attempt leaves addressed work pending
or returns a typed refusal. A caller's intent cannot rotate an external
participant or authorize a substitute launch. Broker acceptance and visibility
at the terminal are separate observations. See
`crates/hrc-native/src/server/broker/participants/delivery.rs#resolve` and the
[host request contract](participant-host-requested.yaml).

Loss of HRC's connection detaches its observation of an external participant.
The reservation and continuation survive and a successful reconnect restores
the broker-reported status. Operator eviction closes the HRC runtime and
retires its HRC attachment. It preserves the external process, its presentation,
placement and continuation. A saved token cannot be revoked inside an external
broker by HRC alone. The old attempt is refused even after owner restart.

`POST /v1/runtimes/inspect` reports
`participant_establishment_exhausted` (HTTP 409) when the queried runtime row
is absent and its attempt has exhausted establishment. It includes the
runtime, attempt and invocation IDs, retry count and last error. An existing
runtime row keeps its normal inspection view. An unknown ID with no exhausted
attempt remains HTTP 404. Exhaustion grants no retirement, succession or
reservation release. See
`crates/hrc-native/src/server/placement/runtime_views.rs#inspect`.

## 5. Verification

Use the native participant workflows for direct registration and attachment,
succession, disposition, operator eviction and externally served input.
The discriminators are the committed attempt and binding identities, receipt
and replay state, and observed runtime or broker behavior. A registration or
attach response alone does not prove input delivery.
