# HRC Rust parity

Status: r2, 2026-10-25, draft for Daedalus review (T-11816). Owner mable@hrc-runtime:primary. Campaign P-00866. r2 replaces r1 (T-11525, c720ad33). Lance ruled 2026-10-25 to delete r1's implementation branch and restart from current main. The P-00869 cleanup had deleted routes, tables and store methods that r1's P1/P2 work and its frozen inventory were built to match.

## What carries over from r1

These were sound, are approved (EN-33646), and stay:

- **Build the native daemon alongside Bun, then transfer each node whole.** Bun HRC keeps working on its own throughout. The Rust daemon is built and qualified on isolated scratch state, and each node switches its whole execution owner at once. Lifecycle, messaging, broker execution and federation never have two live writers.
- **Why not slice-by-slice.** The coupling is structural. A message route can start and finish a turn (`target-message-dm-handlers.ts` → `executeAdmittedTurn`). Claims, retirement and minting are guarded by process-local locks (`federation/authority-lock.ts`). Event wakeups go through a hub keyed by a Bun `Database` (`lifecycle-append-hub.ts`), and a Rust write cannot wake it. Fencing these across processes would mean changing Bun to support the port.
- **Bun owns the schema.** Rust reads and writes the exact current migration set and refuses an unknown or incomplete schema. It never migrates a live store. Scratch stores are created with Bun's migrations.
- **No state-model redesign.** Sessions, scopes, generations, claims, input receipts, ledgers, incarnations and projection-before-ACK keep their current meaning. Cardo stays a derived view.
- **Isolation includes destinations.** Scratch runs get their own tmux server, scopes, sockets, registry, ASP config, wrkq authority and publication targets, never only a separate DB path. Copied production rows must never let a scratch daemon attach to or reap a production broker.
- **Existing boundaries stay.** ASP owns brokers and aspd, wrkq owns collaboration storage, ACP owns the injector and gateways. No consolidation, ACP port or feature flags.
- **The delivered kernel stays as it is** (`crates/hrc-kernel`, API-fed, with `seat.summon`/`seat.restart`/`seat.send` facades) until N4 moves it onto the native ledger.

## What changes from r1

1. **Baseline is current main, regenerated rather than frozen.** r1 froze a 2,078-item inventory with source hashes (`contract/hrc-parity/inventory.json`, 52k lines). Every cleanup commit invalidated entries, and two `hrc-core` types survive only because the inventory names them. In r2 the inventory is a coverage report generated from main at gate time: each registered route, peer/registry/ingest route, CLI command and recurring job maps to a passing case, a named gap, or an "explicitly unsupported" line. A Bun change shows up as a new line in the report, not as a broken hash.
2. **Gates are product claims.** Each package closes on three to five real workflows, run through the existing socket-parameterized runner (`conformance/hrc-parity/run.py`) against Bun and Rust scratch subjects, compared case by case. Internal mechanism races stay out of the gates (see "Explicitly unsupported").
3. **Seven packages instead of nine.** P1 and P2 merge, because the store has no product claim of its own until a daemon serves it. P6 operations fold into the federation package.
4. **Grading.** Mable grades each package from runner artifacts and git. Daedalus reviews this plan once, and a package design only when it departs from this plan.

## Surface on main at r2

92 exact routes on the main socket (`packages/hrc-server/src/server-exact-routes.ts`; r1 counted 112), plus pattern routes, 18 peer routes, 6 registry routes and 1 ingest route. hrc-server is about 95k lines of non-test TypeScript, hrc-cli 27k and hrc-store-sqlite 21k. r1's source audits in `hrc-rust-parity/` are snapshots of the surface before the cleanup. They are kept as the evidence behind EN-33646, not as the r2 inventory. Federation scope is not final: T-11712 is producing a list of federation routes and code to delete, and N4's scope is whatever survives it.

## Packages

The critical path is N0 → N1 → N2 → N3 → N4 → N6. N5 can start after N1 and qualifies each command once its daemon package lands. Each package is one Cody task seat on main, filed when armed.

