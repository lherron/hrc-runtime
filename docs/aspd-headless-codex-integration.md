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

Amendment (T-08555, app-server viewer as the node default; authorized by Lance,
bearing Astra EN-12947; Daedalus APPROVE EN-12956 on `494fef39`): §1.3 makes the aspd-prepared codex-app-server with the
attached `tmux-tui` viewer what an ORDINARY (omitted-choice) Codex request gets
on a node configured for it, max3 first. It narrows
`HRC_CODEX_CLI_TMUX_BROKER_ENABLED` to the omitted-choice redirect it is named
for in §1.1, puts node-default `tmux-tui` on the aspd route when
`HRC_ASPD_SOCKET` is configured, and states how live runtimes and explicit
interactive requests keep their established backend. It changes no preparation,
persistence-ordering, launch, release-binding, renderer, reattach or refusal
rule, and adds no flag, value, endpoint or ASP wire field. Where §1, §1.1, §1.2,
§8 or §9 below say a node-default `tmux-tui` stays on the facade, or that the
omitted choice keeps today's defaults, §1.3 supersedes that sentence.

## 1. Route and configuration

**Route.** HRC-hosted headless Codex: a non-interactive runtime intent whose
compile profile selector is `brokerDriver: codex-app-server`, with EFFECTIVE
operator presentation `none` (no `tmux-tui` viewer), or (T-08554, §1.2) with
presentation `tmux-tui` selected by an explicit request. The effective
presentation is the request's explicit choice when present (§1.1, §1.2),
otherwise the node default `HRC_CODEX_APP_SERVER_OPERATOR_PRESENTATION`. As
amended by T-08555 (§1.3), a node-default `tmux-tui` IS on this route; before it,
it was not. Nothing else changes route.

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
route — only an explicit §1.2 request moves a viewer onto aspd [superseded by
§1.3: node-default `tmux-tui` is on aspd when configured] — pi-sdk,
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
   [T-08555: omitted-choice precedence is restated in full by §1.3.]

**Route selection with aspd configured.** The aspd route (this document)
covers a headless codex-app-server intent whose effective presentation is
`none` (explicit or node default), OR is `tmux-tui` by EXPLICIT request
(`operatorPresentationSource: request`). An omitted choice that resolves to
`tmux-tui` through the node default keeps its facade preparation unchanged, so
no existing caller migrates [superseded by §1.3 decision 2]. With `HRC_ASPD_SOCKET` unset, an explicit
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

### 1.3 App-server viewer as the node default (T-08555)

**Intended behavior.** On a node configured as below (max3), a fresh ordinary
Codex request, meaning one with no `presentation.operator` and no
viewer-selection flag, is not rewritten to the standalone interactive codex-tui
broker. It runs as a headless codex-app-server with the attached `tmux-tui`
viewer, prepared through aspd and bound to one execution release (§3–§6, §1.2
release binding). `--no-viewer` stays the headless opt-out and
`--app-server-viewer` stays accepted (it now selects what the default already
gives, with source `request`). The default never starts a runtime beside a
scope's established one. An omitted choice goes to the admission of that
runtime's own transport (rules 3–4), which reuses it with its presentation,
release and continuation, or applies that admission's existing fenced handling.

**Why two decisions.** Today two node defaults keep an ordinary max3 Codex
request off the aspd viewer: (1) the Codex interactive redirect
(`HRC_CODEX_CLI_TMUX_BROKER_ENABLED=1`) rewrites it to codex-tui before any
presentation decision, and (2) with the redirect out of the way, node-default
`tmux-tui` still prepares through the bundled facade (§1.2 route selection).
Both change: (1) by node configuration, (2) by one routing rule.

**Decision 1: the redirect control governs only the redirect.**
`HRC_CODEX_CLI_TMUX_BROKER_ENABLED` is the node default for whether an
omitted-choice, NON-interactive Codex request (`provider: openai`, harness id
absent or `codex-cli`, `harness.interactive !== true`, no `responseFormat`, not
high-risk actuator split) is normalized into the interactive codex-tui shape. It
no longer also decides whether an EXPLICIT interactive Codex intent is
broker-admissible. Today the same flag gates both: with it `0`,
`decideInteractiveTmuxBrokerStartRoute` returns `legacy-tmux`, a route that no
longer exists for Codex (the start door throws `interactive runtime is not
broker-admissible`), and `resolveInteractiveBrokerAdmissionDriver` refuses reuse
of a live codex-tui runtime (`runtime intent is not broker-admissible`). With
the amendment, the Codex branches of both functions admit `codex-cli`
interactive intents regardless of the flag, so the standalone interactive backend
stays available as an explicit choice and every live codex-tui runtime stays
reusable on a node that turns the redirect off. The Claude and Pi flags and their
branches are unchanged. The flag is not renamed and gains no value.

