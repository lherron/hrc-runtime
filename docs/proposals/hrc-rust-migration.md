# HRC Rust migration

> 2026-10-23 adopted M1 amendment: [Rust native parity](hrc-rust-parity.md), authorized by Lance and reviewed in EN-33646/EN-33680, replaces the provisional slice-writer rollout with independently isolated native development and cohesive per-node execution-owner transfer. Standalone Bun and the delivered kernel/facades remain supported. No activation, retirement or production migration transfer is authorized. Campaign P-00866 owns P0–P8 closure.

Status: proposal r3.2, 2026-10-20 (r3.1 answers daedalus EN-32626 F1–F4: the `/v1/events/page` ledger read, a pinned side-effect-free read set, attach from the presentation read model. r3.2 answers EN-32628 F5: `contextReading` on presentation rows. r3.3: §4.6 stage 1b ops are facade calls over existing routes with no TS change, and `seat.summon` is specified first). Owner mable@hrc-runtime:primary. Campaign P-00862. **Stage 1 delivered 2026-10-20:** gate 0 T-11441 (371cc396), kernel T-11442 (8f70c9e8..5f7e1bc9), gates 0–5 graded PASS, live on max3. Cardo F7 is green; A5 (T-11426) measurements are cardo's. Summon and restart facade amendments have since landed; native parity proceeds under P-00866, beginning with the reviewed P0 baseline. No native execution-owner transfer is delivered. Lance's rulings are marked **RULED**.

r3 replaces r2.2's stage 1 and adds the repository rules:
- **One stage 1.** It merges clod@loggia's stage 0 (R-00448, EN-32603) into stage 1. The kernel reads HRC through its HTTP API through cardo's own ingest machinery, not through a read-only open of `state.sqlite` (§4).
- **One repository**, with independent native development and both-implementation compatibility qualification (§2).
- **Cardo prerequisites:** all of them are on cardo main at 1796e1c (§3).

This page owns the HRC side of the port: the repository layout, the stages, independent native development in stage 2, the compatibility contract, install and fleet, and the process budget. The cardo work lives in cardo's `docs/explorations/pre-hrc-cardo-gaps.md`, which this page cites by item number (`cardo B6`) and does not restate.

## 0. Rulings and scope

- **RULED, Q1 (T-11381): library.** HRC becomes a Rust binary that embeds `cardo-runtime`, as foundry does. Cardo hosts nothing that belongs to HRC.
- **RULED, port first and consolidate later** (Lance, 2026-10-19). Brokers, aspc and the injector do not move into the port. Brokers survive an HRC restart only because they are separate processes in leased tmux servers that reattach by `eventsSince(lastProjectedSeq)`, and there is no strategy yet for keeping them alive inside the daemon (§9).
- **RULED, gradual migration with TS fully functional** (Lance, 2026-10-20). There is no big-bang cutover. The TS daemon stays a complete daemon that can serve every route until stage 3. The adopted M1 plan qualifies native packages independently and transfers coupled execution authority together (§2.2).
- **RULED, one repository** (Lance, 2026-10-20). Rust lives in hrc-runtime beside the TS packages (§2.1).
- **RULED, facade first, then native slices** (Lance, 2026-10-20). Rust HRC starts as a facade over the working TS daemon (stages 1 and 1b), then develops native Rust packages on isolated state/substrate (stage 2), with whole-node execution-owner transfer after parity and rollback. **Stage 1b ops add no TS code and no HRC features:** each op is a client of routes that already exist, exactly as the `hrc` CLI, ACP and the mail injector use them. If an op needs something TS HRC does not offer, it waits for that slice's native Rust implementation; TS HRC does not grow to serve the facade. The three additive S1 reads that stage 1 already landed (§4.8 costs) stand.
- The process-count goal is deferred, and stated as deferred (§8). The mail injector moves with ACP, not HRC (§10).

HRC keeps everything it owns today:
- the store: `state.sqlite`, about 20 GB and about 120 migrations, with the forever ledger `hrc_events`;
- the event record: `hrcSeq` plus `ledger_incarnation_id`, and `wrkq_ledger_cursors`;
- the HTTP API on `hrc.sock`;
- federation;
- brokers in leased tmux servers, launchd supervision, and the restart doctrine.

The cardo wire is an additional socket, the mount surface for Loggia and agents. Cardo documents are derived views and never a second record.

## 1. Stages

Delivered stages are preserved. Native development is incremental; production transfer and retirement have separate gates.

| stage | what runs | writes `state.sqlite` | reversible by |
|---|---|---|---|
| 1. Kernel projector | the TS daemon, plus a Rust `hrc-kernel` that reads HRC over its HTTP API and serves the cardo wire | TS only | stopping the kernel |
| 2. Native parity | independent native daemon on isolated state/substrate; one coupled production execution owner per node | one execution owner per state/substrate, plus inventoried external tools | P8 reviewed whole-owner drain/fence/handoff to named compatible Bun |
| 3. Possible Bun retirement | separately authorized after parity and rollback | production migrations remain Bun-owned until separately transferred | outside P-00866 authorization |

