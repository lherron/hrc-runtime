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

92 exact routes on the main socket (`packages/hrc-server/src/server-exact-routes.ts`; r1 counted 112), plus pattern routes, 18 peer routes, 6 registry routes and 1 ingest route. hrc-server is about 95k lines of non-test TypeScript, hrc-cli 27k and hrc-store-sqlite 21k. r1's source audits (`hrc-rust-parity/{state,operations}-audit.md`, commit d5f9c555) described the surface before the cleanup. They are the evidence behind EN-33646 and are retired from the tree; read them from that commit. T-11712 finished the federation audit: no peer, registry or ingest route was deleted.

## Scope: used endpoints only

Lance ruling, 2026-10-25: this campaign implements only routes and CLI commands with confirmed use. Every other route or command is postponed and kept as Bun pass-through until it is known to be used. Nothing is deleted on this basis.

- **Evidence.** A route is used if day metrics or the L3 request log on any node show calls in the evidence window. The first window, 2026-10-23T20:14Z → 10-25T19:57Z across max3, svc and hrcdev, showed 60 of 99 registered main routes with traffic and 39 with none (`var/wrkq-artifacts/T-11816/main-route-usage-48h.txt`). T-11820 publishes the authoritative lists in `var/wrkq-artifacts/T-11820/`. Its 14-day revision read all retained server metrics plus the per-invocation CLI records on every node (`<stateRoot>/metrics/{server,cli}-<day>.ndjson`) and excluded proven test traffic. It found 77 routes to implement and 22 postponed, and 55 CLI paths to implement and 39 postponed. The 48-hour cut had missed real use, e.g. `GET /v1/attach` with 2,177 calls. A CLI command is used if it calls a used route and there's evidence it is run. The list is regenerated before each package grade and before N6. A postponed route that starts receiving traffic moves to the implement list of the next open package.
- **Order.** Within each package, T1 routes first: the steady loops of the kernel, the mail injector, ACP, the brokers and CLI status reads. Gates use those clients unchanged where possible.
- **CLI pass-through (N5).** `rusthrc <postponed command>` execs the same release's `packages/hrc-cli/bin/hrc.js` under bun with identical argv, stdio and exit code.
- **Daemon pass-through (N1).** `rusthrc server` forwards any route it does not implement, verbatim and including streams, to an optional configured Bun socket. With none configured, it returns the unknown-route envelope.
- **Postponed routes after the flip.** See "Both on every node": a Rust-owned node forwards only postponed routes that pass the front-safe read rule, to serve-only Bun. Every other postponed route is refused by Rust before any mutation, with a named error that is logged like any request. A refusal is evidence of use: implement the route or flip the node back.

## Both on every node: Rust front door

Lance ruling 2026-10-25: during the transition Bun and Rust both run on each node, as Bun and hrc-kernel do today. One process owns execution at a time. Bun's claims, broker control and event wakeups live in process-local state, so two owners on one store would race.

**Topology.** `rusthrc server` binds the node's public `hrc.sock`. Bun binds a private socket (`hrc-bun.sock`) in the same runtime dir and uses the same state root. Every client (CLI, kernel, mail injector, ACP, broker callbacks) reaches Rust. Rust answers what it may serve and forwards everything else verbatim, streams included. Execution owners connect to brokers directly over the brokers' own sockets, so broker IPC does not pass through the front.

| Stage | Execution owner | Rust answers natively | Forwarded to Bun |
|---|---|---|---|
| Front (package F) | Bun | The front-safe read set: routes proven free of side effects and of dependence on Bun process memory | Everything else, including streams until Rust has its own wake source |
| Flip (N6) | Rust | Every implemented route | Only postponed routes that pass the front-safe read rule, to serve-only Bun. Rust refuses every other postponed route before mutation (see below). |
| Rollback | Bun | Front-safe reads | Everything else |

**Front-safe read set.** Start from the side-effect-free read set pinned for the kernel in stage 1 (migration doc section 4), intersected with routes Rust implements and passes compare on. Routes that reconcile or record activity on read (e.g. `GET /v1/runtimes` liveness reconciliation, runtime capture) forward. Event streams and follows forward until Rust has a wake source that does not depend on Bun's in-process append hub, and its added latency is measured.