**Decision 2: with aspd configured, node-default `tmux-tui` prepares through
aspd.** The aspd route (§1) covers every headless codex-app-server intent whose
effective presentation is `none` or `tmux-tui`, whether the source is `request`
or `node-default`. This replaces §1.2's "an omitted choice that resolves to
`tmux-tui` through the node default keeps its facade preparation". With
`HRC_ASPD_SOCKET` unset nothing changes: every presentation keeps the facade.
Because aspd is the only preparation service on this route (§1, no fallback),
ordinary Codex births on a configured node now depend on aspd:
`aspd_unavailable` refuses a NEW execution before any hosting effect. Live
workers, reattach and control never need aspd (§6, unchanged).

**Where the precedence applies.** Rules 3–5 below apply only on a node whose
Codex redirect control is OFF. On a node with the control on, which is every
node's default and the state of svc, lab and hrcdev (fleet plist readback
2026-09-16), the start and dispatch doors keep their pre-T-08555 code path for
Codex requests, including the de85ff26 reusable-headless check, the
`shouldDeferHeadlessToInteractiveBrokerReuse` deferral and the high-risk and
`responseFormat` handling. Nothing about those paths changes there.

**Established runtime.** In this section a scope's *established runtime* is the
most recently created runtime of its host session whose `controllerKind` is
`harness-broker` and whose status is neither unavailable nor `failed`. It can be
of ANY provider, harness or driver, and its invocation state is ignored. A
runtime whose active invocation is `starting` or `stopping` (T-05358) is still
established, and so is a Claude, Pi or `agent-harness` runtime left by an earlier
harness choice for the same scope. §1.3 selects which admission runs for it. It
never decides reuse versus replacement, and no rule starts a runtime of the other
transport beside it.

**Precedence for a Codex request on a redirect-off node (first match wins).**
1. The intent arrives interactive (`harness.interactive: true` or
   `preferredMode: interactive`). This is an explicit interactive request:
   interactive broker admission (standalone codex-tui), independent of the
   redirect flag (decision 1). Door sources are `hrc run`, a cold
   `hrc attach <scope>`, an API caller, or a door that replays a stored session
   intent persisted interactive (below). `presentation.operator` on such an
   intent stays refused (§1.1).
2. An explicit `presentation.operator` (`none` | `tmux-tui`). Validation and
   `presentation_conflict` against every live runtime run exactly as in
   §1.1–§1.2 (the conflict test is status-based and harness-independent). A
   matching live runtime receives the request. Otherwise the request runs
   headless codex-app-server, source `request`.
3. The established runtime has `transport: tmux`, whatever its provider or
   driver. The request is normalized to the interactive Codex shape and handed
   to interactive admission, whatever carries it: omitted choice,
   `responseFormat`, a caller surface-reuse refusal, or a high-risk actuator
   split. Admission alone decides the outcome:
   - It reuses a matching, input-dispatchable Codex broker.
   - It joins a birth (T-07693).
   - It refuses a surface-reuse refusal as `runtime-unavailable` with nothing
     mutated (T-07397).
   - Otherwise (a transitional runtime, or one of another provider or driver) it
     applies its existing fenced stale-and-reprovision into codex-tui.

   A `responseFormat` rides the interactive input turn. A high-risk actuator
   split is refused by the existing actuator-split route admission
   (`high-risk-route-requires-headless-codex-broker`) before any effect.
4. The established runtime has `transport: headless`.
   - Provider `openai` and the request's harness id (absent counts as
     `codex-cli`): the request stays headless and the headless route's own reuse
     or fenced reprovision applies.
   - Any other provider or harness: refused `runtime_unavailable` with reason
     `established_runtime_harness_mismatch` before any runtime, operation or
     hosting effect, runtime untouched. The headless start door stale-marks only
     a same-harness runtime, so proceeding would start a second writer, and there
     is no admission that replaces a foreign headless broker. The caller
     terminates it explicitly.
5. Nothing established. `responseFormat` (T-08338) or a high-risk actuator split
   goes headless as today. Otherwise the request runs headless codex-app-server
   with the node presentation default; with aspd configured that prepares
   through aspd with source `node-default`.

