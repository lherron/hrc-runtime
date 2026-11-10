# 1. Server health

How you tell whether a daemon is up, which build it runs, and whether its node is healthy. Native on both sides
since 2026-10-26. Code: CLI `crates/hrc-cli/src/server_status.rs`, `local/doctor.rs` (node and target rows),
`local/server.rs` (`subscribers`, `tmux status`), `local/info.rs`, `server_start.rs`, `server_lifecycle.rs`;
daemon `crates/hrc-native/src/main.rs` (`server serve` dispatch), `server.rs` (`/v1/status`, logging),
`server/projection/doctor.rs` (every doctor row, served at `GET /v1/doctor` since 2c947087; the CLI only renders) and
`server/front/{front,release,hosting}.rs` (listen socket, release block, store admission). Docs: `docs/cli-surface.md`, `docs/operations-runbook.md`.

## Sub-features

- `~/.bun/bin/hrc server status` (human) and `--json`: pid, socket responsiveness, lock, tmux, `daemon {pid, pidAlive,
  pidFileExists}`, `.schema {readable, storeVersion, releaseVersion, pending, schemaAhead}` (`0131_runtime_live_indexes`
  on 2026-11-09), `release` (`mode`, `releaseId`, `hrcBuild.sourceCommit`, `aspContracts`,
  `runningEqualsInstalled`), `binaryPath`, `node` (`nodeId`, `nodeIdProvenance` declared|derived, `mode`,
  `configPath`, `configExists`, `peerCount`, `peers`) and `api.aspd`. Live: `atomic`, `binaryPath` through the owner link
  `~/praesidium/var/hrc-owner/hrc-runtime-current/bin/rusthrc` (not the fixed `var/hrc-owner/bin/rusthrc`; feature 6). Scratch: `release.mode unmanaged`, `releaseId
  null`, `binaryPath <copy>/bin/rusthrc`, `.node {nodeId max3, nodeIdProvenance derived, mode single-node,
  configExists false}` (2026-11-02, T-12291). `.api.listenSocketPath` is hard-coded equal to `.api.socketPath`
  (Gotchas). `just front-door-status` still runs; live printed `hrc-bun.sock: no answer` (2026-11-02): the
  Bun-behind-rusthrc front door is a retained fallback, not production.
- `~/.bun/bin/hrc doctor [target] [--json] [--strict]`: rows `hrc-daemon`, `node-identity`, `federation-config`,
  one `federation-peer:<node>` per peer (`healthy, answered … in Nms`; back since a46bdc4f, 2026-11-09),
  `placement-skew`, `placement-policy` (one warn row per cause for bindings with a live runtime, plus one `+` row
  counting dormant ones; Gotchas); with a target also `target-lookup`, `target-health`, `dm-capability`,
  `runtime` (`+ runtime (hrcpty:busy)` for this seat, 2026-11-09); a target that doesn't resolve gives one
  `x target-resolve (Invalid scope input …)` row, exit 1 (2026-11-09, T-12756). The daemon builds the rows at
  `GET /v1/doctor` (`[{name,status,detail}]`, 200 on a scratch, 2026-11-09). A socket file whose `/v1/status`
  fails gives one `hrc-daemon` fail row (source-only, 2026-11-02: `local/doctor.rs:33`); no socket file gives no
  rows (Gotchas). `placement-skew` warns when the bindings scan hit its budget (feature 5). `--json` is
  `[{name, status, detail}]`, grouped `placement-policy` rows add `count` and `bindings[]`. Exit 0 with warns, 1
  with `--strict` and a warn.
- `~/.bun/bin/hrc info`: the agent runbook, including every `server status --json` path.
- `~/.bun/bin/hrc server subscribers [--json]`: follow-stream accounting (`active`, `recentlyClosed`; per subscriber
  `route`, `selector`, `enqueuedCount`, `pendingCount`, `receiptState`).
- `~/.bun/bin/hrc server tmux status [--json]`: `available`, `version`, `running`, `sessions`, `leases`, probed client-side
  with no daemon call, plus `leaseDiagnostics {total, probed, skipped}` (source-only, 2026-11-02:
  `crates/hrc-cli/src/local/server.rs:129-164`). Scratch human status: `tmux: available (not running)`.
- `rusthrc server serve` has no harness guard. Use `hv` to scrub inherited harness and owner context.
  Native boot creates a missing store and applies forward migrations before binding, under its store lock
  (T-13056); a foreign or ahead migration set still refuses. Do not use `server start` for a scratch:
  it can kickstart a loaded launchd job. `serve --listen-socket rel` refuses: native listens only on
  the configured runtime root's `hrc.sock`.