**Access logging moves to Rust.** Rust's front door logs every request it receives: `<stateRoot>/metrics/rusthrc-server-<day>.ndjson` plus L3 lines in rusthrc's own log, with the same schema, sampling, retention and suppression list as Bun, and `servedBy: native|bun`. When Rust forwards a request, Bun also logs it, in its own unchanged files (`server-<day>.ndjson`, `hrc-server.log`). The two never share a file. Rust forwards headers verbatim, including the client's User-Agent and request ID when the client sent one. Rust does not mint request IDs for forwarded requests: a request ID makes Bun keep the record unsampled, and doing that for forwarded hot polls would blow Bun's 128 MiB day cap. Both files keep Bun's sampling contract (first 10 per route-minute at weight 1, failures, slow requests and ID-carrying requests always kept, the rest 1-in-20 weighted). So the guarantee is about counts, not per-request records: per route and per hour, Rust's weighted count of `servedBy: bun` requests and Bun's weighted count of the same route reconcile within sampling error. Requests that carry a client request ID (the CLI sends one) join exactly across the two files. The usage audit counts Rust's file as the node's request population once a node is fronted, uses Bun's file as the forwarded subset, and never sums the two. The front-safe read set excludes routes that read Bun process state even though they are GETs: `GET /v1/status` (release, uptime, event loop), `GET /v1/server/subscribers` (live admission) and `GET /v1/transcript-index/status` (live indexer). CLI usage records are unchanged: one record per invocation, from whichever binary ran.

**Post-flip boundary.** After a node's flip Rust is the only authority writer. Serve-only Bun runs no controllers, recovery, timers, publishers, followers or listeners other than its private socket, and Rust sends it only postponed routes that pass the front-safe read rule. Every other postponed route is refused at Rust's front door before anything is written, with error `postponed_on_rust_owner` naming the route, recorded in Rust's access log. This covers routes that write authority or lifecycle state without needing a broker controller, e.g. `POST /v1/federation/retire` (Bun's process-local scope lock, placement retirement, registry delete) and `POST /v1/surfaces/unbind` (binding write and `surface.unbound`). A refusal on a real node is evidence the route is used: implement it in the next open package, or flip the node back to Bun. N6's procedure inherits this boundary.

**Bun changes (package F):** (1) a configurable listen socket path, so Bun can sit behind Rust on the same runtime and state dirs. Default unchanged. (2) Serve-only mode is N6's. Neither is a feature flag. Each is a deployment role chosen by the node's service config.

**Failure and rollback.** Rust in the request path is a new single point of failure for the node API. launchd keeps rusthrc alive. Rollback from the front stage: stop rusthrc, restart Bun on `hrc.sock`. Brokers reattach across HRC restarts as today. Moving Bun's socket takes one HRC restart per node.

## Packages

The critical path is N0 → N1 → N2 → N3 → N4 → N6. N5 can start after N1 and qualifies each command once its daemon package lands. F (front door) follows N1 and runs alongside N2–N4. Packages alternate between clod and cody task seats, and a large package splits by family.

