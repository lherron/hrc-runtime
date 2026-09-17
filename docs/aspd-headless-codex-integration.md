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

Amendment (T-08556, `hrc run` on the aspd-prepared interactive Codex TUI;
authorized by Lance, bearing Astra EN-12983): §1.4 prepares the interactive
Codex app-server with its attached Codex TUI (the `codexTui` backend `hrc run`
already uses) through aspd when the attached-run door births it, and launches the
worker AND its codex-tui wrapper from one frozen execution release. It also
states what `hrc run` does against a scope's live headless runtime. The
interactive shape, the attach-before-start handshake and initial-input delivery
are unchanged. Other doors that birth the interactive backend (cold `hrc attach`,
stored-intent rebirth, §1.3 rule 3 reprovision, selector messages) keep the
facade [T-08560: every door moves, §1.5]. No flag, value, endpoint, ASPC verb or
wire field is added. Where §1, §2, §4, §8 or §9 say the aspd route is headless
only, or that `hrc run` stays on the standalone backend with no release binding,
§1.4 supersedes that sentence for the attached-run door.

Amendment (T-08560, every Codex interactive birth through aspd; campaign P-00521
Leg A, analysis T-08558 rev 2 accepted by Astra, spec accepted by mable EN-13046):
§1.5 prepares EVERY new interactive `codex-app-server` birth (`codexTui`
presentation, transport `tmux`) through aspd on a node with `HRC_ASPD_SOCKET`
configured, whichever door requests it:
- cold `hrc attach`;
- turn dispatch and the mail kicker's summons birth;
- submission doors;
- target and selector messages;
- §1.3 rule 3 reprovision;
- explicit interactive `POST /v1/runtimes/start`;
- `/v1/runtimes/ensure` and app-session ensure;
- rotation relaunch;
- received federation claims;
- the attached-run door (§1.4, unchanged).

Each birth launches the worker, its codex-tui wrapper and its hook receiver from
one frozen execution release. §1.5 states how a launch-carried cold-birth prompt
is frozen and delivered exactly once (D1), how a caller retry key is frozen and
resumed (D2), what keyless doors do (D3), and where reprovision stale-marking sits
relative to preparation (D4). No flag, value, endpoint, ASPC verb or wire field is
added. The one new refusal reason and the two-value door class are HRC-internal.
The Claude, Pi and deprecated `codex-cli-tmux` interactive drivers, hosted
participant brokers and the Codex Desktop observer are not moved. Where §1, §1.3,
§1.4, §8, §9 or §10.4 say that a door other than the attached run keeps the
facade, or that the interactive route is attached-run only, §1.5 supersedes that
sentence.

## 1. Route and configuration

**Route.** HRC-hosted headless Codex: a non-interactive runtime intent whose
compile profile selector is `brokerDriver: codex-app-server`, with EFFECTIVE
operator presentation `none` (no `tmux-tui` viewer), or (T-08554, §1.2) with
presentation `tmux-tui` selected by an explicit request. The effective
presentation is the request's explicit choice when present (§1.1, §1.2),
otherwise the node default `HRC_CODEX_APP_SERVER_OPERATOR_PRESENTATION`. As
amended by T-08555 (§1.3), a node-default `tmux-tui` IS on this route; before it,
it was not. Nothing else changes route. [T-08556 §1.4 and T-08560 §1.5 add the
interactive `codex-app-server` TUI route, `interactive-codex-tui`: first for the
attached-run door, then for every birth door.]

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
   interactive broker admission (standalone codex-tui; [T-08560: its births are
   aspd-prepared on a configured node, §1.5]), independent of the
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
  admission: tmux → interactive, headless → the headless route
  (queue-behind-boot). On this path the T-07693 join does not deliver on its
  own authority. Once the birth settles, it runs `decideInteractiveBrokerAdmission`
  against the newborn runtime with the caller's intent and
  `establishedBrokerInvocationId`, and a `runtime-unavailable` decision refuses
  before delivery. That covers a T-07397 surface-reuse refusal, and an ownership
  proof that does not name the newborn's active invocation. Only the refusal is
  taken from that decision: a newborn is joined, never reprovisioned. This check
  is added only for redirect-off crossings. The redirect-on join is unchanged.
- A foreign-harness birth refuses before any effect: a headless one with
  `established_runtime_harness_mismatch`, a tmux one with
  `start_in_flight_harness_mismatch`. A newborn is never admission-replaced
  (T-07693), so interactive admission's fenced replacement is not available for
  a birth. The caller retries after the birth settles, when the row rules apply.
- A start that records no birth is never treated as absent. The dispatch awaits
  that start in full and then applies the row rules to the rows it left.
- The route and the joined start stay one authority. A crossing dispatch carries
  its classified route to every point that joins an in-flight start: the
  dispatch door's T-07693 join (including the T-08012 invoke rendezvous, which
  records the same birth), the headless boot join, the durable-headless reattach
  join, and the interactive handler's `joinInFlightRuntimeStart` join.
  - Before awaiting, each join re-derives the route from the birth it actually
    joins. It refuses `start_in_flight_unclassified` when that start recorded no
    birth, a foreign-harness mismatch (as above) for a foreign birth, and
    `start_in_flight_changed` when the route differs. A start swapped in after
    routing is never consumed under the earlier route.
  - After a tmux birth settles, it is joined only when interactive admission
    decides `broker-reuse` for the newborn. Any other decision refuses before
    delivery: `runtime-unavailable` with its reason, or
    `start_in_flight_not_reusable`. The refusal set is retryable
    `runtime_unavailable`.

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
  not changed [T-08556/T-08560: that backend's births by these doors are
  aspd-prepared on a configured node, §1.4 and §1.5]. `hrc attach <scope>` on a live operator-attachable app-server
  runtime returns its attach descriptor (§1.2, unchanged); detach/reattach are
  tmux client operations.

**Existing scopes and stored intents.** The start door persists the intent it
executed, so a scope whose earlier start was redirected (or ran via `hrc run` or
attach) has a stored interactive intent. HRC cannot distinguish a
redirect-normalized stored intent from an explicit `hrc run`. Such a scope
therefore keeps the standalone backend at a later cold birth by a door that
replays the stored intent (rule 1) [T-08560: on a configured node that birth
prepares through aspd, §1.5]. It is not migrated. A later `hrc start` on it
with nothing live builds a fresh non-interactive intent and takes the new
default. A scope whose stored intent is non-interactive, including every scope
first born under the new default, takes the default at its next execution when
nothing is established (rule 5).
Continuation selection for that execution is unchanged
(`automaticContinuationForSession`). No runtime is stale-marked, rotated or
terminated by this change, and no migration job runs.

**Codex home (continuation store).** A Codex continuation is a thread whose
rollout lives under `<ASP_HOME>/codex-homes/<project>_<agent>`. The standalone
backend resolves that from HRC's `ASP_HOME`. Before this amendment, an
aspd-prepared worker resolved it from the aspd daemon's own `ASP_HOME`, because
HRC never sent `aspHome` on the compile. A scope whose continuation was minted on
one route could then fail on the other (`no rollout found for thread id`,
`broker_start_failed`) whenever the two daemons' configurations differed. Found
in T-08555 isolation, where bun's cwd `.env.local` autoload gave HRC a different
`ASP_HOME` than aspd; max3 happens to configure both as `var/spaces-repo`.
Therefore every aspd route compile carries HRC's resolved `ASP_HOME`
(`getAspHome()`) as the existing `AspcCompileHarnessInvocationRequest.aspHome`
field, which aspd already honors. No wire, verb or version change. The value is
recorded in the preparation's route decision as `aspHome`. Both routes then use
one continuation store by construction, not by configuration equality.

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
`start_in_flight_harness_mismatch` (a crossing foreign tmux birth), plus the
retryable crossing-join refusals `start_in_flight_unclassified`,
`start_in_flight_changed` and `start_in_flight_not_reusable`. Rule 3 sends high-risk and surface-refusing requests to existing
refusals. Explicit-value validation, `presentation_conflict`,
`presentation_operator_unsupported`, `aspd_unavailable` and every §4–§6 refusal
are unchanged. The default-selected path is subject to the same no-fallback
refusals as an explicit request.

### 1.4 `hrc run` on the aspd-prepared interactive Codex TUI (T-08556)

**Intended behavior.** On a node with `HRC_ASPD_SOCKET` configured (max3),
`hrc run <codex scope>` on a scope with nothing live births the same
interactive Codex runtime it births today: a `codex-app-server` broker with
`codexTui` presentation (transport `tmux`) whose codex-tui wrapper runs the
native `codex app-server` on a websocket UDS and a real Codex TUI attached to it
in the leased `tui` pane. The caller's terminal attaches to that pane before the
invocation starts, and the operator types into the TUI. What changes is where the
launch comes from: it is prepared through aspd and frozen, and the worker and its
wrapper run from that one execution release. The read-only transcript renderer
of §1.2 is never used by this door and stays observation-only.

**Why the TUI was not release-bound.** The worker launched the wrapper as
`<execPath> <dirname(import.meta.url)>/codex-tui-wrapper`. Inside a bun-compiled
release that path is `/$bunfs/root/codex-tui-wrapper` and does not exist
(reproduced by a compiled probe of agent-spaces `864e801e`, T-08556 evidence).
The generated codex hook bridge ran `harness-broker codex-hook` from PATH. An
aspd-prepared interactive worker could therefore not start its TUI, and its hook
receiver would have come from whatever `harness-broker` PATH named.

**ASP (agent-spaces artifact change, no wire change).** The same construction
T-08554 used for the renderer (515063f6):
- `harness-broker codex-tui-wrapper …` runs the wrapper entry from the same
  executable.
