# Viewer Sidecar Spec: Extracting Ghostty Presentation from hrc-server

Status: DRAFT rev 1 — submitted to daedalus for verification  
Date: 2026-08-26  
Author: mable@hrc-runtime  
Primary systems: hrc-server (event ledger, runtime lifecycle), new `packages/hrc-viewer`, `ghostmux` CLI, ScriptableGhostty

## 1. Summary

hrc-server today spawns, retitles, status-paints, and reaps Ghostty panes that mirror broker-tmux runtimes. That presentation logic is not hrc's job (hrc hosts, persists, recovers, and reaps *runtimes*), and it has leaked ~330 lines of viewer-conditional branching into runtime start, broker dispatch, terminate, sweep, and startup reconcile.

This spec moves all Ghostty presentation into a separate per-user process, **`hrc-viewer`**, that:

- subscribes once, fleet-wide, to hrc's durable event stream (`GET /v1/events/bounded-stream`),
- actuates exclusively through the `ghostmux` CLI,
- holds **no persistent state** — Ghostty surface/window metadata remains the registry of record (existing invariant), and `hrc runtime list` is the runtime authority,
- can die, restart, or be absent without affecting any runtime.

hrc-server keeps *knowing* presentation intent (it already receives it from the CLI) and stops *acting* on it. Two additive changes are required on the hrc side (§5). Everything else is deletion.

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
- Bun/TypeScript, `packages/hrc-viewer` in hrc-runtime, consuming `@praesidium/hrc-sdk` (`HrcClient.watchBoundedEvents`, `listLatestEventBySession`, `listRuntimes`, `getAttachDescriptor`) and shelling to `ghostmux`.
- Talks only to the local daemon socket (`HRC_RUNTIME_DIR`) and the Ghostty API socket. No listening ports.

### 4.2 Inputs

| Need | Source |
|---|---|
| runtime identity (`runtimeId`, `hostSessionId`, `generation`, `scopeRef`, `laneRef`) | every hrc event |
| whether an operator terminal is about to attach; requested viewer window key; operator-attachability | `presentation` field on runtime lifecycle events (§5.1) |
| tmux socket path + attach target (`<session>:tui`) | `GET /v1/runtimes/:id/attach` (existing; called once per pane creation) |
| session title | `session.retitled` event (§5.2) + `GET /v1/sessions/:id/title` on reconcile |
| task label for the tab | wrkq lookup **in the viewer** (moves out of hrc) |
| agent theme / project prefix | pure derivation from `scopeRef` (moves out of hrc as-is) |

### 4.3 Reaction table