- `~/.bun/bin/hrc server restart|stop --reason`: operator only (Mable primary). Named here, never driven.
- The daemon log: live `~/praesidium/var/logs/hrc-runtime/rusthrc-owner.log`, JSON lines `{ts, server:"rusthrc",
  level, component, event, data}`; a scratch logs to stdout, kept by `hv` as `/tmp/hv/<name>/serve.log`.
  `server.listening {owner:"rusthrc", role:"native", bunSocket:null}` at boot and `http.request … servedBy:
  "native"` per request name the daemon that answered. `hrc-server.log` (Bun owner, frozen 2026-10-26),
  `hrc-server.err.log` and `~/praesidium/var/logs/hrc-server.err.log` are decoys.
- Capabilities are on `GET /v1/status` `.capabilities`, not in `server status --json`: `legacyLocalBridges` `[]`,
  every `bridgeDelivery` flag `false`, plus `serverLifecycle`, `selfRestart`, `sessionRestart`,
  `federatedSessionRead`, `runtimeListOmitState` (2026-11-09). `?includePeerHealth=true` adds `.peerHealth[]`
  (`{nodeId, state, checkedAt, answeredAt, latencyMs}`); `server status --json` carries it too (`[]` on a scratch).
  `.eventLoop.intervalMs` is 1000 (2026-11-09; 250 before, per the source read).
- Every non-stream request now writes one `http.request` line, `/v1/health` included, with a `caller` field from
  `x-praesidium-caller` (`unknown` for curl). `hv run` leaves the caller's seat identity in place, so scratch lines
  read `caller: "clod@hrc-runtime:T-12756"` for the CLI (2026-11-09, `T-12756/01-server-health/drive.txt`).
- The `server status` tmux probe times out at 750 ms idle / 5 s total and then reports `available`/`running` null
  and `tmux: unknown (…)` (source-only, 2026-11-09: 846648d8, `crates/hrc-cli/src/server_status.rs`; a healthy tmux
  only shows the non-null control).

## How to get to it

Live: `~/.bun/bin/hrc server status` and `~/.bun/bin/hrc doctor` from any shell. Scratch: `hv scratch up --name <task>` (native by
default), then `hv run <task> -- ~/.bun/bin/hrc server status --json` and `hv run <task> -- ~/.bun/bin/hrc doctor`.

## Driving it

```bash
~/.bun/bin/hrc server status --json | jq '{mode: .release.mode, rel: .release.runningEqualsInstalled, src: .release.hrcBuild.sourceCommit, top: .runningEqualsInstalled, bin: .binaryPath, aspd: .api.aspd.reachable, schema: .schema.storeVersion}'
~/.bun/bin/hrc doctor 2>&1 | grep -v '~ placement-policy'; ~/.bun/bin/hrc doctor 2>&1 | grep -c '~ placement-policy'   # 0 warns, one + row (2026-11-09)
~/.bun/bin/hrc doctor --json | jq -c '.[] | select(.name|test("placement-policy|federation-peer")) | {name,status,count}'
~/.bun/bin/hrc doctor --strict >/dev/null; echo "strict rc=$?"   # 1 only while a live binding warns
curl -s -w ' http=%{http_code}' --unix-socket /tmp/hv/<task>/run/hrc.sock http://hrc/v1/doctor | head -c 300
cd ~/praesidium/hrc-runtime && just front-door-status 2>&1 | tail -5   # hrc-bun.sock: no answer
hv run <task> -- ~/.bun/bin/hrc server status --json | jq -c '{release: .release|{mode,releaseId}, node, binaryPath}'   # unmanaged, null, derived
hv run <task> -- ~/.bun/bin/hrc doctor                           # four + rows: single-node, no bindings
grep -m1 '"server.listening"' /tmp/hv/<task>/serve.log   # owner rusthrc, role native
hv run <task> -- ~/.bun/bin/hrc server tmux status --json
~/.bun/bin/hrc server subscribers --json | jq -c '{active: (.active|length), recentlyClosed: (.recentlyClosed|length)}'
grep -m1 '"store.created"' /tmp/hv/<task>/serve.log     # native boot created its private store before listening
HRC_RUNTIME_DIR=/tmp/hv-none HRC_STATE_DIR=/tmp/hv-none-s ~/.bun/bin/hrc doctor; echo rc=$?   # no rows, "socket not found", rc 1
HRC_RUNTIME_DIR=/tmp/hv-none HRC_STATE_DIR=/tmp/hv-none-s ~/.bun/bin/hrc server status --json | jq -c '{status, running, hasApi: has("api")}'
~/.bun/bin/hrc info | head -40
curl -s --unix-socket ~/praesidium/var/run/hrc/hrc.sock http://hrc/v1/status | jq -c .capabilities
```

