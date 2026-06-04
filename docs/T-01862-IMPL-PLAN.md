# T-01862 Implementation Plan — Leased tmux as default harness-broker/0.2 substrate

Coordinator: clod@hrc-runtime:primary. Reviewer: daedalus. Architecture consult: cody@hrc-runtime:primary.
Impl: curly. Reds/acceptance: smokey. (larry excluded per Lance.)
Canonical spec: `docs/T-01862-leased-tmux-harness-broker-substrate-spec.md`
Branch: `main` (develop in place, no new branches).

## Grounded current state (Explore sweep, 2026-06-04)
- Protocol constants are **additive, not aliases**: `BROKER_PROTOCOL_VERSION='harness-broker/0.1'`
  (stdio, headless route) and `BROKER_PROTOCOL_VERSION_V2='harness-broker/0.2'` (unix, durable
  interactive route) coexist in `broker/constants.ts`. agent-spaces
  `SUPPORTED_BROKER_PROTOCOL_VERSIONS = ['harness-broker/0.1','harness-broker/0.2']`.
- **Headless today = v0.1 / stdio / daemon-child** → dies on restart (the bug). compile-profile-selector
  gates headless route on `profile.brokerProtocol === 'harness-broker/0.1'`.
- **Interactive durable leased-tmux already exists**: controller.ts `allocateTmuxIfRequired`
  (1505-1566), durable Unix dial (568-580), persisted `runtimeStateJson.broker`
  {endpoint, brokerWindow, tuiWindow, generation} + redacted attach token; runtime-state.ts
  (353 lines) already splits brokerIpc / operatorAttach / brokerProcess. `reconcileDurableBrokerStartup`
  + `reassociateBrokerTmuxLease` exist.
- **Startup reconcile gates on `transport==='tmux'`** (startup-reconcile.ts 223-255); everything
  else → `gcBrokerRuntimeOnRestart('broker_orphaned_on_restart')`. This is the headless-kill path.
- **Orphan sweeper claimed-lease set derives from `transport==='tmux'`** (800-819).
- No `runtime-hosting.ts` yet; hosting state is implicit across transport/controllerKind/runtimeStateJson.
- ~77 active `harness-broker/0.1` refs across both repos (HRC constants+selector; agent-spaces
  protocol union, compile-runtime-plan defaults, aspc service, client, fixtures, ~37 tests).
- Sizes: startup-reconcile 1181, controller 2214, sweep-reconcile 690, sweep-helpers 195,
  runtime-state 353, constants 9.

## Daedalus rulings (LOCKED 2026-06-04, msg-2cfb759f)
Invariant: **recoverability**, not protocol-deletion order.
- **Q1 durability-first: APPROVED.** Guardrail: v0.1 stays boxed as legacy daemon-child ONLY,
  with a written removal phase and NO new abstractions built around v0.1.
- **Q2 Ph6+Ph7 = one delivery transaction.** Agent-spaces may be coded/tested ahead, but do NOT
  sync/install/restart HRC against a v0.2-only ASP snapshot while HRC still selects/persists v0.1.
  Hold the publish until HRC cutover is ready; if published, immediately run HRC sync + v0.2-only
  cutover. **No live daemon restart between the two halves.**
- **Q3 no production v0.2-over-stdio route.** HRC hosting is either legacy v0.1/stdio/daemon-child
  or new v0.2/unix/leased-tmux. v0.2-over-stdio is a protocol/library TEST shape only.
- **Q4 split T-01868 into a–e child tasks** (each a wrkq/commit/rollback unit), one coordinator
  thread + sequential curly. **Ph2 is NOT "no red"** — add characterization reds around interactive
  behavior + substrate/presentation parsing BEFORE the refactor.
- **Q5 no preservation of nonterminal v0.1 daemon-child brokers.** Preserve terminal history +
  session continuation. Classify once on startup with precedence: v0.1 →
  `broker_protocol_legacy_unsupported_on_startup`; non-v0.1/no durable endpoint →
  `broker_legacy_no_durable_endpoint_on_restart`. Drain/block active v0.1 runs before cutover.

### Six gaps to patch into phase scope (from daedalus)
- **G1 (Ph3):** persist negotiated broker protocol truthfully for durable v0.2 rows NOW, not Ph7.
  controller currently inserts `brokerInvocations.brokerProtocol` from `BROKER_PROTOCOL_VERSION`.
- **G2 (Ph1):** runtime-hosting helpers must parse BOTH the current flat T-01801 shape AND the new
  normalized endpoint/substrate/presentation shape. This is the migration choke point.
- **G3 (Ph4):** must REPLACE the blanket broker GC loop, not add a durable pass in front of it —
  else a headless durable runtime reattaches then still hits the old `transport!=='tmux'`
  `broker_orphaned_on_restart` path.
- **G4 (Ph1/Ph4):** lease identity requires `brokerWindow` for EVERY leased substrate; requires
  `tuiWindow` ONLY for `presentation.kind==='tmux-tui'`.
- **G5 (Ph4):** headless lazy dispatch needs the durable reattach retry path; direct tmux fallback
  stays presentation-gated and is therefore unavailable for `presentation.none`.
- **G6 (Ph4):** activity refresh must touch the active RUN as well as runtime/invocation when
  attach/replay proves liveness, or zombie sweep can still win the race.

## Central sequencing decision (RESOLVED: durability-first, see rulings above)
Spec §13.1 recommends "delete v0.1 first, then add headless leased substrate." But headless
**runs on v0.1/stdio today**, so deleting v0.1 before headless has a working v0.2/leased path
opens a window where headless is broken on this shared dev worktree (I install + restart to
validate every phase). I propose **durability-first**:

> Build the headless v0.2/leased-tmux substrate while v0.1 stays alive as the legacy headless
> route; cut headless over to v0.2/leased; prove durability; THEN delete v0.1 in one coordinated
> cross-repo cutover.

This keeps every intermediate install green. The spec's end-state is identical; only the
intermediate ordering differs. **RESOLVED (daedalus Q1): durability-first approved**, with the
guardrail that v0.1 stays boxed as legacy daemon-child only (see rulings above).

## Phase plan (durability-first ordering) — wrkq IDs locked

| Ph | Task | What | Red? | Impl | Depends on |
|----|------|------|------|------|------------|
| 1 | T-01872 | HRC `broker/runtime-hosting.ts`: parse/require + predicates (hasDurableBrokerEndpoint, hasLeasedBrokerSubstrate, hasBrokerPresentation, canOperatorAttach, canUseDirectPaneFallback, brokerLeaseIdentityMatches). Additive, no behavior change. Parser reads BOTH flat T-01801 + normalized shape (G2). | smokey red (predicate truth table + dual-shape parse) | curly | — |
| 2 | T-01873 | Split durable tmux allocator → `allocateBrokerSubstrate({presentation})` + presentation allocation; move interactive path onto hosting-state model, behavior preserved. | smokey **characterization reds** (interactive behavior + substrate/presentation parsing) BEFORE refactor — NOT a bare green-bar refactor (Q4) | curly | Ph1 |
| 3 | T-01874 | Start **headless** broker through leased tmux + Unix v0.2 IPC, presentation=none. Headless becomes durable. v0.1 stays present as boxed legacy. Persist negotiated v0.2 truthfully now (G1). | smokey red | curly | Ph2 |
| 4 | T-01875 | endpoint/substrate-driven startup reconcile (REPLACES blanket GC loop, G3) + lazy dispatch reattach (G5) + orphan sweeper claimed-lease by substrate + zombie/activity refresh touching active run (G6). | smokey red | curly | Ph3 |
| 5 | T-01876 | status/inspect projection: expose endpoint/substrate/presentation separately; keep legacy transport alias. | smokey red (light) | curly | Ph4 |
| 6 | T-01867 | agent-spaces: delete v0.1 from protocol union, SUPPORTED_*, client, aspc, runtime-contracts, compile-runtime-plan, fixtures, tests; validators reject v0.1; emit v0.2 only. Code/test ahead, but **HOLD publish** until Ph7 staged (see transaction rule below). | smokey red (v0.1-rejection) | curly | Ph5 |
| 7 | T-01866 | HRC: collapse to single `BROKER_PROTOCOL_VERSION='harness-broker/0.2'`; selector admits v0.2 only; reject non-v0.2 hello; persist negotiated v0.2; consume synced agent-spaces snapshot. | smokey red | curly | Ph6 |
| 8 | (coord) | Real smoke: headless mid-flight turn + `hrc server restart` → reattach/replay/complete; interactive regression; repo-wide `harness-broker/0.1` grep gate = 0 active. | coordinator-run | clod | Ph7 |

### Ph6+Ph7 = ONE delivery transaction (daedalus Q2, LOCKED)
agent-spaces v0.1 may be coded + tested ahead, but do **not** publish the dev snapshot / sync /
install / restart HRC against a v0.2-only ASP snapshot while HRC still selects/persists v0.1.
Hold the publish until HRC Ph7 cutover is staged, then run **publish → HRC sync → v0.2-only
cutover → `just install` → restart as one transaction**. **No live daemon restart between the two
halves.** Drain/block active v0.1 broker runs operationally before the cutover.

## Worktree / sequencing constraints
- All HRC phases (1-5,7) touch hrc-server src heavily (controller, startup-reconcile, sweep) →
  **strictly sequential** impl on the shared worktree; commit between phases. smokey reds may run
  ahead in parallel (separate test files).
- Ph6 is agent-spaces repo (`../agent-spaces`) — disjoint worktree from HRC; its dev-snapshot
  publish is held and fused with Ph7 per the transaction rule above.

## Resolved architecture decisions (daedalus, LOCKED 2026-06-04)
- **Ordering:** durability-first (Q1). v0.1 boxed as legacy daemon-child; explicit removal = Ph6/Ph7.
- **Cutover:** Ph6+Ph7 one transaction, no daemon restart between halves (Q2).
- **No production v0.2-over-stdio HRC route** (Q3): HRC hosting is legacy v0.1/stdio/daemon-child
  OR new v0.2/unix/leased-tmux. v0.2-over-stdio is a protocol/library test shape only.
- **T-01868 split into T-01872..T-01876** (Q4), each a commit/rollback unit; Ph2 carries
  characterization reds.
- **Legacy rows (Q5):** no preservation of nonterminal v0.1 daemon-child brokers; preserve
  terminal history + session continuation; classify once on startup with precedence
  (v0.1 → `broker_protocol_legacy_unsupported_on_startup`; non-v0.1/no durable endpoint →
  `broker_legacy_no_durable_endpoint_on_restart`).

## Acceptance (from spec §15) — coordinator-verified at Ph8
Headless leased+unix; headless API identity stays headless; no TUI for headless; interactive
adds tmux-tui; reconcile by endpoint/substrate not transport; no broker_orphaned_on_restart for
live leased headless; lazy reattach on dispatch; sweeper preserves claimed headless substrates;
socket paths under limit; persisted protocol v0.2; validators reject v0.1; zero active v0.1 refs;
real installed-binary restart smoke.
