# The praesidium kernel: one surface for every agent

Status: r1, 2026-11-01, draft for Daedalus review. Companion to `praesidium-document.md` r2.2 (T-12244, APPROVED as a design), which it amends in three places (§4) and otherwise adopts whole. **Not for implementation.** Lance ruled 2026-11-01 that the intent is for every agent (mable, clod, cody and the rest) to migrate off the individual wrkq, wrkc and hrc surfaces onto one standard, and asked whether to derisk that by leaving the existing systems as they are and building a separate praesidium kernel. This record answers yes to the separate kernel and no to "replace them all" as a commitment: **surfaces are replaced; stores are strangled by rule.** Owner mable@hrc-runtime:primary. Facts are from source and live reads of 2026-11-01 ~21:30Z.

## 0. Claim

The taxonomy record unifies what is *read*: one cardo document, `praesidium`, projecting nine subjects from three systems under one vocabulary. It was written for one reader, Loggia, and hosted inside rusthrc on that assumption. With every agent as a consumer, two things change:

1. **The host moves out of rusthrc.** The surface every agent's tools run through must not share a process with the daemon that births, rotates and restarts those agents. It becomes its own kernel, the idiomatic cardo shape (foundry-kernel, raspd's aspd kernel, rusthrc's hrc kernel, cardo-proof each host their own), one per node, reading HRC the way the record already reads peers.
2. **The record gains the half agents use.** A document answers "what is the current situation"; an agent also writes, reads history and bodies, waits, and must be *who it is* in every ledger row. That is an operation catalog with caller identity, served as generated tools. cardo already has the mechanism: discovery generates agent tools from declarations, and `cardo-agent` serves durable tool outcomes on an `agent.sock` beside `kernel.sock`, as foundry-kernel does today.

The owners stay as they are. wrkq, HRC and agent-spaces keep their stores, APIs, fences and authority. Agents stop calling them. New registers are born in the kernel so the owners stop growing. An old register moves only by a per-subject ruling that deletes the old path in the same campaign.

## 1. Today, verified 2026-11-01