- The release entrypoint passes `codexTuiLauncher: <execPath>
  codex-tui-wrapper`, plumbed through `runBrokerCli` → `createDefaultBroker` →
  `createCodexAppServerDriver`. With it, the pane launch argv is `<execPath>
  codex-tui-wrapper --command …`, and the hook bridge wrapper runs `<execPath>
  codex-hook --socket …`. The pane's tmux launch runner is also resolved from
  the module path (`exec bun /$bunfs/root/tmux-launch-runner`) in a compiled
  release, so it runs as `<execPath> tmux-launch --launch-file …` (found by the
  first installed isolated `hrc run`, agent-spaces `90dd7508`). No environment
  variable selects any of them.
- A checkout or package broker passes nothing and keeps `<execPath>
  <wrapper entry>` and PATH `harness-broker codex-hook`.
- The native `codex` binary stays `startSpec.process.command` from the compile,
  as today. A new aspd release carrying this change is built, installed and
  activated. The currently active release predates it, so an interactive
  preparation served by it would launch a worker that cannot start its TUI;
  activation order (§1.4 Delivery) prevents that on max3.

**The door.** The attached-run door is `POST /v1/runs/prepare-attached` with its
`resume-attached` completion, used by `hrc run` and `hrc resume`. It is the only
caller that passes `attachBeforeInvocationStart`, and that option (with the
door's own marking to the start door) is the call intent this section keys on. Cold `hrc attach`, turn dispatch and mail births,
§1.3 rule 3 reprovision into codex-tui, selector and target message births and
`hrc start` do not pass it and keep their current preparation [T-08560: they
move to aspd too, §1.5; `attachBeforeInvocationStart` no longer selects the
route and only decides the recorded door class]. That is a door-by-door
migration step (as T-08555 migrated start and dispatch), not a permanent A/B
mode. A scope's later birth by another door uses that door's preparation. Continuations are shared because both preparations compile under
HRC's `ASP_HOME` (§1.3 Codex home).

**One start authority (attached-run door, aspd configured).** For a Codex
interactive intent (`provider: openai`, harness `codex-cli` or absent) on a node
with `HRC_ASPD_SOCKET` configured, the attached-run door does not use the
turn-dispatch door, with or without `-p`. It calls the start door
(`startRuntimeForSession`) with the intent (minus `initialPrompt`), the request's
`restartStyle`, `attachBeforeInvocationStart`, the door marker and, when present,
the prompt with a fresh run id. The start door is the host session's start
singleflight. Selection, birth and `-p` delivery all happen inside ONE operation
that this door registers in `runtimeStartOperations`. The operation is registered
before its first await and deregistered only after its selected runtime has
received `-p` or the operation refused.

**Joining a registered start.** If a start is already registered when the door
arrives, the door never returns that start's result as its own:
1. It reads that start's recorded birth (§1.3) without awaiting the boot. A
   foreign birth refuses at once, before any effect: tmux with
   `start_in_flight_harness_mismatch`, headless with
   `established_runtime_harness_mismatch`. Foreign means provider other than
   `openai` or harness other than `codex-cli`.
2. Otherwise it awaits that start to settle, success or failure, and records the
   runtime it produced as the *joined newborn*.
3. It re-enters the start door. If another start registered meanwhile, it
   repeats from step 1. Otherwise it registers its own operation, carrying the
   joined newborn's id.

A start that recorded no birth is awaited in full (step 2) and never treated as
absent. Every selection below happens inside the door's own registered operation,
against rows no other registered birth can change in between. A later start
joins the door's operation at the start door. A later dispatch joins it through
the dispatch door's T-07693 birth join (preceded, redirect off and choice
omitted, by the §1.3 recorded-birth classification) and then applies its own
door's existing rules to the runtime this operation produced. The attached-run
door no longer passes through the dispatch door's attach-exempt path. With the
socket unset, or for any other harness, the door keeps today's code path.

**Selection (inside the door's operation, after tmux liveness reconcile).** The
subject is the joined newborn when it is still live (not unavailable or failed).
Otherwise it is the scope's established runtime (§1.3 definition: the newest
harness-broker runtime not unavailable or failed, of ANY provider, harness,
driver or invocation state, so `starting`/`stopping` count). First match wins:
1. Joined newborn, `transport: tmux`. A newborn is never admission-replaced
   (T-07693). It must be provider `openai` and harness `codex-cli`, or the door
   refuses `start_in_flight_harness_mismatch`. It is then joined only when
   interactive admission (`decideInteractiveBrokerAdmission`, the caller's
   intent, input-dispatchability) decides `broker-reuse`. Any other decision
   refuses retryable `runtime_unavailable`: with the admission reason for
   `runtime-unavailable`, otherwise `start_in_flight_not_reusable`. This is
   the §1.3 crossing-join rule applied to the attached-run door.
2. Joined newborn, `transport: headless`: rule 5 below. It is never
   replaced.
3. `restartStyle: fresh_pty` (`--force-restart`) with no live joined newborn:
   the operator asked for replacement. Existing behavior: the established runtime
   is stale-marked, then the interactive birth runs (rule 6). Nothing runs
   beside a live runtime.
4. Established `transport: tmux`: existing interactive start admission decides,
   exactly as today. It reuses a matching runtime, otherwise applies its fenced
   stale-and-reprovision into the interactive birth (rule 6). This is
   same-transport admission for a settled established runtime, which §1.3
   permits. A reused runtime keeps its worker, invocation, release (facade or
   aspd) and presentation.
