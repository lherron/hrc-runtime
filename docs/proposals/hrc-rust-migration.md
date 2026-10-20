# HRC Rust migration

Status: proposal r3.2, 2026-10-20 (r3.1 answers daedalus EN-32626 F1–F4: the `/v1/events/page` ledger read, a pinned side-effect-free read set, attach from the presentation read model. r3.2 answers EN-32628 F5: `contextReading` on presentation rows. r3.3: §4.6 stage 1b ops are facade calls over existing routes with no TS change, and `seat.summon` is specified first). Owner mable@hrc-runtime:primary. Campaign P-00862. **Stage 1 delivered 2026-10-20:** gate 0 T-11441 (371cc396), kernel T-11442 (8f70c9e8..5f7e1bc9), gates 0–5 graded PASS, live on max3. Cardo F7 is green; A5 (T-11426) measurements are cardo's. Stage 1b and stage 2 are not dispatched. Lance's rulings are marked **RULED**.

r3 replaces r2.2's stage 1 and adds the repository rules:
- **One stage 1.** It merges clod@loggia's stage 0 (R-00448, EN-32603) into stage 1. The kernel reads HRC through its HTTP API through cardo's own ingest machinery, not through a read-only open of `state.sqlite` (§4).
- **One repository**, with dual implementation scoped by slice (§2).
- **Cardo prerequisites:** all of them are on cardo main at 1796e1c (§3).

This page owns the HRC side of the port: the repository layout, the stages, the strangler inside stage 2, the compatibility contract, install and fleet, and the process budget. The cardo work lives in cardo's `docs/explorations/pre-hrc-cardo-gaps.md`, which this page cites by item number (`cardo B6`) and does not restate.

## 0. Rulings and scope

- **RULED, Q1 (T-11381): library.** HRC becomes a Rust binary that embeds `cardo-runtime`, as foundry does. Cardo hosts nothing that belongs to HRC.
- **RULED, port first and consolidate later** (Lance, 2026-10-19). Brokers, aspc and the injector do not move into the port. Brokers survive an HRC restart only because they are separate processes in leased tmux servers that reattach by `eventsSince(lastProjectedSeq)`, and there is no strategy yet for keeping them alive inside the daemon (§9).
- **RULED, gradual migration with TS fully functional** (Lance, 2026-10-20). There is no big-bang cutover. The TS daemon stays a complete daemon that can serve every route until stage 3. Dual implementation is scoped by slice (§2.2).
- **RULED, one repository** (Lance, 2026-10-20). Rust lives in hrc-runtime beside the TS packages (§2.1).
- **RULED, facade first, then native slices** (Lance, 2026-10-20). Rust HRC starts as a facade over the working TS daemon (stages 1 and 1b), then replaces the facade's parts with native Rust implementations one slice at a time (stage 2). **Stage 1b ops add no TS code and no HRC features:** each op is a client of routes that already exist, exactly as the `hrc` CLI, ACP and the mail injector use them. If an op needs something TS HRC does not offer, it waits for that slice's native Rust implementation; TS HRC does not grow to serve the facade. The three additive S1 reads that stage 1 already landed (§4.8 costs) stand.
- The process-count goal is deferred, and stated as deferred (§8). The mail injector moves with ACP, not HRC (§10).

HRC keeps everything it owns today:
- the store: `state.sqlite`, about 20 GB and about 120 migrations, with the forever ledger `hrc_events`;
- the event record: `hrcSeq` plus `ledger_incarnation_id`, and `wrkq_ledger_cursors`;
- the HTTP API on `hrc.sock`;
- federation;
- brokers in leased tmux servers, launchd supervision, and the restart doctrine.

The cardo wire is an additional socket, the mount surface for Loggia and agents. Cardo documents are derived views and never a second record.

## 1. Stages

Each stage is usable on its own and reversible.