Stage 1 replaces nothing. It is a new reader, so the dual-implementation rule (§2.2) starts at stage 2. ACP ports afterwards (§10).

## 2. Repository and separation

### 2.1 Layout

```
hrc-runtime/
  packages/        TS: hrc-server, hrc-cli, hrc-core, hrc-sdk, hrc-store-sqlite, … (unchanged)
  crates/          Rust Cargo workspace: hrc-domain, hrc-kernel; later native daemon/rusthrc and hrc-store
  contract/        neutral, consumed by both sides (from stage 2)
  conformance/     the black-box suite that runs against either daemon's socket (from stage 2)
```

- **No cross-imports.** `packages/` and `crates/` meet only through the HTTP API, the cardo wire and the store. Neither builds the other.
- **`contract/` is owned by neither side.** It holds the route table, request and response schemas, event kinds, and the schema version the store is at. TS and Rust either generate their types from it, or check them against it by example in the conformance suite. It starts empty at stage 1, because the kernel consumes the HTTP API as a client (plus two additive TS store reads, §4.2 and §4.3). P0 populates its inventory and qualification contracts; they do not route split production writers.
- **The inventory states compatibility obligations.** Exact/computed/pattern routes, protocols, aliases/refusals, stores, direct tools, exports, jobs and files map to cases and owning packages. It does not assign production route slices; one coupled execution owner controls the node after P8 qualification.
- **Hooks are path-scoped** through the existing `hook-scope`/`.hookignore` mechanism:
  - a TS-only change skips cargo;
  - a `crates/`-only change skips the bun suites;
  - a change under `contract/`, `conformance/`, `packages/hrc-store-sqlite/src/migrations*` or the route table runs both.
- **Seats.** Rust work runs in its own task seats. One session doesn't do both halves of a dual-implemented change unless the change is small.
- **Why not a separate repository.** The two daemons share the API contract, the store schema and the release. One commit can change both sides and the conformance suite together, and one release has one `sourceCommit` per node. Two repositories would turn each of those into a cross-repo pin that drifts. The benefits of a separate repository (build speed, clean ownership, agents that never confuse the halves) come here from the path-scoped hooks and separate seats.

### 2.2 Independent implementations and behavior drift

Complete Bun remains independently usable without Rust, with existing `hrc`, SDK and package exports unchanged. The native CLI is `rusthrc`. Ordinary Bun fixes continue; P0 refreshes source inventories, real baseline observations and release/config/producer tuples before affected Rust behavior can be graded current. A contract change is complete only after both implementations pass the affected conformance obligations; unimplemented native cases remain explicit gaps.

Production migrations stay Bun-owned. Rust refuses unknown/incomplete schemas and uses canonical Bun scratch initialization during coexistence. A named same-release Bun fallback must read and continue native-written history. A Rust migration runner is separately reviewed test-only tooling until production authority changes explicitly. Development packages are not permission to transfer execution owners or retire Bun.

## 3. Prerequisites from cardo

All of them are on cardo main at **1796e1c** (`pre-hrc` fast-forwarded and deleted, 2026-10-20, R-00450). Pin cardo from main revisions only.

| used by | cardo items |
|---|---|
| stage 1 | P1–P3; S0–S6, S8, S9; A1, A2, A4; B1 (in-process ingest worker), B3 (reset), B4 (live-set sweeps, `live_until`), B6 (`ingest_only`, `reports_catch_up`, `bootstrapping`); C4; D2; F0–F4 |
| stage 2 | C1, C3, C5, C7; D1; S7; B7 (safe read-only open, if a Rust reader opens the store before Rust owns it); F5, F6 |
| measured on the stage-1 kernel | A5 (T-11426), F7 `HrcProfile` (T-11427) |

The specs are `docs/cardo-subscriptions-v1.md` (APPROVED r3.1) and `docs/cardo-projections-v1.md` (APPROVED r2.1). Projections v1 §2 is the model stage 1 implements: `LedgerIngest<S: LedgerSource, P: Projector>`. Known cardo flake: T-11440, in the wire `subscriptions` class.

## 4. Stage 1: kernel projector

**Purpose.** It puts HRC's live state on the cardo wire for Loggia's Development workspace: the sessions list, terminal leaves and later the concierge. It also gives cardo the real-data subject that A5 and F7 wait on.

**Where it lives.** `crates/hrc-domain` (types, the projector, the attach builder) and `crates/hrc-kernel` (the binary: cardo owner, wire server, ingest binding, socket). Cardo is pinned by git rev on main (cardo A3).

