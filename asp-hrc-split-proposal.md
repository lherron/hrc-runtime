# ASP/HRC Split Proposal

Status: exploratory proposal; not ratified architecture.

This document inventories the current HRC packages and proposes a package
boundary that separates durable runtime authority from node-local process and
resource ownership.

## As-is package inventory

### `hrc-core`

- HRC domain and HTTP contracts
- Runtime/session/scope selectors
- Generation and context fences
- Error vocabulary
- Runtime-intent assembly
- Federation, mail, monitor, and event DTOs
- Path and project-registry helpers

Current issue: stable contracts are mixed with policy and ASP-derived runtime
intent. The package also depends on `spaces-config` and `spaces-runtime`.

### `hrc-server`

- Unix-socket HTTP daemon and service lifecycle
- Scope, session, runtime, and generation orchestration
- Federation placement, binding, summon, and retirement
- Participant registration, attachment, succession, and activation
- ASP compilation and toolchain selection
- Broker admission, dispatch, submissions, and event handling
- Tmux allocation and presentation
- Process launch, liveness, stop, and reap
- Startup and periodic reconciliation
- Hook, OTEL, and external event ingestion
- ACP event bridge and mail-kicker integration

Current issue: durable authority, process ownership, protocol control,
reconciliation, and integration concerns converge here.

### `hrc-store-sqlite`

- Schema and migrations
- Sessions, runtimes, runs, launches, and events
- Broker invocations and submissions
- Participant registrations and host bindings
- Federation requests and observations
- Claims, watches, and delivery state
- Transcript and tool-result storage
- Legacy mail persistence

Current issue: authority records and local process/resource observations share
one undifferentiated persistence package.

### `hrc-sdk`

- Typed HRC client
- Unix-socket discovery and transport
- Scope resolution
- Project-placement helpers
- Shared client response types

Current issue: scope/profile resolution imports ASP configuration behavior
instead of remaining a pure HRC client.

### `hrc-cli`

- Operator command registration
- Server and release lifecycle
- Runtime, scope, turn, federation, and monitoring commands
- Broker verification and capture inspection
- Terminal rendering and wait/watch behavior
- Release GC and worktree helpers

Current issue: the package is described as a thin SDK wrapper, but directly
depends on `hrc-server`, `hrc-store-sqlite`, ASP configuration, and ASP
execution.

### `hrc-mail-kicker`

- Collaboration-envelope presentation policy
- Cold-start and wake decisions
- Runtime delivery and retry
- Ledger-tail processing
- Terminal/failure handling
- Stranded-delivery diagnostics

Current issue: execution policy is a legitimate concern, but it consumes
runtime and broker details that should be authority projections.

### `hrc-events`

- Hook-derived event schemas
- Claude, Pi, and OTEL normalization
- Tool-output formatting
- Monitor event validation

This package is already reasonably cohesive.

### `hrc-frame-render`

- HRC event-to-frame adaptation
- Session event aggregation
- Render projection and frame types

This package is already reasonably cohesive, although its shared message types
still come from ASP.

### `agent-action-render`

- Tool/action formatting
- Admission labels
- Icons, notices, previews, and Markdown blocks

This is a cohesive shared presentation package.

### `hrc-capture-verifier`

- Provider transcript parsing
- Broker-ledger comparison
- Capture verification
- SQLite-backed verification entrypoint

This is a cohesive diagnostic package.

### `hrc-transcript-index`

- Resident transcript projection
- Turn-document extraction
- FTS5 indexing and weighted search
- Ledger-tail consumption

This is a cohesive projection package.

### `hrc-viewer`

- Per-user Ghostty presentation
- Runtime viewing and tmux attachment
- Agent theming and task labeling
- Headless viewer status

This is a cohesive sidecar, depending primarily on `hrc-sdk`.

### `hrcchat-cli`

- Compatibility redirect from retired `hrcchat` to `wrkc`

This package is intentionally minimal and retired.

## Proposed to-be package inventory

### New: `hrc-authority`

- Scope and address ownership
- Home-node and binding authority
- Sessions and generations
- Registration and reservation
- Participant attachment and succession
- Continuation selection
- Desired runtime lifecycle
- Activation and retirement decisions
- Stale-generation fencing
- Authoritative state transitions

It answers: **Who owns this address, which generation is current, and what
should exist?**

It must not import tmux, process APIs, broker clients, or ASP implementations.

### New: `hrc-runtime-host`