| stage | what runs | writes `state.sqlite` | reversible by |
|---|---|---|---|
| 1. Kernel projector | the TS daemon, plus a Rust `hrc-kernel` that reads HRC over its HTTP API and serves the cardo wire | TS only | stopping the kernel |
| 2. Rust front, sliced by state | the Rust front on `hrc.sock`; the TS daemon on a private socket, still complete | both, one slice each | pointing `hrc.sock` back at TS |
| 3. TS retired | Rust only | Rust only | (not reversible after the first Rust migration, §6.2) |

Stage 1 replaces nothing. It is a new reader, so the dual-implementation rule (§2.2) starts at stage 2. ACP ports afterwards (§10).

## 2. Repository and separation

### 2.1 Layout

```
hrc-runtime/
  packages/        TS: hrc-server, hrc-cli, hrc-core, hrc-sdk, hrc-store-sqlite, … (unchanged)
  crates/          Rust Cargo workspace: hrc-domain, hrc-kernel; later hrc-front, hrc-store
  contract/        neutral, consumed by both sides (from stage 2)
  conformance/     the black-box suite that runs against either daemon's socket (from stage 2)
```

- **No cross-imports.** `packages/` and `crates/` meet only through the HTTP API, the cardo wire and the store. Neither builds the other.
- **`contract/` is owned by neither side.** It holds the route table, request and response schemas, event kinds, and the schema version the store is at. TS and Rust either generate their types from it, or check them against it by example in the conformance suite. It starts empty at stage 1, because the kernel consumes the HTTP API as a client (plus two additive TS store reads, §4.2 and §4.3). It fills as slices move.
- **The route table is the single statement of ownership.** For each route family it names the slice, the daemon that serves it, and whether the slice is ported (§2.2). The Rust front reads it at stage 2.
- **Hooks are path-scoped** through the existing `hook-scope`/`.hookignore` mechanism:
  - a TS-only change skips cargo;
  - a `crates/`-only change skips the bun suites;
  - a change under `contract/`, `conformance/`, `packages/hrc-store-sqlite/src/migrations*` or the route table runs both.
- **Seats.** Rust work runs in its own task seats. One session doesn't do both halves of a dual-implemented change unless the change is small.
- **Why not a separate repository.** The two daemons share the API contract, the store schema and the release. One commit can change both sides and the conformance suite together, and one release has one `sourceCommit` per node. Two repositories would turn each of those into a cross-repo pin that drifts. The benefits of a separate repository (build speed, clean ownership, agents that never confuse the halves) come here from the path-scoped hooks and separate seats.

### 2.2 Dual implementation, scoped by slice

| slice state | a new feature or change lands in |
|---|---|
| not ported | TS only. Rust picks it up when the slice ports. |
| ported (Rust serves it) | both. TS is the rollback target, so it stays current. |
| soaked on every node | both, until stage 3 retires TS |

- **Done means the conformance suite passes against both daemons** for a ported slice. A pre-push check refuses a change to a ported slice's routes, schemas or tests that touches only one side.
- **Schema.** TS owns migrations until stage 3 (§6.2). A migration commit also bumps the schema version in `contract/`, and Rust refuses a store newer than the version it knows. Pre-push checks that the two agree.
- **Keep the double cost short.** It applies only to the slices in flight, so a slice's soak (§5) is kept short and slices move one at a time.

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
- `/v1/presentation/runtimes`, the store-only presentation read model (`hrc-runtime.viewer-presentation-sidecar` §5.3–5.4);
- `/v1/sessions`;
- POST `/v1/presentation/seats/read`, the batched keyed store read adopted after A5 (T-11451).

A test in the style of `t07594-side-effect-free-reads` pins this set against a dead-substrate seed, with the `/v1/runtimes` control, and adds `/v1/events/page` and `/v1/sessions` to the asserted routes (gate 0, §4.8). Presentation rows can name a runtime whose tmux has died until HRC's own sweep marks it. The viewer already accepts that window, and the kernel accepts it too.

- **`bootstrap`** first samples the cursor `at` (incarnation plus head, from the page route), then reads the live set:
  1. `/v1/sessions` with sessions updated in the last 24 h, latest generation only;
  2. `/v1/presentation/runtimes`;
  3. `/v1/events/latest-by-session`.
  This is one page at the live-set size. Sampling `at` before reading state means anything that changes during the read is replayed after it.