| Event | Viewer action |
|---|---|
| `runtime.created` / `runtime.ensured` / `runtime.restarted` / `runtime.adopted` with `presentation.operatorAttachable === true` and `presentation.operatorAttachPending !== true` | `ensurePane(runtime)` (find-or-create; §4.4) |
| same, with `operatorAttachPending === true` | skip (operator terminal will attach; today's `skipped_operator_attach_pending`) |
| `surface.bound` for an operator terminal on a runtime that has a viewer pane | no-op (both may coexist; today's behavior) |
| `turn.started` / `turn.input_resumed` | status bar → `running` |
| `turn.awaiting_input` | status bar → `awaiting` |
| `turn.completed` | status bar → `idle` |
| `runtime.terminated` / `runtime.dead` / `runtime.stale` / `runtime.crashed` | status bar → `exited` (sticky); schedule reap after `linger` seconds (default 300, `0` = immediate) |
| `session.retitled` | `ghostmux set-title` on the pane(s) for that session |
| `context.cleared` / `session.generation_auto_rotated` | rebind pane metadata `hrc_runtime_id` on the next `runtime.*` for the new generation (existing reuse rule) |
| stream `gap` / `ledger_replaced` / socket EOF | reconnect from `/v1/events/tail` head; run full reconcile (§4.5) |

The `eventKind → state` table and sticky-exited rule are lifted verbatim from `headless-viewer-status.ts:38-54`.

### 4.4 Identity and placement (unchanged policy, now written down)

These rules are the shipped T-05237 / T-07118 / T-07121 behavior, moved out of code comments:

- **Window key** = `presentation.viewerWindow` from intent, else `default`. One managed Ghostty window per key, found-or-created via `ghostmux new --window --find-or-create-by {"hrc_role":"headless-sessions-window","hrc_window_key":<key>}`. Adoption is a *window* metadata stamp. Legacy anchor-pane discovery is retained only as the documented 404 fallback for pre-windows-API builds.
- **Tab key** = `task:<T-XXXXX>` when the scope carries a real task id, else `project:<projectId>:primary`. Tab identity is the pair `(windowKey, tabKey)`.
- **Pane key** = `(tabKey, agentId)`, **global**: at most one live viewer pane per hrc session. A pane wearing the right key but resident in a different window is not a split target (residency fence).
- Placement authority is split: pane metadata = logical identity; first-class `window_id` = physical residency. Order is mandatory: find-or-create window first, then evaluate candidates.
- Pane metadata written: `hrc_role=headless-agent-pane`, `hrc_window_key`, `hrc_tab_key`, `hrc_pane_key`, `hrc_agent_id`, `hrc_lane_ref`, `hrc_project`, `hrc_task_id`, `hrc_scope_ref`, `hrc_runtime_id`, `hrc_host_session_id`, `hrc_generation`.
- Pane command: `hrc session-report ... --wait-timeout <linger>` wrapping `tmux -S <socket> attach -t <session>:tui`; the title write is the **last** write after the blocking attach so OSC-7 cwd reporting cannot clobber it.
- Per-key in-process mutex serializes find-or-create per `(windowKey, tabKey)` and per window; each create re-reads live metadata after acquiring the lock.
- **Reap is runtime-fenced**: kill the pane only if live metadata `hrc_runtime_id` equals the terminating runtime and role is `headless-agent-pane`; never kill a window anchor. A pane rebound to a newer runtime survives a stale terminate.

### 4.5 Reconcile

Run on viewer start, on every reconnect, and on a slow timer (default 5 min):

1. `ghostmux list-surfaces --json` → panes with `hrc_role=headless-agent-pane`.
2. `hrc runtime list --json` (live runtimes with `presentation.operatorAttachable`).
3. Runtime with no pane → `ensurePane`. Pane whose `hrc_runtime_id` is not live and whose reap linger has elapsed → reap. Pane whose runtime is live but whose generation differs → rebind metadata.

This is the first time viewer panes are reconciled after a daemon restart at all (hrc-server does not do it today; it relies on lazy re-adoption at the next spawn). A ScriptableGhostty restart wipes the in-memory window registry; reconcile re-adopts by design ("degraded, never broken").

### 4.6 Failure behavior

- ghostmux timeout / unsupported command / Ghostty absent → log, back off (`0,500,1000,2000,4000` ms), retry on next reconcile. No runtime is ever affected.
- Viewer absent → no windows. Runtimes unaffected.
- Daemon absent → viewer idles on reconnect backoff.
- Viewer logs to `~/praesidium/var/logs/hrc-viewer.log` with the same `broker_headless_viewer.*` / `headless_viewer_reap.*` line vocabulary hrc uses today, so existing grep habits survive.

## 5. hrc-server changes (additive; ship dark before Phase 3)

### 5.1 `presentation` on runtime lifecycle events

`runtime.created`, `runtime.ensured`, `runtime.restarted`, `runtime.adopted` payloads gain:

```ts
presentation?: {
  operatorAttachable: boolean         // == canOperatorAttach(runtime) at emit time
  operatorAttachPending?: true        // set when the invoker's terminal will attach (hrc run / hrc attach)
  viewerWindow?: string               // from lastAppliedIntentJson.presentation.viewerWindow
}
```

hrc already computes all three values on the start path today; this makes them facts on the ledger instead of arguments to an in-process spawn. `HrcTargetRuntimeView` already exposes `presentation` and `operatorAttachable` (`target-view.ts:192,205`); the event field mirrors it.

### 5.2 `session.retitled` event kind

`PUT/DELETE` on the session-title route (`index.ts:2222-2255`) appends `session.retitled` (category `session`) with payload `{ title: string | null, source }` and notifies. Today the route is a bare `db.sessionTitles.upsert/delete` with no ledger row, so no external consumer can react to a retitle.

### 5.3 Nothing else

Tmux socket path and attach target stay behind `GET /v1/runtimes/:id/attach` (already exists). Daemon restart needs no event; the viewer detects it via stream EOF + `ledger_replaced`.

## 6. Phases and gates

Each phase lands independently on `main`; none requires the next.

| Phase | Work | Gate (evidence) |
|---|---|---|
| **1. Delete legacy A** | Remove `transport:'ghostty'` spawn-dead tail, `HRC_CLAUDE_GHOSTTY*`, `cleanupIdleClaudeGhosttyRuntimes`, `reconcileGhostty`, legacy attach descriptor, legacy select/transport predicates. Closes T-07201, T-07207 (both dormant behind the deleted flag). | `rg -i 'claude.?ghostty\|transport === .ghostty' packages/hrc-server/src` empty (excluding tests deleted with it); full suite green; `just install` + graceful restart; `hrc runtime list` and one `hrc start` + `hrcchat dm` round-trip unchanged. |
| **2. Emit signals** | §5.1 and §5.2. | New fields visible in `hrc monitor watch --json` on a live `hrc start` and `hrc session retitle`; `KIND_CATEGORIES` includes `session.retitled`; contract tests. |
| **3. Build hrc-viewer; shadow-validate** | New package + LaunchAgent. On `hrc-dev` (or the hrcdev VM), run the daemon with `HRC_GHOSTTY_VIEWERS=0` and the viewer enabled. | For each of: `hrc start` (headless codex + claude), `hrc run` (viewer must be **suppressed**), `hrcchat dm` to a cold scope, `hrc session retitle`, `hrc runtime terminate` (pane survives `linger` then dies), daemon graceful restart, Ghostty quit/reopen — the resulting `ghostmux list-windows/list-surfaces --json` topology is identical to what the in-daemon path produced, screenshots attached to the task. |
| **4. Delete B from hrc; rename C** | Remove everything in §3 rows 1–10 and the dedicated modules; rename `headlessViewerRoute` / `isHeadlessViewerRoute` / `createBrokerHeadlessViewerAllocator` to `tmuxTuiRoute` / `isOperatorPresentationRoute` / `createBrokerTmuxTuiAllocator`. Terminate becomes synchronous. | `rg -i ghostty packages/hrc-server/src` matches only the `GHOSTTY_SURFACE_UUID` CLI-side operator-surface read and docs; suite green; Phase-3 matrix re-run against the deleted daemon on `hrc-dev`. |
| **5. Fleet rollout** | Install LaunchAgent on max3 (lherron), mini (lherron; decide svc/lab), rolling daemon rotation. | Post-rollout `ghostmux list-surfaces --json` on each node shows live-runtime panes; no `broker_headless_viewer.*` lines in hrc-server logs. |

Rollback at any phase ≤ 3: stop the LaunchAgent, leave `HRC_GHOSTTY_VIEWERS` unset (default on). After Phase 4 the rollback is the viewer itself.

## 7. Invariants

1. hrc-server never invokes `ghostmux` (post Phase 4).
2. hrc-server's runtime lifecycle has no code path whose outcome depends on Ghostty state.
3. The viewer never writes to hrc (read-only client: events, runtime list, attach descriptor, session title). It has no `POST` authority.
4. Ghostty metadata is the sole viewer registry; the viewer keeps no state that must survive its own restart.
5. At most one live viewer pane per hrc session (global pane key), same as today.
6. Viewer absence, death, or lag can never change runtime state, delay a turn, or fail a start.

## 8. Risks

- **Race between `runtime.created` and tmux readiness.** Today spawn is called after the broker reports ready. The viewer must call `/attach` only after the runtime's attach descriptor resolves (retry with backoff on `HrcRuntimeUnavailableError`), or key off `runtime.ensured`/first `turn.*` rather than `runtime.created`. Phase 3 matrix decides which; either is acceptable.
- **`presentation.operatorAttachPending` only exists at start.** If an operator attaches *later* (`hrc attach` to a running runtime), the viewer pane already exists and both coexist — identical to today.
- **wrkq read moves to the viewer.** The viewer needs `wrkq` reachable for tab labels; on failure it falls back to the raw task id (same as today's resolver).
- **Two processes to keep alive instead of one.** Mitigated by `KeepAlive` and the fact that the failure mode is cosmetic.

## 9. Relationship to HRCMac embedded terminal

The HRCMac campaign (T-07334..37) embeds libghostty and attaches to broker-tmux directly; its spec names "viewer sunset" as a deliberately separate future spec. This extraction is that sunset's on-ramp: once B is `packages/hrc-viewer`, sunset is the removal of one package and one LaunchAgent, with no further daemon surgery. HRCMac could also become a second consumer of the same `presentation` event fields (§5.1) with no additional hrc work.