5. Established or joined `transport: headless`: never stale-marked, replaced
   or started beside, whatever its harness or state.
   - Provider `openai`, harness `codex-cli`, operator attachable
     (`canOperatorAttach`: the §1.2/§1.3 app-server viewer), not transitional:
     reused. There is no admission, preparation or intent change, and the door
     attaches its `:tui` renderer pane.
   - Same harness, not operator attachable (presentation `none`): refused
     `presentation_conflict` (409), field `presentation.operator`,
     `livePresentation: none`, untouched. An operator terminal requires a
     presentation this execution does not have (the §1.1 conflict rule applied
     to the door's implicit request for a terminal).
   - Same harness, transitional (active invocation `starting`/`stopping`):
     refused retryable `runtime_unavailable`, reason
     `attached_run_runtime_transitional`, untouched.
   - Any other provider or harness: refused `runtime_unavailable`, reason
     `established_runtime_harness_mismatch` (§1.3), untouched.
   The caller terminates it or retries. `--force-restart` with no live joined
   newborn (rule 3) is the only door path that replaces a live headless runtime.
6. Nothing established (or rule 3/4 stale-marked it): the interactive birth. It
   prepares through aspd, frozen, then launches (below). There is no facade
   fallback. `aspd_unavailable` and every §4/§5 refusal refuse the run before any
   hosting effect, the attach handshake is cancelled, and the CLI reports the
   error.

Every refusal happens before any runtime, operation or hosting effect of this
door and delivers no input. The operation's recorded birth (§1.3) is decided from
the selection: tmux for rules 1, 3, 4 and 6, and headless (openai, codex-cli)
for rules 2 and 5. A crossing redirect-off dispatch is therefore routed to the
transport the door actually returns. A refusal records no birth.

**Preparation and freeze (§3–§5 reused).** `startInteractiveTmuxBrokerRuntime`,
when it carries `attachBeforeInvocationStart` for a `codex-app-server` birth on a
configured node, replaces only its compile call. It prepares through aspd with
HRC's `aspHome`, runs the existing admission, and commits boundary P before
any hosting effect. The frozen record is the same `hrc-aspd-preparation/v1` row
with:
- `route: 'interactive-codex-tui'`;
- `hosting.presentation: 'codex-tui'`, meaning the substrate carries the
  leased `tui` pane and no observer socket;
- `hosting.argv` = `worker.argvPrefix` + HRC hosting flags (no observer
  flag);
- the frozen interactive `startRequest`, dispatch env, lifecycle overlay
  (`interactive-broker:codex-app-server`) and route decision
  `{ route: 'broker', selectedBy: 'decideInteractiveTmuxExecutionRoute',
  durableInteractiveRoute: 'durable-ipc', brokerTransport: 'unix-jsonrpc-ndjson',
  preparation: 'aspd', door: 'attached-run', aspdEndpoint, aspdRelease,
  executionReleaseId, aspHome }` [T-08560: `door` is the two-value door class
  `attached-run` | `interactive-birth`, §1.5.1].

Admission requires the selected profile to be `codex-app-server` with
`interactionMode: interactive` and the tmux broker terminal. Anything else is
refused `aspd_route_profile_mismatch`. The durable interactive route is
required: with `HRC_BROKER_DURABLE_IPC_ENABLED` resolving off, the door refuses
`aspd_route_requires_durable_ipc` before preparation. The stdio route spawns a
resolver-selected broker, which cannot be the frozen release.

**Launch.** From the operation id only, exactly as §5. Validation of the persisted
bytes and hosting description is unchanged. The interactive allocator
(`createBrokerDurableTmuxAllocator`) accepts the frozen worker launch
(executable + argv, no resolver, frozen-argv hosting check) and releases a lease
that never carried `invocation.start`. The controller's refusal of an aspd
execution off the headless substrate narrows to: allowed on the interactive tmux
substrate only when the frozen record's route is `interactive-codex-tui`. Worker
hello protocol and release must equal the frozen release before
`invocation.start`. Otherwise HRC releases the lease, records the refusal and
sends no start. B4 and the existing interactive persistence follow: runtime
`transport: tmux`, `runtime_state_json.executionRelease`. The attach
handshake is unchanged.

**Never-started lease cleanup (Astra grade G1).** The controller releases the
lease an attempt realized whenever that start ends without success before
`invocation.start` was sent: an attach cancelled at its resume deadline, a worker
connect or handshake failure, a pre-start admission refusal, or a failed start-graph
commit. The release is the allocator's existing lease-server kill plus broker
socket removal. It sits at the controller's single start exit, so it covers every
route's pre-start failure; before this, only the aspd hello refusal released. Fences:
- once `invocation.start` was sent, the lease is never touched, whether the outcome
  is live or `uncertain`;
- an injected broker client owns no HRC lease;
- an aspd launch's deterministic lease is released only while its frozen operation
  is still `prepared` or this attempt committed its start graph, never when another
  launch owns that operation.

The runtime, run and operation rows settle `failed` as before. `prepare-attached` answers `prepared` once the controller
reports attached-start readiness for this pending start, and the invocation
starts only after `resume-attached` (the CLI has spawned its attach client) or
the existing resume deadline cancels it.

**Initial input exactly once.** [Attached-run door only; T-08560 §1.5.3 freezes
a launch-carried cold-birth prompt for the other doors.] `-p` is never part of
the start request and
is never routed by session. Inside the door's registered operation, after
selection (and, for a birth, after `resume-attached` let the invocation start),
the operation delivers the prompt once, with a fresh run id and
`waitForCompletion: false`, directly into the selected runtime by identity. It
passes through the turn admission gate and the same executor the dispatch door
uses for an already-selected runtime: `executeInteractiveBrokerInputTurn` for
tmux and `executeHeadlessBrokerInputTurn` for a rule 5 reuse (the executors the
participant path uses, with run persistence, user-prompt event, first-turn watch
and broker admission). No session-level selection, admission, stale-marking or
reprovision runs on this path. The prompt therefore reaches exactly the runtime
whose pane the door hands the caller, or fails on that runtime. The operation
deregisters only after the executor has returned its submission, so no
registered start or crossing dispatch can move the session between selection and
delivery. A refused or cancelled operation delivers nothing. The frozen
`startRequest` carries no copy of the prompt. Because `-p` no longer bypasses
the start door on this node, `hrc run --force-restart -p` now honors
`--force-restart`; the pre-change prompt path ignored `restartStyle`.

An unregistered birth (`/v1/runtimes/ensure`, the pre-existing limit below;
[T-08560: now aspd-prepared, still unregistered, §1.5.7]) can
still stale-mark the session's runtime concurrently. On this path that affects
only the executor's own result for the runtime it was given. It cannot redirect
the prompt to another runtime.

**Operator attach marking.** Every attached-run outcome publishes presentation
with `operatorAttachPending: true` before the attach descriptor is returned:
births (existing), tmux reuse (existing) and rule 2/5 headless reuse (added, in
the start operation before it returns).
The viewer sidecar therefore opens no additional Ghostty viewer for a runtime the
caller is attaching to.

**Existing workers, detach, reattach, restart.** Unchanged (§6). Detach is a
tmux client detach and leaves the app-server, TUI and worker running. Warm
`hrc run`/`hrc attach` on an aspd interactive runtime is rule 2 reuse. Daemon
restart reattaches it with the release hello check. aspd is never contacted on
any of these paths, so aspd activation or outage affects only new attached-run
births [T-08560: only new Codex births, by any door, §1.5].

**Persistence and readback.** Applied intent: the interactive intent, as today.
Operation `preparation_json.route: 'interactive-codex-tui'`. Runtime
`transport: tmux`, `runtime_state_json.executionRelease` (source `aspd`), route
decision above. Pane processes: the `broker` window runs `<releaseRoot>/libexec/
harness-broker run …`, and the `tui` pane runs `<releaseRoot>/libexec/harness-broker
codex-tui-wrapper …` with its `codex app-server` and `codex --remote` children.

**Node scope.** Gated by `HRC_ASPD_SOCKET` (max3 only; svc, lab and hrcdev have
none) and the attached-run door [T-08560: the socket alone gates every Codex
interactive birth door, §1.5.8]. With the socket unset, `hrc run` is byte for
byte today's behavior, including stale-and-reprovision of a live headless
runtime. The redirect control is not consulted.

**Delivery and rollback.**
- Order: build, install and activate the new aspd release (it serves every route;
  the headless routes are unchanged by the ASP change), verify its hello, and
  only then install and restart HRC. Live aspd-prepared workers stay on their
  releases (§6).
- HRC rollback: repoint `hrc-runtime-current` to the recorded prior release
  (3d9d0867), then `bootout`/`bootstrap`. `hrc run` returns to the facade. aspd
  interactive runtimes stay live and reattach under the prior release, whose §6
  hello check is transport-agnostic.
- aspd rollback: activate the recorded prior release. Only after HRC is rolled
  back, because the prior release cannot start a TUI.
- No plist change.

**Pre-existing limit, unchanged.** `POST /v1/runtimes/ensure`
(`ensureRuntime`) births without registering in `runtimeStartOperations`, as it
does today for every door. It is an explicit operator ensure outside this
migration [T-08560: its preparation moves to aspd; its registration does not,
§1.5.7].

**Refusals.** New: `aspd_route_requires_durable_ipc` and
`attached_run_runtime_transitional`. Reused on this door:
`presentation_conflict`, `established_runtime_harness_mismatch`,
`start_in_flight_harness_mismatch` and `start_in_flight_not_reusable`,
`aspd_unavailable` and the other §4
preparation refusals, `aspd_route_profile_mismatch`, and every §5 launch and hello
refusal. Existing interactive admission refusals are unchanged.

### 1.5 Every Codex interactive birth through aspd (T-08560)

Source references in §1.5 are `packages/hrc-server/src` at `d27babfd` (whose
`packages/` tree equals installed HRC `bc390971`) unless another package is named.

**Intended behavior.** On a node with `HRC_ASPD_SOCKET` configured (max3), every
new interactive Codex birth is the runtime it is today: a `codex-app-server`
broker with `codexTui` presentation whose codex-tui wrapper runs the native
`codex app-server` and a Codex TUI in the leased `tui` pane. Every door that
births one now prepares it through aspd, freezes it at boundary P as
`route: 'interactive-codex-tui'` (§1.4 record), and launches it only from that
operation. §1.4 already made this true for `hrc run`/`hrc resume`. Four things
are unchanged:
- which door selects which runtime;
- join, reuse, reprovision and refusal decisions;
- how each door delivers its input;
- the interactive shape.

What changes is where the launch comes from, plus the four rules D1–D4 that make
the frozen route carry what the facade route carried.

**Why the other doors are still on the facade (two guards).** Both are in
`startInteractiveTmuxBrokerRuntime` (`broker-interactive-handlers.ts:1357`),
the single interactive birth chokepoint:
- **Guard 1 (cold-birth prompt bypass),** `:1382-1388`. When
  `flagOptions.coldBirthPrompt !== undefined`, the aspd endpoint is never
  consulted.
- **Guard 2 (attached-run key),** `aspdInteractiveCodexEndpoint`
  (`aspd-headless-start.ts:206-215`). It returns undefined unless
  `attachedRunDoor` is true, which `:1386` derives from
  `attachBeforeInvocationStart !== undefined`. Only `handlePrepareAttachedRun`
  passes that (`turn-dispatch-handlers.ts:1463`, `:1484-1495`).

A third, door-keyed fact would refuse any other door even with both guards
removed: launch validation requires `routeDecision.door === 'attached-run'` for
an `interactive-codex-tui` record (`aspd-headless-start.ts:666-668`). Otherwise
the launch fails `launch_description_mismatch`.

**The cold-birth prompt today, end to end (facade).**
1. The dispatch door picks the prompt mode (`turn-dispatch-handlers.ts:2189-2193`):
   - `launchPromptOnColdBirth` (mail kicker, `hrc-mail-kicker/src/drive/delivery.ts:426`)
     ⇒ `replace-priming`;
   - otherwise any `submissionDoor` (`server-types.ts:131-135`) ⇒ `append-to-priming`;
   - otherwise none.
2. `handleInteractiveTmuxBrokerDispatchTurn` strips `initialPrompt` from the
   intent it will persist (`broker-interactive-handlers.ts:655`). It calls the
   chokepoint with `coldBirthPrompt: prompt`,
   `includePrimingForColdBirthPrompt: mode === 'append-to-priming'` and an
   `onColdBirthPromptRoute` callback (`:716-731`).
3. The chokepoint builds a compile-only intent
   `{ ...effectiveTurnIntent, initialPrompt: coldBirthPrompt, omitPriming? }`
   (`:1413-1420`, `omitPriming: true` unless append). It is "deliberately not
   persisted": the applied intent written at `:1610` is the prompt-free
   `effectiveTurnIntent`.
4. For `codex-app-server` the compiler carries the prompt as
   `startRequest.initialInput`, whose `inputId` is HRC's allocated
   `initialInputId` (admission `compile-profile-selector.ts:200-215`).
5. After compile admission and the route check, before `controller.start`, the
   chokepoint reports `onColdBirthPromptRoute(isInteractiveTmuxBrokerProfile(profile))`
   (`:1536-1538`).
6. At B4 the run row gets `dispatchedInputId` and, for a submission door,
   `brokerSubmissionId = initialInputId`
   (`broker/controller/persistence.ts:215-224`, T-08541). `invocation.start`
   carries the prompt. The native TUI never sees it earlier.
7. Because `promptRodeLaunch` is true, the dispatch handler never submits the
   prompt again:
   - the detached path returns early (`:833`);
   - the awaited path answers with the launch submission (`:853-866`);
   - the invoke rendezvous waits for the launch turn's terminal (`:803-805`).

   When the prompt did not ride (no mode, or a non-launch profile), the handler
   submits it once after boot by runtime identity through
   `executeInteractiveBrokerInputTurn` (`:833-839`, `:868-872`).

The existing aspd interactive path (`startAspdInteractiveBrokerRuntime`,
`:1727-1801`) has three gaps:
- it reports `onColdBirthPromptRoute(false)` unconditionally (`:1759`);
- it calls `prepareAspdHeadlessAttempt` without `dispatchIdempotencyKey`
  (`:1760-1776`);
- it has no resume branch.

Guard 1 therefore exists because this path could not carry a launch prompt.

#### 1.5.1 Route predicate (Guards 1 and 2)

**New predicate.** A birth reaching `startInteractiveTmuxBrokerRuntime` prepares
through aspd iff:
- `allowedBrokerDriver === 'codex-app-server'`; and
- the node declares an aspd endpoint (`configuredAspdEndpoint`).

Nothing else enters the predicate: not the door, not `attachBeforeInvocationStart`,
not `coldBirthPrompt`, not the redirect control.
- Guard 1 is removed. `coldBirthPrompt` no longer selects a route; it is an input
  to preparation (D1).
- Guard 2 loses its `attachedRunDoor` input:
  `aspdInteractiveCodexEndpoint({ allowedBrokerDriver }, env)`.
- With the socket unset, or for any other driver (`claude-code-tmux`,
  `pi-tui-tmux`, `codex-cli-tmux`), the chokepoint keeps today's facade code path
  byte for byte, including Guard 1's compile-only intent.

**Door class, recorded.** The frozen route decision's `door` (today the constant
`'attached-run'`, `aspd-headless-start.ts:442`) becomes one of two values:
- `'attached-run'` when the attempt carries `attachBeforeInvocationStart`;
- `'interactive-birth'` otherwise.