- **Agent surface.** Prompts and skills under `var/agents` reference **168 distinct** `wrkq|wrkc|hrc <verb>` forms across **154 files, 1,226 references**. Heaviest: `wrkq cat` 88, `wrkq comment` 73, `wrkq set` 68, `wrkq touch` 29, `wrkq monitor` 27, `wrkq find` 10, `wrkq handoff` 9; `wrkc say` 89, `wrkc inbox` 21, `wrkc log` 18; `hrc monitor` 92, `hrc runtime` 48, `hrc server` 30, `hrc start` 27, `hrc turn` 24, `hrc run` 23. The injected `wrkq info` / `wrkc info` guides hand-encode the same syntax.
- **Agent identity today is environment.** wrkq takes the principal from the runtime and the scope from `HRC_SESSION_REF` (or `--as` / `--scope-ref`); over the wire it is `X-Wrkq-Principal-Ref` plus the node bearer token (`internal/workrpc/remote_stdio.go:146–152`), and scope rides as request params (`created_by_scope_ref`, `requester_scope_ref`, `claimed_scope_ref`, envelope `from_scope_ref`). `wrkq rpc --stdio` is a frame forwarder to wrkqd's HTTP JSON-RPC endpoint; a client can speak that endpoint directly. The method catalog (`rpc.initialize {protocolVersion: "2026-06-30"}`) lists **~130 `wrkq.*` methods** across attachment, comment, container, envelope, handoff, history, index, monitor, project, projectEvent, promise, relation, room, search, task, webhook, workflow, plus the `wrkf.*` family.
- **cardo's wire carries no caller.** A `KernelCommand` is `{operation, arguments, persistence?, cause?}`; a `TargetFence` is document, session token, revision or read predicates (`cardo-runtime/src/service/contracts.rs:95–142`). Identity, if any, is an argument the operation declares. `OperationDeclaration` carries `effect: read | write` ("the conservative answer for a tool generator"), `fences`, `idempotency {field, horizon_s}` and `reports_catch_up` (`cardo-core/src/registry.rs:249–300`); discovery lists every operation and `agent_tools()` generates tools from it (`docs/cardo-wire-v2.md:89, 426`; `cardo-ecosystem-contract-v1.md:71`).
- **The foundry pattern.** `foundry-kernel/src/agent.rs`: a `cardo_agent::HostExecutor` over the product's writes, served on `<runDir>/agent.sock` beside `kernel.sock`; the catalog is the tool table's `write` entries (reads stay plain `kernel.sock` calls); the provider runs an operation as a `kernel.sock` client with `operation_key = action_id`, so the effect and its receipt commit in one transaction; startup is recover → prune → bind. `cardo-agent` also hosts the delegated configured-MCP cycle for Codex (`configured_mcp.rs`): durable admission, one serial dispatch slot, a completion acknowledgment that precedes model visibility.
- **MCP provisioning is agent-spaces', not HRC's.** raspd composes `mcpServers` / `mcp_servers` into each harness home at compile (`crates/raspd/src/compile/stage.rs:898–917`, `compile/codex.rs:680, 917–988`); the Claude and Codex harness adapters carry them. **Nothing in hrc-native mentions MCP.** HRC sets `HRC_SESSION_REF` in the runtime's environment.
- **HRC's HTTP surface** already exposes what the hrc verbs use: `/v1/sessions/{page,get,resolve,metadata,annotations,annotations/act,annotations/delete,attention,facets,by-host}`, `/v1/runs`, `/v1/turns`, `/v1/runtimes`, `/v1/events/{page,tail,head,bounded-stream,latest-by-session}`, `/v1/inputs/:id{,/watch}`, `/v1/interrupt`, `/v1/status`, `/v1/presentation/*`, and the federation routes (`/v1/federation/{health,locate,establish,…}`) under the peer allowlist. Summon and send route to local sessions only (record §1.3).
- **Daemons.** Every fleet daemon is `com.praesidium.<name>` under launchd with a run dir `var/run/<name>/` (aspd, raspd, rusthrc-server, hrc-mail-injector, acp-server, taskboard-server, foundry, jobhunt-kernel, signal-pipeline.kernel). Parity is `sourceCommit` through `just fleet-status`. An unsupervised daemon dies silently (aspd, 2026-09).
- **Everything in the taxonomy record §1** stands: the cardo registry is host-wide, keyed-parent upsert landed, the subscriber queue is shared across documents, `document.open` takes `explicit_save`, `history.tailView` has no incarnation, `room.list` hydrates every room, `tasks.meta` has six live writers and four dead key families, 930 of 1,786 task writes since 2026-10-01 came from free seats.

## 2. Shape

### 2.1 Process

One **praesidium kernel** per node: a Rust binary in its own repo and project, a cardo host on `var/run/praesidium/kernel.sock` with a `cardo-agent` host on `var/run/praesidium/agent.sock`, state under `var/state/praesidium/` (`praesidium.cardo` snapshot, `praesidium.sqlite` own store), `com.praesidium.praesidium-kernel` under launchd, in `just fleet-status` from day one. Loggia mounts it as a new `kernels` entry; the address of the document is `praesidium:praesidium`. **It is a client of HRC, wrkqd and aspd and a dependency of none of them** (S4, §3): HRC's kernel, rotation, summon and placement never call it.

### 2.2 Documents

- **`praesidium`**: the taxonomy record's document (§3 there), persisted (`explicit_save`, 60 s and on shutdown), three feeds, stale-never-absent, `feed` node per binding, no hierarchy until the `hrc` document retires. Adopted whole except the three amendments in §4.
- **The kernel's own store** holds the registers born here (S5): `ext` for every subject and `workstream`. Keep-forever SQLite beside the snapshot; the document projects them like any other source, through a fourth binding `own` that is local and always complete. Fenced by etag, the same shape as HRC's annotation (record D8).

### 2.3 Bindings

