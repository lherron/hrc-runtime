# HRC runtime documentation

The [operations runbook](operations-runbook.md) covers the running service.
The [architecture index](../architecture/README.md) explains the
machine-checked records and how to regenerate their summaries.

## Workflows and operations

| Document | Kind | Code | Grader |
| --- | --- | --- | --- |
| [Architecture boundaries](architecture-overview.md) | guide | | |
| [CLI workflows](cli-reference.md) | guide | | |
| [Target handles](target-handles.md) | spec | `crates/hrc-common/src/scope.rs`, `crates/hrc-cli/src/selectors.rs`, `crates/hrc-cli/src/monitor/selector.rs` | `crates/hrc-cli/e2e/differential.py` |
| [Development workflow](development-workflow.md) | guide | | |
| [Operations runbook](operations-runbook.md) | guide | | |
| [Fleet deployment](fleet-deployment.md) | guide | | |
| [Atomic CLI installs](atomic-install.md) | guide | | |
| [Verdaccio authority](wave-b-registry.md) | guide | | |
| [State retention](state-retention.md) | guide | | |
| [Registry rebuild and cache refresh](federation-binding-registry-rebuild.md) | guide | | |
| [Ordered registry retirement](federation-registry-retirement.md) | spec | `crates/hrc-native/src/server/placement/federation/retirement.rs`, `crates/hrc-native/src/server/placement/federation/registry_listener.rs` | `crates/hrc-native/e2e/retirement_parity.py`, `crates/hrc-native/e2e/retirement_remote_parity.py` |
| [Isolated daemon smoke](isolated-daemon-smoke-recipe.md) | guide | | |
| [Broker admission smoke](urgent-turn-smoke.md) | guide | | |
| [Verify the restart-self callback](../crates/hrc-native/e2e/n2_restart_self.md) | guide | | |
| [Native workflow tests](../crates/hrc-native/e2e/README.md) | guide | | |
| [CLI workflow tests](../crates/hrc-cli/e2e/README.md) | guide | | |
| [Cardo conformance profile](../conformance/hrc/README.md) | guide | | |
| [Native daemon and turn admission](../crates/hrc-native/README.md) | guide | | |
| [Native CLI maintenance](../crates/hrc-cli/README.md) | guide | | |
| [Per-seat PTY lifecycle](../crates/hrc-pty/README.md) | guide | | |
| [Verification traps](verification-traps.md) | guide | | |
| [Rules and their checks](rule-enforcers.md) | guide | | |
| [Test doubles and producer fixtures](test-doubles.md) | guide | | |
| [Lint and type suppressions](suppression-policy.md) | guide | | |

## Contracts

| Document | Kind | Code | Grader |
| --- | --- | --- | --- |
| [Host participant lifecycle](../architecture/contracts/host-participant-lifecycle.md) | spec | `crates/hrc-native/src/server/broker/participants/**`, `crates/hrc-store/src/participants.rs`, `crates/hrc-native/src/server/placement/runtime_views.rs` | `crates/hrc-native/e2e/participant_*.py`, `crates/hrc-native/e2e/participants.py` |
| [Self-brokered seat launch](../architecture/contracts/self-brokered-seat-launch.md) | spec | `crates/hrc-native/src/server/broker/participants/**`, `crates/hrc-native/src/server/broker/lease.rs` | `crates/hrc-native/e2e/self_brokered.py`, `crates/hrc-native/e2e/self_brokered_lifecycle.py` |
| [Session and turn project events](../architecture/contracts/session-project-events.md) | spec | `crates/hrc-native/src/server/lifecycle/publication.rs` | `crates/hrc-native/e2e/n3_publication.py` |
| [Federation peer HTTP](federation-peer-protocol.md) | spec | `crates/hrc-native/src/server/placement/federation/**` | `crates/hrc-native/e2e/n4_federation.py`, `crates/hrc-native/e2e/peer_events_page.py` |
| [Lifecycle event tail](lifecycle-event-tail.md) | spec | `crates/hrc-native/src/server/projection/lifecycle_events.rs`, `crates/hrc-store/src/events.rs` | `crates/hrc-native/e2e/n3_events.py`, `crates/hrc-native/e2e/events_kind_filter.py` |
| [Monitor contract](monitor-spec.md) | spec | `crates/hrc-cli/src/monitor/**`, `crates/hrc-store/src/monitor_read.rs` | `crates/hrc-cli/e2e/monitor_idle.py`, `crates/hrc-cli/e2e/differential.py` |
| [Federated input and interrupt](../architecture/contracts/federated-input-interrupt.yaml) | record | | |
| [Native Rust ownership and migration](../architecture/contracts/hrc-rust-migration.yaml) | record | | |
| [Participant host requests](../architecture/contracts/participant-host-requested.yaml) | record | | |
| [Praesidium surface](../architecture/contracts/praesidium-surface.yaml) | record | | |
| [Runtime context reading](../architecture/contracts/runtime-context-reading.yaml) | record | | |
| [Runtime created](../architecture/contracts/runtime-created.yaml) | record | | |
| [Runtime settled](../architecture/contracts/runtime-settled.yaml) | record | | |
| [Seat annotations](../architecture/contracts/seat-annotations.yaml) | record | | |
| [Seat asks](../architecture/contracts/seat-asks.yaml) | record | | |
| [Seat streams](../architecture/contracts/seat-streams.yaml) | record | | |
| [Turn attention](../architecture/contracts/turn-attention.yaml) | record | | |

## Decisions and retained citations

| Document | Kind | Code | Grader |
| --- | --- | --- | --- |
| [Architecture records](../architecture/README.md) | guide | | |
| [Adopting durable architecture records](../architecture/adr/0001-adopt-durable-architecture-records.md) | decisions | | |
| [Active invariants](../architecture/INVARIANTS.md) | record | | |
| [Accepted risks](../architecture/RISKS.md) | record | | |
| [Agent enablement ledger](agent-enablement-changelog.md) | record | | |
| [Rust migration adoption](proposals/hrc-rust-migration.md) | record | | |
| [Praesidium data taxonomy](proposals/praesidium-document.md) | record | | |
| [Praesidium kernel separation](proposals/praesidium-kernel.md) | record | | |
| [Seat asks design and revisions](proposals/seat-asks.md) | record | | |

## Diagrams

| Document | Kind | Code | Grader |
| --- | --- | --- | --- |
| [Session runtime diagram guide](../architecture/diagrams/session-runtime-view/README.md) | guide | | |
| [Session runtime view](../architecture/diagrams/session-runtime-view/session-runtime-view.arris.json) | diagram | | |
| [Seat and taxonomy board guide](../diagrams/README.md) | guide | | |
| [Seat data baseline](../diagrams/seat-data-as-is.arris.json) | diagram | | |
| [Seat data proposed ownership](../diagrams/seat-data-to-be.arris.json) | diagram | | |
| [Seat document](../diagrams/seat-data-document.arris.json) | diagram | | |
| [Seat document with questions](../diagrams/seat-data-document-seat-questions.arris.json) | diagram | | |
| [Seat data model](../diagrams/seat-data-model.arris.json) | diagram | | |
| [Seat data model with questions](../diagrams/seat-data-model-seat-questions.arris.json) | diagram | | |
| [Keyed seat questions](../diagrams/seat-data-question-keyed.arris.json) | diagram | | |
| [Taxonomy subjects](../diagrams/taxonomy-subjects.arris.json) | diagram | | |
| [Taxonomy alternate layout](../diagrams/taxonomy-subjects-inside.arris.json) | diagram | | |