### 4.1 Document

One document, `hrc`: `rebuildable: true`, durability `none`, `ingest_only: true` (cardo B6). It starts empty at every open, and nothing but ingest writes it.

| type | natural key | carries | notes |
|---|---|---|---|
| `hrc.seat` | sessionRef `(scope_ref, lane_ref)` | current hostSessionId, generation, runtimeId; agentId, projectId, taskId, lane, displayRef; status and phase; latest event kind and time; lastActivityAt; context reading; `live_until` | attachable `tmux-attach`, fence `[hostSessionId, generation, runtimeId]` |
| `hrc.runtime` | runtimeId | seat sessionRef, transport, harness, provider, status, activeRunId, supportsInflightInput, timestamps; `live_until` | within cardo S8's ring quota |
| `hrc.project` | projectId | name | colour stays in a Loggia plugin |

- **There is no sessions document.** A sessions row is one generation, so keying on hostSessionId repeats foundry's EN-30664 defect.
- **The live set** follows T-10833: seats with a live runtime, or activity in the last 24 h, latest generation per seat. `live_until` is `null` while the seat's runtime is live, and otherwise last activity plus 24 h. Cardo B4's sweep removes expired rows with no event needed. Measured 2026-10-19: 9,742 seats ever, 41 ready or busy runtimes.
- **Liveness never comes from `runs`.** Since T-11306, broker-native input mints no HRC run.

### 4.2 Source: `HrcApiLedger`, a `LedgerSource` over the HTTP API

The kernel is an ordinary `hrc.sock` client. It never opens `state.sqlite`.

**One new HRC read route: `GET /v1/events/page`.** Today's API has no read that can back a `LedgerSource`:
- `/v1/events/bounded-stream` requires `follow=true` and an expected `ledgerIncarnationId`. It replays newest-first, keeping only a bounded suffix and reporting the omitted prefix (and oversize or overflow events) as gaps. Those gaps can drop retained rows, not just deleted ones.
- `GET /v1/events?fromSeq=` without follow is ascending, but has no limit.
- `/v1/events/tail` pages backwards.

The page route is the missing ledger read. It is additive, in slice S1, which isn't ported, so it is TS only (§2.2).
- **Request:** `afterSeq` and `limit` are required. `ledgerIncarnationId` is optional. With it, a mismatch refuses `CURSOR_INVALID`. Without it, the route answers against the current incarnation, which is how the kernel initializes.
- **Answer:** `{ledgerIncarnationId, head, rows, scannedThrough}`, read in one read transaction. `rows` holds every existing row in `(afterSeq, scannedThrough]` in ascending `hrc_seq` order, with at most `limit` rows. `scannedThrough` is the last returned row's seq, or `head` when fewer than `limit` rows remain. `head` comes from `sqlite_sequence`, never `max(hrc_seq)`. A payload is returned as stored, so a spilled payload comes back as its stub and no row is omitted for its size.
- **Side effects:** none. It is a store read, and it joins the kernel's pinned read set (§4.3).

| `LedgerSource` | HRC call |
|---|---|
| `incarnation`, `head` | `GET /v1/events/page?afterSeq=<head>&limit=1` (or any page): `ledgerIncarnationId` and `head` |
| `read_after(after, filter, limit)` | `GET /v1/events/page?ledgerIncarnationId=…&afterSeq=<after>&limit=…`. `CURSOR_INVALID` is an incarnation change. The batch covers `(after, scannedThrough]` in one snapshot, as cardo subscriptions v1 requires. |
| `floor` | constant 0. A hole in `hrc_seq` is a deletion, never a skipped retained row (§6.3). A key whose only event was deleted unread is recovered by the resync pass (§4.4). |
| `wake` | a thread following `/v1/events/bounded-stream?follow=true&ledgerIncarnationId=…&afterSeq=…`. The stream is used only as a wake: its rows, gaps and windows are never read as ledger content. A refusal or `ledgerReplaced` re-reads the incarnation from the page route. |
| `fence_database` | `None`. The kernel is never a must-see consumer. |

### 4.3 Projector: `SeatProjector`

Events name keys, and the projector re-reads their current state (projections v1 §2). It never folds deltas.

**The read set is side-effect-free and pinned.** "Read-only" means a read can't change HRC's state, not just that it uses `GET`. `/v1/runtimes` and `/v1/attach` reconcile tmux liveness while reading, and can mark a runtime dead or retire a broker substrate (T-07594). The kernel never calls them. It reads only:
- `/v1/events/page` (§4.2);
- `/v1/events/bounded-stream` (as a wake);
- `/v1/events/latest-by-session`;
- `/v1/events/tail` with exact `hostSessionId`, `generation`, and `limit=10` per page: `category=turn` reverse pages recover display selection; a separate unfiltered ten-event window supplies selected tool-result formatting context (T-11490);
- `/v1/presentation/runtimes`, the store-only presentation read model (`hrc-runtime.viewer-presentation-sidecar` §5.3–5.4);
- `/v1/sessions`;
- POST `/v1/presentation/seats/read`, the batched keyed store read adopted after A5 (T-11451).

