# HRC P0 compatibility runner

P0 freezes the Bun compatibility contract and exercises a real, isolated Bun
subject. `rusthrc` is the future Rust CLI. The installed `hrc` remains Bun.
The approved adoption records are `docs/proposals/hrc-rust-parity.md`,
`docs/proposals/hrc-rust-migration.md` and its architecture contract.

Run from this repository using Python 3.11+ and the workspace Bun dependencies:

```sh
python3 conformance/hrc-parity/run.py inventory --source-ref HEAD --schema-db /absolute/scratch/state/state.sqlite --out /absolute/artifacts/inventory
python3 conformance/hrc-parity/run.py controls --out /absolute/artifacts/controls
python3 conformance/hrc-parity/profile.py --scratch-root /tmp/hrcp0-NAME --release-root /absolute/frozen/release --cli /absolute/frozen/release/packages/hrc-cli/src/cli.ts --asp-evidence /absolute/artifacts/asp-resolution.json --node p0-NAME --out /absolute/artifacts/profile.json
python3 conformance/hrc-parity/run.py run --profile /absolute/artifacts/profile.json --out /absolute/artifacts/baseline
python3 conformance/hrc-parity/run.py compare --baseline /absolute/artifacts/baseline --candidate /absolute/artifacts/candidate --out /absolute/artifacts/comparison
```

For source investigation, pass the repository as release root, its
`packages/hrc-cli/bin/hrc.js` as CLI, and `--source`. Source results always remain
unqualified for installed acceptance. Worktree checks cannot certify canonical
installed behavior. Pin and retain the selected release during a run; pruning a
release is an infrastructure failure, not a successful command result.
`baseline-profile.json` is an admission example, never executable acceptance.
`profile.py` generates the concrete executable actions after real provisioning.

Exit codes are 0 PASS, 1 FAIL, 2 GAP, 3 INFRA_ERROR, with the highest present code
winning. Every invocation writes `summary.json`, `coverage.json`,
`cases.ndjson` and hashes. Runs additionally retain every raw response, SQL
observation, child stdout/stderr/exit, PTY bytes/client identity, drive record,
manifest, stream frames and cleanup result. Missing runner output, interruption,
empty checks, skipped cases, missing fields and baseline failures cannot pass.
Comparison revalidates raw case observations and correlation semantics, then
compares events/effects with an explicit bijection of allowed identity fields.
The synthetic `checker-control` claim can test the checker but cannot qualify a
baseline or full parity.

Inventory completeness means the source extractor resolved its registrations
and they equal the frozen inventory, including source hashes. It does not mean
that every item passed behavior tests. Every inventory obligation retains an
explicit GAP and downstream owner until that behavior is qualified. Full parity
requires clearing all such gaps; the nine mandatory P0 workflows cannot be moved
to downstream GAPs. A complete P0 Bun run is a compatibility baseline, not Rust
parity. Frozen actual SQLite tables, columns, FKs, indexes and SQL objects live
in `contract/hrc-parity/store-schema.json`; `--schema-db` compares an actual
readonly store with that snapshot.

## Provision the real subject

Use a fresh `/tmp/hrcp0-NAME` root and separate durable artifact directory.
Allocate one unique unused loopback port above 30000. Record root realpaths,
commands, PID/argv, listener and DB identities. Do not copy a production DB,
leases, credential file or peer registry. Provision the scratch wrkq database
with the ordinary installed `wrkqadm migrate` path (`WRKQ_DB` set explicitly).
Create a fresh mode-0600 random token file. The disposable authority runs in a
clean foreground terminal with these explicit settings:

```sh
unset WRKQD_NODE_TOKENS WRKQD_NODE_TOKENS_FILE WRKQD_UNIX WRKQ_DB_PATH WRKQ_DB_PATH_FILE
export WRKF_HOOK_CATALOG=/tmp/hrcp0-NAME/hook-catalog.json
export WRKQD_TOKEN="$(cat /tmp/hrcp0-NAME/wrkqd-token)"
exec wrkqd -addr 127.0.0.1:ALLOCATED_PORT -db /tmp/hrcp0-NAME/wrkq.db
```

The scratch catalog is
`{"schemaVersion":"wrkf.hook-catalog.v0","hooks":{},"effectHandlers":{}}`.
Store authority.json with `locator` (`rpc://127.0.0.1:ALLOCATED_PORT`), `port`,
`dbPath` and `tokenFile`; the locator and verified scratch DB are distinct.
Use an ordinary installed `wrkq projects --json` with the same locator/token to
initialize the real authority, then register a scratch `hrc-runtime` project at
its scratch project root. Remote wrkqd owns one workrpc server and ordinary
client initialization is a prerequisite. HRC's unpinned publication path does
not initialize it. Preserve a cold-authority refusal if observed; do not patch
Bun or weaken the publication assertion. A refused local cold authority is not
a replacement for successful real remote publication.

