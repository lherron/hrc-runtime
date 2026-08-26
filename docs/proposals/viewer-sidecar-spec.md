# Viewer Sidecar Spec: Extracting Ghostty Presentation from hrc-server

Status: DRAFT rev 2 — resubmitted to daedalus (rev 1 REJECTED, three flaws; see §10)  
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
- No cross-node behavior. A viewer serves the daemon on its own node for its own GUI user.
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

### 4.2 Inputs

Every input arrives on one of two surfaces, both side-effect-free by contract (§5.4):

| Need | Source |
|---|---|
| runtime identity (`runtimeId`, `hostSessionId`, `scopeRef`, `laneRef`, `generation`) | `runtime.presentation` event (§5.2) / presentation read model (§5.3) |
| operator-attachability; whether an operator terminal will attach (suppression); requested viewer window key | same — persisted on the runtime row by hrc at start (§5.1) |
| tmux socket path + attach target (`<session>:tui`) | same — hrc derives them from the persisted hosting/tmux state when it emits/projects; the viewer never calls `/v1/runtimes/:id/attach` |
| session title | `session.retitled` event (§5.2) and the `title` column of the read model |
| task label for the tab | wrkq lookup **in the viewer** (moves out of hrc); falls back to the raw task id |
| agent theme / project prefix | pure derivation from `scopeRef` (moves out of hrc as-is) |
| lifecycle state for the status bar and reap | existing `turn.*` / `runtime.*` events |

### 4.3 Reaction table

