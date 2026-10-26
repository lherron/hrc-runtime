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
in its own tmux server, and persists the canonical start graph. The worker's
notifications remain unACKed for Bun recovery. Startup reattaches these durable
brokers after checking their release and endpoint roots. Existing-seat turns
name N2 in the unknown-route refusal.

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
leases. It verifies native birth, native restart ownership, held-event replay
through Bun, and a second completed prompt on the same seat:

```
python3 crates/hrc-native/e2e/cold_birth.py --binary crates/target/debug/rusthrc \
  --bun-release /tmp/hrcn1-T11818/bun-release/release-20261025170058436-58302 \
  --aspd-socket /Users/lherron/praesidium/var/aspd/run/aspd.sock \
  --scratch-root /tmp/hrcn1-fresh --artifacts /tmp/hrcn1-results
```

Set `HRC_BUN_PASSTHROUGH_SOCKET` to an absolute Unix socket path to forward
unimplemented routes to a separately managed Bun listener. Rust preserves the
request method, URI, headers and streaming body, and relays response status,
headers and body without buffering live responses. It never launches Bun.
Without this setting, unimplemented routes return the ordinary 404. N1 tests
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
node `launchd-install` keeps Bun's `--listen-socket`. Its L1 logs are
`var/logs/hrc-runtime/rusthrc-server.log` (stdout, which carries the L3 request
lines, as Bun's `hrc-server.log` does) and `rusthrc-server.err.log` (stderr);
access metrics stay in
`<stateRoot>/metrics/rusthrc-server-<day>.ndjson`.

`e2e/front_door.py` is the scratch workflow for gates 1-3: Bun on the private
socket, front refusals, the installed `hrc` CLI and a real model turn through
the front, front-safe native reads against Bun, verbatim forwarding and live
streams, the kernel and a scratch mail injector through the front, the
low-rate log reconciliation, SIGKILL recovery, and rollback with the broker
reattached. Run it from a clean ghostmux terminal:

```
python3 crates/hrc-native/e2e/front_door.py --rusthrc crates/target/debug/rusthrc \
  --kernel crates/target/debug/hrc-kernel --bun-release /tmp/hrcf-rel-T11822 \
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
