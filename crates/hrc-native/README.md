# rusthrc daemon

`cargo build --manifest-path crates/Cargo.toml -p hrc-native` builds
`crates/target/debug/rusthrc`. Run `rusthrc server` (or `server serve`) with
`HRC_RUNTIME_DIR` and `HRC_STATE_DIR` pointing to isolated scratch roots.
The owner creates or migrates `state.sqlite` at boot under the store lock
(`state.sqlite.lock` beside it), before binding any socket; an empty state
directory needs no init step and no Bun (T-12840). `rusthrc store migrate
<path>` does the same for fixtures and refuses `store_owned` while a daemon
holds the store. Production installation is not authorized by N1.

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

## Owner install and code identity (T-12224)

A node's rusthrc owner runs from `~/praesidium/var/hrc-owner` (`OWNER_ROOT`),
which neither `just install` nor a release prune touches:

```
var/hrc-owner/
  bin/rusthrc                  the exe launchd runs: a real file, signed per node
  codesign.identity            optional: one line, the signing identity's common name
  hrc-runtime-current -> hrc-runtime-releases/release-<id>
  hrc-runtime-releases/release-<id>/   staged copies of installed releases
```

`scripts/hrc-owner.sh stage` copies the installed release into
`hrc-runtime-releases/`, then copies its `bin/rusthrc` to `bin/rusthrc` through
a temp file and a rename. It never writes or signs the exe in place, so a running
owner keeps the inode it started from. rusthrc finds its release from that fixed
path through the sibling `hrc-runtime-current` link, once at start
(`hrc_common::release`). The release capture, the lifecycle rows, `hrc-pty` and
`--version` all come from that root, and the boot check that the manifest's
sourceCommit equals the compiled one ties the exe to the link.

Why a fixed, signed path: macOS TCC keys a non-bundled binary's privacy grants
(for example removable volumes, which `var/wrkq-artifacts` →
`/Volumes/Scratch` needs on mini) on its resolved path plus its designated
requirement. An exe inside `release-<id>/` is a new path every release, and the
linker's ad-hoc signature is a new cdhash every build, so each release raised a
dialog that a launchd daemon cannot show. With a fixed path and a certificate
signature, the designated requirement is `identifier "com.praesidium.rusthrc"
and certificate leaf = H"<cert sha1>"`, the same for every build. The grant is
made once.

Signing: when `HRC_CODESIGN_IDENTITY` or `var/hrc-owner/codesign.identity` names
an identity, stage unlocks the signing keychain from its password file, runs
`codesign -f -s <identity SHA-1> --keychain <signing keychain>
-i com.praesidium.rusthrc --timestamp=none` on the temp file, then
`codesign --verify --strict`, and prints
the designated requirement. If signing fails, stage fails and replaces nothing.
It never falls back to ad-hoc when an identity is configured. When no identity
is configured, stage keeps the linker's ad-hoc signature and says so.

Rollback stages the older release, which re-copies and re-signs it into the same
`bin/rusthrc`. A release built before T-12224 cannot run from the fixed exe: it
reports itself unmanaged and looks for `hrc-pty` beside it. Once the plist execs
`bin/rusthrc`, stage refuses such a release before it moves anything. To roll
back past T-12224, first restore `<plist>.pre-fixed-exe`, then stop and
bootstrap the owner.

### One-time setup per node

1. Identity, as the login user (over ssh is fine; nothing needs a console):
   `scripts/macos-codesign-identity.sh create`. It creates the signing keychain
   `~/Library/Keychains/praesidium-codesign.keychain-db` with a random password
   in `~/praesidium/var/codesign/praesidium-codesign.keychain.password` (0600),
   turns its auto-lock off, adds it to the user search list, generates and
   imports `Praesidium Local Code Signing` (self-signed, codeSigning, 10 years),
   sets the key partition list (without it an ssh session gets
   `errSecInternalComponent` even with the keychain unlocked) and proves that
   codesign can use the key without a dialog. It is idempotent.
   Not the login keychain: an ssh session, which is where deploys sign, cannot
   use a login keychain unlocked at the console (`errSecInternalComponent`).
   `scripts/macos-codesign-identity.sh status --sign-probe` repeats the deploy's
   sign (unlock from the password file, sign by certificate SHA-1 with
   `--keychain`), so run it over ssh to confirm.
2. Opt the owner in:
   `echo 'Praesidium Local Code Signing' > ~/praesidium/var/hrc-owner/codesign.identity`.
3. Move the plist to the fixed exe:
   `just refresh-owner-exe <node>` prints the stage dry run and the plist diff;
   `just refresh-owner-exe <node> apply` stages and signs the installed
   release, rewrites only the plist's exec path (the old plist is kept as
   `<plist>.pre-fixed-exe`), runs `hrc server stop --node` (authorized
   daemon-side), bootstraps the refreshed plist and runs the deploy readback.
   A plain restart would respawn launchd's loaded definition. The refresh needs a
   running release that ships T-12224; it refuses an older one.
