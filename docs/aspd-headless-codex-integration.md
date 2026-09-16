# HRC headless Codex preparation through aspd (T-08542)

Status: implementation spec for T-08542, pending Daedalus architecture
verification. Governing design: `asp-hrc-split-proposal.md` at `bf3e539e`
(Daedalus APPROVE EN-12789, R-00095), migration step 3 ("prove one complete
execution path with frozen HRC"). Producer prerequisite: agent-spaces T-08539
(`docs/aspd.md`, scope EN-12854/EN-12856, acceptance C-23052). Brief: EN-12894.

This is one production path, validated in isolation. It is not the ASP/HRC
migration, a shared-host rollout, or a new lifecycle state machine.

## 1. Route and configuration

**Route.** HRC-hosted headless Codex: a non-interactive runtime intent whose
compile profile selector is `brokerDriver: codex-app-server`, with operator
presentation policy `none` (no `tmux-tui` viewer). Nothing else changes route.

**Configuration.** `HRC_ASPD_SOCKET` names the node-local aspd Unix endpoint
(absolute path; the daemon's own environment, read at each preparation, never
cached). It is endpoint configuration, not a flag: when it is set, this route's
preparation service IS that endpoint; when unset, every route, including this
one, keeps its existing behavior (in-process-spawned stdio `aspc-facade`
resolved by `hrc-runtime.asp-toolchain-selection`). A relative or empty value
is a configuration error on this route, not "unset".

Every other route (interactive tmux, the codex `tmux-tui` viewer route, pi-sdk,
participant registration/establishment, previews, catalog/inspection) is
untouched and keeps its facade/toolchain selection.

**No fallback.** On this route with the endpoint configured, aspd
unavailability, protocol/capability incompatibility, an unidentified service
release, or a compile result without `executionRelease` is a named error
before any hosting effect. HRC never reaches the bundled facade, a toolchain
root, a per-binary override, or source for this route.

## 2. Wire use (existing contract only)

Published by agent-spaces `0.1.1-dev.20260916121635` (canonical, source
`d461e7f1`), consumed through one HRC lock advance (`14927d42`).

| Step | Method | HRC requirement |
| --- | --- | --- |
| Connect | `spaces-aspc-protocol/unix-client` `AspcUnixClient.connect` | Named `aspc_service_unavailable` when nothing listens |
| Negotiate | `aspc.hello` (every connection) | `protocolVersion === 'aspc/0.1'`; `capabilities.compileHarnessInvocation === true`; `transports` includes `unix-jsonrpc-ndjson`; `release` present. **Not** `cohostedBroker` and **not** `compileAndStart` |
| Prepare | `aspc.compileHarnessInvocation` with the existing request HRC builds today | Existing `compileBrokerRuntimePlan` verification unchanged; `executionRelease` required on `ok` |
| Close | — | The connection is closed after the one compile. HRC holds no resident compiler connection, so aspd activation cannot be pinned by HRC |
| Worker | `broker.hello` → `invocation.start` → existing attach/control/replay | `hello.protocolVersion === executionRelease.worker.protocol` and `hello.release` equals the frozen release identity, checked before `invocation.start` |

No new verb, required field, version bump or replacement payload. HRC does not
retry an ASPC request on close (the thin client never does either).

## 3. Durable state map

Reused records; one additive column. No new table, no universal lifecycle.

| Fact | Record | Written at |
| --- | --- | --- |
| Frozen preparation: aspd endpoint, service hello identity (protocol, release), the complete unchanged `compileHarnessInvocation` ok response (plan, selectedProfile, startRequest, dispatchRequest incl. dispatchEnv, diagnostics, executionRelease), HRC admission results (profile hashes, identity allocation), HRC dispatch environment and lifecycle policy overlay, the exact worker launch description (executable, argv, socket/ledger/token/stderr paths, tmux socket/session), the dispatch idempotency key | `runtime_operations.preparation_json` (new nullable TEXT column) on the attempt's `operation_id` row | Boundary P |
| Attempt progress for this route | `runtime_operations.status`: new value `prepared`; then the existing `starting` → `completed`/`failed` | P; B4 (existing); after start (existing) |
| Last pre-start refusal of a frozen preparation | `runtime_operations.error_code/error_message` while status stays `prepared` | On refusal |
| Plan projection | `compiled_runtime_plans` (existing insert, now at P for this route) | P |
| Runtime/run/invocation start graph, hosting endpoint/substrate, negotiated protocol | existing `persistStartGraph` rows | B4 (existing position: after hello, before `invocation.start`) |
| Per-runtime execution release (frozen release + actual worker hello release) | `runtimes.runtime_state_json.broker.executionRelease` | B4, then the post-start runtime state write |
| Uncertain start | `preparation_json.startOutcome = 'uncertain'` in addition to the existing failure projection | When `invocation.start` fails at transport level after being sent |

Status of a frozen attempt is therefore read from durable rows only:

| Durable state | Meaning | Retry/recovery rule |
| --- | --- | --- |
| op `prepared`, no runs/runtime row for the attempt | Never submitted. No `invocation.start` was ever sent (the start graph, status `starting`, commits before it). Hosting effects may or may not have happened | Launch from the frozen record only (§5). Never re-prepared, never rebound to the active release |
| op `starting`/`failed` with `startOutcome: uncertain` | `invocation.start` sent, outcome unknown | Stays uncertain. No automatic replay; an idempotent retry finds the run row and replays the existing record (existing behavior) |
| op `completed` | Started | Existing control/reattach |

## 4. Ordering for a new preparation

Transactions are single SQLite writes; effects happen only between them.

0. **Authority (unchanged).** Session resolution, participant-address backstop,
   actuator-split preparation, runtime id, HRC dispatch env composition,
   continuation selection, dispatch idempotency lookup of existing runs.
1. **Prepare (effect: aspd RPC).** Connect → hello requirements → compile →
   close. Errors: `aspd_unavailable`, `aspd_protocol_incompatible`,
   `aspd_capability_missing`, `aspd_release_unidentified`,
   `aspd_connection_closed` (explicitly not retried). Preparation starts no
   worker and no native harness.
2. **Admit (pure).** Existing `compileBrokerRuntimePlan` hash/identity/profile
   checks, then: `executionRelease` present (`execution_release_missing`);
   selected profile is headless `codex-app-server`
   (`aspd_route_profile_mismatch`); existing permission-policy and
   actuator-split admission.
3. **Boundary P — freeze preparation + hosting intent.** One transaction inserts
   the `compiled_runtime_plans` row and the `runtime_operations` row with status
   `prepared` and the complete `preparation_json`, including the launch
   description computed from the frozen release and HRC's deterministic hosting
   paths. After this commit the attempt is bound to that release.
4. **Launch the frozen attempt** (§5), reading the row back by `operation_id`.

## 5. Launching a frozen attempt (fresh or resumed)

Input is only `operation_id`. The code path reads `preparation_json` from the
database; nothing prepared in memory is passed through.

1. **Validate from persisted bytes, before effects.**
   `<releaseRoot>/release.json` readable and naming `releaseId`+`sourceCommit`
   (`release_unavailable` / `release_identity_mismatch`); realpath of
   `worker.executable` inside realpath of `releaseRoot`
   (`worker_executable_outside_release`); `worker.protocol` is a protocol HRC
   supports (`harness-broker/0.2`, `unsupported_worker_protocol`); the frozen
   argv equals `worker.argvPrefix` + HRC's hosting flags
   (`launch_description_mismatch`); session generation still equals the frozen
   generation (`preparation_generation_superseded`). A refusal writes
   `error_code` on the op, leaves it `prepared`, and launches nothing.
2. **Realize resources (effect).** The existing leased-tmux headless substrate
   allocator, with the broker command rendered from the frozen executable/argv
   (no `resolveBrokerBinary`, no driver-name lookup, no PATH, no `current`, no
   override/root/bundled resolution). A leftover lease for this runtime id from
   an interrupted earlier launch of the same never-submitted attempt is
   released first; this is safe because status `prepared` proves no
   `invocation.start` was sent.
3. **Handshake before invocation.** Existing hello (HRC offers only
   `harness-broker/0.2`); then `hello.protocolVersion === worker.protocol`
   (`worker_protocol_mismatch`) and `hello.release` deep-equals the frozen
   identity (`worker_release_unidentified` / `worker_release_mismatch`).
   On refusal HRC closes the client, releases the lease it just realized,
   records the refusal on the op, and sends no `invocation.start`. Existing
   capability, response-format and lifecycle-policy admission follow unchanged.
4. **Boundary B4 — freeze complete dispatch (existing).** `persistStartGraph`
   with the op row UPDATED (not inserted) to `starting`, plus
   `runtime_state_json.broker.executionRelease`. The existing `onAccepted`
   hook runs here.
5. **Establish (existing).** `invocation.start` with the frozen
   `startRequest`, the frozen dispatch env and lifecycle policy overlay, then
   the existing admission, runtime state, event consumption, attach/control,
   projection and ACK paths. A transport failure after send records
   `startOutcome: 'uncertain'`; nothing replays it.

**Resume.** A never-submitted preparation is resumed only by an explicit caller
retry of the same dispatch: the same host session and `idempotencyKey` (e.g.
`hrc start --idempotency-key K -p …`, which already carries retry identity).
The turn-dispatch door looks up a `prepared` op for that key before allocating
a new run id, reuses the frozen run/runtime identity, and goes straight to §5
without contacting aspd. It is never auto-launched at startup: the caller of
the original request may already have treated it as failed, and launching it
unasked would deliver an input nobody is waiting for. A retry after B
activation therefore runs A; a retry after the frozen release is missing is
refused `release_unavailable` again and stays visible.

## 6. Existing workers, reattach and restart

- Warm turns, steer/enqueue/invoke, interrupt, stop, snapshot, replay and ACK
  use the persisted endpoint exactly as today. None touches aspd.
- Daemon-restart and dispatch-time reattach use persisted endpoint, attach
  token ref, identity fences and projection cursor (unchanged). For a runtime
  whose `runtime_state_json.broker.executionRelease` exists, reattach first sends
  `broker.hello` on the candidate connection and requires the same protocol and
  release identity; a mismatch refuses attachment with
  `broker_reattach_release_mismatch` (existing stale-classification path), never
  a silent attach. No preparation and no aspd connection are on this path.
- The orphan lease sweep, lease re-association, stale classification and
  cleanup semantics are unchanged.

## 7. Operator readback

- `hrc server status --json` gains `aspd`: `{ configured, endpoint, reachable,
  protocolVersion?, release?, error? }` from a bounded, closed-after-use
  `aspc.hello` probe. This is the **active preparation release**. The existing
  `aspToolchain` projection (bundled/root/override selection for other routes)
  is unchanged and distinct.
- Per runtime, `runtime_state_json.broker.executionRelease` (frozen release,
  `releaseRoot`, worker executable, `helloRelease`) is the **attempt execution
  release**, visible in existing runtime inspect/list JSON.
- Frozen preparations are readable from `runtime_operations.preparation_json`
  and status (evidence reads use the state DB snapshot, not HRC memory).

## 8. Invariant changes

**Amend `hrc-runtime.asp-toolchain-selection`** (scope + predicate): the spawn
selection authority governs every ASP child spawn EXCEPT the aspd-prepared
headless codex route when `HRC_ASPD_SOCKET` is configured. On that route HRC
spawns no ASP compiler child, and the worker executable and argv prefix are the
committed `executionRelease` persisted at boundary P; the per-binary override,
`HRC_ASP_TOOLCHAIN_ROOT` and bundled resolution are never consulted and there is
no fallback. Toolchain status continues to describe the resolver for the other
routes and is distinct from the aspd service projection.

**New `hrc-runtime.aspd-prepared-execution-release`:** for the route above,
preparation happens only through the configured aspd endpoint with a
per-preparation connection that negotiates `aspc/0.1` + compile capability +
release identity; the complete ok response, execution release, launch
description, HRC dispatch env and lifecycle overlay commit before any hosting
effect; launch validates only persisted bytes; worker hello protocol and release
must match before `invocation.start`; a `prepared` op is never rebound to
another release, never re-prepared, never auto-launched, and is resumed only by
a same-key caller retry; an uncertain start stays uncertain; reattach and
control never require aspd and verify release identity on hello.

Preserved without amendment: participant lifecycle (not on this route),
broker admission client (HRC caller policy and submission doors unchanged),
committed observation control (projection-before-ACK unchanged), continuation
history (HRC continuation selection unchanged), viewer sidecar (the viewer
route keeps the facade), observable release (HRC identity unchanged).

## 9. Deliberate limits

- `RuntimeCompileRequest` construction, runtime-intent assembly and config
  interpretation stay in HRC (deferred).
- No durable start receipt on this path; lost-start-reply safe retry is
  unproven and not claimed. No compiler-output hashes, no participant
  identity/ensure changes.
- Bundled ASP packages remain in HRC's closure for other routes; no dependency
  removal, extraction, all-harness migration, fleet rollout, flags or release GC.
- Broker-side enforcement of `executionRelease` remains absent; HRC's
  pre-launch and hello checks enforce the binding.

## 10. Acceptance (isolated, installed)

One built HRC artifact from a linked-worktree install (worktree channel, no
wrapper cutover), one `hrc server serve` process with isolated
`HRC_RUNTIME_DIR`/`HRC_STATE_DIR`/socket and `HRC_ASPD_SOCKET`, an isolated
aspd namespace with staged copies of A and B, real Codex, driven from a clean
Ghostty terminal through ghostmux with real `hrc` CLI operations.

1. H+A: cold headless start + real turn; second real turn on that worker.
2. Activate B (same endpoint, same HRC pid/artifact/lock): fresh scope prepares
   on B, worker hello B, real turn; warm real turn on the A worker; aspd socket
   peers show no HRC connection held across activation.
3. Prelaunch boundary: with A active and A's release directory withheld,
   `hrc start --idempotency-key K` freezes an A preparation and is refused
   `release_unavailable` (op `prepared`, no worker). Activate B, restore A,
   retry K: the frozen A preparation launches an A worker (hello A) and
   completes a real turn; a new un-keyed scope still prepares on B.
4. Stop aspd: new preparation reports `aspd_unavailable` with no fallback;
   A and B workers complete real turns. Roll back to A: new preparation is A;
   the B worker still completes a turn.
5. Refusals before native invocation: unavailable release, incompatible
   protocol (service and worker), worker release mismatch; frozen preparation
   bytes unchanged afterwards.
6. Separate recovery leg after 1–5: restart the same HRC artifact with A and B
   workers live and aspd stopped; both reattach with identities, release hello
   match and event continuity, and take real turns; a second never-submitted
   preparation frozen before the restart launches from readback after it.
7. Gates: `just verify` (or its stages), targeted tests, architecture records.