A test in the style of `t07594-side-effect-free-reads` pins this set against a dead-substrate seed, with the `/v1/runtimes` control, and adds `/v1/events/page` and `/v1/sessions` to the asserted routes (gate 0, §4.8). Presentation rows can name a runtime whose tmux has died until HRC's own sweep marks it. The viewer already accepts that window, and the kernel accepts it too.

- **`bootstrap`** first samples the cursor `at` (incarnation plus head, from the page route), then reads the live set:
  1. `/v1/sessions` with sessions updated in the last 24 h, latest generation only;
  2. `/v1/presentation/runtimes`;
  3. `/v1/events/latest-by-session`.
  These state reads cover the live set; display selection and formatting use the tails below. Sampling `at` before reading state means anything that changes during the read is replayed after it.
- **`apply`** maps each row to keys: its sessionRef, and for a runtime-scoped row its runtimeId and that runtime's seat. It removes duplicates within the batch, re-reads each key in one POST `/v1/presentation/seats/read` with `{sessionRefs, runtimeIds}`, and emits upserts or `remove_by_key`. The response contains the window-selected latest-generation sessions (plus quiet runtime-named seats), presentation runtimes, and latest events for those sessions. The unchanged projection derives the touched project rows. Apply indexes the bounded result once; bootstrap and resync retain the full read.
- **Latest event previews (T-11490, EN-33174 amendment).** `latestEvent` selects the newest `turn.*` event by hrcSeq within the selected hostSessionId and generation, at or below the newest raw owner event's seq. Bookkeeping cannot displace that display event. `lastHrcSeq`, `lastActivityAt`, membership and cursor progress keep their existing raw-event sources and freshness exclusions. No turn in that generation means no `latestEvent`; an older generation cannot supply a preview.
  - Bootstrap, apply and resync recover display selection through the existing exact-host-session/generation tail with `category=turn` and `limit=10` per page. Category `turn` also includes `broker.turn.origin` and `command_run.*`, so filter the `turn.` eventKind prefix locally and ignore candidates newer than the raw event. Choose the newest eligible turn on the first page containing one. If none is present and `truncated=true`, request an older page with `beforeHrcSeq` equal to the minimum admitted seq and the returned `ledgerIncarnationId`. The reverse cursor strictly decreases; stop on a real turn or exhausted history. Incarnation mismatch fails the read rather than becoming evidence of no turn. Ten bounds each page, not the whole search; no history is retained between projection calls.
  - For a selected tool result, a separate unfiltered ten-event tail for that exact host session and generation supplies formatting context only, with candidates fenced at the selected turn's seq. It cannot change display selection, freshness or cursor progress. Match a result to a tool call by tool-use ID; when absent use the nearest preceding call in the same run, as HRCMac does. Calls beyond that context window fall back to the result payload/tool name. Emit optional nonempty `latestEvent.preview` using HRCMac's payload field precedence, whitespace collapse, result prefixes and 180-character truncation. No projection state is retained, and no HRC server behavior or restart is added.
- **The presentation row gains `contextReading`.** It is an additive, optional field: the runtime's persisted `runtimeStateJson.contextReading`, exactly as stored, and absent when there is none. That is the reading `hrc-runtime.runtime-context-reading` keeps on the runtime across restart and invocation retirement, and the one ACP's `projectContextReading` (`mobile.ts:107`) reads. The route stays a store read. This is the second TS change, in the same unported S1 slice.
- **`hrc.runtime` carries what the presentation row carries:** status, generation, the presentation record, the tmux attach target, `contextReading`, title, and identity and metadata. Fields only `/v1/runtimes` returns (transport, provider, activeRunId, supportsInflightInput) are left out of stage 1 rather than read through a reconciling route.
- **Phase and context.** These follow ACP's `projectSession` (`mobile.ts:537`) as it is today. Phase text comes from the latest event and the session record. The seat's context reading is the seat runtime's persisted `contextReading` from the presentation row, validated as `projectContextReading` validates it. It is never folded from an earlier `runtime.context.updated` event, so a bootstrap after that event has scrolled past still shows it. The port is a translation, not a redesign. Gate 2 diffs the two outputs on the live set.

### 4.4 Ingest wiring

`LedgerIngest<HrcApiLedger, SeatProjector>` is registered with `CoreAdapter::in_process_worker` (cardo B1).
- It declares `reports_catch_up`, so the document carries `bootstrapping`, which Loggia can show until the first catch-up.
- `resync_every` is 10 minutes. Each pass is one bootstrap, about a hundred seats.
- The cursor lives in the document's `cardo.ingest_cursor` node. An incarnation change answers `{"reset": true}` and the binding bootstraps (cardo B3).
- What cardo supplies and the product doesn't write: never-skip replay, reset, sweeps, resync convergence and `bootstrapping`.