Launch validation (`:666-668`) accepts either value for an
`interactive-codex-tui` record whose presentation is `codex-tui`. A record with
any other `door` value is refused `launch_description_mismatch` as today.
- An `'attached-run'` record never carries a launch-carried prompt: that door
  passes none (§1.4).
- An `'interactive-birth'` record is never launched with an attach handshake:
  only the attached-run door has one.

These are construction facts. They are asserted in tests, not new refusals.

**No silent fallback.** On a configured node, no Codex interactive birth reaches
`startAspcFacadeBrokerClient`, the resolver or a checkout worker. Every §4
preparation refusal and every §5 launch refusal fails the birth. The failure
propagates to the calling door exactly as a facade compile failure does today:
- the dispatch/kicker/DM/selector call throws;
- `hrc attach` reports the error;
- a registered start settles rejected and its joiners see the rejection.

`aspd_unavailable` (and every other pre-P refusal) leaves no operation row, no
runtime row for the attempt, no lease and no tmux server. A post-P, pre-start
refusal leaves the op `prepared` with `error_code` (§3) and no worker. The
never-started lease cleanup (§1.4 G1) releases any lease that was realized.

**Durable IPC.** The route requires the durable interactive route (§1.4). With
`HRC_BROKER_DURABLE_IPC_ENABLED` resolving off on a configured node, EVERY Codex
interactive birth now refuses `aspd_route_requires_durable_ipc` before
preparation, not only the attached run. max3 runs with it on (`launchctl print`,
T-08558 §0).

**Participant backstop.** `assertParticipantAddressNotSubstituted` runs at
`broker-interactive-handlers.ts:1376`, before the route predicate. It therefore
guards every door on both routes, including the unregistered ensure door. The
start door's own guards (`runtime-io-handlers.ts:327-341`: desktop reservation
and participant registration) are unchanged.

#### 1.5.2 Doors

Every door below reaches the chokepoint through one of four paths:
- the dispatch handler (`handleInteractiveTmuxBrokerDispatchTurn`, which
  registers its boot in `runtimeStartOperations` at
  `broker-interactive-handlers.ts:792-793`, synchronously after `:716`);
- the start door (`startRuntimeForSession`, which registers at
  `runtime-io-handlers.ts:667`);
- the ensure door (`ensureRuntimeForSession`, `selector-message-handlers.ts:190-236`,
  unregistered);
- the attached-run door (§1.4).

Joining, crossing fences and backstops are those of the path. §1.5 changes none
of them. The prompt class column names the D1 treatment.

| Door | Entry → caller path | Start operation registered | Joins / is joined | Prompt class | Caller retry key |
|---|---|---|---|---|---|
| Mail kicker summons birth (`wrkc say`, wake sweep) | `hrc-mail-kicker/src/drive/delivery.ts:410-427` → `dispatchTurn(session, lastAppliedIntentJson ?? runtimeIntent, …, { submissionDoor: 'invoke', launchPromptOnColdBirth: true, waitForCompletion: false })` → dispatch door | Dispatch handler boot (`broker-interactive-handlers.ts:793`) plus the invoke rendezvous (`:816-828`) | Joins an in-flight birth at the T-07693 fence (`turn-dispatch-handlers.ts:2031-2066`, not on attach), which also carries the T-08555 recorded-birth check when the redirect is off. A later wake joins this boot the same way. | Launch-carried, `replace-priming` | **None** (U8, below) |
| `POST /v1/turns` (`hrc turn`, `hrc start -p`, SDK) | `handleDispatchTurn` `turn-dispatch-handlers.ts:1063-1130` (door `invoke`) → dispatch door | Dispatch handler boot | Same T-07693 fence; T-08012 invoke rendezvous | Launch-carried, `append-to-priming` | `body.idempotencyKey` → `dispatchIdempotencyKey` (`:1063`, `:1121-1125`). The CLI mints a fresh key per invocation unless `--idempotency-key` is given (`hrc-cli/src/cli/handlers-scope-cmd.ts:130`) |
| Submission doors `steer`/`enqueue`/`invoke`/`preempt` | `handleSubmission` `turn-dispatch-handlers.ts:519-620` → `dispatchPublicSubmission` | Dispatch handler boot | T-07693 fence | Launch-carried, `append-to-priming` | **None.** `handleSubmission` parses no idempotency key and passes none (`:596-616`) |
| Target/DM messages (hrcchat) | `target-message-handlers.ts:1135-1142` (`enqueue`); `:1713-1722` (`enqueue`, `joinInFlightRuntimeStart: true`, T-07202) | Dispatch handler boot | T-07693 fence; T-07202 handler join (`broker-interactive-handlers.ts:668-697`) | Launch-carried, `append-to-priming` | None (durable message record, no dispatch key) |
| Selector messages | `selector-message-handlers/selector-input.ts:462-468` (no door) → dispatch door | Dispatch handler boot | T-07693 fence | After-boot: no mode; one submission by runtime identity (`broker-interactive-handlers.ts:868-872`) | None |
| §1.3 rule 3 reprovision at dispatch | Stale-mark `turn-dispatch-handlers.ts:2159-2172`, then the dispatch handler (`:2179-2198`) | Dispatch handler boot | As its caller door | As its caller door | As its caller door |
| Cold `hrc attach <scope>` birth and reprovision | `attachRuntimeEffectfully` `runtime-io-handlers.ts:812-942`: awaits a registered start (`:825-828`); admission (`:894-919`, stale-mark `:914-919`); birth `:921-927` → `startRuntimeForSession(…, 'reuse_pty', { operatorAttachPending: true })` | Start door (`:667`) | Start door joins a registered start (`:366-372`); later starts and dispatches join it | Bare (no input) | None |
| Explicit interactive `POST /v1/runtimes/start`, including §1.3 rule 3 at the start door | `handleStartRuntime` `turn-dispatch-handlers.ts:917` → `startRuntimeForSession`; reprovision stale-mark `runtime-io-handlers.ts:621-626`; birth `:630-639` | Start door | As above | Bare; or an intent-carried `initialPrompt` that is compiled and persisted as today, with the door waiting for `startRunId` completion (`:641-643`) | None (the claim keys below are not dispatch keys) |
| `POST /v1/runtimes/ensure`; app-session ensure/apply | `handleEnsureRuntime` `turn-dispatch-handlers.ts:899-915`; `app-session-handlers.ts:202`, `:315` → `ensureRuntimeForSession`; stale-mark `selector-message-handlers.ts:223-228`, birth `:230-235` | **None** (pre-existing, kept) | Neither joins nor is joined | Bare. App-session `initialPrompt` is a separate later dispatch (`app-session-handlers.ts:215-221`, `:321`) that reuses the ensured runtime | None |
| Rotation relaunch (`hrc session rotate --relaunch`, fresh-context) | `runtime-control-handlers/session-rotation.ts:256` (`effectiveSpec` interactive) and `:282` (stored intent) → `startRuntimeForSession(nextSession, …, 'fresh_pty')` | Start door, on the NEW host session | Start door rules | Bare. The stored intent is replayed; see §9 T-08560 for an intent-carried prompt | None |
| Received federation claims `roster-start` / `exact-start` | `roster-claim.ts:199`, `exact-claim.ts:162` → `startRuntimeForSession` (called under the claim mutex, registered synchronously) | Start door | Start door rules; claim-level replay via `replayRecordedClaim` (`scope-claim-core.ts:221-252`) | Bare | The claim `idempotencyKey` keys the claim record, not a dispatch. It is not a §5 retry key (below) |
| `hrc run` / `hrc resume` (attached run) | `handlePrepareAttachedRun` `turn-dispatch-handlers.ts:1463-1500` | Door-owned start operation (§1.4) | §1.4 joining rules | `-p` after start by identity (§1.4); never frozen | None by design (§9) |

**U8, settled from source: the kicker/dispatch cold birth carries no key usable
as the §5 same-attempt retry key.**
- The kicker calls `server.dispatchTurn` with `submissionDoor`, `ttlMs`,
  `submissionOrigin` and `launchPromptOnColdBirth`, and no
  `dispatchIdempotencyKey` (`hrc-mail-kicker/src/drive/delivery.ts:410-427`).
- `DispatchTurnForSessionOptions` takes the key only through
  `DispatchRunPersistenceOptions` (`server-types.ts:101`). Its one production
  producer is `handleDispatchTurn` (`turn-dispatch-handlers.ts:1121-1125`, key
  from `body.idempotencyKey`, `:1063`). Every other `dispatchIdempotencyKey`
  reference in `src` re-threads an already-supplied value
  (`rg dispatchIdempotencyKey packages/hrc-server/src`, excluding tests).
- The envelope id reaches HRC only as the origin label
  `submissionOrigin.envelopeId` (`delivery.ts:108-114`). Nothing looks up a
  prepared op by it (`findPreparedAspdAttemptForRetry` matches only
  `record.dispatchIdempotencyKey`, `aspd-headless-start.ts:557-577`).
- The kicker never re-dispatches after a throw. Any thrown dispatch is
  `markUncertain(…, 'dispatch_error')` (`delivery.ts:428-433`), so there is no
  retry caller that could present a key.