Rules 3 and 4 use one shared predicate at both the start door
(`startRuntimeForSession`) and the turn dispatch door (`dispatchTurn`). It reads
the runtime rows after the door's existing tmux liveness reconcile. On a
redirect-off node, a start already in flight for the host session
(`runtimeStartOperations`) is routed by the BIRTH it has chosen: its transport,
provider and harness. Every registration records that birth: the start door
once its route is decided, the headless boot from its intent, durable-headless
reattach from its runtime, and the interactive birth from its intent. A crossing
dispatch awaits only that decision, never the boot, because awaiting the boot
would break the headless route's existing queue-behind-boot delivery of a
crossing prompt (`server-sdk-start` "queues an existing-session prompt behind
boot").
- A same-harness (openai, requested harness) birth selects its transport's
  admission: tmux → interactive (the T-07693 join delivers into the birth),
  headless → the headless route (queue-behind-boot).
- A foreign-harness birth refuses before any effect: a headless one with
  `established_runtime_harness_mismatch`, a tmux one with
  `start_in_flight_harness_mismatch`. A newborn is never admission-replaced
  (T-07693), so interactive admission's fenced replacement is not available for
  a birth. The caller retries after the birth settles, when the row rules apply.
- A start that records no birth is never treated as absent. The dispatch awaits
  that start in full and then applies the row rules to the rows it left.

The start door already joins an in-flight start first. The dispatch door's
later T-07693 interactive join and invoke rendezvous keep their places. Every message door
(hrcchat/wrkc submissions, the mail kicker cold birth, selector and target
messages, ACP) enters through that dispatch door.

**Doors.**
- `hrc start <scope> [-p …]` builds a non-interactive intent. Rules 2–5 apply,
  so on max3 a fresh scope gets the aspd viewer.
- Turn dispatch and cold birth (`hrc turn`/hrcchat/`wrkc say` summons, kicker
  birth, ACP) use the caller's intent, else the session's stored
  `lastAppliedIntentJson`, else the resolved placement intent (non-interactive).
  Rules 1–5 apply to whichever intent arrives.
- `hrc run <scope>` and a cold `hrc attach <scope>` build interactive intents.
  Rule 1 applies: they are the explicit standalone interactive backend and are
  not changed. `hrc attach <scope>` on a live operator-attachable app-server
  runtime returns its attach descriptor (§1.2, unchanged); detach/reattach are
  tmux client operations.

**Existing scopes and stored intents.** The start door persists the intent it
executed, so a scope whose earlier start was redirected (or ran via `hrc run` or
attach) has a stored interactive intent. HRC cannot distinguish a
redirect-normalized stored intent from an explicit `hrc run`. Such a scope
therefore keeps the standalone backend at a later cold birth by a door that
replays the stored intent (rule 1). It is not migrated. A later `hrc start` on it
with nothing live builds a fresh non-interactive intent and takes the new
default. A scope whose stored intent is non-interactive, including every scope
first born under the new default, takes the default at its next execution when
nothing is established (rule 5).
Continuation selection for that execution is unchanged
(`automaticContinuationForSession`). No runtime is stale-marked, rotated or
terminated by this change, and no migration job runs.

**Persistence and readback.** A default-selected execution records applied
intent `presentation.operator` absent, route decision
`operatorPresentation: 'tmux-tui'` with `operatorPresentationSource:
'node-default'`, preparation `aspd`, and hosting `presentation.kind: 'tmux-tui'`.
The frozen-preparation resume rule (§1.1) is unchanged: a same-key retry
launches the frozen record and never re-evaluates the node defaults.

**Node scope and configuration.** The code is deployed only to max3, and every
behavior it changes is gated by node configuration that only max3 carries:
- Decision 1 (explicit interactive admission independent of the flag) and rules
  3–5 only change anything where `HRC_CODEX_CLI_TMUX_BROKER_ENABLED` is off.
  With the flag on, admission was already allowed and the doors keep their
  pre-change path.
- Decision 2 only changes anything where `HRC_ASPD_SOCKET` is configured.
- Fleet readback 2026-09-16: svc and lab (mini `com.praesidium.hrc-server`,
  `com.praesidium.lab.hrc-server`) and hrcdev all have the flag `1` and no
  aspd socket. A later fleet deploy of this code therefore changes no behavior
  on them until their configuration changes, which needs its own authority.

max3 delivery sets `HRC_CODEX_CLI_TMUX_BROKER_ENABLED=0` in the installed
`com.praesidium.hrc-server` plist, with `HRC_CODEX_APP_SERVER_OPERATOR_PRESENTATION=tmux-tui`
and `HRC_ASPD_SOCKET` unchanged. The plist is backed up first and the service is
reloaded by launchd `bootout`/`bootstrap` so the environment is re-read. No
other node or ACP changes.

**Rollback.** There is one coherent pair per direction: binary and configuration
move together, never a release alone.
- *Default only* (keep the new release): restore the plist backup (flag `1`),
  then `bootout`/`bootstrap`. The new release with flag `1` takes the
  pre-change door path. Only decision 2 remains: a non-redirected node-default
  viewer, meaning a `responseFormat` dispatch, prepares through aspd on max3.
  Runtimes born under the default stay live and keep receiving input through
  the de85ff26 headless delivery.
- *Full* (prior release): restore the plist backup (flag `1`) FIRST, repoint
  `~/.bun/install/hrc-runtime-current` to the recorded prior release
  (`release-20260916213952226-61246`, HRC `3229f86c`), then
  `bootout`/`bootstrap`. Verify the loaded environment reads flag `1` and
  `hrc server status` reads `3229f86c` with runningEqualsInstalled. Running
  `3229f86c` with flag `0` is not a rollback state. That release still reads
  `0` as "Codex interactive not admissible", which would break `hrc run`, cold
  attach and live codex-tui reuse.
- The aspd release is not touched by this change in either direction.

**Refusals.** Two new reasons, on redirect-off nodes only, both
`runtime_unavailable` with no effect: `established_runtime_harness_mismatch`
(rule 4, or a crossing foreign headless birth) and
`start_in_flight_harness_mismatch` (a crossing foreign tmux birth). Rule 3 sends high-risk and surface-refusing requests to existing
refusals. Explicit-value validation, `presentation_conflict`,
`presentation_operator_unsupported`, `aspd_unavailable` and every §4–§6 refusal
are unchanged. The default-selected path is subject to the same no-fallback
refusals as an explicit request.

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

**Amend `hrc-runtime.asp-toolchain-selection` (T-08554):** the aspd-prepared
route whose worker is exempt from the resolver is headless codex-app-server with
effective presentation `none` (explicit or node default) OR `tmux-tui` selected
by an explicit request (§1.2). For both, the worker comes only from the frozen
`executionRelease` and the tmux-tui renderer is launched by that worker from its
own release payload, never selected by HRC; no override, root, bundled, PATH,
current or source selection and no fallback applies to either. A node-default
`tmux-tui` with no request choice is not on the aspd route and stays governed by
the resolver (facade route) [superseded by the T-08555 amendment below].

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
keeps its facade preparation [superseded by T-08555 below]); such an attempt freezes its tmux-tui presentation
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
node-default viewer route keeps the facade [T-08555: it moves to aspd when
configured; Ghostty actuation is still unchanged]), observable release (HRC
identity unchanged).