| binding | source | note |
|---|---|---|
| `hrc@<node>`, one per HRC node **including this one** | `GET /v1/sessions/page?nodes=local` + `GET /v1/federation/runtimes` + **`GET /v1/events/page`** (the `HrcLedger` already takes a remote page unchanged; record §1.3) | one binding type for every node; max3 is not special. Needs the **remote-state projector** the record deferred (§6 there): seat state rebuilt from the page row and the events page rather than local SQLite. Catch-up and persistence per record §3.8 and D17 |
| `wrkq` | wrkqd's HTTP JSON-RPC directly, node token, one pooled HTTP client, bootstrap + `history.tailView` replay | as record §3.2, minus `ext` (now `own`); keeps the three read views and the `incarnation` on `history.tailView` (D12) |
| `agents` | `var/agents` scan + `aspc.resolveRuntimeDeclaration` | as record §3.2 |
| `own` | the kernel's SQLite | local; never stale; bootstraps first (it is the parent of nothing, so order does not matter until hierarchies) |

### 2.4 The operation catalog: the standard

Operations are the standard agents migrate to; the document is the cache in front of them. Three tiers, every one declared with `effect`, `fences`, caller arguments and, for writes, `idempotency`:

1. **Read the situation**: cardo queries over the `praesidium` document by type and key, generated as read tools from discovery (`seat.list`, `task.get`, `room.members`, `feed.status`). Answered from the snapshot; carry the `feed` state so an agent can see it is reading stale.
2. **Read history and bodies**: `effect: read` operations delegated to the owner, because record R3 and §6 keep ledgers, closed tasks, terminal envelopes and bodies out of the document and that stays true. wrkq: `task.show`, `task.catView`, `task.findListView` (`--state all`), `task.treeView`, `comment.listView`, `comment.catView`, `room.logView`, `room.membersView`, `envelope.show`, `envelope.inboxView`, `handoff.get`, `handoff.listView`, `promise.show`, `promise.ready`, `history.listView`, `search.listView`, `workflow.inspect`. HRC: `seat.get`, `seat.events` (tail / page), `run.list`, `turn.list`, `runtime.list`, `runtime.diagnostics`, `server.status`. Sweeps that the owner runs on a read (`envelope.pendingView`, `inboxView`) run as they do today, under the caller's identity, because the caller is the addressee.
3. **Write**: `effect: write` operations delegated to the owner through `agent.sock` (durable admission, receipt, idempotency key = the tool call's `action_id`, as foundry). wrkq: `task.create`, `task.update`, `task.move`, `task.claim`, `task.release`, `task.acknowledge`, `comment.add`, `container.create/update`, `room.say`, `room.join/leave`, `envelope.defer`, `envelope.withdraw`, `handoff.create`, `handoff.acknowledge`, `promise.add/renew/resolve/abandon`, `workflow.attach`, `projectEvent.post`, `attachment.add`. HRC: `seat.summon`, `seat.send`, `seat.annotation.put/act/delete`, `seat.metadata.patch`, `seat.interrupt`, `seat.restartme` (the rotation door; carries M1's handoff), `input.watch`. Own: `ext.put/delete`, `workstream.create/update`. Waits (`wrkq monitor wait`, `hrc monitor`) are read operations with a bounded timeout over the owner's wait primitive (`monitor.stateView` polling; `events/bounded-stream`), not kernel-side loops.

**Naming.** Operation names are `subject.verb` under the taxonomy's subjects (`task.create`, `room.say`, `seat.send`, `ext.put`), provider beside the name as record R2; where an owner method has the same meaning the kernel keeps the owner's verb so the mapping is mechanical (`wrkq.task.create` → `task.create`). The **parity table** (every one of the 168 CLI forms → operation, or → "human only", or → "retired") is an artifact of step 1 (§9) and the subject of gate 1; the catalog is complete when the table has no blank row.

**Not an operation.** `hrc server restart/stop`, `just install`, `hrc daemon` lifecycle, `wrkq index`, webhooks, `wrkf.*`: operator and workflow-engine surfaces, human or wrkf only. Restart authority stays exactly where the restart doctrine puts it.

### 2.5 Caller identity

Every operation carries the caller: `{principalRef, scopeRef}`.