Among the doors in the table, only `POST /v1/turns` carries a key. The submission
doors are keyless: `handleSubmission` parses and forwards no idempotency key
(`turn-dispatch-handlers.ts:519-620`). This row supersedes T-08558 rev 2's M2 row
("Body key where supplied"), for which Astra recorded an erratum on T-08558. Leg A
adds no submission-door key; that would be a wire addition.

**The federation claim key is not a §5 retry key.** `roster-start` and
`exact-start` require an `idempotencyKey`, but it keys the durable claim record
(`replayRecordedClaim`, `scope-claim-core.ts:221-252`), not a dispatch. A replayed
claim re-enters `startRuntimeForSession` (`exact-claim.ts:162`,
`roster-claim.ts:199`), which carries no key into preparation. It therefore
prepares anew and leaves any earlier `prepared` operation visible (D3). Using the
claim key to resume would give the start door a resume concept it does not have,
for births that carry no input.

#### 1.5.3 D1 — launch-carried prompt: frozen once, reported after admission

**Current behavior.** See the end-to-end trace above:
- facade: the prompt compiles into `startRequest.initialInput` and is reported as
  launch-carried after admission, so the dispatch handler never submits it again;
- aspd: Guard 1 keeps every launch-carried birth off the route.

**New law.**
1. *Compile.* When the chokepoint takes the aspd route with a `coldBirthPrompt`,
   `prepareAspdHeadlessAttempt` receives the prompt and its mode. It compiles
   exactly the facade's compile intent:
   `{ ...intent, initialPrompt: coldBirthPrompt }` plus `omitPriming: true`
   unless the mode is `append-to-priming`.

   No new wire field is used. `initialPrompt` and `omitPriming` are existing
   `HrcRuntimeIntent` inputs that `compileBrokerRuntimePlan` already sends in
   `compileHarnessInvocation` on both routes. The prompt appears in the response
   as the existing `startRequest.initialInput`. No representational capacity is
   missing.
2. *Admit.* Admission is unchanged (§1.4: `codex-app-server`, `interactive`, tmux
   terminal; otherwise `aspd_route_profile_mismatch`). The existing
   initial-input identity check applies: `initialInput.inputId` must equal HRC's
   allocated `initialInputId` (`compile-profile-selector.ts:208-215`), otherwise
   `initial-input-id-mismatch` before P.
3. *Freeze.* Boundary P persists the prompt in exactly one place: the frozen
   `admission.startRequest` (and the identical `response.startRequest`). The
   route decision records `launchCarriedPrompt: { mode }` with mode
   `'replace-priming'` or `'append-to-priming'`, and records nothing when no
   prompt was compiled. The record's `intent`, which launch returns and the
   caller persists as the applied intent
   (`aspd-headless-start.ts:482`, `:732`; `broker-interactive-handlers.ts:1799`),
   is the prompt-free intent. That preserves the facade rule "compile-only intent
   deliberately not persisted" (`:1412`, `:1610`).

   Consequences:
   - A later stored-intent birth (kicker, rotation, cold attach) never replays a
     summons body.
   - `routeDecision.launchCarriedPrompt` is the recorded fact that the caller's
     prompt rode the start. It is needed because a promptless managed interactive
     birth can also carry priming as `initialInput`
     (`compile-adapter.ts:130-150`), so the presence of `initialInput` alone
     cannot distinguish the two.
4. *Report.* `onColdBirthPromptRoute(true)` fires only after P has committed an
   admitted interactive tmux profile with `launchCarriedPrompt`, and before
   launch. The `(false)` at `:1759` is removed.
   - A resumed attempt (D2) reports from the frozen record's
     `launchCarriedPrompt`, never from the retry's mode.
   - A birth without a `coldBirthPrompt` does not call the callback.
   - A refusal before P reports nothing. The dispatch handler's `promptRodeLaunch`
     stays false, and the boot operation rejects, so the post-boot submission
     paths (`:833`, `:868`) never run: nothing is delivered.
5. *Deliver.* The prompt reaches the native harness only as the frozen
   `invocation.start` `initialInput`, sent once by the controller.
   Initial-input provenance is preserved:
   - B4 writes `dispatchedInputId = initialInputId`, and `brokerSubmissionId` for
     a submission door (`persistence.ts:215-224`, unchanged);
   - the kicker's `launch` admission record, the T-08012 invoke rendezvous and
     `waitForLaunchCarriedInvokeSubmission` see the same run and submission
     identities as on the facade.

**Why exactly once.**
- The prompt exists only inside one frozen operation.
- `invocation.start` is sent at most once per operation. It is sent only after B4
  moves the op out of `prepared`, and an uncertain start is never replayed (§5).
- A `prepared` op proves no `invocation.start` was sent (§3), so no native TUI
  consumed the prompt. The native TUI starts only on `invocation.start` (T-08556
  `ev/g1-cancel`: realized lease, no native codex before resume).
- The dispatch handler's second-delivery paths are closed by the truthful report.
- A crossing dispatch that joins this boot delivers its OWN prompt (T-07693), not
  this one.

**Attached-run door.** Unchanged. `-p` is never in its frozen `startRequest` and
is delivered after start by identity (§1.4 "Initial input exactly once"). The
two treatments differ by door class, which the record carries (`door`).

**Proof rows.** §10.5 legs 1, 2, 3 (prompt once in HRC events and the native
rollout; the frozen copy is present exactly once in `startRequest` and absent
from `sessions.last_applied_intent_json`) and gate G-D1.

#### 1.5.4 D2 — retry key frozen, same-attempt resume

**Current behavior.**
- The headless aspd route freezes `dispatchIdempotencyKey` at P
  (`broker-headless-handlers.ts:784`). It resumes a `prepared` op when a
  same-host-session, same-key retry arrives with the frozen run id
  (`:757-775`).
- `handleDispatchTurn` finds that op and rebinds `runId` before routing
  (`turn-dispatch-handlers.ts:1080-1091`).
- The interactive aspd route freezes no key (`broker-interactive-handlers.ts:1760-1776`)
  and has no resume branch. `dispatchRunPersistence` carries the key only to the
  B4 run row (`:1777-1778`, `persistence.ts:215`).

**New law.**
1. `startAspdInteractiveBrokerRuntime` passes `dispatchIdempotencyKey` into
   `prepareAspdHeadlessAttempt`, which freezes it (`aspd-headless-start.ts:454-456`,
   unchanged).
2. Before preparing, it looks up `findPreparedAspdAttemptForRetry(hostSessionId,
   key)`. When a match has `runId === diagnosticRunId` it launches that
   operation with no aspd contact, no re-preparation and no rebinding, exactly
   like the headless branch (`:766-775`). D1 reporting then comes from the frozen
   record.
3. **Route fence.** A resume branch launches only a record of its own route:
   - the interactive branch only `interactive-codex-tui`;
   - the headless branch only `headless-codex-app-server`.

   A same-key, same-runId match of the other route refuses retryable
   `runtime_unavailable` with reason `aspd_preparation_route_changed`. Nothing is
   launched and the op stays `prepared` and visible. The reason is an
   HRC-internal refusal carried in HRC's existing `runtime_unavailable` error
   detail. It is not an ASPC or broker wire value.

   Why: today `findPreparedAspdAttemptForRetry` is route-blind, which is harmless
   only because interactive records never carry a key. After step 1, a keyed
   retry whose session routing changed (for example a body intent that is now
   non-interactive) would otherwise launch a frozen interactive op through the
   headless handler. Preparing anew instead would rebind a committed attempt to
   the active release, which §5 forbids.
4. A same-key retry whose routing selects reuse of a live runtime, or a join, does
   not reach a resume branch. It delivers the retry's input through that
   runtime with the frozen run id (existing `handleDispatchTurn` behavior). The
   prepared op is left `prepared` and visible, never launched. This is safe
   because it never sent `invocation.start`.
5. The retry body's prompt is not compared with the frozen prompt. The frozen
   prompt is the attempt's input, as on the headless route today.

**Scope of D2.** It gives same-attempt retry to `POST /v1/turns` only: `hrc turn`,
`hrc start -p --idempotency-key K` and SDK callers passing a key. No other door
carries a key (§1.5.2). §5 "Resume" is otherwise unchanged. There is no startup
auto-launch. A retry after B activation launches A. A retry after the frozen
release is missing refuses `release_unavailable` again and stays visible.

**Proof rows.** §10.5 leg 4 and gate G-D2.

#### 1.5.5 D3 — keyless doors

**Current behavior.** The attached-run door carries no key. A pre-start refusal
leaves its op `prepared` and visible, and the run fails (§9 T-08556). Headless
kicker and DM births through aspd behave the same today (T-08555, same keyless
doors).

**New law.** For every keyless door:
- the kicker summons birth;
- submission doors;
- target/DM and selector messages;
- cold attach;
- keyless start;
- ensure;
- rotation relaunch;
- received federation claims;
- `hrc run`.

A post-P, pre-start refusal leaves the op `prepared`, with `error_code` and
`error_message` recorded, and no worker. The op is never auto-launched and never
resumed by that door, which has no key to present. The door's own failure
handling runs unchanged:
- dispatch-style doors settle the run `failed` where a run row exists
  (`settleFailedInteractiveBrokerStart`), otherwise they throw;
- start-door births reject their registered operation;
- cold attach reports the error.

A later request by the same door is a new attempt: it gets a new preparation
against the active release. Recovery for the stranded op:
- it is visible in `runtime_operations` (status `prepared`, `error_code`) and in
  `aspd.launch.refused` / `aspd.launch.failed` server logs;
- it is inert: it holds no lease (G1 cleanup) and sent no input;
- the operator re-sends through the door;
- an op frozen for a keyed `/v1/turns` dispatch alone can be resumed (D2).

**Mail kicker (Q7, preserved).** Leg A does not change the kicker. It keeps:
- the keyless dispatch;
- its classification of ANY thrown dispatch as uncertain (`markUncertain(…,
  'dispatch_error')`, `delivery.ts:428-433`), including a known-unapplied aspd
  refusal before or after P;