4. At the node's console, grant Full Disk Access once to
   `var/hrc-owner/bin/rusthrc` (System Settings → Privacy & Security → Full
   Disk Access → +). Harnesses that HRC spawns count rusthrc as their
   responsible process, so this one grant is meant to replace the separate
   removable-volume, network-volume and Desktop/Documents/Downloads prompts;
   the TCC readback below shows whether it did.

After that, every `deploy-*` stages and signs the new release into the same
path, and the readback prints the exe's designated requirement.

### Verify

```bash
exe=~/praesidium/var/hrc-owner/bin/rusthrc
test -f "$exe" && ! test -L "$exe"
codesign -dvv "$exe"     # Identifier=com.praesidium.rusthrc, Authority=Praesidium Local Code Signing
codesign -dr - "$exe"    # designated => identifier "com.praesidium.rusthrc" and certificate leaf = H"..."
hrc server status --json | jq '{binaryPath, mode: .release.mode, id: .release.releaseId, sha: .release.hrcBuild.sourceCommit}'
```

TCC readback (the TCC database is readable by the login user; writing it is
macOS's job):

```bash
db=~/Library/Application\ Support/com.apple.TCC/TCC.db
sqlite3 "$db" "select client, client_type, auth_value, hex(csreq) from access
  where service='kTCCServiceSystemPolicyRemovableVolumes' and client like '%rusthrc'"
# One row, client = the fixed path. Decode its csreq and check the current build:
sqlite3 "$db" "select hex(csreq) from access where service='kTCCServiceSystemPolicyRemovableVolumes'
  and client='$exe'" | xxd -r -p > /tmp/rusthrc.csreq
csreq -r /tmp/rusthrc.csreq -t                 # prints the requirement text
codesign --verify -R /tmp/rusthrc.csreq "$exe" # passes for every build signed by the identity
```

`scripts/hrc-owner-codesign-e2e.sh <old-release> <release-b> <release-c>` proves
the mechanism headlessly on temporary keychains (made by `create`, plus a
same-named decoy certificate in another keychain): sign, designated requirement,
the same requirement across builds, the ad-hoc fallback, refresh-plist, a scratch
daemon reporting its release from the fixed exe, rollback, and the pre-T-12224
refusal. Its transcript and `result.json` go to the task artifact dir. The
per-node recipe for other daemons is
`~/praesidium/var/agents/references/macos-code-signing.md`.

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

This section is the canonical description of how a turn reaches a seat. Other
documents point here.

Two doors start a turn from a prompt, and they are not equivalent.

- `POST /v1/submissions/invoke` is the door for "deliver this message to this
  seat, starting the seat if it is cold". With `runtimeIntent` and `coldBirth`
  it births a seat that has a session but no runtime and delivers the prompt
  as that seat's first turn, in one call and one turn. It forwards the
  caller's `turnPolicy` (`open` or `guarded`) and adds none when the field is
  omitted, so the turn accepts steers unless the caller asks otherwise. It is
  keyed by `idempotencyKey` per host session. It requires an existing session
  row: for a seat that has never existed, call `POST /v1/targets/ensure`
  first. A birth on an existing session continues that session's kept
  conversation; `freshContext: true` forces a new one. `coldBirth.promptMode`
  is validated, but only the presence of `coldBirth` has an effect: the
  request answers 202 at launch and the prompt is always appended to priming.
  Mail delivery uses this door (ensure, then invoke).
- `POST /v1/turns` is the door for a caller that owns the turn's outcome. It
  alone carries `fences`, `attachments`, `repair`, `firstTurnTimeoutMs`, the
  `turn_started` wait and exact host-session pinning. It forces
  `turnPolicy: guarded` (`server/turns/turns/mod.rs`), so a steer into its turn
  is refused until the turn ends. `hrc start -p`, `hrc resume --no-attach -p`
  and the kernel's `seat.summon` with a message use it.

Neither door requires a seat to be started first and messaged second. The
keyed claim-and-start API (`POST /v1/runtimes/start` with a session ref) is
the one place with a two-step contract: it binds `initialPrompt` into the
claim but never delivers it, and its caller follows with `/v1/turns`. A start
with no message that should continue a stopped seat's conversation is
`POST /v1/sessions/resume-continuation` followed by a start of the returned
host session (`hrc resume`, hrc-domain `seat.summon` with
`continuation: "resume"`).

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
An optional `idempotencyKey` (`hrc send --idempotency-key <key>`) reserves an
`active_input_deliveries` row before delivery, scoped to the resolved host
session. An identical retry returns the saved response with `replayed: true`;
a changed request returns HTTP 409 `idempotency_key_conflict`. A reservation
without a saved response returns `status: pending`, `uncertain: true` and
`delivered: false`, including after a crash; retries never redeliver it.
Unkeyed input keeps delivering on every request. The HTTP integration regression
is `cargo test --manifest-path crates/Cargo.toml -p hrc-native literal_input_idempotency_http`.
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
(`e2e/n2_recovery.py`).
A broker client's `close()` half-closes and drains the
frames the broker already sent (`invocation.disposed` follows the dispose
reply). While a terminate finalizes a runtime, its projected exit writes no
second terminal record. Not yet native: final-summary recovery on inspect,
external-participant terminate (both refused with `runtime_unavailable`), and
the retained-evidence terminal outcome.

`e2e/n2_routes.py` records per-case requests on a real seat for
`run.py compare --suite n2-routes`. `e2e/n2_continuation_harness.py` re-births
a seat on a stored continuation behind a logging aspd proxy and requires the
re-born harness to recall the first birth's code word.

`e2e/n2_turns.py` runs cold and Skill-tool warm turns on rusthrc and checks
the raw rows against the seat's own broker ledger. `e2e/n2_restart.py`
restarts rusthrc mid-turn, then restarts it idle and takes another turn.

Session continuity and layered metadata reads/writes now preserve Bun lane
formatting, validation, source precedence, lifecycle events and idempotent writes.
Session lists expose the same count headers and resolved title. Live refs read
the committed runtime ledger. Participants, complete admission/error semantics
and remaining observed-use N1 routes are still in progress; this does not claim
N1 parity. Direct-store readers use `Store::open_readonly`; the daemon uses
`Store::open`.

Schema admission compares the store with the build's set: today still the
names `build.rs` extracts from the frozen TypeScript graph, which equal
`hrc_store::migrate::LEGACY_IDS` (A3 moves admission onto the Rust lists). It checks both a read-only connection and the
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

Native cold birth, restart and retained-seat ownership are exercised by
`e2e/n2_restart.py` and `e2e/hrcpty_substrate.py`. The substrate drive uses a
private compiler and deterministic broker, needs no model credentials, and
cleans its own runtime/store/process roots:

```
python3 crates/hrc-native/e2e/hrcpty_substrate.py \
  --binary crates/target/aarch64-apple-darwin/debug/rusthrc \
  --root /tmp/hrc-substrate --artifacts /tmp/hrc-substrate-evidence
```

The separate-state Bun proxy is retired. `--bun-socket` and `--front` are
refused; native owns execution and does not forward unsupported routes to Bun.
The old `e2e/passthrough.py` proxy driver was deleted in T-13058 because its
only execution path required those retired flags. Paired Bun/native owner
qualification for other features remains in the other e2e drivers.

## Historical front-door role (T-11822, retired)

The following describes the retired front mode; these flags now refuse.

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

The Bun front proxy is retired; its front-door probes were removed in
T-13074. Native owner recovery is checked by `e2e/server_owner.py`, and cold
birth/reattach by `e2e/n2_restart.py` and `e2e/hrcpty_substrate.py`.

Every main-listener request, including pass-through traffic and refusals, uses
Bun's normalized route labels, client strata and weighted metric schema in
`<stateRoot>/metrics/rusthrc-server-<day>.ndjson`, with `servedBy` identifying
`native` or `bun`. The writer flushes asynchronously and
on clean shutdown, bounds the queue, and caps each day at 128 MiB. Once a UTC day
it prunes every writer's dated day file (`<writer>-YYYY-MM-DD.ndjson`: its own,
the CLI's `cli-*`, a stopped Bun daemon's `server-*`, `script-*`) older than 14
days by file mtime; other names are never touched. L3 logs write every completed non-stream request and
stream open/close events. `HRC_METRICS=0` disables metrics as it does in Bun.
The exact-route inventory is generated from Bun source
at build time. `e2e/accounting.py` asserts native weighted request counts,
request and stream logs, then checks failed-writer recovery, retention and
the daily cap in independent scratch roots. It runs without a baseline.
Forwarding never generates a request ID; both writers retain Bun's sampling
contract. Rust L3 records identify `server: rusthrc` and `servedBy`.

`e2e/schema_refusal.py` records the full gate-3 filesystem effect for unknown
and incomplete migrations, including a live WAL: main DB bytes/mtime stay
unchanged, WAL gains no frames, and ownership files remain absent. SQLite may
create or change its SHM index; one failed daemon CLI usage record is expected
(EN-35424). No immutable connection or copied read path is used.

`e2e/session_projection.py` judges historical session lists on one native
owner over a native SQL seed: activity windows, live-runtime exceptions,
generation selection, ordering, scoped history, query errors and configured
projection days, each case a literal predicate (T-13125).

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

`e2e/runtime_reads.py` births a deterministic hrcpty seat through the native
owner (hrc-cli/e2e/native_seat.py) beside native historical terminal rows and
judges each read as a literal: pagination, filters, inspect, seat probes,
targets and error cases (T-13125). Reported-model qualification is separate.
The previous Bun-baselined capture harness is `e2e/seat_capture.py`, still
used by target_placement.py and runtime_surfaces.py.

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