## Gotchas

- **`top` is null on purpose.** `runningEqualsInstalled` lives at `.release.runningEqualsInstalled`; the
  top-level read answers `null` exactly like a dead field (2026-10-05, `T-10297`; no top-level key on native
  2026-11-02). Assert `.release.mode` first (`atomic` live, `unmanaged` scratch).
- **`listenSocketPath == socketPath` cannot be wrong on native.** Both come from `<runtime>/hrc.sock`
  (`crates/hrc-native/src/server.rs:1061`), equal on live and scratch alike (2026-11-02). Prove which daemon
  answered by the log's `server.listening` / `servedBy:"native"` lines, not by that comparison or
  `front-door-status`.
- **Nothing guards `rusthrc server serve` in an agent shell.** It creates a missing store and boots, and its births
  inherit your `CLAUDECODE` and friends (source-only, 2026-11-02: `crates/hrc-native/src/main.rs:34-47`). An empty store is no isolation guard. Start real daemons only through `hv scratch up`
  (scrubbed env, own ghostmux tab). Never run `~/.bun/bin/hrc server start` with scratch env vars: it kickstarts the loaded
  production job `com.praesidium.hrc-server` (source-only, 2026-11-02: `crates/hrc-cli/src/server_start.rs:268-272`).
  Native prunes no release dirs, unlike Bun (source-only, 2026-11-02: no prune in `crates/*/src`), but from a
  production tree it pins itself to that release (SKILL.md).
- **Unreadable placement policies are registry data, and dormant ones no longer warn.** Since a46bdc4f
  (T-11372) doctor warns once per cause, only for bindings with a live runtime, and folds the rest into one
  `+ placement-policy (466 dormant binding(s) (no live runtime) have an unreadable declared policy (project root
  unknown for 177 project(s), 4 other); …)` row: 0 `~` rows and `--strict` rc 0 on 2026-11-09 (466 warns and
  strict rc 1 on 2026-11-02). The causes are still "project root unknown for <project>" (root null in
  `~/.local/bin/wrkq projects`) and a few `ENOENT … .Trash/…` retired worktrees.
- **`federation-peer:` rows are back on native** (a46bdc4f): live doctor printed `+ federation-peer:svc` and
  `+ federation-peer:hrcdev (healthy, answered … in 1ms)` (2026-11-09); each probe also logs
  `federation.peer.probe` in `rusthrc-owner.log`. The scratch (single-node) has none.
- **A missing socket is not a fail row.** With no `hrc.sock` file `~/.bun/bin/hrc doctor` prints nothing on stdout, stderr
  "HRC daemon socket not found at …", rc 1; `server status --json` prints a document with `status:
  "not-running"`, `running: false`, no `.api` key, rc 1 (2026-11-02). `hv scratch up` waits on `.api.socketPath`.
- **Live `server subscribers` lists many idle follows** (28–30 active, `enqueued=0`, `awaiting-first-ack`, on the
  Bun daemon through 2026-10-26, `T-10350`, `T-11864`; 30 active, 0 recently closed on native 2026-11-09);
  steady state, not a leak.

## Proven when

Live `server status --json` names an `atomic` release whose `hrcBuild.sourceCommit` you can name,
`.release.runningEqualsInstalled` is `true` and `binaryPath` is under `hrc-owner`; `doctor` exits 0 with
`hrc-daemon`, `node-identity` (declared, federated), `federation-config`, one `federation-peer:` per peer and
`placement-skew` ok; the scratch
reports `unmanaged`, `releaseId null`, a derived single-node identity and four `+` doctor rows, and its serve log
says `server.listening {owner:"rusthrc", role:"native"}`; `server serve` with `CLAUDECODE=1` on an empty root
reaches store admission (no guard) and `--listen-socket rel` refuses rc 1.

Driven 2026-11-09 (T-12756 upkeep) live read-only and on a native scratch (rusthrc,
release-20261108171912823-43877, 846648d8), evidence
`~/praesidium/var/wrkq-artifacts/T-12756/{01-server-health,live,evidence/t-12756}`.