- **Bound once per connection.** The bridge (§2.6) reads `HRC_SESSION_REF` and the principal from the environment HRC provisioned, exactly the inputs the CLIs read today, and presents them in its hello on `agent.sock` and as a query attribute on `kernel.sock`. The kernel **refuses a hello whose scope is not a live seat in its `hrc@<this node>` binding** (`unknown_caller`), and refuses a principal that is not that seat's agent. Self-asserted, as today, but now checked against the seat table, which the CLIs never do. Trust level is parity with today, not a new authority model.
- **Forwarded, never substituted.** To wrkqd as `X-Wrkq-Principal-Ref` plus the scope params the method takes, so every ledger row names the agent, not the kernel (gate 2). To HRC as the existing bearer plus the caller's scope on the request; HRC's own seat-based refusals (server restart) must see the real caller, so **HRC gains one additive change: accept a caller scope on operator routes when the bearer is the node kernel's token**, and refuses the route as it would for that seat. Until that lands, HRC write operations are not offered through the kernel.
- **`cause`.** Every command carries `{principalRef, scopeRef, taskId?, action_id}` as its cardo `cause` (wire v2 §12), so receipts and the kernel's own ledger say who and why.

### 2.6 Transport: generated tools, provisioned by agent-spaces

- **`praesidium-mcp`**, a stdio MCP bridge shipped by the kernel repo: on start it reads discovery over `kernel.sock`, generates one tool per declared operation (read tools over `kernel.sock`, write tools over `agent.sock`), and refreshes on registry change. Tool descriptions come from the declarations' `description` fields, which replace the injected `wrkq info` / `wrkc info` guides for migrated verbs.
- **Provisioned as a space.** A `praesidium-tools` space in `spaces-repo` declares the MCP server; raspd composes it into every harness home it already composes `mcpServers` for (Claude, Codex, muse). HRC changes nothing for provisioning. An agent whose spaces exclude the space keeps the CLIs; that is the migration unit (S1, gate 5).
- **Humans keep the CLIs.** `wrkq`, `wrkc` and `hrc` remain for Lance and for the transition. Whether a human-facing `praesidium` CLI replaces them later is open (§7) and out of this record.

### 2.7 Degradation and persistence

