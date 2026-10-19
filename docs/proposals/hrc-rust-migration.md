# HRC Rust migration

Status: proposal r2.1, 2026-10-19 (r2: cardo prerequisites renumbered to pre-hrc-cardo-gaps r5; `hrc_events` as a `LedgerSource`, §5.3. r2.1: the retention fence is cardo C3's, as of r6). Owner mable@hrc-runtime:primary. Campaign P-00862 (cardo/gap-explorations). Nothing is dispatched. Lance's rulings are marked **RULED**.

This page owns the HRC side of the port: the stages, the strangler inside stage 2, the compatibility contract, install and fleet, and the process budget. The cardo work that must land first lives in cardo's `docs/explorations/pre-hrc-cardo-gaps.md`. This page cites it by item number (`cardo P1`, `cardo B7`, and so on) and does not restate it. The material is seeded from cardo's `hrc-acp-library-path.md` r3 (66a5434), §0.1, §1, E5, E6, F7, §7a and §9.

## 0. Rulings and scope

- **RULED, Q1 (T-11381): library.** HRC becomes a Rust binary that embeds `cardo-runtime`, as foundry does. It is not a provider inside a shared platform kernel. Cardo hosts nothing that belongs to HRC.
- **RULED, port first and consolidate later** (Lance, 2026-10-19). The port rewrites today's daemon in Rust. Brokers, aspc and the injector do not move into it. Lance's reason: there is no good strategy yet for restarting HRC with brokers inside it. Brokers survive an HRC restart today only because they are separate processes in leased tmux servers that reattach by `eventsSince(lastProjectedSeq)`.
- **The process-count goal is deferred, and is stated as deferred** (§7).
- **The mail injector moves with ACP**, not HRC (§9).
- **Consolidation is deferred behind a named trigger** (§8).

HRC keeps everything it owns today:
- the store (`state.sqlite`, 20 GB, about 100 migrations, a forever ledger `hrc_events`);
- the event record (`hrcSeq` plus `ledger_incarnation_id`, and the wrkq ledger cursor `wrkq_ledger_cursors` used for presentation);
- the HTTP API on `hrc.sock`;
- federation;
- brokers in leased tmux servers, launchd supervision, and the restart doctrine.

The cardo wire is an additional socket, the mount surface for loggia and agents. Cardo projection documents are derived views of the store and never a second record.

## 1. Stages

Each stage is usable on its own and reversible.

| stage | what runs | writes to state.sqlite | reversible by |
|---|---|---|---|
| 1. Shadow projector | the TS daemon, plus a Rust `hrc-kernel` that reads the store read-only and serves the cardo wire | TS only | stopping the projector |
| 2. Rust front, sliced by state | the Rust front on `hrc.sock`, and the TS daemon on a private socket for the slices not yet ported | both, one slice each | pointing `hrc.sock` back at TS |
| 3. TS retired | Rust only | Rust only | (not reversible after the first Rust migration, §5.2) |

ACP ports afterwards, onto the same primitives (§9).

## 2. Prerequisites from cardo

All of these are cardo items in `pre-hrc-cardo-gaps.md`.

| before | cardo items |
|---|---|
| stage 1 | P1 (restart contract), P2 (delivery promises), P3 (supervision scoped); S0–S6 and S9 (subscription model, `LedgerSource`, reference ledger, cursored subscription, live class, ingest on S3, subscription registry, provider shape); A1 (tokio adapter), A2 (owner panic policy), A4 (bundled SQLite with FTS5); B1 (Rust ingest), B3 (reset), B4 (live-set sweeps), B6 (projection rules), B7 (safe read-only open), E4 (outside readers); C3 (durable cursors), C4 (idempotency keys), C7 (retention); F0, F1, F3, F4 |
| stage 2 | C1 (migrations runner), C5 (durable timers and periodic tasks), D1 (idempotent wire ops), D2 (cause on receipts), S7 (wire replay past the ring), S8 (ring quota), F5, F6 |
| measured on the stage-1 projector | A5 (performance budget), F2 and F0 on real data, F7 (`HrcProfile`) |

Numbering is as of cardo d7862d2 (r5).

## 3. Stage 1: shadow projector

**Purpose.** It puts HRC's live state on the cardo wire for loggia's Development workspace (sessions list, terminal leaves, later the concierge), and it proves the cardo primitives against real HRC data before Rust takes any write.

**Where it lives.** A Cargo workspace in hrc-runtime (`crates/hrc-domain`, `crates/hrc-kernel`), with cardo pinned by git rev (cardo A3). It never lives in cardo/crates.

**Input.**
- The store is opened under cardo B7's rules: located through `hrc server status --json` → `stateRoot`, opened read-only with a `file:` URI, short read transactions, no fixtures on live roots.
- The projector implements cardo S1 (`LedgerSource`) read-only over `hrc_events`, under §5.3's semantics. Its wake is `/v1/events/follow`, or a tail by `hrcSeq`, and SQLite rows are the truth. Ingest runs as a cursored subscription (cardo S5).
- The cursor is `{incarnation, hrcSeq}`. An incarnation change resets and rebuilds (cardo B3).

**Documents.** One document, `hrc`, rebuildable, with durability `none`.

| type | natural key | carries | notes |
|---|---|---|---|
| `hrc.seat` | sessionRef `(scope_ref, lane_ref)`, the `continuities` primary key | current hostSessionId, generation, runtimeId; agentId, projectId, taskId, lane, displayRef; status and phase; runtime transport, harness and status; latest event kind and time; lastActivityAt; context reading | attachable `tmux-attach`, fence `[hostSessionId, generation, runtimeId]` |
| `hrc.runtime` | runtimeId | seat sessionRef, transport, harness, provider, status, activeRunId, supportsInflightInput, timestamps | chatty, so it needs cardo S8 before stage 2 |
| `hrc.project` | projectId | name | colour stays in a loggia plugin; a kernel row never carries theme data |

- **There is no sessions document.** A sessions row is one generation, so keying on hsid repeats foundry's EN-30664 defect.
- **The live set** follows T-10833: a live runtime, or activity in the last 24 h, taking the latest generation per seat (cardo B4). Measured 2026-10-19: 9,742 seats ever, against 41 ready or busy runtimes.
- **Liveness never comes from `runs`.** Since T-11306, broker-native input mints no HRC run.

**Attach.** `resource.attach` on `hrc.seat` builds the cardo descriptor `{socket, target, argv, mode}` from the runtime's `tmux_json`. HRC's own `HrcAttachDescriptor` is `{kind: exec, argv, fence}`, so this is adapter work and needs no HRC change. A seat with no live tmux runtime refuses `resource_unavailable`.

**Ops (stage 1b, after the read-only projector is graded).** These are thin calls onto the TS daemon's HTTP API, `fences_on: none`. The row updates come back through ingest (cardo B6).

| op | HRC endpoint | fence or key |
|---|---|---|
| `seat.summon` | runtimes/ensure | idempotent per scope |
| `seat.input` | dispatch / active-run contribution | `{expectedHostSessionId, expectedGeneration}` plus idempotencyKey (both exist today) |
| `seat.interrupt` | `/v1/interrupt` | runtimeId |
| `seat.restart` | the T-10850 restart | `expectedGeneration` (refuses STALE_CONTEXT) |
| `seat.reset` | `/v1/clear-context` | no generation fence today; a double reset is listed as unsupported |

Raw keystroke input (`SendWindowLiteralInputRequest`) has neither a fence nor a key. It is not exposed as an op in stage 1.

**Lifecycle.**
- Loggia starts the projector if none is running and supervises it, the cardo-ui pattern. Its socket sits at a fixed path under HRC's `runtimeRoot`, so a launchd resident can replace Loggia later without changing any mount.
- No new launchd service and no change to restart authority.
- An HRC restart keeps the ledger incarnation, so the follow reconnects and resumes.
- A projector restart rebuilds, under the restart contract (cardo P1).

**Scope.**
- Local node only. Rows for other nodes and remote attach wait for G12, which is unsupported in cardo (a remote node's projector is mounted over an ssh-forwarded socket, when that is wanted).
- Transcripts and history stay out of documents.
- A per-seat timeline document waits for the concierge design. It must not share the seats document's ring quota (cardo S8).

**Gates.** Each one is graded from durable readback.
1. F7 `HrcProfile` passes discovery, query, replay and resources against the projector.
2. F2: a rebuilt projection equals the live one on the real store.
3. A seat restarted through `seat.restart` re-attaches a bound loggia leaf on the same row. Two screenshots: before and after.
4. An HRC restart leaves the projector's cursor resuming with no rebuild (same incarnation).
5. A5 is recorded at the live-set size and at 10× it.

## 4. Stage 2: the Rust front, sliced by state

**Shape.**
- The Rust daemon takes `hrc.sock`. The TS daemon moves to a private socket.
- The front serves the route families it owns and proxies the rest, byte for byte, including the NDJSON follow streams.
- Both processes write the one WAL store under `BEGIN IMMEDIATE` with busy timeouts. That isn't new: the prune job already writes beside the daemon.

**Slices.** A slice moves together with all the in-memory state its routes share, never route by route. Proposed order, from the least in-memory state to the most:

| slice | routes (families) | in-memory state that moves with it |
|---|---|---|
| S1 reads | sessions, runtimes and runs listing; events tail, head and latest-by-session; health and status; capture reads | none |
| S2 messages | messages, dm, query, wait and watch; wrkq presentation; the stop-gate and hint-decision internal routes | `messageSubscribers`; the wrkq ledger cursor's consumer |
| S3 runtime lifecycle | runtimes start, ensure, attach, sweep and prune; capture; bridges; placements and declarations | in-flight start maps; tmux leases |
| S4 brokers and turns | broker-events and broker-sessions; dispatch, inputs and in-flight input; interrupt; clear-context; runs reconcile and recover; the follow hub (`/v1/events/follow`, `/v1/broker-events/follow`); hook ingest | `harnessBrokerController`, `followSubscribers`, the in-flight idempotent dispatch map, the broker warmup |
| S5 federation | the peer listener, bindings, designations, locate, retire | peer health |

**Rules while split.**
1. **One owner per slice.** A route family is served by exactly one daemon. The front's route table is the single statement of which one.
2. **One process runs each sweep.** HRC has about 13 timer loops (`sweep-handlers.ts`, `first-turn-watch.ts`, …). Each one moves with the slice whose state it reads. Two daemons running the same sweep is a double-reaper hazard, and the front refuses to start if both claim a loop.
3. **The follow hub is split.** Until S4 moves, the Rust post-commit hub cannot see TS writes, so Rust followers use a seq-poll fallback on `hrc_events`. Once S4 moves, the TS writes it still does (S5 only) are polled the same way.
4. **No Rust migration** (§5.2). The TS daemon stays the migration owner until it is retired on every node, and Rust refuses a schema newer than it knows.
5. **Restart doctrine unchanged.** Brokers reattach to whichever daemon owns S4. A front restart is an HRC restart, and Mable primary's authority covers both processes.

**Gate per slice: F7.** The existing TS end-to-end suites (hrc-server has about 116 k lines of tests) pass against the front as a black box, with the slice served by Rust. Add an installed smoke through `verify-hrc-runtime`, and a broker reattach count after a restart (the baseline is 39/39 and 50/50).

**Owed before the port starts: finding M1.** M1 confirms or rewrites the slice table from a route-by-state inventory of `hrc-server` (method aliases in the server context, subscriber sets, in-flight maps, timer loops). It also checks the seq-poll fallback's latency against the follow consumers: ACP's dashboard, the mail injector and agent-loop.

**Cutover, per node.** hrcdev first, then svc, then max3. Each node runs every slice on Rust for a soak period before the next node starts. Rollback at any point before stage 3 is pointing `hrc.sock` back at the TS daemon.

## 5. Compatibility contract (stages 1–2)

### 5.1 HTTP API

All of the routes on `hrc.sock` (about 110), with the same request and response shapes, error codes and NDJSON follow semantics. Clients:
- `hrc-sdk` and the `hrc` CLI;
- hcs (Go);
- ACP (gateway, dashboard, injector);
- agent-loop;
- the **hook bridges shipped in ASP releases** (`/v1/internal/hooks/ingest`, `/v1/internal/mail/stop-decision`, `/v1/internal/mail/hint-decision`);
- federation peers.

**Federation runs mixed-version during cutover.** A Rust max3 may peer with a TS svc, so the peer protocol (`docs/federation-peer-protocol.md`) is part of the contract unchanged until every node is on stage 3.

### 5.2 Schema

- Frozen until the TS daemon is retired everywhere. Rust adds no migration, because a rollback would otherwise meet the rule that a reader behind the schema refuses (cardo C1), and the TS daemon would refuse its own database.
- After retirement, Rust takes migration ownership through cardo C1.
- The contract includes the exact columns read from outside the daemon: the `hrc` CLI's monitor reads, the capture verifier, the prune job (`com.praesidium.hrc-prune-deltas`), and **ACP's twelve direct reads** (open item, §10).

### 5.3 Event record, and `hrc_events` as a cardo `LedgerSource`

`hrcSeq` plus `ledger_incarnation_id` is unchanged. HRC ports its own ledger code in stage 2: the exact table, triggers, FTS and partial indexes. HRC implements cardo S1 over that table and does not adopt cardo's reference ledger (S2) during the port.

What a `LedgerSource` over `hrc_events` has to state (read-only query of the live store, 2026-10-19):

- **The seq is monotonic but holey.** `hrc_seq` is `INTEGER PRIMARY KEY AUTOINCREMENT`, so it is never reused. The live table spans 1,501–3,040,223 with 1,582,444 rows, which is about 1.46 M holes.
- **Holes are anywhere, not only below a floor.**
  - `hrc runtime prune` deletes every event of the selected runtimes at any age (`runtime-repository.ts:643`).
  - Retention deletes by age, except resume-barrier kinds, when it is run with `hrc_events` in `--tables` (`scripts/prune-hrc-event-deltas/`; the nightly job runs `runtime_buffers` only today).
- **So `retained_from` is a floor, not a promise.** Every row above it may still be missing. `read_after` means "the next existing rows with seq greater than the cursor", and a hole is never a loss signal.
- **Payloads are compacted in place.** Spill and restub rewrite `payload_json` after the fact. A replay can see different payload bytes for the same seq.
- **Use `head` from `sqlite_sequence`, not `max(hrc_seq)`.** Deleting the newest rows would otherwise move the head backwards.
- **`stream_seq` is a second unique sequence** (`event_stream_cursor`). The record is `hrc_seq`, and nothing new keys on `stream_seq`.
- **Retention fence (stage 2).** HRC's two delete paths honour cardo C3's fence: they call `min_consumer_cursor(source)` and never delete rows above the slowest must-see consumer registered in S6. Until then, a cursored consumer of `hrc_events` accepts that a pruned runtime's unconsumed events can vanish.

## 6. Install, activation and fleet

What exists today: atomic releases, install then restart, status `sourceCommit`, the release-prune rule (T-10024: keep current plus running), `verify-hrc-runtime`, and Mable primary's restart authority. The Rust daemon keeps every one of these behaviours and changes the artifact:

- **Build.** `cargo build --release` joins `just install`. The release directory holds the binary next to the TS release until stage 3. `status --json` reports `sourceCommit` for the daemon that owns `hrc.sock` and for the private TS daemon.
- **Verify and pre-push.** A cargo leg in `just verify` and pre-push. The cardo pin moves only through an explicit bump commit (cardo A3).
- **launchd.** The same label. The program path changes to the front. The private TS daemon gets its own plist while the daemon is split. Edits follow the launchd-control rules: edit the installed plist in place, then bootout and bootstrap, because kickstart never re-reads the plist.
- **Fleet.** Build on each node, or ship the binary to hrcdev and svc. The deploy order is the cutover order (§4). The parity check is still `sourceCommit` per node.
- **The projector (stage 1)** ships in the same release. Loggia finds it on the fixed socket path.

## 7. Process budget, consolidation deferred

| process (per node, max3 2026-10-19) | today | stage 1 | stage 2 (split) | stage 3 |
|---|---|---|---|---|
| HRC daemon | 1 (bun) | 1 | 2 (Rust front + TS) | 1 (Rust) |
| hrc-kernel projector | 0 | 1 | 1, folded into the front once S1 moves | 0, in-process |
| harness-broker | about 70 (3.5 GB, 6 ASP releases live) | unchanged | unchanged | unchanged |
| aspd | 1 | unchanged | unchanged | unchanged |
| injector | inside acp-server | unchanged | unchanged | moves with the ACP port |
| HRC's `wrkq rpc --stdio` children | today's count | unchanged | unchanged | wrkq's call: rpc, a linked library, or wrkqd |

**The port does not reduce the process count, and it says so.** Reducing it is consolidation (§8).

## 8. Consolidation (Track G): deferred, with a trigger

**Trigger: finding G0**, a broker-restart strategy: how an HRC upgrade keeps in-process broker tasks and their harness pipes alive. The candidates:
- exec-in-place with inherited file descriptors;
- one pipe-holder process per node;
- a broker reattach protocol that survives losing the pipe.

G0 is the first thing filed when consolidation is picked up. Nothing in Track G is on the critical path before G0 exists.

Then, in order:
1. broker tasks in the binary;
2. aspc in-process;
3. the provider actor model (cardo G4) and the in-process JS host (cardo G5), so the injector becomes a reloadable provider (install = one reload command);
4. provider subscriptions (cardo G3);
5. timers that survive reload, on cardo C5;
6. plugin reach (cardo Q5).

Every stage of the port is a prerequisite for Track G, so none of the port's work is thrown away.

## 9. ACP port (after stage 3)

The ACP port is ACP's own document. What this page fixes:
- It starts after HRC stage 3, onto the cardo items listed as "after HRC, for ACP" in `pre-hrc-cardo-gaps.md` §8: the reference ledger (S2) and its hub, lifted from HRC's Rust ledger, the leased work queue, the action journal on a product connection, and the process worker for any executable.
- The mail injector moves with ACP, and its write-ahead intents map onto the action journal lifecycle.
- gateway-discord stays a standalone bun sidecar talking HTTP.

## 10. Open items

| item | owner | recommendation |
|---|---|---|
| M1 slice finding (§4) | mable@hrc-runtime | owed before the HRC port starts |
| ACP's twelve direct reads of `state.sqlite` | ACP | move them onto the API before stage 2; that shrinks §5.2 |
| HRC's wrkq client in Rust (rpc, a linked library, or wrkqd) | wrkq | decide before S2 moves |
| Stage-1b ops: include, or stay read-only | Lance | include, after the read-only gates pass |
| Stage-1 projector supervision: Loggia or launchd | Lance | Loggia, until a second consumer exists |

## 11. Explicitly unsupported

- Transcripts and history in cardo documents.
- Rows for other nodes and remote attach in stage 1.
- A Rust schema migration before TS is retired everywhere.
- Two daemons serving one route family, or running one sweep loop.
- A double `seat.reset` (clear-context has no generation fence).
- Raw keystroke input as a wire op.
- Feature flags.

## 12. Order

1. **Now:** cardo findings P1–P5 (cardo's order). On the HRC side: finding M1, and ACP's direct reads.
2. **Stage 1:** after cardo's stage-1 items (§2), build `crates/hrc-domain` and `crates/hrc-kernel`, graded by §3's gates. Then stage 1b ops.
3. **Stage 2:** after cardo's stage-2 items and M1, build the Rust front. Port S1 to S5 in order, each gated by F7, with cutover hrcdev, then svc, then max3.
4. **Stage 3:** retire TS on every node. Rust takes migration ownership.
5. **ACP port** (§9).
6. **Track G**, on its trigger (§8).
