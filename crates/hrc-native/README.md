# rusthrc daemon

`cargo build --manifest-path crates/Cargo.toml -p hrc-native` builds
`crates/target/debug/rusthrc`. Run `rusthrc server` (or `server serve`) with
`HRC_RUNTIME_DIR` and `HRC_STATE_DIR` pointing to isolated scratch roots.
The database must already have the exact current Bun migration set. Rust
never creates or migrates it. Production installation is not authorized by N1.

The first N1 landing provides schema admission, the Unix HTTP listener,
Bun-compatible ownership files, health/status, session resolve/list/by-host,
and stored runtime listing. Other routes answer Bun's unknown-route 404.
ASP-backed declaration and placement observation now share a native NDJSON
JSON-RPC client. Status probes the actual configured aspd. Observation creates
no broker or runtime rows. The cold format-1 `/v1/turns` path now compiles via
ASP, commits the frozen preparation before hosting, starts the external worker
in its own tmux server, and persists the canonical start graph. Startup
reattaches these durable brokers after checking their release and endpoint
roots. Existing-seat turns name N2 in the unknown-route refusal.

## Broker event path (N2)

`server/controller.rs` owns the external brokers' event streams. Each
`invocation.event` envelope commits its raw `broker_invocation_events` row, its
hash disposition, the HRC state it implies and its canonical `hrc_events` rows
in one transaction (`server/projection/`, a port of Bun's BrokerEventMapper);
the broker is ACKed only through the durable contiguous cursor
(`broker_invocations.last_projected_seq`). Raw `*.delta` fragments stay in the
broker ledger and only their contiguous high-water is recorded. A reattach
replays `invocation.eventsSince` from that cursor and re-ACKs even when the
replay is empty; arrival gaps are backfilled from the ledger after a short
debounce. Format-2 invocations are refused (none exist in production).

## Turn doors (N2)

`POST /v1/turns` and `POST /v1/submissions/invoke` run Bun's nine-step
admission (`server/turns/admission.rs`) and record its trace as
`submission.admission`. A live broker seat takes the turn through
`controller::submit` (invoke falls back to the queue class without the
exclusive admission class); otherwise the turn births a seat. Responses are
Bun's receipt and wait-stage projection (`accepted` 202, `turn_started`,
`terminal`), including idempotent replay. Every compile sends Bun's request:
the normalized intent, `dispatchEnv` (also top level), `aspHome`, and the
session's stored continuation unless reuse is disabled. Not yet native:
stale-generation auto-rotation and fresh-context rotation (refused with
`runtime_unavailable`), participant delivery, and format 2. Every committed
ledger write bumps `Server.ledger` (a data-free watch counter followers re-query on).

The preempt door's authority is `turns::admission::preempt_admission`, which
asks capability first, then the operator principal, then turn ownership.

