# hrc-server Architecture

**Date:** 2026-06-07
**Status:** CANONICAL (current, shipped architecture)
**Scope:** `packages/hrc-server` within `/Users/lherron/praesidium/hrc-runtime`

This document describes the architecture **as shipped today**. It records only current facts. It deliberately omits any forward-looking vocabulary or routing redesign that has not landed.

---

## 1. What hrc-server is

`hrc-server` is the HRC daemon. It exposes a **Unix-socket HTTP API** and owns runtime orchestration: launching/controlling agent runtimes (headless and tmux), driving the Harness Broker, tmux/ghostmux pane management, hook/OTEL event ingestion, message persistence, and the directed-messaging (`hrcchat`) selector surface.

Package facts (`package.json`):
- `name: hrc-server`, `version: 0.1.0`, `type: module`.
- Exports map serves **TypeScript source under the `bun` condition** (`"bun": "./src/index.ts"`) and `dist` for the standard `import`/`types` conditions. This is why the daemon runs worktree source under bun — no build/install step is required for source edits to take effect on the next daemon restart.
- Depends on the HRC layer (`hrc-core`, `hrc-events`, `hrc-store-sqlite`) and the pinned ASP `spaces-*` / `agent-spaces` / `agent-scope` packages (currently `0.1.1-dev.20260606225727`), resolved via Verdaccio at install time.
- Scripts: `build` (`tsc`), `typecheck` (`tsc --noEmit`), `test` (`bun test --timeout 10000`), plus `prepack`/`postpack` that strip the bun export condition for packaging.

---

## 2. Module topology under `packages/hrc-server/src`

The tree is a **flat domain-module layout** at `src/` plus four cohesive subdirectories: `broker/`, `parsers/`, `launch/`, and `agent-spaces-adapter/`. The daemon entrypoint is `index.ts`.

### 2.1 `index.ts` — aggregation, bootstrap, handler registration (NOT business ownership)

`index.ts` (≈1,518 lines) is no longer the monolith. Its current, confirmed role is:

- **Construction / lifecycle.** `createHrcServer(options)` prepares the filesystem, acquires the server lock (`server-lock.ts`), prepares the socket, creates the tmux manager (`tmux.ts`) and ghostmux manager (`ghostmux.ts`), opens the SQLite DB (`hrc-store-sqlite`), replays the launch spool (`replay-spool.ts`), reconciles startup state (`startup-reconcile.ts`), and returns a `HrcServerInstance`.
- **Class shell.** `class HrcServerInstance implements HrcServer` holds the in-flight operation maps (`runtimeAttachOperations`, `runtimeStartOperations`, `attachedRunOperations`, `turnResponseFinalizers`, `pendingBrokerLiteralInputs`), the broker controller handle, subscriber sets, and the recurring-sweep timers.
- **Route aggregation.** It builds `exactRouteHandlers: Record<string, ExactRouteHandler>` keyed by `exactRouteKey(method, pathname)`, registers `route.handler`s into that map, and dispatches in `handleRequest(request)` by exact-route lookup followed by a small set of prefix matches (e.g. `GET /v1/sessions/by-host/…`, `GET /v1/active-run-contributions/…`, several `POST` prefixes). Routing is **aggregation here, not per-domain route ownership** — the route table lives in `index.ts`.
- **Handler registration.** The concrete handler implementations are **not** defined in `index.ts`. They live in per-domain modules and are attached onto the instance prototype via a single `Object.assign(HrcServerInstance.prototype, …)` that composes the exported method bags: `appSessionHandlersMethods`, `eventHandlersMethods`, `turnDispatchHandlersMethods`, `brokerInteractiveHandlersMethods`, `brokerHeadlessHandlersMethods`, `sdkTurnHandlersMethods`, `bridgeSurfaceHandlersMethods`, `sweepHandlersMethods`, `runtimeIoHandlersMethods`, `runtimeControlHandlersMethods`, `targetMessageHandlersMethods`, `eventNotificationHandlersMethods`, `selectorMessageHandlersMethods`, `selectorWaitHandlersMethods`. (Note: `runtimeListAdoptRoutes` are registered via a route factory, `createRuntimeListAdoptRoutes`, rather than prototype attachment.)

So `index.ts` owns **aggregation, bootstrap, and handler registration**; the domain modules own the behavior.

### 2.2 `server-instance-context.ts` — the shared handler context with `HandlerMethod` aliases