Unchanged from the record §3.8–3.9 and D17: persisted snapshot, resume at last-good, stale-never-absent, `feed` node per binding, `praesidium kernel rebuild` discards the cache. Two additions for agents: a **read tool answers from a stale snapshot and says so** (the result carries the subject's `feed` state and `cursorAt`), and a **write tool to an unreachable owner refuses `owner_unreachable {owner, since}`** rather than queueing, because the owner's fence cannot be supplied from a snapshot and a queued write would be the kernel acting later with authority it does not hold (record §3.8 rule 3).

### 2.8 Multi-node

One kernel per node. Each binds every HRC node's page, so an agent on svc sees max3's seats, with `node` on each. wrkq and `own` are per node (own stores are node-local and project only locally in rev 1; a cross-node `own` feed is §6). Agents use their node's kernel. The `hrc@<node>` binding for the local node goes over the same HTTP routes as the remote ones, on loopback.

## 3. Rules: the strangler contract

- **S1 Surfaces are replaced.** Every CLI form an agent uses gets an operation, a parity-table row, and a generated tool. Migration is per space membership. The injected guides retire per migrated verb. Fully committed.
- **S2 Stores move one subject at a time, by ruling.** A subject's identity, state, obligation or ledger register leaves its owner only when the kernel reproduces its full lifecycle (fences, sweeps, obligation discharge, federation routing), gates it, and **deletes the old path in the same campaign**. No deferred retirement. Merging daemons or stores wholesale remains unsupported (record §6, D1).
- **S3 Projection tax.** Once a register is read through the kernel, an owner change that the kernel does not project is incomplete. Each owner's definition of done gains "projected in the praesidium kernel or declared human-only".
- **S4 Dependency direction.** HRC, wrkq and aspd never call the kernel. Handoff stays in HRC (rotation injects it; record M1). The kernel is a client of all three.
- **S5 New registers are born in the kernel.** Extension and workstream are the first. A new register proposed for wrkq or HRC must say why it is not an `own` register.

## 4. Amendments to the taxonomy record

| # | record section | r2.2 says | this record says |
|---|---|---|---|
| A1 | §3.5 Hosting (RULED) | hosted inside rusthrc beside `hrc` | hosted in the praesidium kernel, its own process. Reverses the ruling under the new intent; Lance's to confirm (§7) |
| A2 | §3.2 `hrc` row, §3.3 remote seats | local binding over `HrcLedger` + local SQLite; peers by page poll, observation-only, remote-state projector deferred | one `hrc@<node>` binding type for every node over the page, runtimes probe and events page; the remote-state projector is in revision one. Operations on any seat route to its home over HTTP; the home's own local-only rules (`seat.send` on a foreign-only seat) still apply, so no remote authority is created |
| A3 | M4, M5 | workstream in wrkq (`task kind=workstream`); `ext` in wrkq with `wrkq ext put/get/list/delete` | both in the kernel's own store. wrkq keeps D12 (three read views, `incarnation` on `history.tailView`) and nothing else. The M5 writer-by-writer migration and the hash note stand, targeted at `ext.put` on the kernel; readers of moved registers (taskboard for `acp.request.rev` and `scribe`; hcs for `hcs_*`) move with them |

M1, M2, M3 and M6 are unchanged: `seat.handoff`, `seat.asks`, `seat.kind`, `seat.work` are HRC's, and the `agent` node is the scan.

## 5. Decisions

| id | decision | why |
|---|---|---|
| K1 | A separate kernel process per node, not a document inside rusthrc. | The surface every agent runs through must not share a failure domain, restart authority or release cadence with the daemon that births and rotates agents; it is the idiomatic cardo shape; it inherits none of rusthrc's eight single-document assumptions; max3 stops being special. |
| K2 | The operation catalog is the standard; the document is a cache in front of it. | Agents write, read history and bodies, and wait. R3 keeps those out of the document and that is right; delegated read-through ops serve them under the owner's own sweeps. |
| K3 | Caller identity is bound per connection from HRC's environment, checked against the live seat table, and forwarded verbatim to every owner. | Parity with today's trust (self-asserted from env) plus one check the CLIs never make; every ledger row keeps naming the agent. |
| K4 | Tools are generated from discovery and served by an MCP bridge that agent-spaces provisions as a space. | cardo already generates tools from declarations; raspd already composes `mcpServers`; space membership is a per-agent migration switch with trivial rollback. |
| K5 | Writes go through `agent.sock` with durable receipts and idempotency keys; reads through `kernel.sock`. | The foundry pattern, proven in this fleet; an uncertain write is reconciled from the receipt, never retried blind against a fenced owner. |
| K6 | A write to an unreachable owner refuses; it is never queued. | The kernel holds no authority of its own; a queued write would execute later with a fence the caller never supplied. |
| K7 | New registers are born in the kernel's own store; old ones move by per-subject ruling with same-campaign deletion. | The strangler lever without the strangler's graveyard: owners stop growing now; nothing is "retired later". |
| K8 | Humans keep the CLIs in this record. | The goal is the agent surface; a human CLI over the kernel is a separate decision with its own ergonomics. |
| K9 | The persisted document, stale-never-absent, and the `feed` node are adopted unchanged. | With agents as consumers they are essential, not optional: an agent on max3 must keep reading when mini's wrkqd blips. |

## 6. Explicitly unsupported

Merging daemons or stores; the kernel holding write authority or fences of its own; queuing writes for an unreachable owner; the kernel as a dependency of HRC, wrkq or aspd; replacing `wrkf.*`, webhooks, index or daemon-lifecycle surfaces; a human `praesidium` CLI; a cross-node `own` feed in revision one; inferring the caller from anything but the provisioned environment; projecting ledgers, closed tasks, terminal envelopes or bodies into the document (they are read-through ops); hierarchies while the `hrc` document is live; seat records (`asks`, `work`, `kind`, `handoff`) anywhere but HRC; remote send, summon or rotation beyond what the home already allows.

## 7. Open for Lance

1. **Confirm A1**: hosting leaves rusthrc. The r2.2 ruling was made under the Loggia-only assumption.
2. **Names**: repo and project id for the kernel, the daemon name, the space name. This record uses `praesidium-kernel`, `com.praesidium.praesidium-kernel`, `praesidium-tools` as placeholders.
3. **Taskboard and hcs** read moved registers (A3). They migrate to the kernel with M5/M4, or those registers stay in wrkq. This record assumes they migrate.
4. **The HRC caller-scope change** (§2.5) is a small HRC additive; without it HRC writes stay CLI-only through the first phases.

## 8. Acceptance, if built (product claims; readback from ledgers, stores, transcripts)

1. **Tool parity.** A task-scoped clod with `praesidium-tools` in its spaces and **no `wrkq`, `wrkc` or `hrc` on its PATH** takes a real wrkq task through claim, progress comments, a wrkc exchange with another seat, a handoff and completion, using generated tools only. The parity table has no blank row for the verbs it used. Transcript and ledger rows are the evidence.
2. **Identity survives the hop.** Every row that run wrote (`tasks.*_scope_ref`, `event_log.scope_ref`, envelope `from_scope_ref`, `hrc_events`) names the clod's principal and scope, never the kernel's. A hello with a scope that is not a live seat is refused `unknown_caller`.
3. **Isolation both ways.** Kill the kernel: HRC, wrkqd and every agent still on the CLIs are unaffected; agents on tools get a tool error, not a hung turn. Restart rusthrc: tool reads keep answering from the snapshot with `feed{hrc@max3}` stale; writes to HRC refuse `owner_unreachable` until it answers; wrkq writes keep landing.
4. **One model.** Loggia mounted on `praesidium:praesidium` and a tool read from an agent return the same node for the same seat, including a seat homed on svc, with no second mount.
5. **Migration unit.** One skill's verbs are moved to tools for one agent by space membership; a second agent without the space is unchanged; removing the space restores the first. One commit each way.

## 9. Sequence (if ruled)

0. Lance confirms A1 and §7; this record approved; the taxonomy record's step 0 (R4, R6 ruled; `federated-session-read` amended for the per-node page poll).
1. **Parity table** (every CLI form → operation / human-only / retired) and the HRC additive step from the taxonomy record (`seat.kind`, `seat.work`, `seat.asks` T-12239, `seat.handoff` M1), plus HRC's caller-scope route change. Both are invariant under every plan.
2. **Kernel skeleton**: repo, daemon, launchd, fleet-status; `praesidium` document with the `agents` and `own` bindings and the `hrc@<node>` binding (remote-state projector); `praesidium-mcp` with read tools; gate 3 (isolation) and gate 4 (one model, seats only).
3. **wrkq binding** (D12 read views and incarnation land in wrkq first) and the delegated read-through ops; cardo pin bump.
4. **Write ops over `agent.sock`** with identity; `ext` and `workstream` in the own store; gates 1, 2.
5. **Migration** by space: one skill, one agent (gate 5); then the drain order mable sets, heaviest verbs first; the injected guides retire per verb.
6. Loggia moves its mount; the `hrc` document retires; hierarchies declared; `hrc.*` names released.
7. M4 workstream and M5 writer migrations under their own specs; per-subject store moves only by their own rulings (S2).

## 10. Sizing, honestly

This is the largest re-platforming praesidium has attempted. Phases 1–4 are each a campaign of several task-scoped seats over days, not hours; phase 5 is a long tail across 154 files that runs while everything else proceeds. Two surfaces coexist for the whole of phase 5. The kernel becomes the critical path for every migrated agent write, where today only Loggia depends on cardo. Against that: one vocabulary and canonical keys everywhere; tools generated from declarations instead of 1,226 hand-encoded references; agents and operator reading one model with the same degradation guarantees; owners that stop growing from phase 4 on.

## 11. Revision log

- r1 (2026-11-01): first draft after Lance's ruling that every agent migrates onto the standard, and his question whether a separate kernel derisks it.
