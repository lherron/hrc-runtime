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
normalization, session/run/message state, and the operator/chat CLIs
(`hrc`, `hrcchat`). It sits above agent-spaces (ASP), which materializes
agent homes/skills/prompts and provides the harness broker, and below
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
`hrc`/`hrcchat` wrappers, since those are `bun link`ed artifacts). It is
managed by launchd:

- Launchd label: `com.praesidium.hrc-server` (`ProgramArguments: hrc server serve`)
- Unix socket: `/Users/lherron/praesidium/var/run/hrc/hrc.sock`
- State DB: `/Users/lherron/praesidium/var/state/hrc/state.sqlite`
- Logs: `/Users/lherron/praesidium/var/logs/hrc-server.{log,err.log}`

The daemon exposes a **Unix-socket HTTP API** (`/v1/*`, roughly 90 exact
routes) and owns: runtime orchestration (headless and tmux), driving the
Harness Broker, tmux/ghostmux pane management, hook/OTEL event ingestion,
message persistence, and the `hrcchat` directed-messaging selector surface.

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
- `broker/controller.ts` — `HarnessBrokerController`, the single largest
  module (~2,460 lines): broker client/session lifecycle, admission and
  capability checks, start-graph persistence (runtime plans → runtimes →
  runs → invocations), tmux/headless substrate allocation, and terminal/crash
  transition handling.
- `parsers/` — request-body/query parsing, split by domain
  (`runtime.ts`, `app-sessions.ts`, `bridges.ts`, `messages.ts`,
  `sweeps.ts`), plus `runtime-harness-resolver.ts` for the one parser that
  does filesystem IO. `server-parsers.ts` is a thin re-export barrel.
- `launch/` — the wrapper-process launch path for headless runtimes: hook
  callbacks, launch env, OTEL ingestion glue, launch spool.
- `agent-spaces-adapter/` — the seam onto pinned ASP `spaces-*` packages:
  `compileBrokerRuntimePlan`, the broker JSON-RPC facade client
  (`aspc.hello` / `aspc.compileHarnessInvocation` over stdio).
- Persistence lives in the sibling package `hrc-store-sqlite` (migrations +
  repositories), opened by `hrc-server` at `state.sqlite`.

## Package topology (10 packages, built in dependency order)

| Package | Role |
| --- | --- |
| `agent-action-render` | Shared rendering semantics for agent tool/action lines (tool emoji, action lines, admission labels) — shared with ACP's gateway-discord |
| `hrc-core` | Runtime/session/run DTOs, HTTP contracts, errors, path resolution, monitor condition engine |
| `hrc-events` | Hook/OTEL/SSE/Pi event normalization + schemas |
| `hrc-store-sqlite` | SQLite migrations + repositories for HRC state |
| `hrc-capture-verifier` | Capture verification |
| `hrc-sdk` | Typed client (`HrcClient`) for the HRC daemon over the unix socket |
| `hrc-frame-render` | Projects HRC lifecycle/message events into RenderFrames/timeline |
| `hrc-server` | The daemon: Unix-socket HTTP API, launch/control, tmux/headless/broker orchestration |
| `hrc-cli` | `hrc` operator CLI |
| `hrcchat-cli` | `hrcchat` directed-messaging CLI |

## The three transports

Turn dispatch chooses a transport per-turn via `broker-decisions.ts`:

- **Interactive-tmux broker** — drives a real tmux/Ghostty pane; survives
  `hrc server restart`.
- **Headless broker** — runs agents under a wrapper process; events flow via
  hooks and OTEL; does not survive a daemon restart.
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

The handle resolves to a canonical `scopeRef` (`agent:<agentId>:project:<projectId>`)
and `sessionRef` (`agent:<agentId>:project:<projectId>/lane:<lane>`). See
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
- **Not the task store.** HRC does not own tasks/handoffs/comments — that is
  wrkq. HRC only does a best-effort, read-only `wrkq cat <id> --json` to
  enrich a status bar with a task slug; it never mutates wrkq state.
- **Not the workflow engine.** Scheduling/runs/effects belong to wrkf; HRC
  executes individual agent turns, not the workflow orchestrator.
- **Not a PTY multiplexer.** HRC drives real Ghostty/tmux panes by shelling
  out to the `ghostmux` CLI; it does not implement the terminal multiplexer.
- **Not a headless agent SDK.** Programmatic agent-turn scripting is
  `@praesidium/agent-loop`; HRC is the local daemon those flows ultimately
  reach.

## Module-shape invariants

- No parser file exceeds 1,000 lines.
- No newly-created `hrc-server` source file exceeds 1,500 lines
  (`broker/controller.ts`, `startup-reconcile.ts`, and `index.ts` predate
  this ceiling and are grandfathered).
- Validation bar: `bun run typecheck`, `bun run test`, `bun run lint`,
  `bun run check:boundaries`, `bun run check:manifests`, `bun run build`,
  then an installed-binary smoke (`just install`, restart the real launchd
  daemon, `hrc --help` / `hrc server status` / one real read-only command).