| Package | Delivers | Closes when (each a real workflow on isolated scratch; Bun daemon down for the Rust subject) |
|---|---|---|
| **N0 Re-baseline** | Regenerate the coverage report from main. Delete the frozen `inventory.json`/`store-schema.json` hash pins and the two hrc-core types they keep alive (`HrcCompiledRuntimePlanRecord`, `HrcLifecyclePolicyRecord`). Keep `cases.json` and the nine mandatory runner workflows, pruned of deleted surface. | (1) The runner baseline passes against installed Bun on scratch. (2) A deliberately broken subject fails it. (3) The coverage report lists every route, CLI command and job on main with no unmapped line. |
| **N1 Native daemon foundation** | `crates/hrc-store` (canonical mappings, transactions, schema guard, ledgers, FTS, spill) and `crates/hrc-native` (listener, config, status, credentials, sessions, claims, placement, ASP preparation, runtime provisioning, participant register/attach). | (1) Unchanged Bun `hrc` against the Rust daemon: a cold `hrc start` births a real seat, and `hrc status`/`runtime list` agree with the store. (2) Stop Rust, start Bun on the same scratch state: Bun reads and continues it. (3) An unknown or incomplete schema is refused with no writes. (4) Clean shutdown leaves the brokers alive. |
| **N2 Broker turns and recovery** | Controller over the existing external brokers: raw ingest, projection, ACK, replay and gaps; input and submissions; capture; context, continuation and restart; startup recovery and recurring sweeps. | (1) A real turn runs to `turn.completed` on the Rust daemon. (2) The Rust daemon restarts mid-turn: brokers reattach and the turn completes with no duplicate. (3) A human-typed turn with no run row is recorded. (4) Every startup and recurring job in the coverage report runs once in the window. |
| **N3 Messages and streams** | DM, handoff, query, wait and watch; response finalization; lifecycle, raw and message streams; wrkq session and server publication with cursors. | (1) `wrkc say` to a seat on the Rust daemon gets exactly one reply, including across a daemon restart between delivery and reply. (2) The kernel follows Rust's event stream across replay into live with no gap or duplicate. (3) A lost publication ACK recovers with no duplicate publish. |
| **N4 Federation, operations, kernel** | Whatever peer, registry and ingest surface survives T-11712; transcript index and search; diagnostics; native packaging and status; the kernel projecting from the native ledger. | (1) Mixed Bun and Rust scratch nodes deliver mail and a reply in both directions. (2) Transcript search returns the same hits as Bun on the same store. (3) The installed Rust release reports its own `sourceCommit` and owner identity, so a proxy cannot pass. (4) Loggia attaches to a seat through the native kernel. |
| **N5 `rusthrc`** | A Rust CLI for every `hrc` command in the coverage report, with the same arguments, JSON/NDJSON output, exit codes and PTY attach. The TS SDK stays for TS clients. | (1) The runner's CLI cases pass with `rusthrc` against both daemons. (2) Real PTY `attach` and `monitor` work. (3) Unchanged Bun `hrc` still passes against the Rust daemon. |
| **N6 Node handoff** | A reviewed per-node switch procedure: close admission, settle or record pending work, stop the old owner without killing brokers, start the new one, verify. Rollback is the same procedure in reverse. | (1) On scratch, Bun → Rust → Bun keeps the same seats, history and pending input, with one owner at a time and a real turn after each switch. (2) Then hrcdev, then svc, then max3, each authorized separately by Lance. |

## Explicitly unsupported

These are never gates, and Rust does not have to reproduce them:

- Fallback to any Bun release other than the named one paired with the qualifying Rust release.
- Any route, table or command deleted on main, including whatever T-11712 deletes.
- Two full owners against one live store, or split-writer operation of any kind.
- A Rust schema migrator for production stores. A Rust test-only migrator for scratch is optional in N1.
- Mechanism races that no product path exhibits, such as two internal checks racing, or stall shapes that no broker or client produces. Measure them if cheap and record the number. Don't gate on them.
- Fixed throughput or latency budgets. N4 records resource use and latency against the Bun baseline for Lance to rule on.

## Authority

No install, activation or fleet change is authorized by this plan. Scratch work happens on the task seat's own isolated roots. Restarts and installs follow the normal Mable-primary doctrine. Each move in N6 needs Lance's go for that node. Bun retirement and the ACP port are separate later decisions.