- no auto-resume.

An envelope whose summons birth refuses stays uncertain and needs operator
action (`hrc mail inspect <envelope>`), exactly as a facade compile failure does
today. Retry semantics are not enlarged to route births. Duplicate safety holds
because an uncertain envelope is never re-dispatched, and the refused op never
launches.

**Proof rows.** §10.5 legs 3 and 6 and gate G-D3.

#### 1.5.6 D4 — stale-mark before preparation; the new pre-launch failure class

**Current behavior.** The reprovision doors stale-mark the live runtime they
replace BEFORE the chokepoint runs:
- dispatch rule 3 / interactive admission, `turn-dispatch-handlers.ts:2159-2172`;
- the start door, `runtime-io-handlers.ts:621-626`;
- cold attach, `:914-919`;
- ensure, `selector-message-handlers.ts:223-228`;
- rotation invalidates the prior host session's runtimes before relaunch,
  `session-rotation.ts:196-256`.

A facade compile failure after that point leaves the scope with the old runtime
stale-marked and no new runtime.

**New law.** The ordering is unchanged:
1. selection and stale-mark;
2. preparation (aspd RPC);
3. P;
4. launch.

No aspd preflight is added before stale-marking. A hello probe is not a
reservation: aspd can fail between probe and compile, so a preflight would only
narrow the window, not close it.

aspd adds a new pre-launch failure class for reprovision doors on a configured
node:
- **pre-P refusals, which leave no op:** `aspd_unavailable`,
  `aspd_protocol_incompatible`, `aspd_capability_missing`,
  `aspd_release_unidentified`, `aspd_connection_closed`,
  `execution_release_missing`, `aspd_route_profile_mismatch`,
  `aspd_route_requires_durable_ipc`, compile-not-ok;
- **post-P, pre-start refusals, which leave the op `prepared` with
  `error_code`:** `release_unavailable`, `release_identity_mismatch`,
  `worker_executable_outside_release`, `unsupported_worker_protocol`,
  `launch_description_mismatch`, `preparation_generation_superseded`,
  `worker_protocol_mismatch`, `worker_release_unidentified`,
  `worker_release_mismatch`.

In either case the replaced runtime is already stale-marked, and no new runtime,
lease or tmux server remains for the attempt. The scope has no live runtime
until the next birth. The same statement holds for rotation relaunch on the new
host session. For a non-reprovision birth (nothing live), a refusal leaves the
scope as it was.

**Proof rows.** §10.5 leg 6 (aspd stopped against a reprovision door) and gate
G-D4.

#### 1.5.7 Ensure stays unregistered

`/v1/runtimes/ensure` and app-session ensure still birth without registering in
`runtimeStartOperations` (§1.4 "Pre-existing limit"). They now prepare through
aspd like every other door. Leg A does not register them, for three reasons:
- **It would change a door, not a preparation.** Registration would make ensure
  a joinable birth for every dispatch and start. It would also make ensure join
  in-flight starts, which it does not do today: it reuses or stale-marks by rows
  alone (`selector-message-handlers.ts:208-228`). That is a change in join law
  for an operator door, orthogonal to where the launch is prepared.
- **Exactly-once does not depend on it.** Ensure carries no input. Every prompt
  on the route is either frozen inside its own operation (D1) or delivered by
  runtime identity (§1.4; selector after-boot).
- **The hazard is pre-existing and unchanged.** Ensure can stale-mark a runtime
  another door is still birthing. aspd adds preparation latency, which widens the
  window, but a concurrent stale-mark still cannot move a frozen prompt to
  another runtime.

#### 1.5.8 Unchanged

- The attached-run door (§1.4): selection, joining, `-p` by identity, attach
  handshake and G1 cleanup.
- §6: existing workers, detach, reattach, restart and release-hello reattach.
  aspd is never contacted there, so aspd activation or outage affects only new
  Codex births.
- §1.3 precedence rules 1–5, redirect scope, the established-runtime definition,
  crossing refusals and the T-07693/T-07202/T-07397 joins and refusals.
- Continuation selection (`decideInteractiveTmuxBrokerContinuation` on both
  routes) and HRC `aspHome` on every compile (§1.3 Codex home).
- Persistence and readback per §1.4, with two exceptions: route decision `door`
  is `'interactive-birth'` for non-attached doors, and `launchCarriedPrompt` is
  added where D1 applies.
- Not moved:
  - the Claude, Pi and `codex-cli-tmux` interactive drivers (Leg B, after P1);
  - the hosted participant broker (M7);
  - the Codex Desktop observer (M18: Leg B / T-08567, U12 pending).

**Refusals.** New: `aspd_preparation_route_changed` (D2 route fence, retryable
`runtime_unavailable`; HRC-internal, not wire). Reused on every Codex interactive birth door:
`aspd_route_requires_durable_ipc`, `aspd_route_profile_mismatch`, every §4
preparation refusal including `aspd_unavailable`, and every §5 launch and hello
refusal. Door admission refusals are unchanged.

**Node scope.** Gated by `HRC_ASPD_SOCKET` alone. Only max3 has it; svc, lab and
hrcdev have none (§1.3 fleet readback). With the socket unset, every door is byte
for byte today's behavior. The redirect control is not consulted.

**Delivery and rollback.**
- No ASP change: producer `90dd7508` already carries the interactive wrapper,
  hook and tmux-launch launchers (T-08558 §4 Leg A, M2).
- Order: `just install` HRC, restart, and verify that running equals installed,
  that aspd is reachable on the active release, and that warmup reattached.
- HRC rollback: repoint `hrc-runtime-current` to the recorded prior release
  (at the time of writing, HRC `bc390971`), then `bootout`/`bootstrap`. Non-attached Codex interactive births
  return to the facade. Runtimes born on the aspd route stay live and reattach
  under the prior release, whose §6 hello check is door-agnostic.
- No plist change and no aspd release change.

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
   selected profile is headless `codex-app-server` [T-08556/T-08560: or, on the
   interactive route, interactive `codex-app-server` with the tmux terminal, §1.4]
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

**Amend `hrc-runtime.aspd-prepared-execution-release` (T-08556):** the route
also covers a new interactive `codex-app-server` birth with `codexTui`
presentation made by the attached-run door (`hrc run`, `hrc resume`) on a node
with `HRC_ASPD_SOCKET` configured. The attempt freezes route
`interactive-codex-tui`, presentation `codex-tui` and the interactive start
request at boundary P. It launches only on the durable interactive tmux substrate
from those persisted bytes, requires the durable interactive route, and its
codex-tui wrapper and hook receiver run from the same execution release as the
worker. Other doors that birth the interactive backend are not on the route
[T-08560: every door is, amendment below]. On that door, selection, birth and input delivery happen inside one operation
the door registers in the host session's start singleflight. A joined start is
re-checked by its recorded birth and joined only as a same-harness newborn
that interactive admission reuses (tmux) or that rule 5 reuses (headless). The
input is delivered by runtime identity to the selected runtime before the
operation deregisters. A live headless runtime of any harness or invocation state is never
stale-marked, replaced or started beside, except by explicit `--force-restart`
with no start joined. A settled, operator-attachable Codex one is attached and
receives the input. A Codex one without an operator presentation is refused
`presentation_conflict`. A transitional or foreign one is refused
`runtime_unavailable`. Each refusal leaves the runtime untouched. Detach,
reattach and restart never require aspd.

**Amend `hrc-runtime.asp-toolchain-selection` (T-08556):** with
`HRC_ASPD_SOCKET` configured, the resolver does not govern an interactive Codex
birth made by the attached-run door. Its worker comes only from the frozen
`executionRelease`, and there is no fallback. Interactive births by every other
door stay resolver-governed [superseded by T-08560 below].

**Amend `hrc-runtime.aspd-prepared-execution-release` (T-08560):** on a configured
node every new interactive `codex-app-server` birth prepares through aspd,
whichever door requests it: attached run, cold attach, turn dispatch, mail summons,
submission doors, target and selector messages, reprovision, explicit start,
ensure, rotation relaunch, or a received federation claim. It freezes route
`interactive-codex-tui`, presentation `codex-tui`, its door class (`attached-run`
or `interactive-birth`) and the interactive start request at boundary P.
- **No fallback.** No interactive `codex-app-server` birth on a configured node is
  facade-prepared or resolver-launched, and none falls back when aspd or launch
  validation refuses. A refusal before boundary P leaves no operation, runtime,
  lease or tmux server. A refusal after it leaves the operation `prepared` with its
  refusal recorded.
- **Attached-run door.** The attached-run door keeps its single registered
  operation, its joins and its identity-bound `-p` delivery. Its prompt is never
  part of the frozen start request.
- **Other doors' prompts.** A cold-birth prompt carried by any other door is
  compiled into the preparation exactly as the facade compiles it: priming is
  replaced for a launch-primed summons and appended for a submission door. The
  prompt is persisted only in the frozen start request, recorded as launch-carried
  with its priming mode, and never persisted in the applied intent. It is reported
  to the dispatch door as launch-carried only after boundary P commits an admitted
  interactive profile, so the dispatch door never submits it separately. A
  prepared operation proves the prompt was never applied.
- **Retry.** Interactive and headless preparations freeze the caller's key alike. A
  resume launches only a preparation of the route the retry selected. Otherwise it
  refuses `aspd_preparation_route_changed` (HRC-internal), and the operation stays
  `prepared`. A door that carries no caller key never resumes a prepared
  operation. That includes the mail kicker, whose classification of a thrown
  dispatch as uncertain is unchanged.
- **Stale-mark ordering.** A door that replaces a live runtime stale-marks it
  before preparation, as on the facade route. A preparation or pre-start launch
  refusal therefore leaves that scope with no live runtime until its next birth.
- **Ensure.** Ensure births stay unregistered in the start singleflight.