### 4.5 Attach

`resource.attach` on `hrc.seat` builds the cardo descriptor `{socket, target, argv, mode}` from the seat runtime's presentation row `tmux: {socketPath, attachTarget}`, following foundry-kernel's `attach.rs` for argv and mode. The kernel never parses `tmux_json` or `runtimeStateJson` itself.

HRC fills that block with the same resolvers `/v1/attach` uses (`getBrokerRuntimeTmuxSocketPath`, `getBrokerRuntimeTmuxAttachTarget`), so every shape HRC supports is covered:
- legacy `tmux_json` runtimes;
- durable broker leases with the `:tui` target;
- the codex-app-server flat shape, whose lease lives in `runtimeStateJson`.

A runtime whose presentation row has no `tmux` block (not operator-attachable) refuses `resource_unavailable`. That is the same answer HRC's own attachability rule (`canOperatorAttach`) gives.

### 4.6 Ops (stage 1b): facade calls over existing routes

Kernel ops (`fences_on: none`, no `document_id`) that call the TS daemon's existing HTTP API. They write nothing to the document: row updates arrive back through ingest. **No op adds or changes TS code or HRC routes** (§0). Each op names the existing caller whose request it copies, so the kernel is a third client of a shape HRC already serves, never a new one.

| op | existing routes | copies | fence or key |
|---|---|---|---|
| `seat.summon` | POST `/v1/declarations/resolve` (by scope), then POST `/v1/runtimes/start` (claim-and-start) | the mail injector's by-scope resolve; ACP `buildMobileStartRequest` | caller `request_id` → idempotencyKey |
| `seat.input` | dispatch / active-run contribution | ACP mobile input | `{expectedHostSessionId, expectedGeneration}` plus idempotencyKey |
| `seat.interrupt` | `/v1/interrupt` | ACP mobile interrupt | runtimeId |
| `seat.restart` | the T-10850 restart | HRCMac restart | `expectedGeneration` (refuses STALE_CONTEXT) |
| `seat.reset` | `/v1/clear-context` | `hrc` CLI | no generation fence; a double reset is unsupported |

`seat.summon` ships first, because Loggia is not usable day to day without it. The others follow the same pattern and are specified when dispatched. Raw keystroke input (`SendWindowLiteralInputRequest`) has neither a fence nor a key, and is not an op.

#### 4.6.1 `seat.summon`

**Args:** `{session_ref, fresh, request_id}`. `session_ref` is `agent:<a>:project:<p>:task:<t>/lane:main`. `fresh` is false unless the operator asked for a new seat. `request_id` is minted by the caller once per logical summon and reused on every retry of it.

**Steps:**
1. POST `/v1/declarations/resolve` with `{scopeRef, runMode: 'task', interactive: true, preferredMode: 'headless'}`. This is the by-scope arm (`ResolveRuntimeIntentByScopeRequest`): the daemon resolves placement, agent sources and the declaration itself, as it does for the mail injector. The kernel resolves no paths.
2. Take the returned `intent`, and set `placement.correlation.sessionRef` to the summoned seat, as the CLI's `buildManagedRuntimeIntent` does.
3. POST `/v1/runtimes/start`:
   - `fresh: false` → the exact shape: `{sessionRef, runtimeIntent, conflictPolicy: 'reject', summonIntent: 'implicit', idempotencyKey, restartStyle: 'reuse_pty'}`.
   - `fresh: true` → the suffix shape: `{baseSessionRef: sessionRef, runtimeIntent, conflictPolicy: 'suffix', summonIntent: 'implicit', idempotencyKey, restartStyle: 'reuse_pty'}`.
   - `idempotencyKey` is `hrc-kernel-summon-<request_id>`, so a lost-reply retry converges on the same claim.
   - `summonIntent: 'implicit'` lets HRC decide the seat's home node, so a pinned scope starts on its own node through federation, as it does from ACP.

**Receipt:** `{session_ref, host_session_id, runtime_id, status, replayed}`, with `session_ref` taken from the start response's `claim`, never from the args (a suffix start claims `<task>-<suffix>`).

**Refusals:** HRC's error is returned as the op's error, with `{hrc_code, message}` in details and nothing retried by the kernel. `session_scope_occupied` (exact shape, live seat) is an expected answer, not a fault.

**What the caller does, not the kernel.** The kernel never checks for an existing seat: the caller (Loggia) reads the `hrc.seat` row it already has and attaches if it is live and attachable, and calls `seat.summon` only otherwise. The attach then follows the claimed `session_ref`'s row through ingest (§4.5); summon returns no descriptor.