**Amend `hrc-runtime.asp-toolchain-selection` (T-08555):** with
`HRC_ASPD_SOCKET` configured, the aspd-prepared route is every HRC-hosted
headless codex-app-server execution with effective presentation `none` or
`tmux-tui`, from an explicit request or the node default; no node-default
presentation of that driver remains resolver-governed on a configured node. With
the endpoint unset, the resolver governs every presentation as before.

**Amend `hrc-runtime.aspd-prepared-execution-release` (T-08555):** the route
covers node-default `tmux-tui` as well as explicit choices, and records
`operatorPresentationSource: node-default` for it.

The Codex interactive redirect control no longer decides whether an explicit
interactive Codex intent is admissible. With the control on, Codex start and
dispatch routing is otherwise unchanged. With it off, a non-interactive Codex
request without an explicit presentation is routed by the scope's established
runtime before `responseFormat`, actuator-split or node defaults are
considered. The established runtime is the most recent harness-broker runtime
of the host session whose status is neither unavailable nor failed, of any
provider, harness, driver or invocation state. An in-flight start is routed by
its recorded birth (transport, provider, harness; decision awaited, never the
boot): same-harness selects that transport's admission, foreign-harness refuses
before effect, and an unrecorded start is awaited in full.
- A tmux transport selects interactive admission, which alone decides reuse,
  birth join, refusal or fenced replacement; high-risk requests are refused by
  actuator-split route admission.