**Amend `hrc-runtime.asp-toolchain-selection` (T-08560):** with
`HRC_ASPD_SOCKET` configured, every new interactive `codex-app-server` birth, by
any door, is aspd-prepared and is not governed by the resolver. Its worker,
codex-tui wrapper and hook receiver run only from the frozen `executionRelease`,
with no fallback. Interactive births of other broker drivers (`claude-code-tmux`,
`pi-tui-tmux`, `codex-cli-tmux`), hosted participant brokers and the Codex
Desktop observer broker remain resolver-governed.

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
  only by that backend are untouched [T-08556/T-08560: its births move to aspd on
  a configured node, §1.4 and §1.5; the facade path remains elsewhere].
- T-08555: the default changes new executions only. There is no migration of live
  runtimes or of scopes whose stored intent is interactive, and no deletion of
  the standalone backend. `hrc run` and cold `hrc attach` stay on it, and it gets
  no new release binding [T-08556: `hrc run`/`hrc resume` births move to aspd,
  §1.4; T-08560: cold `hrc attach` and every other door's births move too,
  §1.5]. The redirect flag keeps its name. Other nodes keep
  their configuration.
- T-08556: only the attached-run door moves. Cold `hrc attach`, stored-intent
  rebirth, §1.3 rule 3 reprovision and message births of the interactive
  backend keep the facade [superseded by T-08560 below]. The facade backend and its checkout wrapper launch are
  not removed. The read-only renderer gains no input. A never-submitted
  interactive preparation has no caller retry key (the attached-run door carries
  none), so a pre-start refusal leaves it `prepared` and visible, and the run
  fails. It is never auto-launched. No lost-start-reply retry, no flag, no
  other node.

- T-08560: every Codex interactive birth door moves.
  - There is still no durable start receipt and no lost-start-reply retry. A
    transport-uncertain start stays uncertain on every door.
  - Nothing new is added: no flag, value, endpoint, ASPC verb, wire field or
    producer change. `aspd_preparation_route_changed` and the door class are
    HRC-internal.
  - max3 only; no fleet activation and no ACP producer advance.
  - The facade interactive backend is not removed. Its compile-only intent, the
    checkout wrapper launch and the resolver remain for unconfigured nodes and
    other drivers.
  - Only `POST /v1/turns` resumes a frozen interactive preparation. The submission
    doors, the federation claim key and the mail kicker gain no retry semantics.
    The kicker's keyless dispatch and uncertain-on-throw classification are
    unchanged.
  - Ensure stays unregistered (§1.5.7).
  - Not moved: Claude, Pi and `codex-cli-tmux` interactive births, hosted
    participant brokers, and the Codex Desktop observer (Leg B / T-08567).
  - There is no migration of live facade-born interactive runtimes. They are
    reused by admission and replaced only by today's reprovision rules, and that
    rebirth is aspd-prepared.
  - **Named hazard, pre-existing, outside Leg A, not assumed safe:** an
    intent-carried `initialPrompt` is persisted in `last_applied_intent_json`.
    - The start door persists it on the facade interactive route
      (`broker-interactive-handlers.ts:1610`, intent from
      `runtime-io-handlers.ts:633`).
    - The headless aspd route persists it too (read-only max3 query, 2026-09-17:
      14 of 14 `headless-codex-app-server` preparations carry
      `intent.initialPrompt`).
    - Rotation relaunch and cold attach replay the stored intent into
      `startRuntimeForSession`.

    Whether such a replay re-sends the prompt is unresolved. §1.5 does not change
    it, and it does not persist a launch-carried prompt (D1). The hazard is
    tracked on the P-00521 campaign ledger.

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

### 10.4 `hrc run` interactive aspd acceptance (T-08556)

