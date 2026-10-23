# hrc-server Architecture

**Scope:** `packages/hrc-server`, the HRC daemon.

This page maps the daemon's source as shipped. It names modules and seams, not
line counts or version pins, because those go stale within days. The normative
laws (admission, boundaries, retention, release provenance) are the records
under [`architecture/`](../architecture/README.md); the platform-facing summary
is [architecture-overview.md](architecture-overview.md).

## 1. What hrc-server is

`hrc-server` is a Bun TypeScript process exposing a **Unix-socket HTTP API**
(`Bun.serve({ unix })`). It owns runtime orchestration: launching and
controlling agent runtimes (headless and tmux), driving Harness Broker
processes, broker-event projection, session/run/message state, the
`hrc_events` ledger, federation with peer nodes, and HRC's door onto the wrkq
collaboration ledger.

- The package `exports` serve TypeScript source under the `bun` condition
  (`"bun": "./src/index.ts"`) and `dist` for `import`/`types`.
- The launchd daemon runs from the **installed atomic release**, not from the
  checkout: `hrc server status --json` reports `.release.releasePath` and
  `.release.hrcBuild.sourceCommit`. A source edit reaches the daemon only
  through `just install` followed by a restart
  ([atomic-install.md](atomic-install.md)).
- `bun run test` here goes through `scripts/hermetic-test.ts --timeout 10000`.

## 2. Module topology under `src/`

Most behavior lives in flat domain modules under `src/`. Larger domains have
their own subdirectory.

### 2.1 `index.ts`: construction, lifecycle and handler composition

- `createHrcServer(options)` prepares the filesystem, takes the server lock
  (`server-lock.ts`), opens the SQLite store (`hrc-store-sqlite`), replays the
  launch spool (`replay-spool.ts`), reconciles startup state
  (`startup-reconcile.ts`) and returns a `HrcServerInstance`.
- The `HrcServerInstance` constructor starts the socket server and federation
  services (`startFederationServices`), wires the wrkq ledger client (a real
  one only from `hrc server serve`, otherwise `UnreachableWrkqLedger`), and
  starts the recurring jobs: zombie-run sweep, active-run reconcile, broker
  lease GC, the retained-evidence pass, tmux aging, session retention, the
  first-turn watchdog, the transcript indexer, foreign-home shadow teardown and
  the lifecycle-credential sweep. It then eagerly warms the broker controller
  (`brokerWarmupComplete`).
- Handlers are not defined in `index.ts`. Each domain module exports a
  `…HandlersMethods` (or `…Methods`) bag, and a single
  `Object.assign(HrcServerInstance.prototype, …)` composes them all.

### 2.2 Routing

- `server-exact-routes.ts` builds `exactRouteHandlers`, keyed by
  `exactRouteKey(method, pathname)` (`server-routing.ts`). Runtime-list routes
  come from the `createRuntimeListRoutes` factory and are added in the
  constructor.
- `server-request-methods.ts` owns `handleRequest` (request metrics) and
  `dispatchRequest`. It refuses sealed execution formats first
  (`refuseExecutionFormatAtSealedDoor`), tries the exact-route map, then a
  small set of pattern matchers from `server-routing.ts` (input watch, session
  title, runtime seat, retired launch subroutes, …).

### 2.3 The shared handler context

`server-instance-context.ts` defines `HrcServerInstanceForHandlers`, the `this`
type every handler module is written against. It is derived from the real
method-bag types plus the instance's data fields, so handlers call each other
with checked signatures. `never`-returning failure helpers are re-asserted
there to keep control-flow narrowing.

### 2.4 Domains

- **Turn admission**, `turn-admission/`: admit, plan, submit, continue and the
  admission routes. Delivery executors need an `AdmittedPlan`, and only the
  admission implementation may construct one (`createAdmittedPlan`, enforced
  by `scripts/check-admission-entry.ts`).
- **Turn execution**: `turn-dispatch-handlers.ts`, `broker-decisions.ts`
  (headless route `sdk` / `broker` / `legacy-exec`; interactive tmux route
  `broker` / `legacy-tmux`), `broker-headless-handlers.ts`,
  `broker-interactive-handlers.ts` (+ `broker-interactive-handlers/`),
  `sdk-turn-handlers.ts`, `accepted-run-recovery-handlers.ts`.
- **Runtime lifecycle**: `runtime-start-handlers.ts`,
  `runtime-control-handlers.ts` (+ `runtime-control-handlers/`: interrupt and
  terminate, broker dispose, session rotation), `runtime-io-handlers.ts`,
  `runtime-inspect-handlers.ts`, `runtime-prune-handlers.ts`,
  `seat-withdraw-handlers.ts`, `sweep-handlers.ts` / `sweep-helpers.ts`.
- **Events**: `event-handlers.ts`, `event-notification-handlers.ts`,
  `event-ingest.ts`, follow fan-out.
- **Messaging and selectors**: `target-message-handlers.ts`,
  `selector-message-handlers.ts` (+ `selector-message-handlers/`),
  `selector-wait-handlers.ts`, `messages.ts`.
- **External participants**: `external-registration-rendezvous.ts`,
  `registration-handlers.ts`, `registration-gc-handlers.ts`,
  `participant-registration-handlers.ts`, `participant-attach-handlers.ts`,
  `participant-establishment.ts`, `roster-claim.ts`, `exact-claim.ts`.
- **Federation**, `federation/`: node identity and config, the binding registry
  client and endpoint, placement policy, the peer protocol and reachability,
  the summon gate, collective history, scope-read routing.
- **wrkq**, `wrkq/`: `ledger-client.ts` (the only door HRC reads or writes
  rooms and envelopes through), the session and server project-event
  publishers, and stop-gate handlers.