- A headless transport of the same provider and harness selects the headless
  route.
- A headless transport of any other provider or harness refuses
  `established_runtime_harness_mismatch` with no effect.

No rule starts a runtime of another transport beside an established one. With
nothing established, the request runs headless codex-app-server with the node
presentation default on this route. An intent that arrives interactive keeps the
standalone interactive backend. No rollback pairs a release that gates
interactive Codex admission on the redirect control with that control off.

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
  interactive broker, the default max3 Codex route until T-08555) is not moved to aspd and its
  entry resolution is unchanged. Hook-bridge and codex-tui wrapper paths used
  only by that backend are untouched.
- T-08555: the default changes new executions only. There is no migration of live
  runtimes or of scopes whose stored intent is interactive, and no deletion of
  the standalone backend. `hrc run` and cold `hrc attach` stay on it, and it gets
  no new release binding. The redirect flag keeps its name. Other nodes keep
  their configuration.

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

### 10.3 App-server viewer default acceptance (T-08555)

Isolation first: one linked-worktree HRC artifact under `hrc server serve` with
isolated state, runtime and socket. It uses the intended max3 configuration
(`HRC_CODEX_APP_SERVER_OPERATOR_PRESENTATION=tmux-tui`, `HRC_ASPD_SOCKET` to an
isolated aspd namespace carrying the operational release), real Codex, clean
Ghostty via ghostmux, and the real CLI.
1. Pre-change baseline on the same artifact with the redirect ON: born live are
   an interactive codex-tui scope `old-tui` (omitted start), an explicit
   viewer scope `old-v` (`--app-server-viewer`), and a terminated
   interactive scope `old-dead` with a stored non-interactive intent.
2. Restart the same artifact with the redirect OFF. Omitted input to `old-tui`
   (start `-p` and dispatch) is delivered into the same runtime, invocation,
   worker pid and transport tmux, with no compile and no second writer.
   Omitted input to `old-v` is delivered into it with the same release. Every
   pre-existing runtime row is unchanged apart from activity.
3. Default cold launch, ordinary doors, no viewer flags: `hrc start <fresh> -p`
   and a cold dispatch (hrcchat/turn) to another fresh scope. Each gets
   aspd compile +1, route decision `tmux-tui`/`node-default`, preparation aspd,
   hosting `tmux-tui`, executionRelease plus worker hello from the active
   release, and a `:tui` pane process `<release>/libexec/harness-broker
   renderer`. The turn completes and renders.
4. `hrc attach <fresh>`: viewer attaches. Detach, warm turn while detached,
   reattach. Runtime, invocation, worker and release are unchanged.
5. `--no-viewer` fresh scope: headless `none` via aspd, source `request`.
   `--no-viewer` against the default viewer scope and `--app-server-viewer`
   against `old-tui` both refuse `presentation_conflict` with the runtime
   untouched. `hrc run` on a fresh scope is still the standalone interactive
   backend (admitted with the flag off).
6. `old-dead` cold dispatch after the change takes the default and completes a
   real turn (continuation behavior recorded).
7. Gates (unit, real handlers): a transitional (`starting`/`stopping`) established
   interactive runtime and a transitional established headless runtime each
   get only their own transport's admission, with no cross-transport start.
   `responseFormat`, surface-reuse refusal and high-risk against an established
   TUI go to interactive admission or its refusal. A foreign-harness established
   runtime (tmux Claude → interactive admission's fenced replacement; headless
   `agent-harness` → `established_runtime_harness_mismatch`, untouched). Flag `0`
   keeps explicit interactive Codex admissible. With the flag ON the doors
   are unchanged (existing redirect/deferral regression tests stay green). These
   run at both the start and dispatch doors.
8. aspd stopped: a fresh omitted-choice start refuses `aspd_unavailable` with
   no facade process and no op row, while live default viewer runtimes keep
   taking turns.

Then shared max3, with the paired rollback record (plist backup plus prior
release, §1.3 Rollback) written before cutover: `just install`, set the flag to `0` in the installed
plist, `bootout`/`bootstrap`, and read back the loaded environment, running
equals installed, aspd identity, and warmup reattachment against the 9 known
unreachable runtimes. Repeat 3–5 through the real ordinary doors on fresh scopes,
plus omitted input to a pre-existing live codex-tui scope and a pre-existing
app-server scope. Clean up test scopes only. Astra grades.