Runtime doors (N2): `GET /v1/runs` (`server/runs.rs`, Bun's filter parse and
ordering; scope-home forwarding is N4), `POST /v1/interrupt` and
`/v1/terminate` (`server/control.rs`: tmux C-c or broker interrupt; broker
stop → dispose → close within 15 s, lease teardown, `runtime.terminated`),
`GET /v1/attach`, `GET /v1/capture`, `POST /v1/capture/by-selector`,
`/v1/runtimes/capture/status` and `/v1/runtimes/broker/inspect`
(`server/io.rs`). `POST /v1/literal-input/by-selector` (`server/input.rs`)
buffers broker literal text until Enter, sends an empty Enter to the pane, and
flushes the prompt through admission as door `literal-flush`.
`POST /v1/active-run-contributions` records `active_input_deliveries`, types an
answer into a pending AskUserQuestion, and otherwise recommends the queue.
`POST /v1/runs/prepare-attached` and `/v1/runs/resume-attached`
(`server/attached.rs`) are the `hrc run` door. A live seat answers `started`.
A birth (promptless, or with a prompt through admission door
`prepare-attached`) parks after its start graph commits (`broker::AttachGate`),
answers `prepared` with the attach descriptor, and starts its invocation only
after resume and an attached tmux client. `e2e/n2_attached.py` drives the
unchanged Bun `hrc run` on a pty for `--suite n2-attached`.
`POST /v1/clear-context` (`server/context.rs`) is rotateSessionContext: the
continuity fence, every live runtime of the host disposed and finalized,
surfaces unbound, the session archived and its successor (generation + 1)
activated in one transaction, `context.cleared` and `session.created`, and an
optional relaunch. Admission now rotates a stale generation
(`session.generation_auto_rotated`, skipped while a live tmux runtime holds it)
and a `freshContext` submission. `POST /v1/sessions/drop-continuation` disables
continuation reuse once (`session.continuation_dropped`).
Sweeps (`server/sweeps.rs`, `server/reconcile.rs`): `POST /v1/runs/sweep-zombies`
and `/v1/runs/reconcile-active` plus their 300 s jobs (at boot, then on cadence),
the daily session retention archive and the 300 s tmux aging pass (the runtime
sweep with reason `runtime_tmux_aging`), all inside `!front`. Not yet native:
the accepted-never-started settlement in reconcile (T-11306) and the retained
evidence passes. Startup cold-boot input recovery (`server/recovery.rs`)
re-delivers an accepted headless run's durable owed prompt once the seat probes
live and its priming turn has ended, or fails it `cold_input_continuation_lost`
(`e2e/n2_recovery.py`, `--suite n2-recovery`).
A broker client's `close()` half-closes and drains the
frames the broker already sent (`invocation.disposed` follows the dispose
reply). While a terminate finalizes a runtime, its projected exit writes no
second terminal record. Not yet native: final-summary recovery on inspect,
external-participant terminate (both refused with `runtime_unavailable`), and
the retained-evidence terminal outcome.

`e2e/n2_routes.py` records per-case requests on a real seat for
`run.py compare --suite n2-routes`. `e2e/n2_continuation.py` re-births a seat
on a stored continuation behind a logging aspd proxy; `--suite
n2-continuation` compares both compile requests field for field and requires
the re-born harness to recall the first birth's code word.

`e2e/n2_turns.py` runs one workflow on a named Bun copy or rusthrc; compare
two dumps with `run.py compare --suite n2-turns`. Each side's raw rows are
checked against its own broker ledger, then the sides are compared on raw key
order, run/runtime rows, per-turn lifecycle shapes, Skill rows and the
human-typed turn. `e2e/n2_restart.py` restarts rusthrc mid-turn and then hands
the seat to the Bun copy for another turn.

Session continuity and layered metadata reads/writes now preserve Bun lane
formatting, validation, source precedence, lifecycle events and idempotent writes.
Session lists expose the same count headers and resolved title. Live refs read
the committed runtime ledger. Participants, complete admission/error semantics
and remaining observed-use N1 routes are still in progress; this does not claim
N1 parity. Direct-store readers use `Store::open_readonly`; the daemon uses
`Store::open`.

Schema admission extracts migration names from the checked-out Bun migration
source graph at build time. It checks both a read-only connection and the
write handle before any pragma or write. Missing or extra names refuse boot.
Shutdown closes the listener/store and removes only this owner's control
socket and ownership files; it never kills a broker.

The workflow test creates its schema with Bun's real migrator, then drives the
native binary as a subprocess. It tests unknown/incomplete schema refusal
without main-database changes, durable session creation and repeat resolution, one
lifecycle row, a refused competing owner and graceful shutdown:

```
python3 crates/hrc-native/e2e/foundation.py \
  --binary crates/target/debug/rusthrc --artifacts /tmp/hrc-native-results
```

For installed Bun scratch comparisons, copy the named installed release under
the scratch root with a parent other than `hrc-runtime-releases`. A daemon
running from the actual atomic release tree can prune shared releases even
when runtime/state roots are isolated. The copy must report `unmanaged`, emit
no `server.start.release_prune`, and leave the shared release list unchanged.

The real birth/replacement workflow runs in a clean ghostmux terminal with an
explicit named copied Bun release and the shared aspd socket. It requires a fresh
scratch root, creates its own project and ledger, and cleans only its own broker
leases. It verifies native birth and projection, native restart ownership, and
a second completed prompt on the same seat under Bun:

```
python3 crates/hrc-native/e2e/cold_birth.py --binary crates/target/debug/rusthrc \
  --bun-release /tmp/hrcn1-T11818/bun-release/release-20261025170058436-58302 \
  --aspd-socket /Users/lherron/praesidium/var/aspd/run/aspd.sock \
  --scratch-root /tmp/hrcn1-fresh --artifacts /tmp/hrcn1-results
```

`rusthrc server [serve] --bun-socket <abs>` forwards unimplemented routes to a
separately managed Bun listener (an explicit argument; the environment carries
no role, and `HRC_BUN_PASSTHROUGH_SOCKET` is no longer read). Rust preserves the
request method, URI, headers and streaming body, and relays response status,
headers and body without buffering live responses. It never launches Bun; an
unreachable Bun answers 502 `runtime_unavailable` per request. Without the
argument, unimplemented routes return the ordinary 404. N1 tests
use separate native/Bun state roots; N6 owns the serve-only production design.

`e2e/passthrough.py` drives that separate-state workflow against the named Bun
copy, including large requests, malformed JSON, query strings, postponed N1
routes and a live bounded-event stream.

## Front-door role (T-11822)

`rusthrc server --front --bun-socket <abs>` is the node's front door. It binds
the public `<runtime>/hrc.sock` while Bun, still the execution owner, runs
`hrc server serve --listen-socket <runtime>/hrc-bun.sock` on the same runtime
and state dirs. The front natively serves only the front-safe reads in
`src/server/front.rs` (pinned kernel read set intersected with compared,
implemented routes) and forwards every other request verbatim, streams
included. It opens the store read-only, reattaches no brokers, mints no IDs,
and keeps its own `rusthrc-front.lock`/`.pid` (a flock, so launchd can respawn
it after a crash) beside Bun's `server.lock`/`server.pid`. It refuses to start
without a reachable `--bun-socket` or beside a live listener on `hrc.sock`.
Brokers keep the public socket as `HRC_MAIL_STOP_SOCKET`. The plain native
role refuses an explicit non-default `--listen-socket`.

