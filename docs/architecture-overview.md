---
id: hrc-runtime/architecture-overview
title: HRC runtime architecture overview
kind: reference
authority: descriptive
status: active
visibility: internal
provenance: authored
---

# HRC runtime architecture overview

HRC (Harness Runtime Controller) is the **H** layer of the three-repo
`ASP / HRC / ACP` split. It owns the harness runtime lifecycle, event
ingest, session/run/message state, and the operator CLI (`hrc`). The old
`hrcchat` CLI is gone: its live-runtime verbs moved into `hrc` and agent
messaging moved to `wrkc` (T-07612, T-07616). It sits above agent-spaces (ASP), which materializes
agent homes/skills/prompts and provides the harness broker and the `aspd` compile daemon, and below
agent-control-plane (ACP), the external gateway (Discord/iOS) into the
collective. HRC consumes ASP packages as pinned Verdaccio dev-snapshots and
publishes a subset of its own packages back to Verdaccio for ACP.

This page describes shipped architecture, not aspiration. For the deeper
daemon module breakdown, the repo's own `docs/hrc-server-architecture.md`
remains the most detailed source; this page is the platform-docs-facing
summary plus the pieces that page does not cover (package topology, state
locations at a glance).

## The daemon: `hrc-server`

`hrc-server` is a Bun TypeScript process (`packages/hrc-server`) that runs
worktree source directly under Bun via the `"bun"` export condition — source
edits take effect on the next daemon restart with no build/install step (a
`bun run build` + atomic install is still required to update the installed
`hrc` wrapper, since it is a `bun link`ed artifact). It is
managed by launchd:

- Launchd label: `com.praesidium.hrc-server` (`ProgramArguments: hrc server serve`)
- Unix socket: `/Users/lherron/praesidium/var/run/hrc/hrc.sock`
- State DB: `/Users/lherron/praesidium/var/state/hrc/state.sqlite`
- Logs: `/Users/lherron/praesidium/var/logs/hrc-server.{log,err.log}`

The daemon exposes a **Unix-socket HTTP API** (`/v1/*`, roughly 120 exact
routes) and owns: runtime orchestration (headless and tmux), driving the
Harness Broker, tmux pane management, event ingestion from broker envelopes
(hook, OTEL and launch-callback ingest were retired in T-08566), presenting
addressed wrkq mail to seats, and the federation peer surface.

### Module topology (`packages/hrc-server/src`)

- `index.ts` — bootstrap (`createHrcServer`), the `HrcServerInstance` class
  shell, and **route aggregation only**. It builds an exact-route map keyed
  by method+path and a small set of prefix matches; it does not implement
  handler behavior.
- Domain handler modules (`*-handlers.ts`, e.g. `app-session-handlers.ts`,
  `broker-interactive-handlers.ts`, `broker-headless-handlers.ts`,
  `sdk-turn-handlers.ts`, `runtime-control-handlers.ts`,
  `selector-message-handlers.ts`, `selector-wait-handlers.ts`, …) export
  method bags that are `Object.assign`-ed onto the instance prototype. Each
  owns one domain's behavior; `index.ts` only aggregates.
- `broker/controller.ts` plus `broker/controller/*` — `HarnessBrokerController`
  (~6,800 lines across the split modules): broker client/session lifecycle, admission and
  capability checks, start-graph persistence (runtime plans → runtimes →
  runs → invocations), tmux/headless substrate allocation, and terminal/crash
  transition handling.
- `parsers/` — request-body/query parsing, split by domain
  (`runtime.ts`, `runtime-dispatch.ts`, `runtime-intent.ts`,
  `app-sessions.ts`, `bridges.ts`, `command-runs.ts`, `messages.ts`,
  `provision.ts`, `sweeps.ts`), plus `runtime-harness-resolver.ts` for the one parser that
  does filesystem IO. `server-parsers.ts` is a thin re-export barrel.
- `launch/` — callback spooling and tmux environment hygiene. The
  launch-wrapper hook, OTEL and artifact plumbing was retired in T-08566.
- `agent-spaces-adapter/` — the seam onto `aspd`: `compileBrokerRuntimePlan`
  and per-request Unix-socket clients (`aspc.hello` /
  `aspc.compileHarnessInvocation`); HRC holds no resident ASP process.
- `wrkq/` — the wrkq ledger client (mail presentation, receipts, room reads
  and says, project events) and the session/turn project-event publisher.
- Persistence lives in the sibling package `hrc-store-sqlite` (migrations +
  repositories), opened by `hrc-server` at `state.sqlite`.

## Package topology (10 packages, built in dependency order)