For **both** the foreground HRC owner and CLI/SDK children set:

```sh
export HRC_RUNTIME_DIR=/tmp/hrcp0-NAME/run HRC_STATE_DIR=/tmp/hrcp0-NAME/state
export ASP_AGENTS_ROOT=/tmp/hrcp0-NAME/agents HRC_PROJECT_SEARCH_ROOTS=/tmp/hrcp0-NAME/project
export HRC_WRKQ_DB=rpc://127.0.0.1:ALLOCATED_PORT WRKQ_DB=rpc://127.0.0.1:ALLOCATED_PORT
export HRC_WRKQD_TOKEN_FILE=/tmp/hrcp0-NAME/wrkqd-token WRKQD_TOKEN_FILE=/tmp/hrcp0-NAME/wrkqd-token
export WRKQD_TOKEN=''
export HRC_PEER_CONFIG_FILE=/tmp/hrcp0-NAME/federation.json
export HRC_EVENT_INGEST_SOCKET=/tmp/hrcp0-NAME/run/ingest.sock
export HRC_ACP_WEBHOOK_URL=''
export HRC_ASPD_SOCKET=/absolute/verified/aspd.sock
export HRC_BROKER_DURABLE_IPC_ENABLED=1 HRC_HEADLESS_CODEX_BROKER_ENABLED=1 HRC_CLAUDE_CODE_TMUX_BROKER_ENABLED=1
unset WRKQ_DB_PATH WRKQ_DB_PATH_FILE WRKQD_NODE_TOKENS WRKQD_NODE_TOKENS_FILE WRKQD_UNIX
unset HRC_EVENT_FORWARD_URL HRC_EVENT_INGEST_TCP_PORT HRC_EVENT_FORWARD_SOURCE_REF
unset HRC_SESSION_REF HRC_RUNTIME_ID HRC_RUN_ID HRC_HOST_SESSION_ID
```

These broker settings already exist in the supported isolated recipe; without
durable IPC, a legacy allocation can compile successfully and then fail its
broker-command fallback. Preserve that allocator/result failure separately from
ASP endpoint admission. Use a blank scratch `tabularasa/agent-profile.toml`
(version 4, claude provisioning, spaces base=[]); the workload requests only
`OK`, no tools. Peer config has the explicit p0 node and an empty peers object.
Resolve a real declaration by paths, capture the complete response, and verify
its ASP release and canonical scratch agent/project roots before profile
admission. Use supported `sessions/resolve` with `summonIntent:explicit_local`,
then `runtimes/start` by host ID. Implicit provisioning requires federation
placement enforcement; do not confuse that refusal with failure of this
explicit local path. Local bounded reads use host/generation fences.

Launch the exact frozen Bun CLI **in a new clean ghostmux terminal**, clearing
harness markers in that terminal, as `bun /absolute/cli server serve`. Capture
its PID in owner.pid and its JSON log in serve.log. Never use server start,
launchd, installs or shared service restarts. The runner preflights real status,
PID argv, destinations and fresh exact scope before mutations, and guards every
mutating selector against the born scratch IDs. It cannot dispatch agent seats.

The runner closes its followers and terminates only runtime IDs of its newly
admitted exact scope, including successors discovered after a timed-out birth.
It waits for their processes and tmux sockets; residue is INFRA_ERROR. The
operator then snapshots the DB through readonly queries/SQLite backup, stops
only the owned foreground HRC PID (SIGTERM, bounded settle), captures completed
stop lifecycle/publication evidence, then stops the owned wrkqd PID and closes
only the owned terminal surfaces. A baseline setup may include a completed
foreground stop/start cycle in this same scratch ledger to observe startup and
stop paths. Never remove evidence before checking child processes, sockets and
publication children. Never kill by process name. Do not stop installed/shared
services or use this recipe for installed acceptance from a worktree.

The first real observations and all red/green controls are retained under the
T-11527 artifact root. Early restart timeouts are preserved independently of the
separately delivered Bun inherited-prompt fix. A later successful run does not
rewrite those observations.

For the unavailable-authority leg, provision a second foreground owner under
`scratchRoot/unavailable` with separate run/state/agent/project/peer roots and
both locators `rpc://127.0.0.1:1`, empty scratch credential overrides. Retain its
launch.sh, safe environment.json, owner.pid, serve.log and shell exit. Before
stopping it, capture ps output as process-before-stop.json and readonly
wrkq_ledger_cursors plus lifecycle source events as
publication-before-stop.json (keys cursors/events; events include hrc_seq,
eventKind and payload_json). Snapshot the log as publication-before-stop.log.
A real ready server can still fail publication: require its actual
server_project_event.post_failed diagnostic and unadvanced server cursor.
Stop only this owned PID, retain its exit and prove it disappeared. The runner
reads these raw observations directly and binds installed negative-leg source
identity to the successful subject's release. CLI refusal alone is insufficient.
