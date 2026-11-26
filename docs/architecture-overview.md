# HRC runtime architecture

HRC owns execution identity, runtime and broker attachment, and the durable
history of sessions and turns. Agent-spaces owns agent declaration,
provisioning and execution preparation. ACP owns the external gateway to
Discord and iOS. wrkq owns tasks, conversations and collaboration obligations.

## Execution boundary

Agent-spaces selects the execution release through aspd. HRC commits the
preparation and hosting intent before it starts a broker. A broker stays bound
to its prepared ASP release, so a new aspd release can prepare new work while
existing workers continue. HRC projects committed broker envelopes into its
ledger and session state. A broker's admission receipt does not prove a turn
completed. See the [prepared execution invariant](../architecture/records/invariants/hrc-runtime.aspd-prepared-execution-release.yaml).

The native owner, `rusthrc`, serves the Unix-socket HTTP API and enforces
placement and runtime authority. Its CLI release and daemon release are
selected independently. A daemon change reaches the running process through
owner deployment and authorized activation. Read the running source commit
as described in the [fleet deployment guide](fleet-deployment.md).

## Observation and ownership

Praesidium owns the unified read document, seat attachment discovery and
agent command declarations. HRC serves the owner operations and the durable
ledger behind that document. The document can be rebuilt from its owners
without transferring their write authority. Addressed mail is presented by
the Praesidium kernel's mail-delivery module. See the
[kernel inspection contract](operations-runbook.md#kernel-inspection-contract).

External participants retain host process authority when they register an
address with HRC. HRC manages the continuity and can observe or disconnect a
participant without claiming its process. A self-brokered declaration is the
case where HRC provisions the terminal child and it serves the broker
protocol. See the [host participant contract](../architecture/contracts/host-participant-lifecycle.md)
and [self-brokered launch contract](../architecture/contracts/self-brokered-seat-launch.md).

The [crate dependency invariant](../architecture/records/invariants/hrc-runtime.rust-crate-edges.yaml)
records the native boundaries. The [development workflow](development-workflow.md)
explains how the Bun package checks enforce cross-repo dependency rules.
