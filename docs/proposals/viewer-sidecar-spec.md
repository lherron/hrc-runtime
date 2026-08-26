# Viewer Sidecar Spec: Extracting Ghostty Presentation from hrc-server

Status: DRAFT rev 6 — material amendment to APPROVED rev 3 (DM #21133, law `hrc-runtime.viewer-presentation-sidecar`), submitted to daedalus. Trigger: P3 live shadow run reaped production panes (§10).  
Date: 2026-08-26  
Author: mable@hrc-runtime  
Primary systems: hrc-server (event ledger, runtime lifecycle), new `packages/hrc-viewer`, `ghostmux` CLI, ScriptableGhostty

## 1. Summary

hrc-server today spawns, retitles, status-paints, and reaps Ghostty panes that mirror broker-tmux runtimes. That presentation logic is not hrc's job (hrc hosts, persists, recovers, and reaps *runtimes*), and it has leaked ~330 lines of viewer-conditional branching into runtime start, broker dispatch, terminate, sweep, and startup reconcile.

This spec moves all Ghostty presentation into a separate per-user process, **`hrc-viewer`**, that:

- subscribes once, fleet-wide, to hrc's durable event stream (`GET /v1/events/bounded-stream`),
- actuates exclusively through the `ghostmux` CLI,
- holds **no persistent state** — Ghostty surface/window metadata remains the registry of record (existing invariant), and hrc's **presentation read model** (§5.3, a db-only projection with no liveness reconcile) is the runtime authority for reconstruction,
- touches **only side-effect-free hrc reads** (§5.4): it never calls a route that reconciles liveness, attaches, or mutates,
- can die, restart, or be absent without affecting any runtime.

hrc-server keeps *knowing* presentation intent (it already receives it from the CLI) and stops *acting* on it. Three additive changes are required on the hrc side (§5): persist the presentation facts it already computes, publish them as one event, and expose them through one pure read. Everything else is deletion.

The target model:

```text
hrc decides where/how to host, persist, recover, and reap runtimes, and emits facts.
hrc-viewer decides what the operator sees on screen, and only reads facts.
ghostmux actuates Ghostty. It knows nothing about hrc.
```

## 2. Scope

### 2.1 Three systems currently wear the "ghostty" label

| Label | What it is | Gate | Disposition |
|---|---|---|---|
| **A. Legacy `transport:'ghostty'`** | Claude CLI executing *directly* in a Ghostty surface (pre-broker). No live spawn path remains (`GhostmuxManager.ensureSurface` / `createClaudeRuntimeSurface` / `ensureClaudeTab` have zero external callers). Only the reconcile / sweep / terminate / select tail survives, ~500 LOC across 12 files. | `HRC_CLAUDE_GHOSTTY` (unset on every production plist) | **Delete** (Phase 1). |
| **B. Headless viewer** | The consolidated "Headless Sessions" Ghostty window: one pane per broker-tmux runtime, `tmux attach` into the runtime's `:tui` window, status bar painted from turn events, linger + reap on terminate. ~1,900 LOC dedicated + ~330 LOC conditionals in shared code. | `HRC_GHOSTTY_VIEWERS` (default on) | **Extract** to `hrc-viewer` (Phases 2–4). |
| **C. `headlessViewerRoute`** | Codex app-server dual-tmux substrate: whether a headless runtime gets an operator-attachable `:tui` window (`presentation.kind === 'tmux-tui'`) plus an observer socket. **Not Ghostty.** It is a tmux hosting decision. | `HRC_CODEX_APP_SERVER_OPERATOR_PRESENTATION` | **Keep in hrc; rename** so it stops reading as viewer code (Phase 4). |

### 2.2 Non-goals

- No change to the tmux substrate, broker protocol, or which runtimes get an attachable `:tui` window (system C is untouched except for naming).
- No change to `hrc run` / `hrc attach` operator-terminal attach.
- No new authentication, provenance, signing, attestation, or audit surfaces. The viewer is a same-user, same-host, loopback consumer of a Unix socket the user already owns; it inherits exactly the trust the `hrc` CLI has. Anything beyond that is out of scope for this spec.
- No cross-node behavior. A viewer serves ONE daemon on its own node for its own GUI user. **Several daemons per user share one Ghostty registry** (production `hrc` and the `hrc-dev` lane on max3 today); each may have its own viewer, and a viewer must never act on another daemon's panes (§4.4 ownership, §4.5).
- No HRCMac / libghostty embedding (that campaign has its own spec; §9 notes the relationship).

## 3. Current coupling being removed (evidence)

Non-viewer lifecycle code that branches on viewer state today, all of which this spec deletes or reduces to a data pass-through:

| Site | Branch |
|---|---|
| `runtime-io-handlers.ts:335-337` | `operatorAttachPending` computed and threaded through all four return paths of `startRuntimeForSession`; `suppressHeadlessViewer` at `:733` for attach-by-id |
| `broker-headless-handlers.ts:744` | `if (canOperatorAttach(runtime)) void spawnBrokerHeadlessViewer(runtime)` |
| `broker-interactive-handlers.ts:596` | driver-name branch `allowedBrokerDriver === 'claude-code-tmux'` gating viewer spawn |
| `turn-dispatch-handlers.ts:660` | fire-and-forget viewer spawn inside `finalizeHeadlessBrokerSessionOpen` |
| `interrupt-terminate.ts:571-630` | terminate schedules a detached 300 s linger timer before reaping the pane; `runtime.terminated` precedes pane death |
| `startup-reconcile.ts:213-232` | legacy-A transport reconcile branch |
| `sweep-reconcile.ts:292-377`, `sweep-handlers.ts:623-648` | legacy-A idle `/quit` sweep |
| `event-notification-handlers.ts:78` | unconditional `headlessViewerStatus.observe(event)` on the hot notify path |
| `target-view.ts:198-200`, `runtime-select.ts`, `hook-lifecycle.ts:443`, `first-turn-bundle.ts:347-368`, `runtime-io-handlers.ts:554` | legacy-A `transport === 'ghostty'` predicates |
| `controller-factory.ts:232-356`, `ghostmux.ts` (1,354 LOC), `headless-viewer-status.ts` (250), `agent-theme.ts` / `project-prefix.ts` / `wrkq-task-label.ts` (343) | viewer-dedicated code, including an out-of-band **wrkq read** for the tab label |

Configuration removed from hrc: `HRC_CLAUDE_GHOSTTY`, `HRC_CLAUDE_GHOSTTY_IDLE_CLEANUP_MINUTES`, `HRC_GHOSTTY_VIEWERS`, `HRC_GHOSTTY_VIEWER_LINGER_SECONDS`. The `surface_bindings` rows of kind `ghostty-headless-viewer` are no longer written (the table stays for operator-terminal bindings).

## 4. hrc-viewer design

### 4.1 Process model

- One `hrc-viewer` process per **GUI user session** (Ghostty is per-user; on `mini`, `svc` and `lab` are distinct users and get their own instance or none).
- Managed as a LaunchAgent (`com.praesidium.hrc-viewer`), `KeepAlive: true`. Presence of the LaunchAgent *is* enablement; there is no hrc-side flag.
- Bun/TypeScript, `packages/hrc-viewer` in hrc-runtime, consuming `@praesidium/hrc-sdk` (`HrcClient.watchBoundedEvents`, `tailEvents`, `listLatestEventBySession`, `listPresentationRuntimes` — the §5.4 set and nothing else) and shelling to `ghostmux`.
- Talks only to the local daemon socket (`HRC_RUNTIME_DIR`) and the Ghostty API socket. No listening ports.
- **`hrc-viewer --dry-run`**: runs the full subscribe + reconcile loop, classifies every pane and window in the registry as owned / foreign / legacy, and logs every actuation it *would* perform (`dry_run.would_<action>` with surface id, classification, reason) while performing **none** — no `new`, `new-pane`, `equalize`, `set-title`, `set-bg`, `statusbar`, `metadata set`, or `kill-surface`. Registry reads are `list-windows --json`, `list-surfaces --json`, and `metadata get -t <surface>` / `metadata get --window-id <id>` for every surface and window listed — `list-surfaces` carries geometry and identity only, so classification requires the per-surface metadata read. The dry-run report lists, per surface and window, the id, the raw `hrc_role` / `hrc_owner_root` / `hrc_runtime_id` values read (or `absent`), the resulting classification, and the would-be action; a report missing any listed surface is a gate failure. Dry-run is the isolation gate (§6 row 13) and the mode a viewer must be started in on any host where it is new.

### 4.2 Inputs

Every input arrives on one of two surfaces, both side-effect-free by contract (§5.4):

| Need | Source |
|---|---|
| runtime identity (`runtimeId`, `hostSessionId`, `scopeRef`, `laneRef`, `generation`) | `runtime.presentation` event (§5.2) / presentation read model (§5.3) |
| operator-attachability; whether *this invocation's* operator terminal will attach (suppression); requested viewer window key | `runtime.presentation` event per invocation (§5.2); the monotone `viewerRequested` fact persisted on the runtime row (§5.1) for reconcile |
| tmux socket path + attach target (`<session>:tui`) | same — hrc derives them from the persisted hosting/tmux state when it emits/projects; the viewer never calls `/v1/runtimes/:id/attach` |
| session title | `session.retitled` event (§5.2) and the `title` column of the read model |
| task label for the tab | wrkq lookup **in the viewer** (moves out of hrc); falls back to the raw task id |
| agent theme / project prefix | pure derivation from `scopeRef` (moves out of hrc as-is) |
| lifecycle state for the status bar and reap | existing `turn.*` / `runtime.*` events |

### 4.3 Reaction table

| Event | Viewer action |
|---|---|
| `runtime.presentation` with `operatorAttachable === true` and `operatorAttachPending === false` | `ensurePane(record)` (find-or-create; §4.4). The event carries the socket path and attach target, so no further hrc call is needed. Emitted once per start/reuse invocation, so a detached `hrc start` that reuses an `hrc run` runtime mints the pane exactly as today (`runtime-io-handlers.ts:352-368`, `:451-463`). |
| `runtime.presentation` with `operatorAttachPending === true` | skip this invocation only (today's `skipped_operator_attach_pending`, `controller-factory.ts:232-251`). Nothing is remembered about the skip; a later non-pending invocation on the same runtime proceeds. |
| `runtime.created` / `runtime.ensured` / `runtime.adopted` | **no viewer action** — these fire before the tmux `:tui` window exists on some paths and not at all on the broker path; `runtime.presentation` is the only spawn trigger |
| `surface.bound` for an operator terminal on a runtime that has a viewer pane | no-op (both may coexist; today's behavior) |
| `turn.started` / `turn.input_resumed` | status bar → `running` |
| `turn.awaiting_input` | status bar → `awaiting` |
| `turn.completed` | status bar → `idle` |
| `runtime.terminated` / `runtime.dead` / `runtime.stale` / `runtime.crashed` | status bar → `exited` (sticky); schedule reap after `linger` seconds (default 300, `0` = immediate). Reap is fenced on the pane's live `hrc_runtime_id` equalling the event's `runtimeId` (globally unique `rt-<uuid>`), so an event from this daemon can only ever reap a pane mirroring this daemon's runtime, owned or legacy; foreign panes are excluded regardless. |
| `session.retitled` | `ghostmux set-title` on the pane for that session |
| `context.cleared` / `session.generation_auto_rotated` | rebind pane metadata `hrc_runtime_id` on the next `runtime.*` for the new generation (existing reuse rule) |
| stream `gap` / `ledger_replaced` / socket EOF | reconnect from `/v1/events/tail` head; run full reconcile (§4.5) |

The `eventKind → state` table and sticky-exited rule are lifted verbatim from `headless-viewer-status.ts:38-54`.

### 4.4 Identity and placement (unchanged policy, now written down)

These rules are the shipped T-05237 / T-07118 / T-07121 behavior, moved out of code comments:

- **Window key** = `presentation.viewerWindow` from intent, else `default`, **scoped by owner**: one managed Ghostty window per `(hrc_owner_root, windowKey)`, found-or-created via `ghostmux new --window --find-or-create-by {"hrc_role":"headless-sessions-window","hrc_window_key":<key>,"hrc_owner_root":<root>} --metadata <same keys>`. Because the owner is part of the match predicate and of the create metadata, a miss creates a window already stamped for this owner and a hit can only ever be this owner's window; two owners can never select the same window through this call (ghostmux returns `created:false` only for a full match and never alters metadata — README.md:143-147). The production daemon's window keeps the title "Headless Sessions"; any other lane's window is titled "Headless Sessions · <lane>" (lane = basename of runtimeRoot). Legacy anchor-pane discovery is retained only as the documented 404 fallback for pre-windows-API builds, and is likewise owner-qualified.
- **Tab key** = `task:<T-XXXXX>` when the scope carries a real task id, else `project:<projectId>:primary`. Tab identity is the triple `(hrc_owner_root, windowKey, tabKey)`; tabs are searched only inside the owner's window.
- **Placement never targets a foreign or legacy pane.** A split (`ghostmux new-pane -t <surface>`) may target only an *owned* pane in an *owned* tab, and `equalize-panes` runs only on a tab in which **every** pane is owned. If the owner's tab exists but contains any non-owned pane (possible only in an adopted legacy window, below), the viewer opens a new tab instead of splitting. This closes the path by which rev 4 let a viewer resize a foreign pane.
- **Legacy windows are never claimed and never placed into.** A window carrying `hrc_role=headless-sessions-window` without `hrc_owner_root` is not a placement target for any viewer or (until P4) any in-daemon path — there is no claiming step, so there is no claim race. Legacy panes inside such a window are adopted *in place* per §4.5 for painting, retitle, rebind and event-reap only; no new pane is ever created next to them and no equalize ever runs in that window. New panes for a runtime whose legacy pane exists go to the owner's window only when the legacy pane is gone (§4.5 step 4 never mints while a legacy pane for that key exists). As legacy panes are event-reaped by their owners, the legacy window empties and Ghostty retires it on last-tab-out. Transitional consequence: for a while a lane may have both a legacy "Headless Sessions" window and its new owner-stamped one. Accepted.
- Pane command: `hrc session-report ... --wait-timeout <linger>` wrapping `tmux -S <socket> attach -t <session>:tui`; the title write is the **last** write after the blocking attach so OSC-7 cwd reporting cannot clobber it.
- Per-key in-process mutex serializes find-or-create per `(ownerRoot, windowKey, tabKey)` and per owned window; each create re-reads live metadata after acquiring the lock.
- **Reap is runtime-fenced**: kill the pane only if live metadata `hrc_runtime_id` equals the terminating runtime and role is `headless-agent-pane`; never kill a window anchor. A pane rebound to a newer runtime survives a stale terminate.

### 4.5 Reconcile

Run on viewer start, on every reconnect, and on a slow timer (default 5 min). Uses only §5.4 reads.

1. `ghostmux list-surfaces --json` → panes with `hrc_role=headless-agent-pane`.
2. `GET /v1/presentation/runtimes` (§5.3) → every non-terminal runtime with its persisted presentation record (or none). This is a db-only projection: no liveness reconcile runs, no runtime can be marked dead by the call.
3. Partition panes by ownership (§4.4): **foreign** panes are dropped from consideration entirely. **Owned** and **legacy** panes proceed.
4. Record with `viewerRequested === true` and `operatorAttachable === true` and no owned pane for its key → `ensurePane` (stamping `hrc_owner_root`). A legacy pane whose `hrc_runtime_id` matches a live runtime in this read model is **adopted** on the spot: its metadata is rewritten with `hrc_owner_root` (pane-level stamp only; the enclosing legacy window stays unstamped and is never a placement target); it is thereafter owned for painting/retitle/rebind/reap but **never** used as a split target and its tab is never equalized, because its window is not owned. No second pane is minted while a legacy or adopted-in-place pane exists for the key. Record with `viewerRequested === false`, or **no record** (§5.5) → never mint.
5. **Absence-reap is owner-fenced.** An *owned* pane whose `hrc_runtime_id` is absent from the read model (terminal or unknown to this daemon) and whose reap linger has elapsed → reap. A *legacy* pane absent from this daemon's read model is **never** reaped by reconcile — this daemon has no authority to say the runtime is gone, because the runtime may belong to another daemon. Legacy panes are reaped only by the event path (§4.3), which is fenced on a `runtime.terminated|dead|stale` event *from this daemon's own ledger* carrying that exact `hrc_runtime_id`.
6. Owned pane whose session is present with a newer generation → rebind metadata. Titles re-applied from the `title` column for owned panes.

`viewerRequested` is exactly the fact the in-daemon path acts on today: ensure is find-or-create and reap happens only on terminate, so "a pane should exist" ⇔ "at least one non-suppressed invocation has run for this generation". Reconcile therefore reproduces the event path's cumulative outcome, not a snapshot of one invocation. A runtime born for `hrc run` and never reused stays pane-less; once a detached invocation reuses it, `viewerRequested` flips and both the event and the next reconcile mint the pane — identical to today.

This is the first time viewer panes are reconciled after a daemon restart at all (hrc-server does not do it today; it relies on lazy re-adoption at the next spawn). A ScriptableGhostty restart wipes the in-memory window registry; reconcile re-adopts by design ("degraded, never broken").

### 4.6 Failure behavior

- ghostmux timeout / unsupported command / Ghostty absent → log, back off (`0,500,1000,2000,4000` ms), retry on next reconcile. No runtime is ever affected.
- Viewer absent → no windows. Runtimes unaffected.
- Daemon absent → viewer idles on reconnect backoff.
- Viewer logs to `~/praesidium/var/logs/hrc-viewer.log` with the same `broker_headless_viewer.*` / `headless_viewer_reap.*` line vocabulary hrc uses today, so existing grep habits survive.

## 5. hrc-server changes (additive; ship dark before Phase 3)

### 5.1 Persist the presentation record on the runtime row

`HrcRuntimeSnapshot` gains an additive, nullable field:

```ts
presentation?: {
  operatorAttachable: boolean   // == canOperatorAttach(runtime) once the :tui substrate is known
  viewerRequested: boolean      // MONOTONE within a generation: false → true on the first
                                // non-suppressed start/reuse invocation; never cleared
  viewerWindow?: string          // from lastAppliedIntentJson.presentation.viewerWindow (latest wins)
}
```

`operatorAttachPending` is **not** persisted. It is an invocation-local predicate (`runtime-io-handlers.ts:302-338`) and stays one: it travels on the per-invocation event (§5.2) and nowhere else. What is persisted is its cumulative consequence, `viewerRequested`, which is what today's find-or-create + reap-on-terminate behavior actually depends on.

Written by a single `publishPresentation(runtime, { operatorAttachPending })` helper at the point where each of the seven spawn call sites lives today — every fresh start *and* every reuse invocation (`runtime-io-handlers.ts:368,402,463,485`, `broker-headless-handlers.ts:745`, `broker-interactive-handlers.ts:596`, `turn-dispatch-handlers.ts:660`). The helper: computes `operatorAttachable`; if `operatorAttachPending === false` sets `viewerRequested = true`; updates `viewerWindow`; persists (`broker/controller/persistence.ts` on the broker path; the runtime-record update on the managed-start paths); then appends the event. A new generation starts with no record.

### 5.2 Two event kinds

**`runtime.presentation`** (category `runtime`). Appended and notified by `publishPresentation` on **every** start/reuse invocation — the moment the tmux `:tui` window exists and hrc has decided attachability for that invocation. It is a *new* append, not a field on `runtime.created`: the broker path persists its runtime directly (`persistence.ts:103-148`) and never appends `runtime.created`, and reuse invocations append no runtime event at all today. Payload:

```ts
{
  invocation: { operatorAttachPending: boolean },          // this invocation only
  presentation: { operatorAttachable, viewerRequested, viewerWindow? },  // persisted record after this invocation
  tmux?: { socketPath: string, attachTarget: string },     // present iff operatorAttachable
  title?: string                                           // current session title, if any
}
```

`tmux` is derived at emit time from the persisted hosting state via the existing `getBrokerRuntimeTmuxSocketPath` / `getBrokerRuntimeTmuxAttachTarget` (`broker-decisions.ts:1016,1062`).

**`session.retitled`** (category `session`). Appended by the `POST`/`DELETE` session-title route (`index.ts:2222-2255`) with payload `{ title: string | null }`. Today the route is a bare `db.sessionTitles.upsert/delete` with no ledger row.

Both kinds are added to `KIND_CATEGORIES` (`hrc-event-helper.ts:18-77`).

### 5.3 Presentation read model

`GET /v1/presentation/runtimes` returns, for every runtime whose status is non-terminal, one row: identity (`runtimeId`, `hostSessionId`, `scopeRef`, `laneRef`, `generation`, `status`), `presentation` (the persisted record, or absent for pre-Phase-2 generations), `tmux`, `title`. No invocation-local field appears here; the read model carries only durable facts. The response envelope also carries `daemon: { runtimeRoot: string }` — the serving daemon's configured runtime root — which the viewer uses as the ownership key (§4.4). This is configuration, not store state, and stays side-effect-free. It is a **projection over the store only**: it reads runtime rows, the persisted §5.1 record, hosting/tmux state and `session_titles`, and returns. It does **not** call `reconcileTmuxRuntimeLiveness`, probe tmux, attach, or append events. SDK: `HrcClient.listPresentationRuntimes()`.

### 5.4 Side-effect-free read contract

The viewer is permitted exactly these hrc routes: `GET /v1/events/tail`, `GET /v1/events/bounded-stream`, `GET /v1/events/latest-by-session`, `GET /v1/presentation/runtimes`, `GET /v1/health`. Each is a store read with no reconcile or mutation. This is enforced two ways:

- a contract test per route that seeds a runtime whose tmux substrate is *absent*, calls the route, and asserts the runtime's status and the ledger head are unchanged (the same seed makes `GET /v1/runtimes` and `GET /v1/runtimes/:id/attach` mark it dead — those are the routes the viewer is forbidden);
- the viewer package's SDK usage is limited to the corresponding client methods, checked by the existing `boundaries` lint.

Routes that reconcile liveness as a side effect of reading (`GET /v1/runtimes` via `runtime-list-adopt-handlers.ts:186-198`, `GET /v1/runtimes/:id/attach` via `index.ts:2277-2280`) are unchanged and remain off-limits to the viewer.

### 5.5 Upgrade rule for pre-Phase-2 generations

Runtime generations created before Phase 2 ships have no persisted record and — because today's `operatorAttachPending` was never recorded — no authority exists to reconstruct whether a viewer should exist for them. The spec does not invent one:

- The read model returns `presentation: undefined` for them; the viewer **never mints** a pane for a record-less row.
- A pane that the in-daemon path already created for such a runtime carries the same Ghostty metadata keys, so the viewer **adopts** it: status painting, retitle, rebind and reap all apply.
- The next start/reuse invocation on that runtime runs `publishPresentation`, which writes the record and emits the event, from which point the runtime is fully governed.
- Generation rotation (24 h default, checked before dispatch; disable-able, and live tmux runtimes do not rotate — `session-rotation.ts:71-99`) shrinks the record-less population over time but is not relied on: adopt-only plus next-invocation record is sufficient for safety and parity on its own.

This is parity with today: the in-daemon path also never re-creates a pane for an existing runtime except on a new invocation.

### 5.6 In-daemon path stamps ownership until Phase 4

Until P4 deletes it, `GhostmuxManager.ensureHeadlessViewer` in hrc-server stamps `hrc_owner_root` (its own `runtimeRoot`) on every pane it creates or reuses, and scopes its own find-or-create by `(hrc_owner_root, hrc_pane_key)`. This (a) shrinks the legacy population to panes created before this change ships, and (b) fixes the pre-existing cross-daemon key collision in the in-daemon path itself. The in-daemon reaper is already runtime-fenced and is unchanged.

## 6. Phases and gates

Each phase lands independently on `main`; none requires the next.

| Phase | Work | Gate (evidence) |
|---|---|---|
| **1. Delete legacy A** | Remove `transport:'ghostty'` spawn-dead tail, `HRC_CLAUDE_GHOSTTY*`, `cleanupIdleClaudeGhosttyRuntimes`, `reconcileGhostty`, legacy attach descriptor, legacy select/transport predicates. Closes T-07201, T-07207 (both dormant behind the deleted flag). | `rg -i 'claude.?ghostty\|transport === .ghostty' packages/hrc-server/src` empty (excluding tests deleted with it); full suite green; `just install` + graceful restart; `hrc runtime list` and one `hrc start` + `hrcchat dm` round-trip unchanged. |
| **2. Persist, publish, project** | §5.1–5.4: persisted presentation record, `runtime.presentation` + `session.retitled` kinds, the read model route + SDK method, the side-effect-free contract tests. The seven spawn call sites collapse to one `publishPresentation` call that (until Phase 4) still invokes the in-daemon viewer behind it. | `runtime.presentation` visible in `hrc monitor watch --json` on a live `hrc start` (with `tmux`) and on `hrc run` (with `operatorAttachPending: true`); `session.retitled` on `hrc session retitle`; `GET /v1/presentation/runtimes` returns the same records; §5.4 contract tests green. |
| **3. Build hrc-viewer; shadow-validate** | New package + LaunchAgent; `ghostmux.ts` viewer portion, `headless-viewer-status.ts`, theme/prefix/label modules and their tests move across. On `hrc-dev` (or the hrcdev VM), run the daemon with `HRC_GHOSTTY_VIEWERS=0` and the viewer enabled. | For each of: `hrc start` (headless codex + claude), `hrc run` (viewer must be **suppressed**, including after a viewer restart + reconcile while the run is live), then a detached `hrc start` reusing that runtime (viewer **must appear**), `hrcchat dm` to a cold scope, two role-qualified scopes for one agent/task (two panes), `hrc session retitle`, `hrc runtime terminate` (pane survives `linger` then dies), daemon graceful restart, viewer restart, Ghostty quit/reopen — the resulting `ghostmux list-windows/list-surfaces --json` topology is identical to what the in-daemon path produced, screenshots attached to the task. Additionally: with the viewer running against a runtime whose tmux socket has been removed, the runtime's status does not change until hrc's own sweep runs. **Row 13 — cross-daemon isolation, run FIRST and again LAST:** with production `hrc` holding ≥1 live viewer pane (owned-by-prod or legacy), (a) `hrc-viewer --dry-run` against hrc-dev through a full reconcile logs zero `would_*` actuations against any surface whose classification is foreign or legacy-not-in-this-read-model, and the classification table lists every production surface id as foreign/legacy; (b) only then the live sidecar is run through a full reconcile + terminate of a dev runtime + viewer restart, and `ghostmux list-surfaces --json` / `list-windows --json` before/after show every production surface and window untouched (same ids, same metadata, same size); (c) a legacy pane for a runtime live in hrc-dev is adopted in place (gains `hrc_owner_root`), not duplicated; (d) dev panes land in a separate "Headless Sessions · hrc-dev" window. Rows 1–12 may not begin until 13(a) passes. |
| **4. Delete B from hrc; rename C** | Remove everything in §3 rows 1–10 and the dedicated modules; rename `headlessViewerRoute` / `isHeadlessViewerRoute` / `createBrokerHeadlessViewerAllocator` to `tmuxTuiRoute` / `isOperatorPresentationRoute` / `createBrokerTmuxTuiAllocator`. Terminate becomes synchronous. | `rg -i ghostty packages/hrc-server/src` matches only the `GHOSTTY_SURFACE_UUID` CLI-side operator-surface read and docs; suite green; Phase-3 matrix (including row 13 in the same order) re-run against the deleted daemon on `hrc-dev`. |
| **5. Fleet rollout** | Install LaunchAgent on max3 (lherron), mini (lherron; decide svc/lab), rolling daemon rotation. | Post-rollout `ghostmux list-surfaces --json` on each node shows a pane for every live runtime with `viewerRequested === true`, and every pre-rollout pane still present is adopted (metadata `hrc_runtime_id` matches a live runtime or is reaped after linger); no `broker_headless_viewer.*` lines in hrc-server logs. |

Rollback at any phase ≤ 3: stop the LaunchAgent, leave `HRC_GHOSTTY_VIEWERS` unset (default on). After Phase 4 the rollback is the viewer itself.

## 7. Invariants

1. hrc-server never invokes `ghostmux` (post Phase 4).
2. hrc-server's runtime lifecycle has no code path whose outcome depends on Ghostty state.
3. The viewer calls only the §5.4 routes, each of which is a store read with no reconcile or mutation, proven by contract test. "Read-only" means side-effect-free, not merely `GET`.
4. Ghostty metadata is the sole viewer registry; the viewer keeps no state that must survive its own restart. Everything needed to reconstruct a pane (attachability, the cumulative `viewerRequested` fact, window key, socket, target, title) is persisted by hrc and served by §5.3; invocation-local facts are never persisted and never needed for reconstruction (§5.5).
5. At most one live viewer pane per hrc session, keyed by normalized `(scopeRef, laneRef)`, same as today.
6. Viewer absence, death, lag, or polling can never change runtime state, finalize a run, delay a turn, or fail a start — a consequence of invariant 3.
7. A viewer never mutates, resizes, splits from, or reaps a pane it does not own, and never places into, splits within, or equalizes a window or tab it does not own — legacy windows included. Ownership is the `hrc_owner_root` stamp equal to the connected daemon's `runtimeRoot`, on windows and panes alike; unstamped (legacy) panes may be adopted or event-reaped only when this daemon's own ledger names their exact runtime id, and are never reaped on mere absence from this daemon's read model. Enforced by the §6 row-13 dry-run gate before any live actuation on a host.

## 8. Risks

- **Readiness race.** Eliminated by construction: `runtime.presentation` is appended at the exact point the in-daemon spawn happens today, i.e. after the `:tui` substrate exists, and it carries the socket and target.
- **Suppression is per invocation.** An `hrc run` runtime later reused by a detached `hrc start` gains a pane (today's behavior, now explicit). If an operator attaches *later* to a runtime that already has a pane, both coexist — identical to today.
- **Shared Ghostty registry across daemons.** Discovered live in P3: a dev-lane sidecar reaped three production panes because absence-from-read-model was treated as "runtime gone". Rev 4's ownership stamp + owner-fenced absence-reap + event-only reap for legacy panes closes it. Residual: a legacy pane whose runtime died while its owning daemon had no viewer running is never reaped by another daemon's viewer; it is reaped when that daemon's viewer (or in-daemon path, until P4) processes the terminate, or by the operator. Acceptable — the failure mode is a stale pane, never a lost one.
- **Record-less generations after upgrade** get no new panes until their next invocation or rotation (§5.5). Parity with today; rotation helps but is not required.
- **Stale read model rows.** The read model deliberately does not reconcile liveness, so it can list a runtime whose tmux has died until hrc's own sweep marks it. The viewer's pane then shows a dead attach until the `runtime.dead`/`stale` event arrives — the same window that exists today between substrate death and sweep.
- **wrkq read moves to the viewer.** The viewer needs `wrkq` reachable for tab labels; on failure it falls back to the raw task id (same as today's resolver).
- **Two processes to keep alive instead of one.** Mitigated by `KeepAlive` and the fact that the failure mode is cosmetic.

## 9. Relationship to HRCMac embedded terminal

The HRCMac campaign (T-07334..37) embeds libghostty and attaches to broker-tmux directly; its spec names "viewer sunset" as a deliberately separate future spec. This extraction is that sunset's on-ramp: once B is `packages/hrc-viewer`, sunset is the removal of one package and one LaunchAgent, with no further daemon surgery. HRCMac could also become a second consumer of the same `presentation` event fields (§5.1) with no additional hrc work.

## 10. Revision history

**rev 1 → rev 2** (daedalus REJECT, DM #21126):

- *Flaw 1 — viewer reads were effectful.* `hrc runtime list` and `GET /v1/runtimes/:id/attach` run `reconcileTmuxRuntimeLiveness`, which can mark a runtime dead. Rev 2 removes both from the viewer entirely: socket path and attach target ride on the `runtime.presentation` event and the new db-only `GET /v1/presentation/runtimes` (§5.2–5.3); §5.4 enumerates the permitted routes and adds a contract test proving each is side-effect-free; invariants 3 and 6 are restated accordingly.
- *Flaw 2 — pane key changed silently.* Rev 1 wrote `(tabKey, agentId)`; the shipped key is normalized `(scopeRef, laneRef)`. Rev 2 restores it verbatim (§4.4), names `agentId` as presentation-only, and adds the two-roles-one-agent case to the Phase 3 matrix.
- *Flaw 3 — no reconstruction contract.* Rev 1 relied on runtime-list rows that carry no presentation fields, a session-title `GET` that does not exist, and a `runtime.created` append the broker path never makes. Rev 2 persists the presentation record on the runtime row (§5.1), introduces `runtime.presentation` as a new append at the single point where the seven spawn sites live today (§5.2), serves title from the read model (§5.3), and makes reconcile honour persisted suppression (§4.5).

**rev 2 → rev 3** (daedalus REJECT, DM #21131):

- *Flaw 1 — invocation-local `operatorAttachPending` promoted to immutable generation state.* Today the predicate is computed per start/reuse invocation and only skips that invocation; a detached `hrc start` reusing an `hrc run` runtime mints a viewer. Rev 3 stops persisting `operatorAttachPending`; it rides only on the per-invocation `runtime.presentation` event (§5.2), which is now emitted on every start *and reuse* invocation. The persisted record carries the cumulative fact the in-daemon path actually acts on — monotone `viewerRequested` (§5.1) — and reconcile keys on it (§4.5), reproducing the event path's cumulative outcome. The reuse-after-run case is added to the Phase 3 gate.
- *Flaw 1b — no authority for pre-upgrade generations.* Rev 3 adds §5.5: record-less rows are never minted, existing panes are adopted, the next invocation writes the record, and rotation shrinks the population without being relied on. The Phase 5 gate is restated to what can actually be asserted.

**rev 3 APPROVED** (DM #21133). Non-binding prose correction applied: generation rotation is not a hard expiry.

**rev 3 → rev 4** (material amendment; trigger: cody's P3 shadow run, T-07595 blocked, evidence `T-07595/sidecar-off/`):

- *Defect — cross-daemon reap.* Rev 3 §4.5 reaped any pane whose runtime was absent from the connected daemon's read model. Ghostty's metadata registry is per user and shared by every daemon of that user (prod `hrc` + `hrc-dev` on max3), so the hrc-dev sidecar's first reconcile reaped three production panes (2 s test linger). The in-daemon reaper never had this defect: it reaps only on its own runtime's terminate, runtime-fenced. Rev 4 adds pane ownership (`hrc_owner_root` = owning daemon's `runtimeRoot`, served by the read model envelope), makes absence-reap owner-fenced, makes legacy (unstamped) panes adopt-only and event-reap-only, excludes foreign panes from every viewer action, scopes the pane key by owner (fixing a latent in-daemon cross-daemon key collision), stamps ownership from the in-daemon path until P4 (§5.6), and adds matrix row 13 (cross-daemon isolation) to the P3/P4 gates. Invariant 7 added; §2.2 now states the multi-daemon fact.

**rev 4 → rev 5** (daedalus REJECT, DM #21161):

- *Flaw 1 — placement still reached foreign panes.* Rev 4 fenced paint/retitle/rebind/reap but left window/tab identity global, so a split target or `equalize-panes` could touch a foreign pane. Rev 5 scopes window and tab identity by owner (one window per daemon lane; tabs searched only within it), forbids splitting from any non-owned pane, runs equalize only on fully-owned tabs (else opens a new tab), and defines legacy-window claiming so that claiming a window claims none of its panes. Invariant 7 restated to cover placement and resize.
- *Flaw 2 — no gate could catch a violation.* Rev 4's row 13 was described in §10 but never written into the Phase 3/4 tables. Rev 5 adds `hrc-viewer --dry-run` (classifies every surface, logs intended actuations, performs none) and writes row 13 into the Phase 3 gate as the FIRST and LAST row — rows 1–12 may not begin until 13(a) shows zero foreign/legacy actuations against live production panes; Phase 4 re-runs it in the same order; Phase 5 requires 13(a) on each node before install.

**rev 5 → rev 6** (daedalus REJECT, DM #21163):

- *Flaw 1 — "atomic first-claimant" legacy-window stamp does not exist in ghostmux.* `--find-or-create-by` returns an existing match unchanged and cannot stamp it, so any later stamp is a race. Rev 6 deletes legacy-window claiming altogether: owner-qualified find-or-create (owner in both the match predicate and the create metadata) means two owners can never select the same window; legacy windows are never a placement target for anyone, legacy panes are adopted in place for paint/retitle/rebind/event-reap only and are never split targets, no equalize ever runs in a legacy window, and no pane is minted for a key while a legacy/adopted-in-place pane exists. Legacy windows drain via event-reap and Ghostty's last-tab-out retirement.
- *Flaw 2 — dry-run could not read the predicate it classifies on.* `list-surfaces --json` has no metadata. Rev 6 adds `metadata get -t <surface>` / `--window-id` for every listed surface and window to the dry-run read set, and requires the report to show the raw owner/role/runtime values read per surface so the gate's observation is itself observable; a surface missing from the report fails the gate.
