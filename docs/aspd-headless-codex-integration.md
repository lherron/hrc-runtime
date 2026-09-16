# HRC headless Codex preparation through aspd (T-08542)

Status: implementation spec for T-08542; Daedalus APPROVE EN-12902 (records
`248138b9`). Governing design: `asp-hrc-split-proposal.md` at `bf3e539e`
(Daedalus APPROVE EN-12789, R-00095), migration step 3 ("prove one complete
execution path with frozen HRC"). Producer prerequisite: agent-spaces T-08539
(`docs/aspd.md`, scope EN-12854/EN-12856, acceptance C-23052). Brief: EN-12894.

This is one production path, validated in isolation. It is not the ASP/HRC
migration, a shared-host rollout, or a new lifecycle state machine.

Amendment (T-08553, shared max3 rollout; Lance-selected per-request option,
EN-12917): §1.1 adds a per-request operator-presentation choice so the route can
be requested on a node whose defaults send Codex elsewhere (max3: the Codex
interactive redirect is enabled and the headless presentation default is
`tmux-tui`). It changes no
preparation, persistence-ordering, launch, release-binding or reattach rule
below.

Amendment (T-08554, Codex app-server viewer on this route; released by Astra
EN-12934 under Lance's standing authorization EN-12932): §1.2 lets a request
explicitly select the headless codex-app-server with HRC's existing attached
`tmux-tui` renderer viewer, prepared through aspd and bound to the same
execution release as its worker. It is not the standalone interactive Codex
CLI/tmux backend (the `codexTui` interactive broker), does not change any
omitted-request default, and adds no ASPC verb, flag or wire field.

## 1. Route and configuration

**Route.** HRC-hosted headless Codex: a non-interactive runtime intent whose
compile profile selector is `brokerDriver: codex-app-server`, with EFFECTIVE
operator presentation `none` (no `tmux-tui` viewer), or (T-08554, §1.2) with
presentation `tmux-tui` selected by an explicit request. The effective
presentation is the request's explicit choice when present (§1.1, §1.2),
otherwise the node default `HRC_CODEX_APP_SERVER_OPERATOR_PRESENTATION`; a
node-default `tmux-tui` is not on this route. Nothing else changes route.

### 1.1 Per-request operator presentation (T-08553)

**Carrier.** The existing `HrcRuntimeIntent.presentation` object
(`HrcPresentationIntent`, today `{ viewerWindow? }`) gains one optional field,
`operator?: 'none'`. As amended by T-08554 (§1.2) it also accepts `'tmux-tui'`,
which selects the app-server viewer; the rules below for `none` are otherwise
unchanged. No flag, no ASP wire change, no new endpoint.

**Doors.** The same intent every start/dispatch door already accepts, so the
HTTP API takes `intent.presentation.operator` where it takes
`intent.presentation.viewerWindow`. The CLI door is `hrc start <scope>
--no-viewer` (beside the existing `--viewer-window`). It is not offered on
`hrc run` or attach, which are interactive by definition.

**Precedence.** Two node defaults can keep a Codex request off this route; an
explicit choice overrides both for that request only, and an omitted choice
leaves both byte for byte as today:
1. *Codex interactive redirect* (`HRC_CODEX_CLI_TMUX_BROKER_ENABLED`, the
   `codexRedirect` normalization in turn dispatch, which rewrites every Codex
   dispatch without a `responseFormat` into the interactive codex-tui broker
   shape). `operator: 'none'` exempts the dispatch exactly as T-08338's
   `responseFormat` already does: the intent stays headless. The Claude
   interactive redirect is NOT exempted (see validation).
2. *Headless presentation default* (`HRC_CODEX_APP_SERVER_OPERATOR_PRESENTATION`,
   `decideCodexAppServerPresentation`, used by this route's selector
   `aspdHeadlessCodexEndpoint` and by the existing headless handler):
   `operator: 'none'` → `none`; omitted → the node default. The decision stays
   driver-gated: any other broker driver already resolves `none`.

**Validation (refusals, before any runtime, operation or hosting effect;
`malformed_request` (400) with `field: presentation.operator` unless named):**
- any value other than `'none'`;
- `operator: 'none'` together with `presentation.viewerWindow` (a placement for a
  viewer the request declined);
- `operator: 'none'` on an intent that is interactive (`harness.interactive:
  true` or `preferredMode: interactive`), or that the Claude interactive broker
  redirect normalizes into an interactive route, or that otherwise does not
  resolve to the headless broker route: refused
  `presentation_operator_unsupported`. The choice is honored only on the
  headless broker route.

**Persistence.** The choice is part of the applied intent
(`lastAppliedIntentJson.presentation.operator`). The executed decision is
recorded in the operation's `route_decision_json` as `operatorPresentation`
plus `operatorPresentationSource: 'request' | 'node-default'`, and the launched
runtime's durable hosting state records `presentation.kind: 'none'` (existing).
On this route the frozen preparation (§3) already fixes the hosting; a same-key
resume (§5) launches that frozen preparation and does not re-evaluate the
presentation choice or node default.

**Existing scope.** The choice governs only a NEW execution. It never changes a
live worker's hosting, frozen release or presentation:
- request `none`, live runtime of the scope whose presentation is not `none`
  — a headless runtime with a `tmux-tui` viewer, or a live interactive tmux
  broker surface (the runtime the existing headless→interactive reuse deferral
  would deliver into): refused `presentation_conflict` before delivery, no
  stale-marking, no reprovision, runtime untouched. The caller terminates that
  runtime explicitly if it wants a no-viewer execution;
- request `none`, live headless runtime already `none`: delivered normally;
- omitted choice: never a conflict; delivered to whatever runtime is live
  (its established presentation is preserved);
- no live runtime (never started, terminated or unavailable): a new execution
  with the effective presentation above.

**Configuration.** `HRC_ASPD_SOCKET` names the node-local aspd Unix endpoint
(absolute path; the daemon's own environment, read at each preparation, never
cached). It is endpoint configuration, not a flag: when it is set, this route's
preparation service IS that endpoint; when unset, every route, including this
one, keeps its existing behavior (in-process-spawned stdio `aspc-facade`
resolved by `hrc-runtime.asp-toolchain-selection`). A relative or empty value
is a configuration error on this route, not "unset".

Every other route (interactive tmux, the node-default codex `tmux-tui` viewer
route — only an explicit §1.2 request moves a viewer onto aspd — pi-sdk,
participant registration/establishment, previews, catalog/inspection) is
untouched and keeps its facade/toolchain selection.

**No fallback.** On this route with the endpoint configured, aspd
unavailability, protocol/capability incompatibility, an unidentified service
release, or a compile result without `executionRelease` is a named error
before any hosting effect. HRC never reaches the bundled facade, a toolchain
root, a per-binary override, or source for this route.

### 1.2 Explicit app-server viewer (T-08554)

**What the viewer is today.** On the headless codex-app-server route with
effective presentation `tmux-tui`, HRC allocates the leased substrate with two
windows (`broker`, `tui`), launches the worker with
`--experimental-observer-socket <bipc/<hash>/observer path>`, dispatches
`runtime.terminalSurface` = the `tui` pane lease with
`terminalSurfaceRequired: true` and `HARNESS_BROKER_OBSERVER_SOCKET`, and
persists `presentation: { kind: 'tmux-tui', tuiWindow, operatorAttachTarget,
attachCommand }`. The worker's codex-app-server driver launches its read-only
renderer into that pane (bootstrap `invocation.eventsSince`, live
`invocation.event`; `/quit` in the pane is the driver's quit intent). The
public transport stays `headless`. The Ghostty viewer (hrc-viewer) attaches
from the presentation read model (`tmux attach-session -t <session>:tui`), with
no server attach call. Today that route is reached only by an omitted choice on a node
whose default is `tmux-tui` AND whose Codex redirect does not apply (e.g. a
`responseFormat` dispatch), and it always prepares through the bundled facade.

**Carrier.** `HrcPresentationIntent.operator` accepts one more value:
`operator?: 'none' | 'tmux-tui'`. `'tmux-tui'` means "run this new execution on
the headless codex-app-server with the HRC tmux-tui viewer". No new object,
flag, endpoint or ASP wire field.

**Doors.** The same intent every start/dispatch door already accepts
(`intent.presentation.operator: 'tmux-tui'` on the HTTP API). CLI: `hrc start
<scope> --app-server-viewer`, beside `--no-viewer` and `--viewer-window`. The CLI
refuses `--app-server-viewer` together with `--no-viewer` before any request.
Not offered on `hrc run`. `--viewer-window` remains accepted with it (it places
the Ghostty session tab that shows the attach; it is not a second viewer).

**Precedence.** Identical to `none` except the presentation it selects:
1. *Codex interactive redirect*: an explicit `'tmux-tui'` exempts that dispatch
   exactly as `'none'` and `responseFormat` do; the intent stays headless.
2. *Headless presentation default*: explicit `'tmux-tui'` → `tmux-tui`
   regardless of the node default.
3. Omitted choice: every node default byte for byte as today, including the
   Codex redirect and the omitted-choice delivery rule of §1.1 (de85ff26).

**Route selection with aspd configured.** The aspd route (this document)
covers a headless codex-app-server intent whose effective presentation is
`none` (explicit or node default), OR is `tmux-tui` by EXPLICIT request
(`operatorPresentationSource: request`). An omitted choice that resolves to
`tmux-tui` through the node default keeps its facade preparation unchanged, so
no existing caller migrates. With `HRC_ASPD_SOCKET` unset, an explicit
`'tmux-tui'` runs on the existing facade viewer route.

**Validation.** `'tmux-tui'` is refused before any runtime, operation or
hosting effect exactly where `'none'` is (interactive intent, Claude redirect,
not the headless broker route: `presentation_operator_unsupported`), and
additionally when the intent's compile profile selector is not
`brokerDriver: codex-app-server` (`presentation_operator_unsupported`, reason
`driver-has-no-viewer`), because the presentation decision is driver-gated and
would otherwise silently resolve `none`. Any value other than the two:
`malformed_request`.

**Existing scope.** Generalizes §1.1 to "the request's presentation must equal
the live runtime's": an explicit `'tmux-tui'` against a live runtime presenting
`none`, an interactive surface, or unreadable hosting is refused
`presentation_conflict`, untouched; against a live `tmux-tui` runtime it is
delivered normally. `'none'` against live `tmux-tui` stays refused. Omitted:
never a conflict (§1.1). Terminated, unavailable and `failed` runtimes never
count.

**Persistence.** Applied intent `presentation.operator: 'tmux-tui'`;
route decision `operatorPresentation: 'tmux-tui'`,
`operatorPresentationSource: 'request'`; persisted runtime hosting
`presentation.kind: 'tmux-tui'` (existing shape).

**Operator attach door.** `hrc attach <scope>` must attach to this viewer, not
replace it. Today `attachRuntimeEffectfully` rewrites the latest intent to
interactive and runs `decideInteractiveBrokerAdmission`, which only reuses a
`transport: tmux` broker; a live headless runtime falls through to
stale-and-reprovision and an interactive codex-tui broker. The amendment: when
the scope's latest runtime is a live harness-broker runtime that is operator
attachable (`canOperatorAttach`: persisted `tmux-tui` presentation with an
attach target), attach returns that runtime's existing attach descriptor
(`attachRuntime`, tmux attach to `:tui`) with no admission, stale-marking,
reprovision or intent change. Every other attach case is unchanged. Detach is a
tmux client detach; reattach is the same door. None of these contacts aspd or
the worker.

**Release binding of the viewer.** On this route the renderer is part of the
execution release, never resolved from PATH, a checkout, or HRC's bundled ASP:
- HRC freezes at boundary P the observer socket path in
  `hosting.paths.observerSocketPath` and the worker argv
  `argvPrefix + HRC hosting flags + ['--experimental-observer-socket', path]`,
  plus `hosting.presentation: 'tmux-tui'` and the route decision above. Launch
  (§5.1) recomputes and compares these (`launch_description_mismatch`) and
  allocates with the existing tmux-tui allocator carrying the frozen worker
  launch (the allocator's frozen-argv hosting check also covers the observer
  flag). The controller's current refusal of an aspd execution on the tmux-tui
  substrate (`aspd_route_profile_mismatch`) narrows to: allowed only when the
  frozen record's presentation is `tmux-tui`.
- ASP (agent-spaces, artifact change, no wire change): a standalone release
  worker launches the renderer through its own release executable,
  `<releaseRoot>/libexec/harness-broker renderer --driver codex-app-server …`,
  via a new `harness-broker renderer` subcommand compiled into the same payload.
  The release entrypoint passes that launcher explicitly (its own
  `process.execPath` + `renderer`) down to the codex-app-server driver; no
  environment variable selects it (agent-spaces `515063f6`, proven by running
  the subcommand from a release built at that commit).
  Today the driver pastes `exec bun <dirname(import.meta.url)>/renderer-entry`,
  which inside a bun-compiled release resolves to `/$bunfs/root/renderer-entry`
  and does not exist (verified against release
  `asp-fa4514730cc9-20260916T190607Z-b5f584` and a compiled probe), so without
  this the viewer cannot start from any aspd release. Checkout/package brokers
  (facade route) keep the existing `bun <entry>` launch. The same release
  build and activation produces the A and B releases for acceptance.
- HRC does not verify the renderer process; the binding is by construction in
  the release worker and is evidenced by pane process readback.

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
| Per-runtime execution release (frozen release + actual worker hello release) | `runtimes.runtime_state_json.executionRelease` (`source: 'aspd'`) | B4, then the post-start runtime state write |
| Uncertain start | `preparation_json.startOutcome = 'uncertain'` in addition to the existing failure projection | When `invocation.start` fails at transport level after being sent |

T-08554 adds no record: for an explicit app-server viewer the same
`preparation_json` carries `hosting.presentation: 'tmux-tui'`,
`hosting.paths.observerSocketPath` and the observer flag in `hosting.argv`; the
runtime row carries the existing `tmux-tui` presentation projection.

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
   `runtime_state_json.executionRelease`. The existing `onAccepted`
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
  whose `runtime_state_json.executionRelease` exists, reattach first sends
  `broker.hello` on the candidate connection and requires the same protocol and
  release identity; a mismatch refuses attachment with
  `broker_reattach_release_mismatch` (existing stale-classification path), never
  a silent attach. No preparation and no aspd connection are on this path.
- T-08554 viewer: attach (`hrc attach`, §1.2 attach door, or the Ghostty
  viewer), detach (tmux client detach) and
  reattach are tmux client operations on the persisted `tui` window; they never
  restart the worker or renderer, never contact aspd, and never change runtime
  identity or execution release. Renderer death is the driver's existing
  diagnostic, not a runtime lifecycle input for HRC. After a daemon restart the
  tmux server holding broker and renderer panes is untouched; reattach is the
  existing endpoint + release-hello path above.
- The orphan lease sweep, lease re-association, stale classification and
  cleanup semantics are unchanged.

## 7. Operator readback

- `hrc server status --json` gains `aspd`: `{ configured, endpoint, reachable,
  protocolVersion?, release?, error? }` from a bounded, closed-after-use
  `aspc.hello` probe. This is the **active preparation release**. The existing
  `aspToolchain` projection (bundled/root/override selection for other routes)
  is unchanged and distinct.
- Per runtime, `runtime_state_json.executionRelease` (frozen release,
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

**Amend `hrc-runtime.aspd-prepared-execution-release` (T-08553):** the route is
selected by EFFECTIVE operator presentation `none`: an explicit per-request
`presentation.operator: 'none'` takes precedence over the node headless
presentation default and exempts the dispatch from the Codex interactive
redirect, an
omitted choice uses the node default unchanged, the choice is refused off the
headless broker route or with a viewer placement, it is persisted in the applied
intent and route decision, a live runtime whose presentation differs is refused
rather than replaced, and a frozen preparation is resumed without re-evaluating
the choice.

**Amend `hrc-runtime.aspd-prepared-execution-release` (T-08554):** the route
also covers an explicit per-request `presentation.operator: 'tmux-tui'` on a
headless codex-app-server intent (node-default `tmux-tui` with an omitted choice
keeps its facade preparation); such an attempt freezes its tmux-tui presentation
and observer socket in the launch description, launches only on the tmux-tui
substrate from those persisted bytes, and its renderer runs from the same
execution release as the worker; accepted request values are `none` and
`tmux-tui`, each refused off the headless codex-app-server broker route, and a
live runtime whose presentation differs from the request is refused
`presentation_conflict` and left untouched. Viewer attach, detach and reattach
never require aspd or change worker identity.

Preserved without amendment: participant lifecycle (not on this route),
broker admission client (HRC caller policy and submission doors unchanged),
committed observation control (projection-before-ACK unchanged), continuation
history (HRC continuation selection unchanged), viewer sidecar (HRC still only
publishes runtime presentation; hrc-viewer/Ghostty actuation is unchanged — the
T-08554 tmux-tui renderer is a worker-side pane, not the Ghostty viewer; the
node-default viewer route keeps the facade), observable release (HRC identity
unchanged).

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

- T-08554: the standalone interactive Codex CLI/tmux backend (`codexTui`
  interactive broker, the default max3 Codex route) is not moved to aspd and its
  entry resolution is unchanged. Hook-bridge and codex-tui wrapper paths used
  only by that backend are untouched.

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

### 10.1 Shared max3 rollout acceptance (T-08553)

Real shared HRC (launchd `com.praesidium.hrc-server`, node default
`tmux-tui` unchanged) with `HRC_ASPD_SOCKET` pointing at the persistent,
launchd-supervised max3 aspd. On one fixed HRC artifact/lock/pid:
1. Omitted-choice control: `hrc start <fresh scope> -p …` on a codex agent
   keeps today's max3 route, the interactive codex-tui broker (transport tmux,
   no aspd preparation).
2. `hrc start <fresh scope> --no-viewer -p …` prepares through aspd on A:
   `presentation.kind: none`, `operatorPresentationSource: request`,
   `executionRelease` A, worker hello A, real turn; second warm turn.
3. `--no-viewer` against the live control scope (interactive surface) is
   refused `presentation_conflict` with the runtime untouched.
4. Activate B at the persistent endpoint with the same HRC pid: fresh
   `--no-viewer` scope on B (hello B, real turn); the A worker completes another
   turn. Existing non-test brokers stay attached.

### 10.2 Explicit app-server viewer acceptance (T-08554)

Isolation first (same harness as §10: one linked-worktree HRC artifact under
`hrc server serve` with isolated state/runtime/socket, isolated aspd namespace
with staged A and B built from agent-spaces commits carrying the renderer
subcommand, real Codex, clean Ghostty via ghostmux, real CLI):
1. `hrc start <fresh> --app-server-viewer -p …`: aspd compile, route decision
   `operatorPresentation: tmux-tui` source `request`, hosting `tmux-tui`,
   observer flag in frozen argv, `executionRelease` + worker hello A, turn
   completes; pane process of `:tui` is `<release A>/libexec/harness-broker
   renderer` and renders the transcript.
2. `hrc attach <scope>`: usable viewer; detach; warm turn while detached;
   reattach shows it; worker pid, runtime id, invocation id, executionRelease
   unchanged throughout.
3. Activate B, same HRC pid: attached A viewer/worker still takes a turn and
   renders it; fresh `--app-server-viewer` scope gets B (hello B, renderer from
   B) with a working viewer.
4. Refusals: `--app-server-viewer` against a live `none` runtime and against a
   live interactive surface → `presentation_conflict`; non-codex agent →
   `presentation_operator_unsupported`; CLI with `--no-viewer` refused.
5. Recovery: restart the same HRC artifact with aspd stopped; the A and B
   viewer runtimes reattach (release hello verified), panes still attached and
   rendering, real turns complete.
6. Omitted-choice control on the new artifact: still the interactive redirect
   (tmux transport, no compile); `--no-viewer` unchanged.
Then shared max3: guarded install/activation of HRC and of new A/B aspd
releases (one active preparation release per node, prior releases retained),
repeat 1–4 and 6 on the fixed HRC pid, final readback, Astra grade. No ACP, no
other node.