| Package | Role |
| --- | --- |
| `agent-action-render` | Shared rendering semantics for agent tool/action lines (tool emoji, action lines, admission labels) — shared with ACP's gateway-discord |
| `hrc-core` | Runtime/session/run DTOs, HTTP contracts, errors, path resolution, monitor condition engine |
| `hrc-events` | Canonical HRC event payload types, Zod schemas, and the monitor event schema |
| `hrc-store-sqlite` | SQLite migrations + repositories for HRC state |
| `hrc-capture-verifier` | Capture verification |
| `hrc-sdk` | Typed client (`HrcClient`) for the HRC daemon over the unix socket |
| `hrc-frame-render` | Projects HRC lifecycle/message events into RenderFrames/timeline |
| `hrc-server` | The daemon: Unix-socket HTTP API, launch/control, tmux/headless/broker orchestration |
| `hrc-cli` | `hrc` operator CLI |
| `hrc-transcript-index` | Resident FTS5 projection and search over HRC transcript turns |

## The three transports

Turn dispatch chooses a transport per-turn via `broker-decisions.ts`:

- **Interactive-tmux broker** — drives a real tmux pane; survives
  `hrc server restart`.
- **Headless broker** — runs agents without a TUI; events flow back as broker
  envelopes, as on the interactive route.
- **Headless SDK executor** — a third, non-broker execution path for
  programmatic headless turns.

Broker-routed turns go through `HarnessBrokerController`, which persists the
start graph and drives the broker client; invocation events are mapped back
through `broker/event-mapper.ts` into HRC events/state.

## Target handle grammar (summary)

HRC identifies agent sessions with a shorthand **target handle**:

```
agentId[@projectId[:taskId[/roleName]]][~lane]
```

The handle resolves to a canonical `scopeRef`
(`agent:<agentId>:project:<projectId>:task:<taskId>[:role:<roleName>]`, task
defaulting to `primary`) and `sessionRef` (`<scopeRef>/lane:<lane>`). See
`hrc-runtime/target-handles` for the full grammar, resolution rules, and
examples.

## "Awaiting user input" bracket

A turn parked on a user question is modeled as a first-class durable
bracket (`ask-bracket.ts`), which is the reaper authority — this is what
prevents the active-run reaper from killing a turn that is legitimately
waiting on a human/agent response.

## System boundaries (what HRC is NOT)

Enforced by `bun run check:boundaries` (`scripts/check-boundaries.ts`):

- **Not agent composition.** HRC does not materialize agent homes, skills,
  prompts, or harnesses — that is agent-spaces (ASP). HRC consumes ASP only
  as Verdaccio dev-snapshot pins; there is no source-level cross-repo
  import.
- **Not the external gateway.** HRC does not talk to Discord/iOS — that is
  agent-control-plane (ACP). HRC source must not import `acp-*`,
  `gateway-discord`, `gateway-ios`, `coordination-substrate`, `wrkq-lib`, or
  `wlearn`, and must not assert ACP-source invariants even in tests.
- **Not the task store.** HRC does not own tasks, handoffs, comments or
  conversations — that is wrkq. HRC reaches wrkq only through its ledger
  client (`packages/hrc-server/src/wrkq/`): it presents addressed envelopes
  to seats and records presentation or failure, reads and posts room
  messages, and publishes session/turn project events. HRC source still may
  not import `wrkq-lib`.
- **Not the workflow engine.** Scheduling/runs/effects belong to wrkf; HRC
  executes individual agent turns, not the workflow orchestrator.
- **Not a PTY multiplexer.** HRC drives real tmux panes by shelling out to
  `tmux`; it does not implement the terminal multiplexer.
- **Not the Ghostty actuator.** The viewer, now shipped from ACP, alone
  drives Ghostty through `ghostmux`; hrc publishes presentation facts and never
  touches a surface.
- **Not a headless agent SDK.** Programmatic agent-turn scripting is
  `@praesidium/agent-loop`; HRC is the local daemon those flows ultimately
  reach.

## Module-shape invariants

- No parser file exceeds 1,000 lines.
- No `hrc-server` source file exceeds 1,500 lines. The files once
  grandfathered (`broker/controller.ts`, `startup-reconcile.ts`, `index.ts`)
  have since been split below it. Neither ceiling is enforced by a check.
- Validation bar: `just verify` (env-up, architecture records, `check` —
  which runs the boundary, manifest, dependency-pin and other repository
  checks — lint, typecheck, test), then an installed-binary smoke (`just install`, restart the real launchd
  daemon, `hrc --help` / `hrc server status` / one real read-only command).