On a node, `just front-door-enable '<reason>'` and `just front-door-disable
'<reason>'` move between the two modes (one HRC restart each; Mable seats with
restart authority on the node only), and `just front-door-status` reports the
mode. The rusthrc job is `launchd/com.praesidium.rusthrc-server.plist`, which
`launchd-install` skips (front-door-enable is its only renderer); on a fronted
node `launchd-install` keeps Bun's `--listen-socket`. Nodes whose installed Bun plist predates the
`var/logs/hrc-runtime/` L1 paths (svc and hrcdev on 2026-10-26) align them with
`bun scripts/front-door.ts l1-logs ~/Library/LaunchAgents/com.praesidium.hrc-server.plist`,
which takes effect at the job's next bootstrap (front-door-enable is one). Its L1 logs are
`var/logs/hrc-runtime/rusthrc-server.log` (stdout, which carries the L3 request
lines, as Bun's `hrc-server.log` does) and `rusthrc-server.err.log` (stderr);
access metrics stay in
`<stateRoot>/metrics/rusthrc-server-<day>.ndjson`.

`e2e/front_door.py` is the scratch workflow for gates 1-3: Bun on the private
socket, front refusals, the installed `hrc` CLI and a real model turn through
the front, front-safe native reads against Bun, verbatim forwarding and live
streams and a scratch mail injector through the front (front mode hosts no kernel), the
low-rate log reconciliation, SIGKILL recovery, and rollback with the broker
reattached. Run it from a clean ghostmux terminal:

```
python3 crates/hrc-native/e2e/front_door.py --rusthrc crates/target/debug/rusthrc \
  --bun-release /tmp/hrcf-rel-T11822 \
  --aspd-socket /Users/lherron/praesidium/var/aspd/run/aspd.sock \
  --injector 0.1.0-dev.20261023155744 --scratch-root /tmp/hrcf/1 --artifacts /tmp/hrcf-results
```

Every main-listener request, including pass-through traffic and refusals, uses
Bun's normalized route labels, client strata and weighted metric schema in
`<stateRoot>/metrics/rusthrc-server-<day>.ndjson`, with `servedBy` identifying
`native` or `bun`. Rust prunes only its own filename prefix. The writer flushes asynchronously and
on clean shutdown, bounds the queue, caps each day at 128 MiB, and retains 14
days by file mtime. L3 logs use Bun's successful-poll suppression policy and
stream open/close events. `HRC_METRICS=0` disables metrics as it does in Bun.
The exact-route inventory and suppression table are generated from Bun source
at build time. `e2e/accounting.py` compares a real Bun/native request mix through
`compare --suite n1-accounting`, then checks failed-writer recovery, retention,
and the daily cap in independent scratch roots. `e2e/front_accounting.py` checks
separate Rust/Bun metric files and L3 streams, exact low-rate counts, verbatim
User-Agent and optional client request IDs, and upstream-error versus local
transport-failure attribution through `compare --suite n1-front-accounting`.
Forwarding never generates a request ID; both writers retain Bun's sampling
contract. Rust L3 records identify `server: rusthrc` and `servedBy`.

`e2e/schema_refusal.py` records the full gate-3 filesystem effect for unknown
and incomplete migrations, including a live WAL: main DB bytes/mtime stay
unchanged, WAL gains no frames, and ownership files remain absent. SQLite may
create or change its SHM index; one failed daemon CLI usage record is expected
(EN-35424). No immutable connection or copied read path is used.

`e2e/session_projection.py` compares historical session lists through
`compare --suite n1-session-projection`: activity windows, live-runtime
exceptions, generation selection, ordering, scoped history, query errors and
configured projection days. Its fixtures are new scratch rows.

Local session pages and facets query the trigger-maintained session index with
Bun's filters, excluded facet dimensions and v5 keyset cursors. The index
workflow checks titles, nonempty pages, cursor termination, malformed input,
and each owner's actual ledger high-water. Peer aggregation remains N4's
federation workflow. Native query parsing preserves URLSearchParams semantics,
including the first duplicate value and lossy UTF-8 decoding.

Runtime list, inspect, injector seat and target reads share persisted hosting
projections and the live broker seat probe. Runtime lists validate filters,
terminal visibility and keyset cursors, decorate continuity identity, and read
first-turn health trips. Inspect redacts token references and exposes reported
model/context, control and hosting facts. Both successful and failed seat
observations are retained. Reattach refreshes owner diagnostics while retaining
only the previously recorded ACK position; it sends no event ACK.

`e2e/runtime_reads.py` births and completes a real blank seat through the named
Bun CLI, establishes a real acknowledged checkpoint, and compares sequential
Bun/native readers of the same scratch snapshot. It includes historical terminal
rows, pagination, filters and error cases. Bun finishes its legacy historical-row
startup classification before the shared snapshot; the N2 startup job is not
claimed by this N1 read case. `compare --suite n1-runtime-reads` verifies full
responses and persisted probes, bounding dynamic timestamps and ages before
normalization.

Runtime attachment returns the realized tmux descriptor and binding fence.
Surface binding validates the host/generation fence and commits the binding,
TTY displacement and lifecycle facts in one transaction. An identical retry
returns the prior row without another event. `e2e/runtime_surfaces.py` reuses the
real-seat workflow and `compare --suite n1-surfaces` compares descriptors,
errors, complete binding rows and event payloads. Timestamp normalization first
checks request bounds and the committed row/event correspondence.

Target ensure mints a local session address and continuity without launching a
worker. It persists the supplied intent unless `persistIntent` is false, returns
the existing address on retry, and refuses reserved participant addresses.
`e2e/target_placement.py` compares real ASP placement, target creation, intent
updates, role identities and selector errors. `compare --suite
n1-target-placement` checks full responses, session/continuity rows and creation
facts; new identifiers are mapped bijectively after their shape and clocks are
checked. Archived continuation succession belongs to N2; federated summon
authority belongs to N4.