**Explicitly unsupported in 1b:**
- attaching a seat that HRC homed on another node. The start succeeds there, no local row appears (§4.7, local node only), and the caller times out with a message that names remote homing as a possible cause;
- summon while `hrc.sock` is down, beyond returning HRC's transport error;
- two hosts summoning the same scope at once. HRC's claim and idempotency rules decide; the kernel adds nothing.

**Gates (stage 1b, summon):**
1. **No TS change:** `git diff <dispatch base>..<landing> -- packages/` is empty.
2. **Cold seat:** summoning a seat with no live runtime starts it, and its row becomes attachable through ingest. HRC's events show one `runtimes/start` for the `request_id`.
3. **Retry:** the same `request_id` sent twice yields one runtime and the same claim, the second with `replayed: true`.
4. **Fresh:** `fresh: true` on a roster lane claims a suffix seat and returns its `session_ref`.
5. **Parity:** for the gate-2 seat, the started runtime's harness, project root and cwd equal `hrc start <scope> --dry-run --json`'s preview for the same scope.

#### 4.6.2 `seat.restart` (T-11496)

Architecture: APPROVED by Daedalus, 2026-10-22, EN-33147; recorded in
`architecture/contracts/hrc-rust-migration.yaml` (`hrc-runtime.rust-migration`).

Kernel-scoped, `fences_on: none`, no Cardo idempotency receipt or document fence.
Input is `{host_session_id, expected_generation}` from the selected seat row;
unknown fields (including `force`) and empty IDs or negative/noninteger generations
refuse before HTTP. The generation is an HRC semantic fence, not a document revision.
Call existing POST `/v1/sessions/restart` once with
`{hostSessionId, expectedGeneration}`. No resolve, server change or retry.
HRC owns freshness, home authority, idle probing, rotation and relaunch. Busy,
unobservable and stale refusals retain the HRC code/message in typed op errors.
Return `{prior_host_session_id, host_session_id, generation, launch}` from HRC.
`launch` preserves the existing `{status: started, runtimeId}` or
`{status: failed, code?, message}` shape: failed launch is a committed rotation,
not a refusal or permission to retry the old generation. Ingest updates the same
scope/lane natural key; the op never writes projected rows or returns a descriptor.
Cancellation cannot undo an owner mutation; its outcome is unknown until readback.

Acceptance: cargo tests first against captured real restart request/response,
including malformed input, response mapping and committed launch failure; black-box
wire tests for typed refusal, stale fence, no caching/retry and responsive reads.
Installed Loggia discovery must list the op; a throwaway-seat restart must advance
the generation on the same seat row, and a real busy-seat refusal must be captured.
Only the Loggia-supervised kernel is stopped for activation; HRC is not restarted.

### 4.7 Lifecycle and scope

- Loggia starts the kernel if none is running and supervises it, the cardo-ui pattern. The socket is at a fixed path under HRC's `runtimeRoot`, so a launchd resident can replace Loggia later without changing a mount. There is no new launchd service and no change to restart authority.
- **An HRC restart** keeps the ledger incarnation. The follow reconnects and ingest resumes from the document's cursor with no rebuild.
- **A kernel restart** opens empty and bootstraps, under cardo P1. Loggia's mounts resync on the kernel incarnation change (loggia T-11429, 08584ec).
- Local node only. Remote nodes wait for cardo G12, which is unsupported. Transcripts and history stay out of documents. A per-seat timeline document waits for the concierge design.

### 4.8 Gates

Each one is graded from durable readback.
0. **Side-effect-free reads:** the pinned read-set test (§4.3) passes, with its `/v1/runtimes` control going red on the same seed. The page route's test shows ascending coverage of `(afterSeq, scannedThrough]` over interior holes and spilled payloads, and `CURSOR_INVALID` on an incarnation mismatch.
1. **F7:** `HrcProfile` passes discovery, query, replay and resources against the kernel (cardo T-11427).
2. **F2 and parity:** after a resync pass, a rebuilt projection equals the live one, and every seat row's phase and context equal ACP's dashboard projection for the same seat.
3. **Attach:** a seat restart re-attaches a bound Loggia leaf on the same row. Two screenshots: before and after.
4. **HRC restart:** the kernel resumes from its cursor with no rebuild (same incarnation, no `bootstrapping: true`).
5. **Kernel restart:** Loggia shows the current live set after it.
6. **A5:** recorded, not gated (cardo T-11426). Heavy runs (10× the live set, 50/s bursts, catch-up over 1.58 M rows) run against a dev-env daemon over a `VACUUM INTO` copy of the store, never the live daemon.

**What stage 1 no longer does** (compared with r2.2):
- no read-only open of `state.sqlite`, no decoy-file handling, and no coupling to the store's columns;
- no feeder that writes the projection outside ingest.