This module defines `HrcServerInstanceForHandlers` — the broad context type every split handler module is typed against. Confirmed shape:
- Concrete owned state: `options`, `db`, `tmux`, `ghostmux`, `ctx`, the in-flight maps, the sweep/reconcile/idle timers, broker feature flags (`headlessCodexBrokerEnabled`, `claudeCodeTmuxBrokerEnabled`, `codexCliTmuxBrokerEnabled`, stale-generation knobs), the `harnessBrokerController` handle, the post-restart `brokerWarmupComplete` promise, optional broker factory hooks, and the `followSubscribers` / `messageSubscribers` notifier sets.
- A large block of method aliases declared as `HandlerMethod = (...args: any[]) => any` (with `HandlerNever` and `HandlerSessionRecord` variants). These aliases (e.g. `dispatchTurnForSession`, `executeHeadlessBrokerInputTurn`, `handleDispatchTurn`, `handleStartRuntime`, `getHarnessBrokerController`, `maybeAutoRotateStaleSession`, …) are how the prototype-attached handlers are made visible to one another and to `index.ts` under a single context type. The `any`-typed aliases are an intentional, biome-suppressed seam that preserves the original monolith method signatures across the split. It also exports the compat constants `COMMAND_RUNTIME_COMPAT_HARNESS = 'codex-cli'` and `COMMAND_RUNTIME_COMPAT_PROVIDER = 'openai'`.

This context is the current coupling surface between `index.ts` and the domain handler modules.

### 2.3 Domain handler modules (flat `src/`)

Each domain is a `*-handlers.ts` module exporting a `…HandlersMethods` bag (and its `…HandlersMethods` type) that is `Object.assign`-ed onto the prototype. The current set:

- `app-session-handlers.ts` — managed app-session apply/ensure/dispatch/interrupt/terminate (≈867 lines).
- `event-handlers.ts` / `event-notification-handlers.ts` — event append, follow/notify, subscriber fan-out.
- `turn-dispatch-handlers.ts` — semantic turn dispatch.
- `broker-interactive-handlers.ts` (≈1,399 lines) / `broker-headless-handlers.ts` — interactive-tmux vs headless broker turn execution.
- `sdk-turn-handlers.ts` — headless SDK executor turns.
- `bridge-surface-handlers.ts` — bridge target/deliver/close + surface bind/unbind.
- `sweep-handlers.ts` (+ `sweep-helpers.ts`, `sweep-reconcile.ts`) — runtime sweep, zombie-run sweep, active-run reconcile.
- `runtime-io-handlers.ts`, `runtime-control-handlers.ts` (≈1,054 lines), `runtime-list-adopt-handlers.ts` — runtime lifecycle (ensure/start/inspect/attach/interrupt/terminate, list/adopt).
- `target-message-handlers.ts`, `selector-message-handlers.ts` (≈1,091 lines), `selector-wait-handlers.ts` — `hrcchat` directed-messaging surface (target/by-selector dispatch, blocking waits, watch streams).

Supporting flat modules: `broker-decisions.ts` (route choice between interactive-tmux / headless-broker / headless-SDK transports), `ask-bracket.ts` (durable composite-identity "awaiting user input" bracket that is the reaper authority), `hrc-event-helper.ts`, `hook-lifecycle.ts`, `otel-ingest.ts`, `messages.ts`, `dispatch-invocation.ts`, `option-resolvers.ts`, `require-helpers.ts`, `runtime-select.ts`, `status-views.ts`, `target-view.ts`, `local-bridge-helpers.ts`, `brain-enricher*`, `startup-reconcile.ts` (≈1,563 lines), `tmux.ts`, `tmux-socket.ts`, `ghostmux.ts`, `replay-spool.ts`, `server-context.ts`, `server-types.ts`, `server-constants.ts`, `server-lock.ts`, `server-log.ts`, `server-util.ts`, `server-misc.ts`.

### 2.4 `parsers/` — the request-parsing layer, and `server-parsers.ts` as a thin barrel

**Confirmed: the parser split is already done.** `server-parsers.ts` is now a **67-line thin barrel** that contains only `export { … } from './parsers/*.js'` re-exports (no logic). It exists solely to preserve the historical import path. The real parsing lives in `parsers/`:

- `parsers/common.ts` (≈258) — `isRecord`, `parseJsonBody`, `parseFromSeq`, `normalizeOptionalQuery`, primitive field/query helpers.
- `parsers/runtime.ts` (≈530) — runtime ensure/start/inspect/attach/action/terminate, in-flight input, list-runs/list-runtimes filters, broker-inspect, drop-continuation, prepare/resume attached-run parsing; exports the `InFlightInputRequest`, `ListRunsFilter`, `ListRuntimesFilter` types.
- `parsers/app-sessions.ts` (≈557) — app-session specs/selectors, managed-session apply, dispatch/in-flight/clear-context/literal-input/interrupt/terminate requests, with the parsed-request types.
- `parsers/bridges.ts` (≈206) — bridge selectors, target/deliver/close requests, surface bind/unbind.
- `parsers/messages.ts` (≈53) — `parseSessionRef`, `parseResolveSessionRequest`.
- `parsers/sweeps.ts` (≈167) — sweep-runtimes, sweep-zombie-runs, reconcile-active-runs parsing.
- `parsers/runtime-harness-resolver.ts` (≈59) — the filesystem/profile harness-resolution that performs IO, kept **separate from shape-validation parsers** (parsing validates shape; the resolver does IO).

Total parser layer ≈1,830 lines across cohesive modules; the largest parser file is well under the repo's 1,000-line parser ceiling (see §4).

### 2.5 `broker/` — the Harness Broker control surface

**Confirmed: `broker/controller.ts` is a single large class** (`export class HarnessBrokerController`, ≈2,462 lines) — the broker control surface. It is the broadest-responsibility module in the package and owns:
- broker client/session lifecycle and the RPC method surface (`hello`, `health`, `startInvocationFromRequest`, `input`, `interrupt`, `stop`, `status`, `dispose`, permission/close handlers), via the `BrokerClientLike` / `DurableBrokerClientLike` (adds `attach`, `snapshot`, `eventsSince`, `ackEvents`, `permissionRespond`) abstractions;
- admission/capability checks, start-graph persistence (compiled runtime plans, runtimes, runs, invocations, lifecycle policies into the SQLite DB), tmux/headless substrate allocation (`BrokerTmuxAllocator`, lease serialization), and terminal/crash transition handling.
- It is constructed with an explicit `HarnessBrokerControllerDeps` dependency object (db, event mapper, broker client factories, permission channel, agentchat lifecycle, tmux allocators, reap/reconcile hooks, command/args/env, clock, server-instance id). Its public surface is `HarnessBrokerController` plus the `Broker*` types and `BrokerControllerError`.

The rest of `broker/` are cohesive collaborators, already extracted:
- `event-mapper.ts` (≈1,191) — `BrokerEventMapper`: broker invocation events → HRC events/state.
- `runtime-hosting.ts` (≈528) — `projectBrokerHostingState` and hosting projection.
- `runtime-state.ts` (≈349) — `extractFullRuntimeControlState` and runtime-state helpers.
- `capabilities.ts` (≈321) — admission/capability checks.
- `lifecycle-overlay.ts` (≈116) — lifecycle overlay projection.
- `constants.ts` (≈13).

Note (cross-cutting, shipped): the controller participates in the durable-broker model — eager warm of the serving controller after a daemon restart (`brokerWarmupComplete`), `broker.health` liveness, per-runtime liveness probing for the reaper, and the `classifyBrokerInputFailure` messaging path for cold-controller/probe races.

### 2.6 `launch/` and `agent-spaces-adapter/`

- `launch/` — wrapper-process launch path for headless runtimes: `hook.ts`/`hook-cli.ts` (lifecycle/continuation/event hook callbacks), `env.ts` (launch env), `callback-client.ts`, `codex-otel.ts`, `launch-artifact.ts`, `spool.ts`, `index.ts`. Events from launched wrappers flow back via hooks and OTEL into `hook-lifecycle.ts` / `otel-ingest.ts`.
- `agent-spaces-adapter/` — the seam onto the pinned ASP `spaces-*` packages: `compile-adapter.ts` (`compileBrokerRuntimePlan`), `compile-profile-selector.ts`, `cli-adapter.ts`, `sdk-adapter.ts`, `aspc-facade-client.ts`, `index.ts`.

### 2.7 Persistence