- **Server lifecycle and status**: the server-stop, server-status and
  server-session method bags, `server-lifecycle-credentials.ts` and the
  restart-authority controller (T-09861), `release-provenance.ts`.
- **Startup**, `startup-reconcile.ts` (+ `startup-reconcile/`): classifies
  persisted runtimes, recovers lease identity and reattaches durable brokers.
  It logs `broker.warmup.runtime` per runtime and `broker.warmup.complete` with
  `total`, `attached` and `byCategory`.
- **Awaiting input**: `ask-bracket.ts` keeps a durable bracket around a turn
  parked on a user question, so the active-run reaper never kills it.

### 2.5 `parsers/`

Shape validation for request bodies and queries: `common.ts`, `runtime.ts`,
`runtime-dispatch.ts`, `runtime-intent.ts`, `provision.ts`,
`command-runs.ts`, `bridges.ts`, `messages.ts`, `sweeps.ts`.
`runtime-harness-resolver.ts` holds the parsing helper that does filesystem
IO, kept apart from the pure parsers. `server-parsers.ts` is a re-export
barrel that keeps the historical import path.

### 2.6 `broker/`: the Harness Broker control surface

- `controller.ts` exports `HarnessBrokerController`
  (`HarnessBrokerController.createProduction(deps)` in production). The class
  is composed from method bags under `broker/controller/` (`bc-attach`,
  `bc-close`, `bc-events`, `bc-projection`, `bc-rpc`, `bc-submission`) plus
  allocation, dispatch, lifecycle and persistence helpers.
- `event-mapper.ts` (+ `event-mapper/`) contains `BrokerEventMapper`, which
  projects committed broker envelopes into HRC events and runtime, run and
  message state. Harness evidence reaches HRC only this way: the old hook, OTEL
  and launch-callback ingest was retired in T-08566 stage 1, and
  `/v1/internal/hooks/ingest` and `/v1/internal/launches/:launchId/*` answer
  unmatched `404 Not Found` (T-11567).
- Other modules: capabilities, runtime hosting and runtime state, the
  lifecycle overlay, submission doors, turn ownership, live substrate,
  adoption root, observability.
- `offline-evidence*.ts` handles retained-evidence recovery for a terminated or
  failed broker runtime whose endpoint is gone. It runs the owning release's
  `evidence-read` mode (`harness-broker.offline-evidence/v1`), validates each
  page and projects through the mapper with `evidence_origin = 'retained'`.
  Outcomes go to `retained_evidence_outcomes`. Entry points are
  `POST /v1/capture/recover` (`hrc capture recover`) and the server's own
  passes. Operator disposal is
  `hrc runtime prune --dispose-retained-evidence --reason`.
- `runtime-exclusive-owner.ts` gives each runtime one owner shared by every live
  attach path and retained recovery. Once a retained projection has committed,
  attach refuses with `runtime_retained_evidence_projected`.

### 2.7 `launch/` and `agent-spaces-adapter/`

- `launch/`: callback client, spool and environment hygiene (`env.ts`).
- `agent-spaces-adapter/`: the seam to ASP. `compile-adapter.ts` (+ its
  admission and types modules) sends the runtime intent, including
  `selectionContext.summonDirectives`, to `aspd` and consumes the selected
  execution. `aspd-preparation-client.ts`, `aspd-observation-client.ts`,
  `aspd-execution-release.ts` and `cli-adapter.ts` are the other ASP-facing
  clients.

### 2.8 Persistence

The sibling package `hrc-store-sqlite` owns the store: `database.ts`,
`migrations.ts` + `migrations/`, `repositories/` and the per-domain
repositories (messages, sessions, participants, federation, collective
history, transcript index). hrc-server opens it with `openHrcDatabase` and
passes the `HrcDatabase` handle through the handler context and the broker
controller deps. Locate the live DB with `hrc server status --json`
(`.api.dbPath`); never type the path in.

## 3. Request and runtime flow

1. A client hits the Unix socket. `dispatchRequest` resolves an exact route,
   then the pattern matchers.
2. The handler parses with `parsers/*`. A turn goes through `turn-admission/`,
   which yields an `AdmittedPlan`.
3. `broker-decisions.ts` picks the transport. Broker routes go through
   `HarnessBrokerController`, which persists the start graph and drives the
   broker. Envelopes come back through `BrokerEventMapper` into
   `hrc-store-sqlite`.
4. On `hrc server restart`, tmux and broker runtimes survive. Startup reconcile
   classifies them and warmup reattaches the durable brokers.

## 4. Invariants and where they are enforced

- **Boundaries** (`scripts/check-boundaries.ts`): HRC packages must not import
  `acp-*`, `gateway-discord`, `gateway-ios`, `coordination-substrate`,
  `wrkq-lib` or `wlearn`. HRC talks to wrkq through its ledger client, not the
  library.
- **Admission** (`scripts/check-admission-entry.ts`): handlers cannot import
  executors or the plan constructor.
- **Daemon subprocesses** (`scripts/check-daemon-subprocess.ts`): run only
  through `runBoundedSubprocess`, with no synchronous spawn.
- **File size**: test files are capped at 1,000 lines
  (`scripts/check-test-source-size.ts`). No check caps source files.
- The full rule-to-enforcer table is [rule-enforcers.md](rule-enforcers.md).
  The validation commands are in [development-workflow.md](development-workflow.md).

**CLIs:** `hrc` (`packages/hrc-cli`) is the operator CLI. The `hrcchat` CLI is
retired: its runtime verbs moved into `hrc`, and agent messaging moved to
`wrkc`.
