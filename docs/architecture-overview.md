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

This page describes shipped architecture, not aspiration: the platform-docs-facing
summary of the daemon, crate and package topology, and state locations at a
glance. For the native daemon's internals see `crates/hrc-native/README.md`.

## The daemon: `rusthrc`

Every fleet node (max3, svc, hrcdev) runs the native Rust owner, `rusthrc`
(`crates/hrc-native`, T-11893); `just fleet-status` reads it in the `OWNER`
column. There is no Bun daemon (its package was deleted in T-13157);
`just verify-bun` and `just e2e` provision an ephemeral native daemon through
`scripts/dev-env.sh`. The daemon is managed by launchd:

- Launchd label: `com.praesidium.hrc-server` (`ProgramArguments`:
  `praesidium-launch <owner exe> server serve`, where the owner exe is
  `~/praesidium/var/hrc-owner/bin/rusthrc` or, before
  `just refresh-owner-exe <node>`, the release link
  `~/praesidium/var/hrc-owner/hrc-runtime-current/bin/rusthrc`)
- Unix socket: `/Users/lherron/praesidium/var/run/hrc/hrc.sock`
- State DB: `/Users/lherron/praesidium/var/state/hrc/state.sqlite`
- Log: `/Users/lherron/praesidium/var/logs/hrc-runtime/rusthrc-owner.log`
  (`hrc-server.log` is the retired Bun owner's)

The owner runs a staged release under `~/praesidium/var/hrc-owner/`, not the
CLI release `just install` cuts over. A daemon change reaches it only through
`just deploy-max3` / `just deploy-fleet` (stage, then an authorized restart);
`hrc server status --json` reports `.release.releasePath` and
`.release.hrcBuild.sourceCommit` (`docs/fleet-deployment.md`,
`crates/hrc-native/README.md`).

The daemon exposes a **Unix-socket HTTP API** (`/v1/*`) and owns: runtime
orchestration, driving the Harness Broker, tmux pane management, event
ingestion from broker envelopes (hook, OTEL and launch-callback ingest were
retired in T-08566), the mail hook routes and session/turn project events, and
the federation peer surface. Addressed wrkq mail is presented to seats by the
separately deployed `hrc-mail-injector` (not in this repo; HRC source may not
import it).

### Crate topology (`crates/`)

- `hrc-native` — the daemon library and the `rusthrc` executable. Its
  `src/server.rs` maps each module group to the Bun module it replaces:
  `front/` (daemon entry, HTTP, telemetry), `broker/` (broker execution
  ownership, aspd compile, startup reattach, retained evidence), `projection/`
  (ledger reads and envelope projection), `turns/` (turn admission and input),
  `placement/` (placement, aspd client, federation) and `lifecycle/` (daemon
  lifecycle, restart authority, handoff, mail hooks, project-event
  publication).
- `hrc-cli` — the `hrc` command surface, linked into `rusthrc`. Its command
  graph and help text are the hand-maintained `surface.json`; the admin route
  inventory `src/admin/route-inventory.json` is hand-owned too.
- `hrc-store` — SQLite access, row shapes and event append. It owns schema
  migration (`src/migrate/`, T-12840): only the owner at boot and
  `rusthrc store migrate` migrate; every other open admits or refuses.
- `hrc-domain` — the six operator operations behind rusthrc's ops-only kernel
  provider (`hrc-kernel.sock`); seat and runtime reads belong to the
  Praesidium kernel (`prae seat`, `prae runtime`).
- `hrc-common` — shared leaf: federation config, scope-ref parsing,
  JavaScript compatibility helpers and release location.
- `hrc-pty` — per-seat pty supervisor and attach client for tmux-free seats.

`crates/README.md` holds the allowed dependency edges, enforced by
`scripts/check-rust-crate-edges.py` in `just verify`.

## Package topology (6 Bun packages, built in dependency order)

| Package | Role |
| --- | --- |
| `agent-action-render` | Shared rendering semantics for agent tool/action lines (tool emoji, action lines, admission labels) — shared with ACP's gateway-discord |
| `hrc-core` | Runtime/session/run DTOs, HTTP contracts, errors, path resolution, monitor condition engine |
| `hrc-events` | Canonical HRC event payload types, Zod schemas, and the monitor event schema |
| `hrc-sdk` | Typed client (`HrcClient`) for the HRC daemon over the unix socket |
| `hrc-frame-render` | Projects HRC lifecycle/message events into RenderFrames/timeline |
| `hrc-turn-attention` | Node-local turn attention classifier subscriber (`bunx hrc-turn-attention@<version>`, activated separately) |

## Transports

A runtime's transport is `tmux`, `headless`, `sdk` or `hrcpty` (the
`hrc runtime list --transport` values):

- **tmux** — the broker drives a real tmux pane; survives
  `hrc server restart`.
- **headless** — the broker runs the agent without a TUI; events flow back as
  broker envelopes, as on the interactive route.
- **sdk** — a non-broker execution path for programmatic headless turns.
- **hrcpty** — a tmux-free seat supervised by `hrc-pty`.

Broker births compile through aspd, persist the start graph before hosting and
launch from the frozen preparation; committed broker envelopes are projected
back into HRC events and state (`crates/hrc-native/src/server/broker/`,
`projection/`).

## Target handle grammar (summary)

HRC identifies agent sessions with a shorthand **target handle**:

```
agentId[@projectId[:taskId][/roleName]][~lane]
```

The handle resolves to a canonical `scopeRef`
(`agent:<agentId>:project:<projectId>:task:<taskId>[:role:<roleName>]`, task
defaulting to `primary`) and `sessionRef` (`<scopeRef>/lane:<lane>`). See
`hrc-runtime/target-handles` for the full grammar, resolution rules, and
examples.

## "Awaiting user input" bracket

A turn parked on a user question is modeled as a first-class durable state:
the daemon projects it as the `awaiting_input` runtime status and the
`turn.awaiting_input` event.

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
  client (`crates/hrc-native/src/server/lifecycle/`): it answers
  mail hooks, reads and posts room messages, and publishes session/turn
  project events. HRC source still may not import `wrkq-lib`.
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

## Validation bar

`just verify` (architecture records, the Rust crate-edge check, and
`just cargo-check` when Rust inputs changed; no Bun suites); `just verify-bun`
(ephemeral daemon, `check` — the boundary, manifest, dependency-pin and other
repository checks — lint, typecheck, test) when Bun/TS code changed. A CLI
change smokes after `just install`; a daemon change needs Mable's
`just deploy-max3` and a `sourceCommit` readback.