State is persisted by the sibling package `hrc-store-sqlite` (not inside hrc-server): `database.ts`, `migrations.ts`, `repositories.ts`, `message-repository.ts`, `index.ts`. hrc-server opens it via `openHrcDatabase(options.dbPath)` and threads the `HrcDatabase` handle through `HrcServerInstanceForHandlers` and `HarnessBrokerControllerDeps`. Canonical DB path: `/Users/lherron/praesidium/var/state/hrc/state.sqlite`.

---

## 3. Request and runtime flow (current)

1. A client hits the Unix socket (`/Users/lherron/praesidium/var/run/hrc/hrc.sock`). `handleRequest` resolves the handler via the exact-route map (then prefix fallbacks).
2. The handler (a prototype-attached domain method) parses the body via `parsers/*` (imported through the `server-parsers.ts` barrel), validates shape, and resolves IO-bound harness/profile data via `parsers/runtime-harness-resolver.ts`.
3. Turn dispatch chooses a transport via `broker-decisions.ts`: interactive-tmux broker, headless broker, or headless SDK executor. Broker routes go through `HarnessBrokerController`; the controller persists the start graph and drives the broker client; broker invocation events are mapped back through `broker/event-mapper.ts` into HRC events/state and persisted via `hrc-store-sqlite`.
4. "Awaiting user input" is modeled as a first-class durable bracket (`ask-bracket.ts`) so the active-run reaper never kills a turn parked on a user question.
5. tmux runtimes survive `hrc server restart`; on restart, `startup-reconcile.ts` + `replay-spool.ts` reconcile and the durable broker controller is eager-warmed.

---

## 4. Module-shape invariants the repo enforces

**Validation bar (root `package.json` scripts + AGENTS.md "Validation"):**
- `bun run typecheck` (per-package `tsc --noEmit`)
- `bun run test` (hrc-server uses `bun test --timeout 10000`; broker tests want `TMPDIR=/tmp` to dodge the macOS Unix-socket path-length limit)
- `bun run lint` / `bun run lint:fix` (biome)
- `bun run check:boundaries` and `bun run check:manifests`
- `bun run build` (`tsc`)
- Installed-binary bar: `just install`, restart the real launchd daemon, and smoke `hrc --help`, `hrc server status`, and at least one real read-only API/CLI command. `just install` prepares an immutable release and atomically advances the shared `hrc`/`hrcchat` indirection; see [Atomic HRC CLI installs](atomic-install.md). After source changes, install before restarting the launchd service.

**Boundary invariant (`scripts/check-boundaries.ts`):** the repo is split into an **ASP layer** and an **HRC layer**. HRC source (`hrc-*`, `agent-action-render`, `hrc-frame-render`) **must not** import `acp-*`, `gateway-discord`, `gateway-ios`, `coordination-substrate`, `wrkq-lib`, or `wlearn`. HRC may import ASP `spaces-*`/`agent-*` packages by name, pinned to exact versions in `package.json`. The ASP layer must not import HRC. A cross-layer import (or an HRC test asserting an ASP-source invariant) is a split violation.

**File-size ceilings (enforced as the package's refactor bar):**
- No parser file exceeds **1,000 lines** (largest current parser, `parsers/runtime.ts`, ≈530 — satisfied).
- No newly-created hrc-server source file exceeds **1,500 lines**. Pre-existing modules above this — `broker/controller.ts` (≈2,462), `startup-reconcile.ts` (≈1,563), `index.ts` (≈1,518) — are the known large surfaces that predate the ceiling; the ceiling constrains new files, not these legacy ones.

**Command set (CLIs that drive this daemon):** `hrc` (operator CLI, `packages/hrc-cli`) and `hrcchat` (directed-messaging CLI, `packages/hrcchat-cli`). The daemon's own surface is the Unix-socket HTTP API enumerated by the exact-route map in `index.ts`.

---

## 5. Current coupling seams (factual, not aspirational)

These are the seams that exist today, recorded as current state:
- Domain handlers are attached to a single `HrcServerInstance.prototype` via `Object.assign` and are typed against the broad `HrcServerInstanceForHandlers` context with `any`-typed `HandlerMethod` aliases. This is the working split.
- Route ownership lives in `index.ts`'s `exactRouteHandlers` map (route aggregation is centralized, not domain-owned), with `runtime-list-adopt-handlers.ts` as the one domain registered via a route factory.
- `broker/controller.ts` remains a single multi-responsibility class and is the broker control surface.

These seams are stated as facts of the shipped system; this document does not prescribe their evolution.