- Generic worker launch and rediscovery
- Tmux server, session, window, and pane leases
- Process identity and liveness observation
- Unix-socket and broker attachment
- Presentation surfaces
- Local launch receipts
- Graceful save/stop execution
- Explicit force execution
- Resource cleanup and local recovery observations
- ASP worker/toolchain endpoint selection

It answers: **What process and presentation resources actually exist on this
node?**

It must not allocate addresses, advance generations, select continuations, or
decide succession.

### Reduced: `hrc-server`

- HTTP/API surface
- Dependency composition
- Authority-to-runtime-host reconciliation
- Transaction and workflow coordination
- Scheduling startup and periodic reconciliation
- Publishing events and read projections
- Wiring federation, mail-kicker, ASP, and ACP ports

It becomes the application layer rather than the owner of every mechanism.

### Narrowed: `hrc-core`

- Pure HRC DTOs
- IDs and value types
- Error vocabulary
- Generation/context fences
- API contracts
- Authority/host command and observation contracts

Responsibilities moved out:

- Runtime-intent assembly moves to `hrc-authority`.
- ASP profile/configuration logic moves behind ASP RPC.
- Process and hosting projections move to `hrc-runtime-host`.

The package should no longer depend on `spaces-config` or `spaces-runtime`.

### Partitioned: `hrc-store-sqlite`

Initially retain one SQLite package and database, but divide repositories into
explicit responsibility groups:

```text
authority/
  bindings
  sessions
  generations
  reservations
  participant registrations
  continuation and succession

runtime-host/
  launch intents and receipts
  process observations
  tmux leases
  endpoints
  presentation resources

projections/
  events
  transcripts
  watches
  tool results
```

The runtime-host side records observations; it does not mutate authority state
directly. A later split into separate SQLite packages remains possible but is
not required for the first boundary.

### Narrowed: `hrc-sdk`

- Pure typed HRC client
- Transport and discovery
- HRC request/response DTOs

Responsibilities moved out:

- Agent-profile parsing moves to `aspd`.
- ASP placement/configuration interpretation moves to `aspd` or an explicit
  authority response.

### Narrowed: `hrc-cli`

- Parse operator intent
- Call `hrc-sdk`
- Render responses
- Manage local server installation commands where necessary

Responsibilities moved out:

- Direct store access
- Direct server implementation imports
- ASP execution imports
- Independent runtime-policy decisions

### Adjusted: `hrc-mail-kicker`

- Retains envelope delivery policy and retry
- Reads authority projections
- Requests births or delivery through authority commands
- Never launches or reaps a process directly

### Mostly unchanged

- `hrc-events`
- `hrc-frame-render`
- `agent-action-render`
- `hrc-capture-verifier`
- `hrc-transcript-index`
- `hrc-viewer`
- `hrcchat-cli`

These may receive dependency cleanup, but their responsibilities remain intact.

## Responsibility moves

| As-is location | Responsibility | To-be location |
| --- | --- | --- |
| `hrc-server` | Binding, registration, generation, continuation | `hrc-authority` |
| `hrc-server` | Tmux, spawn, PID inspection, resource cleanup | `hrc-runtime-host` |
| `hrc-server` | Participant establishment | Split: authority state machine and host realization |
| `hrc-server` | Startup reconciliation | Split: authority decision and host observation |
| `hrc-server` | Sweep/reap | Authority eligibility and host execution |
| `hrc-server` broker controller | Admission, ownership, durable receipts | `hrc-authority` |
| `hrc-server` broker controller | Socket client, hello, input, stop, event stream | `hrc-runtime-host` |
| `hrc-core` | Runtime-intent policy | `hrc-authority` or ASP RPC |
| `hrc-store-sqlite` | Mixed authority/resource records | Partitioned repository namespaces |
| `hrc-sdk` / `hrc-cli` | ASP profile/configuration parsing | `aspd` |
| `hrc-mail-kicker` | Cold-birth process knowledge | Authority command only |

## State-model consequence

The decisive change is that `runtime.status` stops carrying both desired
authority state and observed process state. Authority and host each receive a
separate state machine, with `hrc-server` reconciling between them.

```text
Authority:
reserved -> registered -> attached -> active -> retiring

Local host:
absent -> launching -> running -> exited
                    \-> unknown
```

A lost broker socket changes the local observation; it does not automatically
change address ownership. A dead managed worker may drive succession, but only
through the authority state machine.