- **`apply`** maps each row to keys: its sessionRef, and for a runtime-scoped row its runtimeId and that runtime's seat. It removes duplicates within the batch, re-reads each key in one POST `/v1/presentation/seats/read` with `{sessionRefs, runtimeIds}`, and emits upserts or `remove_by_key`. The response contains the window-selected latest-generation sessions (plus quiet runtime-named seats), presentation runtimes, and latest events for those sessions. The unchanged projection derives the touched project rows. Apply indexes the bounded result once; bootstrap and resync retain the full read.
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

## 5. Stage 2: the Rust front, sliced by state

**Shape.**
- The Rust front takes `hrc.sock`, and the TS daemon moves to a private socket.
- The front serves the slices marked ported in the route table (§2.1) and proxies the rest byte for byte, including the NDJSON follow streams.
- Both processes write the one WAL store under `BEGIN IMMEDIATE` with busy timeouts. The prune job already writes beside the daemon today.

**Slices.** A slice moves together with all the in-memory state its routes share, never route by route. Proposed order, from the least in-memory state to the most:

| slice | routes (families) | in-memory state that moves with it |
|---|---|---|
| S1 reads | sessions, runtimes and runs listing; events tail, head and latest-by-session; health and status; capture reads | none |
| S2 messages | messages, dm, query, wait and watch; wrkq presentation; the stop-gate and hint-decision internal routes | `messageSubscribers`; the wrkq ledger cursor's consumer |
| S3 runtime lifecycle | runtimes start, ensure, attach, sweep and prune; capture; bridges; placements and declarations | in-flight start maps; tmux leases |
| S4 brokers and turns | broker-events and broker-sessions; dispatch, inputs and in-flight input; interrupt; clear-context; runs reconcile and recover; the follow hub; hook ingest | `harnessBrokerController`, `followSubscribers`, the in-flight dispatch map, broker warmup |
| S5 federation | the peer listener, bindings, designations, locate, retire | peer health |

**Rules while split.**
1. **One owner per slice.** A route family is served by exactly one daemon, as stated in the route table.
2. **One process runs each sweep.** HRC's timer loops (`sweep-handlers.ts`, `first-turn-watch.ts`, …) move with the slice whose state they read. The front refuses to start if both daemons claim a loop.
3. **The TS daemon stays complete** (§2.2). It keeps every slice's code current, so pointing `hrc.sock` back at it restores full service.
4. **The follow hub is split.** Until S4 moves, Rust followers use a seq-poll fallback on `hrc_events`.
5. **No Rust migration** (§6.2).
6. **Restart doctrine unchanged.** Brokers reattach to whichever daemon owns S4. A front restart is an HRC restart, and Mable primary's authority covers both processes.
7. **The stage-1 kernel** keeps reading the HTTP API through the front. Once S1 and S4 move, its source can become an in-process `LedgerSource` over `hrc_events`, and the document, types and mounts stay unchanged.

**Gate per slice.** The conformance suite passes against both daemons for the slice (§2.2). Add an installed smoke through `verify-hrc-runtime`, and a broker reattach count after a restart.

**Owed before stage 2 starts:**
- **Finding M1:** confirm or rewrite the slice table from a route-by-state inventory of `hrc-server` (method aliases, subscriber sets, in-flight maps, timer loops), and check the seq-poll fallback's latency against the follow consumers.
- **`contract/` and `conformance/` populated for S1:** the existing hrc-server e2e suites run as a black box against a socket.

**Cutover, per node and per slice:** hrcdev first, then svc, then max3. The soak is short by design (§2.2). Rollback before stage 3 is pointing `hrc.sock` back at TS.

## 6. Compatibility contract

### 6.1 HTTP API

All the routes on `hrc.sock` (about 110), with the same request and response shapes, error codes and NDJSON follow semantics. Clients:
- `hrc-sdk` and the `hrc` CLI; hcs (Go); ACP (gateway, dashboard, injector); agent-loop;
- the hook bridges shipped in ASP releases;
- federation peers;
- **the stage-1 kernel** (§4.2).