| Package | Delivers | Closes when (each a real workflow on isolated scratch; Bun daemon down for the Rust subject) |
|---|---|---|
| **N0 Re-baseline** | Regenerate the coverage report from main. Delete the frozen `inventory.json`/`store-schema.json` hash pins and the two hrc-core types they keep alive (`HrcCompiledRuntimePlanRecord`, `HrcLifecyclePolicyRecord`). Keep `cases.json` and the nine mandatory runner workflows, pruned of deleted surface. | (1) The runner baseline passes against installed Bun on scratch. (2) A deliberately broken subject fails it. (3) The coverage report lists every route, CLI command and job on main with no unmapped line. |
| **N1 Native daemon foundation** | `crates/hrc-store` (canonical mappings, transactions, schema guard, ledgers, FTS, spill) and `crates/hrc-native` (listener, config, status, credentials, sessions, claims, placement, ASP preparation, runtime provisioning, participant register/attach), including admission and the cold-birth branch of `/v1/turns` used by ordinary `hrc start -p`. Existing-seat turns and broker event projection remain N2; N1 holds unprojected events without ACK. | (1) Unchanged Bun `hrc` against the Rust daemon: a cold `hrc start` births a real seat, and `hrc status`/`runtime list` agree with the store. (2) Stop Rust, start Bun on the same scratch state: Bun replays held birth events through the first prompt’s `turn.completed`, then completes a second turn on the same seat. (3) An unknown or incomplete schema is refused with no writes. (4) Clean shutdown leaves the brokers alive. |
| **N2 Broker turns and recovery** | Controller over the existing external brokers: raw ingest, projection, ACK, replay and gaps; input and submissions; capture; context, continuation and restart; startup recovery and recurring sweeps. | (1) A real turn runs to `turn.completed` on the Rust daemon. (2) The Rust daemon restarts mid-turn: brokers reattach and the turn completes with no duplicate. (3) A human-typed turn with no run row is recorded. (4) Every startup and recurring job in the coverage report runs once in the window. |
| **N3 Messages and streams** | DM, handoff, query, wait and watch; response finalization; lifecycle, raw and message streams; wrkq session and server publication with cursors. | (1) `wrkc say` to a seat on the Rust daemon gets exactly one reply, including across a daemon restart between delivery and reply. (2) The kernel follows Rust's event stream across replay into live with no gap or duplicate. (3) A lost publication ACK recovers with no duplicate publish. |
| **N4 Federation, operations, kernel** | Whatever peer, registry and ingest surface survives T-11712; transcript index and search; diagnostics; native packaging and status; the kernel projecting from the native ledger. | (1) Mixed Bun and Rust scratch nodes deliver mail and a reply in both directions. (2) Transcript search returns the same hits as Bun on the same store. (3) The installed Rust release reports its own `sourceCommit` and owner identity, so a proxy cannot pass. (4) Loggia attaches to a seat through the native kernel. |
| **N5 `rusthrc`** | A Rust CLI for every `hrc` command in the coverage report, with the same arguments, JSON/NDJSON output, exit codes and PTY attach. The TS SDK stays for TS clients. | (1) The runner's CLI cases pass with `rusthrc` against both daemons. (2) Real PTY `attach` and `monitor` work. (3) Unchanged Bun `hrc` still passes against the Rust daemon. |
| **F Front door** | Bun configurable listen socket; rusthrc front mode with the front-safe read set and verbatim forwarding; separate-file access logging; launchd service for rusthrc; deploy hrcdev → svc → max3 with Bun still execution owner. | (1) On scratch, a rusthrc front with Bun behind on the same state root serves the front-safe reads natively and forwards everything else, and the unchanged CLI, kernel, injector and a real turn all work through it. (2) The two logs reconcile. At a test rate below the per-route-minute unsampled head, every request appears exactly once in `rusthrc-server-*`, forwarded ones exactly once more in Bun's `server-*`. CLI requests (client-supplied IDs) join exactly, SDK requests without IDs match by route and minute count. No file is written by both. On hrcdev's 24h fronted run, per-route hourly weighted counts are reported side by side, measured, not gated. (3) Rollback (stop rusthrc, Bun back on `hrc.sock`) restores service with brokers reattached. (4) hrcdev runs fronted for 24h with no request errors attributable to the front, then svc, then max3. |
| **N6 Node handoff** | A reviewed per-node switch procedure: close admission, settle or record pending work, stop the old owner without killing brokers, start the new one, verify. Rollback is the same procedure in reverse. | (1) On scratch, Bun → Rust → Bun keeps the same seats, history and pending input, with one owner at a time and a real turn after each switch. (2) Then hrcdev, then svc, then max3, each authorized separately by Lance. |

## Progress

As of 2026-10-26 07:40Z. The wrkq tasks are authoritative. This section records package state and the scope moves made since r2.

| Package | Task | State |
|---|---|---|
| N0 | T-11817 | Closed. |
| N1 | T-11818 | Closed at ff24579a: gates 1–4 pass, 0 GAP:N1. |
| N2 | T-11823 (clod) | Active. Landing 1 (61c733d5) owns the broker event path: projection, ACK after commit, replay. |
| N3 | T-11839 (cody) | Active. |
| N4 | — | Not started. |
| N5 | T-11819 (cody), N5b T-11821 | All 55 implement commands native and installed (8d7c3502). Remaining: Rust-only server help, the launch/commands split, aggregate gates. |
| F | T-11822 (clod) | Landed through a002f77a. hrcdev enable is pending a Claude login on the hrcdev seat; then 24h, svc, max3. |
| N6 | — | Not started. |

Scope moves since r2:
- `GET /v1/presentation/runtimes` and `POST /v1/presentation/seats/read` move N4 → N3. The unchanged kernel needs both to bootstrap, and N3's gate 2 is the unchanged kernel.
- Native server lifecycle moves to N5 as one owner: `POST /v1/server/lifecycle` (from N4) and the `server.started` / `shutting_down` / `stopped` ledger rows with grant attribution. N5 writes them through N2's append path, only on a non-front daemon; the front role stays writer-free.
- The 11 slow-statement telemetry items (`hrc-store-sqlite/src/statement-telemetry.ts`) move N5 → N4. Only the daemon instruments statements.
- Continuation on `aspc.compileHarnessInvocation` is assigned to N2, including births on a scope with a stored continuation. N1's fresh-scope gates missed it; agent-spaces T-11833 found it.
- The claude-code-tmux Stop-fallback duplicate `turn.message` (agent-spaces T-11837) was an N6 blocker. A fast Stop-hook mail decision raced the transcript reader; the measured rate was 38% on Stop paths under ~100 ms. It was fixed and deployed to max3 aspd a34f6e14 on 2026-10-26 08:39Z, with svc and hrcdev following. Seats keep the old broker until rebirth.

Rule added after an incident: a scratch Bun daemon started from the installed tree deleted production's running release (2026-10-26 04:50Z). Scratch Bun daemons run only from a `cp -R` of the release with an atomic-mode refusal. T-11830 (02661aeb) makes every release prune keep any release a live process holds.

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