A `LedgerSource` read directly over `hrc_events` moves to stage 2, where Rust owns the ledger in-process (§6.3).

**Costs, stated.**
- **Phase logic in two copies.** It exists in Rust and in ACP's TS until the ACP port. Gate 2 catches drift.
- **Additive HRC TS changes**, all store reads in slice S1: the `/v1/events/page` route and its test (§4.2), and `contextReading` on `/v1/presentation/runtimes` rows (§4.3), plus the pre-ruled batched seat-read route adopted after A5 (T-11451). Nothing else in TS HRC changes.
- **HTTP reads per batch.** Each batch re-reads only the seats it names, in one batched seat-read route in TS HRC. A5 exposed the full-state-per-batch deviation; T-11451 applies this pre-ruled remedy without changing delta semantics or the ingest batch size.

## 5. Stage 2: independent native parity

The M1 state and operational audits resolve the provisional slice finding: process-local claims, retirement, broker control, messages, publication and recovery cross the former S1–S5 groupings. Shared WAL serialization does not fence asynchronous execution or recreate live maps. Do not introduce Bun job suppression or split-writer locks solely to support the port.

Develop on separate state/runtime roots AND scope identities, tmux leases, sockets/ports, registry, ASP preparation configuration, wrkq authority and publication destinations. Never attach or reap production brokers from copied rows. Preserve the current API-fed Cardo kernel until equivalent native ledger integration is qualified; summon/restart remain honest facades over Bun in their delivered mode.

The executable package sequence is P0 baseline → P1 store → P2 lifecycle foundation → P3 broker/turn/recovery → P4 messages/streams/publication → P5 federation/ingest → P6 operational/kernel closure → P8 reversible node qualification. P7 rusthrc/tools requires P1 and qualifies execution commands against P3–P6. Each package gets its own task-seat design ruling, real checks and independent grade. The full [closure ledger](hrc-rust-parity.md) and audits define the obligations, including direct store writers and every startup/recurring/controller job.

P0 inventory completeness is separate from its mandatory real Bun baseline, and both are separate from full native/tooling parity. Missing, empty, skipped or fixture-only cases cannot pass. Native qualification requires the Bun daemon unavailable for its subject; external ASP/brokers and unchanged Bun clients may remain. Performance budgets are measured proposals until separately approved.

Transfer the entire coupled execution owner per node only through P8: close admission, settle or durably classify pending work, stop/fence old ingress/controllers/jobs/publishers/credentials, establish relinquishment, then start and verify the new owner. Preserve surviving brokers, replay/ACK, queued input, incarnations and publisher cursors. Rollback stops/fences the candidate before restoring the named compatible Bun release and demonstrates continued real turns on the same history/substrate. A socket swap is insufficient.

Intended qualification order is isolated scratch → hrcdev → svc → max3, using a reviewed supported pilot procedure. Existing deploy-fleet runs max3 → svc → hrcdev and cannot be cited as implementing the pilot order. No production transfer or activation is authorized by this plan.

## 6. Compatibility contract

### 6.1 HTTP API

All exact, computed and pattern routes on `hrc.sock`, refreshed by P0 rather than a historical count, with the same request and response shapes, error codes and NDJSON follow semantics. Clients:
- `hrc-sdk` and the `hrc` CLI; hcs (Go); ACP (gateway, dashboard, injector); agent-loop;
- the hook bridges shipped in ASP releases;
- federation peers;
- **the stage-1 kernel** (§4.2).

P0 writes the executable contract in `contract/hrc-parity/` and external runner in `conformance/hrc-parity/`. Federation runs mixed-version during cutover, so the peer protocol (`docs/federation-peer-protocol.md`) is unchanged until stage 3.

### 6.2 Schema

Bun owns production migrations. Rust supports the exact compatible migration set, refuses unknown/incomplete stores and cannot initialize or migrate production by accident. Canonical Bun migrations initialize scratch during coexistence. P7 may qualify a Rust runner for canonical migration history as test-only tooling; production migration transfer and Bun retirement require separate authorization.

The contract inventories all schema/repositories and direct consumers/writers, including monitor, export/annotation, capture verifier, maintenance/archive/rebuild tools and release/schema inspection. ACP call sites remain ACP-owned compatibility/coordination obligations; no historical direct-read count is exhaustive. The stage-1 kernel adds no direct store read. Same-release fallback must reopen and continue native-written state; broader historical compatibility is not implied.

### 6.3 `hrc_events` as a `LedgerSource` (stage 2)

`hrcSeq` plus `ledger_incarnation_id` is unchanged. Rust ports the ledger code in stage 2 (table, triggers, FTS, partial indexes), implements cardo S1 over it, and does not adopt cardo's reference ledger (S2). What that source must state, from a read-only query of the live store on 2026-10-19:

- **The seq is monotonic but has holes.** It is `INTEGER PRIMARY KEY AUTOINCREMENT`, spans 1,501–3,040,223 with 1,582,444 rows, so about 1.46 M holes.
- **Holes appear anywhere.** `hrc runtime prune` deletes a runtime's events at any age. Retention deletes by age (except resume-barrier kinds) when run with `hrc_events` in `--tables`.
- **`retained_from` is a floor, not a promise.** `read_after` means "the next existing rows above the cursor", and a hole is never a loss signal.
- **Payloads are compacted in place**, so a replay can see different payload bytes for the same seq.
- **`head` comes from `sqlite_sequence`**, not `max(hrc_seq)`.
- **`stream_seq` is a second unique sequence**, and nothing new keys on it.
- **Retention fence:** HRC's delete paths call cardo C3's `min_consumer_cursor(source)`, and never delete above the slowest must-see consumer.

## 7. Install, activation and fleet

Atomic kernel packaging, incremental Cargo reuse, TS/Rust verification, selected/running provenance and Mable's restart authority already exist. Extend them; do not create another installation system. Native CLI name is `rusthrc`; default Bun `hrc` remains unchanged. Reuse the existing canonical Cargo target.

Build, commit/push, install, activation and promotion are distinct states. Worktree checks do not certify installed acceptance; landing and canonical installation/smoke remain coordinated. No private Bun daemon/plist or front activation is required by independent development. P8 must review supported activation/rollback and pilot tooling before services change. Read back actual sourceCommit, binaryPath/packagePath, selected/running tuple AND implementation owner; matching source does not prove native authority. Production operations remain separately authorized.

## 8. Process budget

Production keeps one execution owner per node/state/substrate throughout. Isolated development may run separate Bun/native subjects with disjoint substrates; this is not a production dual-daemon topology. The API-fed hrc-kernel remains separate until P6 native ledger integration preserves its document and mount contracts. ASP/brokers stay external; ACP owns the injector and gateways. The port claims no process reduction and does not authorize consolidation or ACP changes.

## 9. Consolidation (Track G): deferred, with a trigger

**Trigger: finding G0**, a broker-restart strategy: how an HRC upgrade keeps in-process broker tasks and their harness pipes alive. Candidates:
- exec-in-place with inherited file descriptors;
- one pipe-holder process per node;
- a broker reattach protocol that survives losing the pipe.

G0 is filed first when consolidation is picked up. Then, in order:
1. broker tasks in the binary;
2. aspc in-process;
3. the provider actor model (cardo G4) and the in-process JS host (cardo G5);
4. provider subscriptions (cardo G3);
5. timers that survive reload (cardo C5);
6. plugin reach (cardo Q5).

## 10. ACP port (after stage 3)

The ACP port is ACP's own document. What this page fixes:
- It starts after HRC stage 3, onto cardo's "after HRC, for ACP" items: the reference ledger (S2) and its hub, the leased work queue, the action journal, and the process worker.
- The mail injector moves with ACP.
- gateway-discord stays a standalone bun sidecar.
- The dashboard's `projectSession` logic then has one home: the Rust copy in `hrc-domain` (§4.3).

## 11. Open items

| item | owner | recommendation |
|---|---|---|
| M1 ownership finding (§5) | P-00866 | resolved by source audits; executable P0 closure remains required |
| ACP direct consumers | ACP | refresh call-site inventory; preserve exports and current behavior |
| HRC's wrkq client in Rust | wrkq/HRC | external authority contract before P4 |
| `contract/` format | T-11527 P0 | neutral manifest and external runner approved EN-33680; behavior evidence required |
| Stage 1b ops | Lance | include, after the read-only gates pass |
| Kernel supervision: Loggia or launchd | Lance | Loggia, until a second consumer exists |

## 12. Explicitly unsupported

- Calling unimplemented native behavior qualified, or accepting native drift without requalification.
- Transcripts and history in cardo documents.
- Rows for other nodes, and remote attach, in stage 1.
- The stage-1 kernel opening `state.sqlite`, or calling a route outside its pinned read set (§4.3).
- Production Rust migration authority or Bun retirement without separate authorization.
- Two execution owners controlling one node/state/substrate, including alternate ingress, controllers, recovery, timers and publishers.
- A double `seat.reset`. Raw keystroke input as a wire op.
- Feature flags.

## 13. Order

1. Preserve delivered stage 1/1b kernel/read/facade behavior and its recorded gates.
2. P0 executable compatibility baseline and adopted architecture record precede native implementation dispatch.
3. Implement P1–P6 and P7 under the closure ledger, isolated real validation and independent package grades.
4. P8 proves whole-owner handoff and named Bun fallback on the same real history/substrate, then obtains separate activation/pilot authority.
5. Bun retirement, production migration transfer, consolidation and any ACP port remain separate future decisions.