From stage 2 the contract is written down in `contract/`. Federation runs mixed-version during cutover, so the peer protocol (`docs/federation-peer-protocol.md`) is unchanged until stage 3.

### 6.2 Schema

- TS owns migrations until it is retired everywhere. Rust adds none, because a rollback would meet cardo C1's "a reader behind the schema refuses" rule.
- `contract/` carries the schema version. Rust refuses a newer store, and pre-push checks the two agree (§2.2).
- After retirement, Rust takes migration ownership through cardo C1.
- The contract includes the columns read from outside the daemon: the `hrc` CLI's monitor reads, the capture verifier, the prune job, and ACP's twelve direct reads (§11). The stage-1 kernel adds none.

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

What exists today: atomic releases, install then restart, status `sourceCommit`, the release-prune rule (T-10024), `verify-hrc-runtime`, and Mable primary's restart authority. Rust keeps all of these.

- **Build.** `cargo build --release` joins `just install`, path-scoped, so a TS-only change doesn't trigger it. The release directory holds the Rust binaries beside the TS release. `hrc server status` reports one `sourceCommit`, which covers both.
- **Verify and pre-push.** A cargo leg, path-scoped (§2.1). The cardo pin moves only through an explicit bump commit.
- **launchd.** Stage 1 adds nothing. At stage 2 the label is the same and the program path changes to the front. The private TS daemon gets its own plist. Edits follow the launchd-control rules: edit the installed plist in place, then bootout and bootstrap.
- **Fleet.** Build on each node, or ship the binary. The deploy order is the cutover order. Parity is `sourceCommit` per node.
- **The stage-1 kernel** ships in the same release. Loggia finds it on the fixed socket path.

## 8. Process budget

| process (per node, max3 2026-10-19) | today | stage 1 | stage 2 (split) | stage 3 |
|---|---|---|---|---|
| HRC daemon | 1 (bun) | 1 | 2 (Rust front plus TS) | 1 (Rust) |
| hrc-kernel | 0 | 1 | 1, folded into the front once S1 and S4 move | 0, in-process |
| harness-broker | about 70 | unchanged | unchanged | unchanged |
| aspd | 1 | unchanged | unchanged | unchanged |
| injector | inside acp-server | unchanged | unchanged | moves with the ACP port |
| HRC's `wrkq rpc --stdio` children | today's count | unchanged | unchanged | wrkq's call |

The port does not reduce the process count, and it says so. Reducing it is consolidation (§9).

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
| M1 slice finding (§5) | mable@hrc-runtime | owed before stage 2 |
| ACP's twelve direct reads of `state.sqlite` | ACP | move them onto the API before stage 2 |
| HRC's wrkq client in Rust | wrkq | decide before S2 moves |
| `contract/` format: generated types, or by-example checks only | mable@hrc-runtime | decide with M1; by-example is enough for S1 |
| Stage 1b ops | Lance | include, after the read-only gates pass |
| Kernel supervision: Loggia or launchd | Lance | Loggia, until a second consumer exists |

## 12. Explicitly unsupported

- Feature work implemented in both daemons for a slice that isn't ported.
- A change to a ported slice on one side only.
- Transcripts and history in cardo documents.
- Rows for other nodes, and remote attach, in stage 1.
- The stage-1 kernel opening `state.sqlite`, or calling a route outside its pinned read set (§4.3).
- A Rust schema migration before TS is retired everywhere.
- Two daemons serving one route family, or running one sweep loop.
- A double `seat.reset`. Raw keystroke input as a wire op.
- Feature flags.

## 13. Order

1. **Now: stage 1** (§4), graded by §4.8. Cardo's F7 and A5 run against it. Then the stage 1b ops.
2. **Before stage 2:** M1, ACP's direct reads, and `contract/` plus `conformance/` for S1.
3. **Stage 2:** port S1 to S5 in order. Each slice passes conformance against both daemons, then cuts over hrcdev, svc, max3.
4. **Stage 3:** retire TS on every node. Rust takes migration ownership.
5. **ACP port** (§10).
6. **Track G**, on its trigger (§9).