Reproduction first: the compiled probe resolving `/$bunfs/root/codex-tui-wrapper`
(absent) against agent-spaces `864e801e`, and the same probe passing on the fix.
Isolation: a linked-worktree HRC artifact under `hrc server serve` with isolated
state, runtime and socket, durable IPC on, max3 configuration (redirect off,
`tmux-tui`, `HRC_ASPD_SOCKET` to an isolated aspd namespace with retained
releases A (current operational, pre-fix) and B (fix), and HRC's `ASP_HOME`
distinct from aspd's). Clean Ghostty via ghostmux, real cody Codex scopes, real
keystrokes.
1. B active. `hrc run <fresh>` with no flags gives:
   - aspd compile +1 and an op `route: interactive-codex-tui` with executionRelease
     and worker hello B;
   - transport `tmux`, `broker` pane process `<B>/libexec/harness-broker run` and
     `tui` pane process `<B>/libexec/harness-broker codex-tui-wrapper` with
     `codex app-server` and `codex --remote` children;
   - a prompt typed into the TUI produces a rendered response and a completed
     turn with its native submission and normalized events;
   - `routeDecision.aspHome` equals HRC's.
2. `hrc run <fresh> -p MARK`: exactly one user input carrying MARK (HRC events
   and native rollout), one completed turn, attached terminal.
3. Detach (tmux client detach), then a warm turn while detached via `hrc turn`,
   then `hrc run <scope>` (warm reuse) and `hrc attach <scope>`. Runtime,
   invocation, worker pid, wrapper and app-server pids and release are
   unchanged, and typed input still works.
4. Reuse without replacement:
   - `hrc run` on a live facade codex-tui scope (born by cold attach) attaches
     it, unchanged [T-08560: cold attach no longer births facade runtimes on a
     configured node; a re-run uses a pre-change facade runtime];
   - `hrc run -p` on a live default app-server viewer scope attaches its
     renderer and delivers once, runtime unchanged;
   - `hrc run` on a live `--no-viewer` scope refuses `presentation_conflict`
     with nothing mutated.
5. Cold `hrc attach <fresh>` still births the facade backend (no aspd
   compile). [Inverted by T-08560: §10.5 leg 5.]
6. Stop aspd: `hrc run <fresh>` refuses `aspd_unavailable` with no op, runtime
   or tmux server left behind. `hrc run`/`hrc attach` on the live aspd
   interactive scope still attach and take typed input.
7. Retained-release proof: with A active, an interactive preparation launches a
   worker that fails to start its TUI (recorded, run fails with state
   accurate), which demonstrates that the binding is real. Activate B: the next
   `hrc run` is B and works. A B interactive worker stays usable after
   re-activating A. Restart the HRC artifact with aspd stopped: the B
   interactive runtime reattaches (release hello), and its TUI keeps typed
   input. A cancelled attach (CLI killed before resume) leaves no worker and an
   accurate op/run state.
8. Gates: targeted route/admission/allocation/duplicate-input tests, including
   crossing tests. An `hrc start` birth in flight when `hrc run` (with and
   without `-p`) arrives is joined, never duplicated. A dispatch crossing the
   door's start joins it. Established transitional, foreign-harness, no-viewer
   and viewer headless runtimes each get the rule 3 outcome with rows untouched,
   with no stale-mark and no second runtime.
   A joined foreign tmux birth refuses without awaiting its boot. A joined
   same-harness tmux newborn that admission does not reuse is refused. `-p`
   reaches the selected runtime by identity even when another runtime is
   stale-marked or inserted for the session between selection and delivery.
   Suites:
   hrc-server and hrc-cli suites, and the harness-broker suite in agent-spaces.

Shared max3 (rollback record first): build and install the ASP release, activate
it on the persistent aspd, verify hello, `just install` HRC, restart, and read
back running equals installed, the aspd release and warmup reattachment against
the 9 known unreachable. Repeat 1–4 on fresh cody scopes in clean Ghostty,
without touching other users' scopes. Clean up test scopes only, leaving one
active aspd release with prior releases retained. Astra grades.

### 10.5 Every Codex interactive birth through aspd acceptance (T-08560)

**Executors.**
- **Implementer (I):** an isolated rig identical to §10.4: linked-worktree HRC
  artifact under `hrc server serve` with isolated state, runtime and socket;
  durable IPC on; redirect off; `tmux-tui`; `HRC_ASPD_SOCKET` pointing at an
  isolated aspd namespace with retained A (current operational `90dd7508`) and
  B (a visibly different staged release); clean Ghostty via ghostmux; real cody
  Codex scopes; real CLI. I runs every destructive leg (aspd stop, A→B, withheld
  release, cancellation, restart) because those affect every max3 user on shared.
- **Supervisor (S), mable:** shared max3 after guarded `just install` and restart,
  on fresh cody scopes, non-destructive legs only, then independent grade.

**Per-birth observation set (O).** Resolve `STATE=$(hrc server status --json | jq -r .stateRoot)`;
the ledger is `$STATE/state.sqlite`, opened `sqlite3 -readonly`.
- **O1 compile +1 and route:**
  `select operation_id,status,error_code,json_extract(preparation_json,'$.route'),json_extract(route_decision_json,'$.door'),json_extract(route_decision_json,'$.launchCarriedPrompt.mode'),json_extract(preparation_json,'$.executionRelease.releaseId'),json_extract(preparation_json,'$.dispatchIdempotencyKey') from runtime_operations where host_session_id=? and preparation_json is not null`
  count before/after = +1, plus one `aspd.preparation.frozen` line in the HRC
  server log.
- **O2 worker hello = frozen:** `hrc runtime inspect <rt> --json`, reading
  `runtime_state_json.executionRelease` (`releaseId`, `helloRelease`, source
  `aspd`) equal to O1's release; transport `tmux`.
- **O3 panes:** the runtime's tmux socket from `hrc runtime inspect`, then
  `tmux -S <sock> list-panes -a -F '#{window_name} #{pane_pid}'` and
  `ps -o pid,ppid,args -p <pid>` recursively.
  - `broker` pane: `<release>/libexec/harness-broker run …`;
  - `tui` pane: `<release>/libexec/harness-broker codex-tui-wrapper …` with
    `codex app-server` and `codex --remote` children.
- **O4 prompt exactly once:**
  - `select event_kind,count(*) from hrc_events where host_session_id=? and payload_json like '%<MARK>%' group by event_kind`
    shows exactly one user-prompt event and no duplicate submission;
  - in the native rollout, `<ASP_HOME>/codex-homes/<project>_<agent>/sessions/**/rollout-*.jsonl`,
    MARK appears in exactly one user message (T-08556 `shared/s2` method);
  - frozen copy: `json_extract(preparation_json,'$.admission.startRequest.initialInput')`
    contains MARK once;
  - `select last_applied_intent_json from sessions where host_session_id=?` does
    not contain MARK.

| Leg | Door / mechanism | Action | Required observation | Exec |
|---|---|---|---|---|
| 1 | Mail kicker summons (C-replace) | Seed a fresh scope's stored intent interactive (one `hrc run`, then terminate), then `wrkc say <scope> --to <scope>` with MARK | O1 (door `interactive-birth`, mode `replace-priming`), O2, O3, O4; mail receipt landed (`hrc mail inspect <envelope>`); priming absent from the launch turn | I, then S |
| 2 | `/v1/turns` (C-append), DM (C-append), submission door `enqueue` (C-append), rule 3 reprovision | Cold `hrc turn <scope> MARK` on an interactive-stored fresh scope; hrcchat DM cold birth; `enqueue` submission cold birth; `hrc turn` against a live Claude tmux runtime of the same scope (rule 3 → stale-mark → birth) | Each: O1 (mode `append-to-priming`), O2, O3, O4 with priming present; rule 3: prior runtime stale, one new runtime | I (all), S (`hrc turn`, DM) |
| 3 | Selector message (C-after) | Selector message MARK to an interactive-stored fresh scope | O1 (no `launchCarriedPrompt`), O2, O3; O4 with the frozen copy ABSENT and one identity submission | I, then S |
| 4 | D2 same-key retry | I: withhold release A's directory; `hrc start <scope> -p MARK --idempotency-key K` on an interactive-stored scope, giving `release_unavailable`, op `prepared`, no worker/tmux; activate B; restore A; retry K | Retry launches the frozen op: O2 hello A (not B), O4 once, O1 count unchanged by the retry; a new un-keyed scope prepares on B | I |
| 5 | C-bare doors | Cold `hrc attach <fresh interactive-stored scope>`; `hrc session rotate <hostSessionId> --relaunch` on a live interactive scope; `POST /v1/runtimes/ensure` (interactive intent); explicit interactive `POST /v1/runtimes/start`; received `exact-start` claim | Each: O1 (door `interactive-birth`, no prompt), O2, O3; attach gives a usable TUI with typed input rendering; claim via a two-daemon isolated pair (peer-routed) | I (all); S (attach, rotate --relaunch) |
| 6 | No fallback / D3 / D4 | Stop aspd. (a) Cold `hrc attach <fresh>`; (b) kicker summons to a fresh scope; (c) cold attach against a live facade-born or Claude tmux runtime (reprovision) | (a) `aspd_unavailable`, no op row, no runtime row, no lease, no btmux socket/process; (b) same, plus envelope `uncertain` (`dispatch_error`) and not re-dispatched on the next sweep; (c) prior runtime stale-marked, nothing new; live aspd interactive runtimes still take typed input and `hrc turn` | I |
| 7 | A→B activation with a live A interactive worker | A active: leg 1 birth on A. Activate B (same HRC pid/artifact). Type into the A TUI and `hrc turn` it; fresh summons birth | A worker keeps typed input and a completed turn, hello A unchanged; the fresh birth is B (O2); no HRC connection to aspd held across activation | I |
| 8 | Cancellation / never-started lease cleanup (G1) on a non-attached door | Kill the leg 1 launch between P and `invocation.start` (worker handshake refused by withholding the release after realization, or a daemon stop mid-launch in the rig) on a kicker birth | Op `prepared` (hello refusal) or `failed` per §1.4 G1; no lease-server process, no broker socket, no native codex; run state accurate; no user-prompt event | I |
| 9 | Restart reattach | Restart the rig HRC with aspd stopped, with leg 1/2/5 runtimes live | Each reattaches (release hello), typed input and a warm turn work | I |
| 10 | Attached-run door unchanged | `hrc run <fresh> -p MARK` | §10.4 legs 1–2 hold; door `attached-run`; frozen copy ABSENT; O4 once | I, then S |
| 11 | Other drivers unchanged | Kicker summons and cold attach to a Claude scope | No aspd compile; facade/resolver path as today | I, then S |
| 12 | Gates | The gate suites below, `just architecture-records` | Green | I |

**Shared max3 (S).**
1. Write the rollback record first (prior HRC release `bc390971`).
2. `just install`, `hrc server restart`.
3. Read back running equals installed, aspd reachable on
   `asp-90dd75083a32-20260917T020900Z-81b3b5`, and warmup attached == total
   minus the known unreachable set.
4. Run legs 1, 2 (`hrc turn`, DM), 3, 5 (attach, rotate --relaunch), 10 and 11 on
   fresh `cody` scopes in clean Ghostty, without touching other users' scopes.
5. Clean up test scopes only.
6. Independent grade.

No aspd stop, activation or withheld release on shared.

**Gates that must stay green unchanged (names from source).**

- `t08556-attached-run-aspd-tui.test.ts` except the two rewritten below: cold birth,
  `-p` exactly once, aspd unavailable, durable IPC, established runtimes, crossing,
  F4 identity delivery, G1 lease cleanup.
- `t07693-two-wake-double-birth.red.test.ts` (join, never double-birth);
  `t07202-semantic-dm-cold-singleflight.red.test.ts`.
- T-07397 surface-reuse refusal and join caller policy:
  `submission-door-session-surface.test.ts`, and
  `t08555-default-app-server-viewer.test.ts` "a crossing same-harness tmux birth
  is joined only through admission caller policy (T-07397)".
- `t07920-kicker-launch-prompt.test.ts`, `t08004-invoke-cold-priming.test.ts`,
  `t08531-enqueue-cold-priming.test.ts` (claude-code-tmux: facade by driver, must
  be unaffected); `t08541-cold-invoke-initial-input-identity.test.ts` (Codex,
  socket unset: facade).
- `t07944-cold-birth-lifecycle.test.ts`, `t07963-cold-birth-first-turn.test.ts`,
  `attached-run-operation-lifecycle.test.ts`.
- `t08542-aspd-prepared-execution.test.ts`, `t08553-per-request-presentation.test.ts`,
  `t08554-app-server-viewer.test.ts`, `t08555-default-app-server-viewer.test.ts`.
- hrc-mail-kicker: `t08394-absent-seat-cold-birth.test.ts`,
  `t08139-broker-start-birth-retry.test.ts`, `t08094-*`.
- The hrc-server and hrc-cli suites, and `just architecture-records`.

Note: `t08553` "omitted choice keeps the node Codex redirect: interactive route,
no aspd preparation" stays green only because it stubs the interactive route. Its
title states a premise §1.5 makes false for a real configured node. Retitle it,
don't change the assertion.

**Gates whose premise inverts (rewrite, do not delete).**

- `t08556` "only the attached-run door, the codex-app-server driver and a
  configured node select aspd" (`:288-300`) becomes "the codex-app-server driver
  and a configured node select aspd for every door; other drivers and an unset
  socket do not."
- `t08556` "another door birthing the interactive backend keeps the facade"
  (`:367-377`) becomes "a non-attached interactive Codex birth prepares through
  aspd with door `interactive-birth` (facade not reached)".
- The `door: 'attached-run'` expectation (`:316`) stays for the attached run.

**New gates (real handlers, aspd double, facade spy throwing).**

- **G-route:** per door in §1.5.2, through its own entry function (kicker
  `deliver…`, `handleDispatchTurn`, `handleSubmission` ×4, both DM paths, selector
  input, dispatch rule 3, `attachRuntimeEffectfully`, `handleStartRuntime`,
  `handleEnsureRuntime`, app-session ensure, both rotation relaunch branches,
  `roster-start`/`exact-start` claims). Each gives aspd compile +1, op
  `interactive-codex-tui`, and door class as specified. The facade is never
  reached. Claude/Pi on the same doors still reach the facade. The socket unset
  reaches the facade.
- **G-D1:**
  - for `replace-priming` and `append-to-priming`, the frozen
    `startRequest.initialInput` carries the prompt once and priming is
    omitted/included;
  - `routeDecision.launchCarriedPrompt.mode` is recorded;
  - `last_applied_intent_json` has no `initialPrompt`;
  - `onColdBirthPromptRoute(true)` fires after P and before launch, and never on
    a pre-P refusal;
  - no post-boot `executeInteractiveBrokerInputTurn` for the run;
  - B4 `dispatchedInputId`/`brokerSubmissionId` equal `initialInputId`;
  - the invoke rendezvous crossing waits for the launch turn terminal (T-08004
    shape on codex-app-server);
  - selector (no mode): no frozen prompt and one identity submission.
- **G-D2:**
  - a keyed `/v1/turns` interactive birth freezes the key;
  - a withheld release refuses post-P (op `prepared`);
  - a same-key retry resumes with no aspd contact and delivers once;
  - a retry after B activation launches A;
  - the route fence refuses `aspd_preparation_route_changed` both ways with the
    op untouched;
  - a retry that finds a live runtime delivers through it and leaves the op
    `prepared`.
- **G-D3:**
  - kicker summons with a post-P refusal leaves op `prepared` + `error_code`, the
    envelope uncertain (`dispatch_error`) and nothing re-dispatched on the next
    sweep;
  - DM/selector/attach/start/ensure/rotate/claim refusals leave op `prepared` and
    no auto-launch after a daemon restart.
- **G-D4:** rule 3 / attach / start / ensure reprovision with aspd unavailable:
  the old runtime is stale-marked, no op, no new runtime, no lease.
- **G-join:** the T-07693, T-07202 and T-08555 crossing tests re-run with the
  birth on the aspd route: one runtime, each prompt once.
- **G-backstop:** a participant-registered scope refuses at every door before
  preparation (no aspd compile), including ensure.
- **G-ipc:** durable IPC off on a configured node refuses every door
  `aspd_route_requires_durable_ipc` before preparation.
