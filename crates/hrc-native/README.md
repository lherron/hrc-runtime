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
without file changes, durable session creation and repeat resolution, one
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

Every main-listener request, including pass-through traffic and refusals, uses
Bun's normalized route labels, client strata and weighted metric schema in
`<stateRoot>/metrics/server-<day>.ndjson`. The writer flushes asynchronously and
on clean shutdown, bounds the queue, caps each day at 128 MiB, and retains 14
days by file mtime. L3 logs use Bun's successful-poll suppression policy and
stream open/close events. `HRC_METRICS=0` disables metrics as it does in Bun.
The exact-route inventory and suppression table are generated from Bun source
at build time. `e2e/accounting.py` compares a real Bun/native request mix through
`compare --suite n1-accounting`, then checks failed-writer recovery, retention,
and the daily cap in independent scratch roots.