| Event | Viewer action |
|---|---|
| `runtime.presentation` with `operatorAttachable === true` and `operatorAttachPending !== true` | `ensurePane(record)` (find-or-create; §4.4). The event carries the socket path and attach target, so no further hrc call is needed. |
| `runtime.presentation` with `operatorAttachPending === true` | skip, and the fact is persisted (§5.1), so reconcile skips it too (today's `skipped_operator_attach_pending`) |
| `runtime.created` / `runtime.ensured` / `runtime.adopted` | **no viewer action** — these fire before the tmux `:tui` window exists on some paths and not at all on the broker path; `runtime.presentation` is the only spawn trigger |
| `surface.bound` for an operator terminal on a runtime that has a viewer pane | no-op (both may coexist; today's behavior) |
| `turn.started` / `turn.input_resumed` | status bar → `running` |
| `turn.awaiting_input` | status bar → `awaiting` |
| `turn.completed` | status bar → `idle` |
| `runtime.terminated` / `runtime.dead` / `runtime.stale` / `runtime.crashed` | status bar → `exited` (sticky); schedule reap after `linger` seconds (default 300, `0` = immediate) |
| `session.retitled` | `ghostmux set-title` on the pane for that session |
| `context.cleared` / `session.generation_auto_rotated` | rebind pane metadata `hrc_runtime_id` on the next `runtime.*` for the new generation (existing reuse rule) |
| stream `gap` / `ledger_replaced` / socket EOF | reconnect from `/v1/events/tail` head; run full reconcile (§4.5) |

The `eventKind → state` table and sticky-exited rule are lifted verbatim from `headless-viewer-status.ts:38-54`.

### 4.4 Identity and placement (unchanged policy, now written down)

These rules are the shipped T-05237 / T-07118 / T-07121 behavior, moved out of code comments:

- **Window key** = `presentation.viewerWindow` from intent, else `default`. One managed Ghostty window per key, found-or-created via `ghostmux new --window --find-or-create-by {"hrc_role":"headless-sessions-window","hrc_window_key":<key>}`. Adoption is a *window* metadata stamp. Legacy anchor-pane discovery is retained only as the documented 404 fallback for pre-windows-API builds.
- **Tab key** = `task:<T-XXXXX>` when the scope carries a real task id, else `project:<projectId>:primary`. Tab identity is the pair `(windowKey, tabKey)`.
- **Pane key** = the normalized `(scopeRef, laneRef)` pair, exactly as shipped (`ghostmux.ts:157-168`, `:247-270`), **global**: at most one live viewer pane per hrc session. `agentId` is presentation metadata used for theme and labels, never uniqueness authority — two role-qualified scopes for the same agent/task are two sessions and get two panes (characterized by `ghostmux-manager-viewer.test.ts:353-391`, which moves to the viewer package unchanged). A pane wearing the right key but resident in a different window is not a split target (residency fence).
- Placement authority is split: pane metadata = logical identity; first-class `window_id` = physical residency. Order is mandatory: find-or-create window first, then evaluate candidates.
- Pane metadata written: `hrc_role=headless-agent-pane`, `hrc_window_key`, `hrc_tab_key`, `hrc_pane_key`, `hrc_agent_id`, `hrc_lane_ref`, `hrc_project`, `hrc_task_id`, `hrc_scope_ref`, `hrc_runtime_id`, `hrc_host_session_id`, `hrc_generation`.
- Pane command: `hrc session-report ... --wait-timeout <linger>` wrapping `tmux -S <socket> attach -t <session>:tui`; the title write is the **last** write after the blocking attach so OSC-7 cwd reporting cannot clobber it.
- Per-key in-process mutex serializes find-or-create per `(windowKey, tabKey)` and per window; each create re-reads live metadata after acquiring the lock.
- **Reap is runtime-fenced**: kill the pane only if live metadata `hrc_runtime_id` equals the terminating runtime and role is `headless-agent-pane`; never kill a window anchor. A pane rebound to a newer runtime survives a stale terminate.

### 4.5 Reconcile

Run on viewer start, on every reconnect, and on a slow timer (default 5 min). Uses only §5.4 reads.

1. `ghostmux list-surfaces --json` → panes with `hrc_role=headless-agent-pane`.
2. `GET /v1/presentation/runtimes` (§5.3) → every non-terminal runtime with its persisted presentation record. This is a db-only projection: no liveness reconcile runs, no runtime can be marked dead by the call.
3. Record with `operatorAttachable && !operatorAttachPending` and no pane → `ensurePane`. Pane whose `hrc_runtime_id` is absent from the read model (terminal or unknown) and whose reap linger has elapsed → reap. Pane whose session is present with a newer generation → rebind metadata. Titles re-applied from the `title` column.

Because attachability, suppression, window key, socket path, attach target and title are all persisted by hrc and projected by the read model, a viewer that starts or reconnects *after* a runtime exists reconstructs exactly the state the event path would have produced. Suppression is per runtime generation: a runtime born for `hrc run` never acquires a viewer pane on a later reconcile (identical to today, where nothing spawns after start either).

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
  operatorAttachable: boolean   // == canOperatorAttach(runtime) when the :tui substrate is known
  operatorAttachPending: boolean // invoker's terminal will attach (hrc run / hrc attach-by-id)
  viewerWindow?: string          // from lastAppliedIntentJson.presentation.viewerWindow
}
```

Written once, at the point where hrc today calls `spawnBrokerHeadlessViewer` — i.e. where `runtime-io-handlers.ts:335-337` already computes `operatorAttachPending` and `controller-factory.ts:232-260` already evaluates `canOperatorAttach` and the window key. Persisted alongside the runtime (`broker/controller/persistence.ts` on the broker path; the runtime record update on the managed-start paths). Never mutated afterwards; a new generation gets a new record.

### 5.2 Two event kinds

**`runtime.presentation`** (category `runtime`). Appended and notified at the same single point as §5.1 — which is the moment the tmux `:tui` window exists and hrc has decided attachability. This collapses the seven current spawn call sites (`runtime-io-handlers.ts:368,402,463,485`, `broker-headless-handlers.ts:745`, `broker-interactive-handlers.ts:596`, `turn-dispatch-handlers.ts:660`) into one `publishPresentation(runtime, { operatorAttachPending })`. It is a *new* append, not a field on `runtime.created`: the broker path persists its runtime directly (`persistence.ts:103-148`) and never appends `runtime.created`, so there is nothing there to extend. Payload:

```ts
{
  presentation: { operatorAttachable, operatorAttachPending, viewerWindow? },
  tmux?: { socketPath: string, attachTarget: string },   // present iff operatorAttachable
  title?: string                                          // current session title, if any
}
```

`tmux` is derived at emit time from the persisted hosting state via the existing `getBrokerRuntimeTmuxSocketPath` / `getBrokerRuntimeTmuxAttachTarget` (`broker-decisions.ts:1016,1062`).

**`session.retitled`** (category `session`). Appended by the `POST`/`DELETE` session-title route (`index.ts:2222-2255`) with payload `{ title: string | null }`. Today the route is a bare `db.sessionTitles.upsert/delete` with no ledger row.

Both kinds are added to `KIND_CATEGORIES` (`hrc-event-helper.ts:18-77`).

### 5.3 Presentation read model

`GET /v1/presentation/runtimes` returns, for every runtime whose status is non-terminal, one row with the same shape as the `runtime.presentation` payload plus identity (`runtimeId`, `hostSessionId`, `scopeRef`, `laneRef`, `generation`, `status`). It is a **projection over the store only**: it reads runtime rows, the persisted §5.1 record, hosting/tmux state and `session_titles`, and returns. It does **not** call `reconcileTmuxRuntimeLiveness`, probe tmux, attach, or append events. SDK: `HrcClient.listPresentationRuntimes()`.

### 5.4 Side-effect-free read contract

The viewer is permitted exactly these hrc routes: `GET /v1/events/tail`, `GET /v1/events/bounded-stream`, `GET /v1/events/latest-by-session`, `GET /v1/presentation/runtimes`, `GET /v1/health`. Each is a store read with no reconcile or mutation. This is enforced two ways:

- a contract test per route that seeds a runtime whose tmux substrate is *absent*, calls the route, and asserts the runtime's status and the ledger head are unchanged (the same seed makes `GET /v1/runtimes` and `GET /v1/runtimes/:id/attach` mark it dead — those are the routes the viewer is forbidden);
- the viewer package's SDK usage is limited to the corresponding client methods, checked by the existing `boundaries` lint.

Routes that reconcile liveness as a side effect of reading (`GET /v1/runtimes` via `runtime-list-adopt-handlers.ts:186-198`, `GET /v1/runtimes/:id/attach` via `index.ts:2277-2280`) are unchanged and remain off-limits to the viewer.

## 6. Phases and gates

Each phase lands independently on `main`; none requires the next.

| Phase | Work | Gate (evidence) |
|---|---|---|
| **1. Delete legacy A** | Remove `transport:'ghostty'` spawn-dead tail, `HRC_CLAUDE_GHOSTTY*`, `cleanupIdleClaudeGhosttyRuntimes`, `reconcileGhostty`, legacy attach descriptor, legacy select/transport predicates. Closes T-07201, T-07207 (both dormant behind the deleted flag). | `rg -i 'claude.?ghostty\|transport === .ghostty' packages/hrc-server/src` empty (excluding tests deleted with it); full suite green; `just install` + graceful restart; `hrc runtime list` and one `hrc start` + `hrcchat dm` round-trip unchanged. |
| **2. Persist, publish, project** | §5.1–5.4: persisted presentation record, `runtime.presentation` + `session.retitled` kinds, the read model route + SDK method, the side-effect-free contract tests. The seven spawn call sites collapse to one `publishPresentation` call that (until Phase 4) still invokes the in-daemon viewer behind it. | `runtime.presentation` visible in `hrc monitor watch --json` on a live `hrc start` (with `tmux`) and on `hrc run` (with `operatorAttachPending: true`); `session.retitled` on `hrc session retitle`; `GET /v1/presentation/runtimes` returns the same records; §5.4 contract tests green. |
| **3. Build hrc-viewer; shadow-validate** | New package + LaunchAgent; `ghostmux.ts` viewer portion, `headless-viewer-status.ts`, theme/prefix/label modules and their tests move across. On `hrc-dev` (or the hrcdev VM), run the daemon with `HRC_GHOSTTY_VIEWERS=0` and the viewer enabled. | For each of: `hrc start` (headless codex + claude), `hrc run` (viewer must be **suppressed**, including after a viewer restart + reconcile while the run is live), `hrcchat dm` to a cold scope, two role-qualified scopes for one agent/task (two panes), `hrc session retitle`, `hrc runtime terminate` (pane survives `linger` then dies), daemon graceful restart, viewer restart, Ghostty quit/reopen — the resulting `ghostmux list-windows/list-surfaces --json` topology is identical to what the in-daemon path produced, screenshots attached to the task. Additionally: with the viewer running against a runtime whose tmux socket has been removed, the runtime's status does not change until hrc's own sweep runs. |
| **4. Delete B from hrc; rename C** | Remove everything in §3 rows 1–10 and the dedicated modules; rename `headlessViewerRoute` / `isHeadlessViewerRoute` / `createBrokerHeadlessViewerAllocator` to `tmuxTuiRoute` / `isOperatorPresentationRoute` / `createBrokerTmuxTuiAllocator`. Terminate becomes synchronous. | `rg -i ghostty packages/hrc-server/src` matches only the `GHOSTTY_SURFACE_UUID` CLI-side operator-surface read and docs; suite green; Phase-3 matrix re-run against the deleted daemon on `hrc-dev`. |
| **5. Fleet rollout** | Install LaunchAgent on max3 (lherron), mini (lherron; decide svc/lab), rolling daemon rotation. | Post-rollout `ghostmux list-surfaces --json` on each node shows live-runtime panes; no `broker_headless_viewer.*` lines in hrc-server logs. |

Rollback at any phase ≤ 3: stop the LaunchAgent, leave `HRC_GHOSTTY_VIEWERS` unset (default on). After Phase 4 the rollback is the viewer itself.

## 7. Invariants

1. hrc-server never invokes `ghostmux` (post Phase 4).
2. hrc-server's runtime lifecycle has no code path whose outcome depends on Ghostty state.
3. The viewer calls only the §5.4 routes, each of which is a store read with no reconcile or mutation, proven by contract test. "Read-only" means side-effect-free, not merely `GET`.
4. Ghostty metadata is the sole viewer registry; the viewer keeps no state that must survive its own restart. Everything needed to reconstruct a pane (attachability, suppression, window key, socket, target, title) is persisted by hrc and served by §5.3.
5. At most one live viewer pane per hrc session, keyed by normalized `(scopeRef, laneRef)`, same as today.
6. Viewer absence, death, lag, or polling can never change runtime state, finalize a run, delay a turn, or fail a start — a consequence of invariant 3.

## 8. Risks

- **Readiness race.** Eliminated by construction: `runtime.presentation` is appended at the exact point the in-daemon spawn happens today, i.e. after the `:tui` substrate exists, and it carries the socket and target.
- **Suppression is fixed at start.** If an operator attaches *later* (`hrc attach` to a running runtime), the viewer pane already exists and both coexist — identical to today. A runtime born suppressed stays viewer-less for its generation — also identical to today.
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
