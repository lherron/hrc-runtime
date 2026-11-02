# 1. Server health

How you tell whether a daemon is up, which build it runs, and whether its node is healthy. Native on both sides
since 2026-10-26. Code: CLI `crates/hrc-cli/src/server_status.rs`, `local/doctor.rs` (node and target rows),
`local/server.rs` (`subscribers`, `tmux status`), `local/info.rs`, `server_start.rs`, `server_lifecycle.rs`;
daemon `crates/hrc-native/src/main.rs` (`server serve` dispatch), `server.rs` (`/v1/status`, logging) and
`server/front/{front,release,hosting}.rs` (listen socket, release block, store admission). `server tmux kill` is a
Bun passthrough (`crates/hrc-cli/command-scope.json`). Docs: `docs/cli-surface.md`, `docs/operations-runbook.md`.

## Sub-features

- `hrc server status` (human) and `--json`: pid, socket responsiveness, lock, tmux, `daemon {pid, pidAlive,
  pidFileExists}`, `.schema {readable, storeVersion, releaseVersion, pending, schemaAhead}` (`0130_seat_handoffs`
  on 2026-11-02), `release` (`mode`, `releaseId`, `hrcBuild.sourceCommit`, `aspContracts`,
  `runningEqualsInstalled`), `binaryPath`, `node` (`nodeId`, `nodeIdProvenance` declared|derived, `mode`,
  `configPath`, `configExists`, `peerCount`, `peers`) and `api.aspd`. Live: `atomic`, `binaryPath` through the owner link
  `~/praesidium/var/hrc-owner/hrc-runtime-current/bin/rusthrc` (not the fixed `var/hrc-owner/bin/rusthrc`; feature 6). Scratch: `release.mode unmanaged`, `releaseId
  null`, `binaryPath <copy>/bin/rusthrc`, `.node {nodeId max3, nodeIdProvenance derived, mode single-node,
  configExists false}` (2026-11-02, T-12291). `.api.listenSocketPath` is hard-coded equal to `.api.socketPath`
  (Gotchas). `just front-door-status` still runs; live printed `hrc-bun.sock: no answer` (2026-11-02): the
  Bun-behind-rusthrc front door is a retained fallback, not production.
- `hrc doctor [target] [--json] [--strict]`: rows `hrc-daemon`, `node-identity`, `federation-config`,
  `placement-skew`, `placement-policy` (warn per unreadable declaration); with a target also `target-lookup`,
  `target-health`, `dm-capability`, `runtime`; a target that doesn't resolve gives one `target-resolve` fail row,
  exit 1 (source-only, 2026-11-02: `crates/hrc-cli/src/local/doctor.rs:163-166`). No `federation-peer:` rows on
  native (Gotchas). A socket file whose `/v1/status` fails gives one `hrc-daemon` fail row (source-only,
  2026-11-02: `local/doctor.rs:33`); no socket file gives no rows (Gotchas). `placement-skew` warns when the
  bindings scan hit its budget (feature 5). `--json` is `[{name, status, detail}]`. Exit 0 with warns, 1 with
  `--strict` and a warn.
- `hrc info`: the agent runbook, including every `server status --json` path.
- `hrc server subscribers [--json]`: follow-stream accounting (`active`, `recentlyClosed`; per subscriber
  `route`, `selector`, `enqueuedCount`, `pendingCount`, `receiptState`).
- `hrc server tmux status [--json]`: `available`, `version`, `running`, `sessions`, `leases`, probed client-side
  with no daemon call, plus `leaseDiagnostics {total, probed, skipped}` (source-only, 2026-11-02:
  `crates/hrc-cli/src/local/server.rs:129-164`). Scratch human status: `tmux: available (not running)`.
- `rusthrc server serve` has no harness guard: with `CLAUDECODE=1` it went straight to store admission and
  refused `server.exit` "schema: cannot open existing Bun store", rc 1, on an empty state root (2026-11-02,
  T-12291). The guard text ("refusing to boot in the foreground … (detected: …)", rc 2) lives only in `hrc server
  start` foreground, unreachable on max3 because `start` first kickstarts any loaded launchd job (source-only,
  2026-11-02: `crates/hrc-cli/src/server_start.rs:268-272,290-299`). `serve --listen-socket rel` refuses with one
  stderr JSON line `server.exit` "--listen-socket rel is unsupported: rusthrc always listens on <rt>/hrc.sock; a
  private listener is Bun's role", rc 1. Bun only (`--engine bun`): the rc 2 guard on `serve`, rc 2
  "--listen-socket must be an absolute path", and the 104-byte boot refusal (feature 2 Gotchas).
- `hrc server restart|stop --reason`: operator only (Mable primary). Named here, never driven.
- The daemon log: live `~/praesidium/var/logs/hrc-runtime/rusthrc-owner.log`, JSON lines `{ts, server:"rusthrc",
  level, component, event, data}`; a scratch logs to stdout, kept by `hv` as `/tmp/hv/<name>/serve.log`.
  `server.listening {owner:"rusthrc", role:"native", bunSocket:null}` at boot and `http.request … servedBy:
  "native"` per request name the daemon that answered. `hrc-server.log` (Bun owner, frozen 2026-10-26),
  `hrc-server.err.log` and `~/praesidium/var/logs/hrc-server.err.log` are decoys.
- Capabilities are on `GET /v1/status` `.capabilities`, not in `server status --json`: `legacyLocalBridges` `[]`,
  every `bridgeDelivery` flag `false`, plus `serverLifecycle`, `selfRestart`, `sessionRestart`,
  `federatedSessionRead` (source-only, 2026-11-02: `crates/hrc-native/src/server.rs:1024`).

## How to get to it

Live: `hrc server status` and `hrc doctor` from any shell. Scratch: `hv scratch up --name <task>` (native by
default), then `hv run <task> -- hrc server status --json` and `hv run <task> -- hrc doctor`.

## Driving it

```bash
hrc server status --json | jq '{mode: .release.mode, rel: .release.runningEqualsInstalled, src: .release.hrcBuild.sourceCommit, top: .runningEqualsInstalled, bin: .binaryPath, aspd: .api.aspd.reachable, schema: .schema.storeVersion}'
hrc doctor 2>&1 | grep -v '~ placement-policy'; hrc doctor 2>&1 | grep -c '~ placement-policy'
hrc doctor --strict >/dev/null; echo "strict rc=$?"   # 1 while any warn row exists
cd ~/praesidium/hrc-runtime && just front-door-status 2>&1 | tail -5   # hrc-bun.sock: no answer
hv run <task> -- hrc server status --json | jq -c '{release: .release|{mode,releaseId}, node, binaryPath}'   # unmanaged, null, derived
hv run <task> -- hrc doctor                           # four + rows: single-node, no bindings
grep -m1 '"server.listening"' /tmp/hv/<task>/serve.log   # owner rusthrc, role native
hv run <task> -- hrc server tmux status --json
hrc server subscribers --json | jq -c '{active: (.active|length), recentlyClosed: (.recentlyClosed|length)}'
C=/tmp/hv/<task>/release/bin/rusthrc                  # the scratch's copy, never the installed tree (Gotchas)
mkdir -p /tmp/hvg/run /tmp/hvg/state                  # EMPTY state root: no state.sqlite, so serve stops at admission
timeout 10 env -i HOME=$HOME PATH=/usr/bin:/bin CLAUDECODE=1 CLAUDE_CODE_ENTRYPOINT=cli HRC_LAUNCHD_LABEL=hv.none HRC_RUNTIME_DIR=/tmp/hvg/run HRC_STATE_DIR=/tmp/hvg/state $C server serve 2>&1 | tail -3; echo rc=${PIPESTATUS[0]}   # no guard: "cannot open existing Bun store", rc 1
timeout 10 env -i HOME=$HOME PATH=/usr/bin:/bin HRC_LAUNCHD_LABEL=hv.none HRC_RUNTIME_DIR=/tmp/hvg/run HRC_STATE_DIR=/tmp/hvg/state $C server serve --listen-socket rel 2>&1 | tail -2; echo rc=${PIPESTATUS[0]}   # rc 1
rm -rf /tmp/hvg                                       # the probe leaves state/metrics behind
HRC_RUNTIME_DIR=/tmp/hv-none HRC_STATE_DIR=/tmp/hv-none-s hrc doctor; echo rc=$?   # no rows, "socket not found", rc 1
HRC_RUNTIME_DIR=/tmp/hv-none HRC_STATE_DIR=/tmp/hv-none-s hrc server status --json | jq -c '{status, running, hasApi: has("api")}'
hrc info | head -40
curl -s --unix-socket ~/praesidium/var/run/hrc/hrc.sock http://hrc/v1/status | jq -c .capabilities
```

## Gotchas

- **`top` is null on purpose.** `runningEqualsInstalled` lives at `.release.runningEqualsInstalled`; the
  top-level read answers `null` exactly like a dead field (2026-10-05, `T-10297`; no top-level key on native
  2026-11-02). Assert `.release.mode` first (`atomic` live, `unmanaged` scratch).
- **`listenSocketPath == socketPath` cannot be wrong on native.** Both come from `<runtime>/hrc.sock`
  (`crates/hrc-native/src/server.rs:1023`), equal on live and scratch alike (2026-11-02). Prove which daemon
  answered by the log's `server.listening` / `servedBy:"native"` lines, not by that comparison or
  `front-door-status`.
- **Nothing guards `rusthrc server serve` in an agent shell.** On a migrated store it boots, and its births
  inherit your `CLAUDECODE` and friends (source-only, 2026-11-02: `crates/hrc-native/src/main.rs:36-46`). Probe it
  only with the scratch's copy on an EMPTY state root (Driving it); start real daemons only through `hv scratch up`
  (scrubbed env, own ghostmux tab). Never run `hrc server start` with scratch env vars: it kickstarts the loaded
  production job `com.praesidium.hrc-server` (source-only, 2026-11-02: `crates/hrc-cli/src/server_start.rs:268-272`).
  Native prunes no release dirs, unlike Bun (source-only, 2026-11-02: no prune in `crates/*/src`), but from a
  production tree it pins itself to that release (SKILL.md).
- **`~ placement-policy` warns are normal on max3, and they are registry data.** 466 on 2026-11-02 (7 on
  2026-10-05, 5 on 2026-10-26): mostly "project root unknown for <project>; register it with: wrkq set <project>
  --root <path>" (e.g. `strategy` has root null in `wrkq projects`), a few `ENOENT … .Trash/…` retired worktrees.
  They don't stop a drive; they make `--strict` exit 1.
- **No `federation-peer:` rows on native.** Live doctor printed `node-identity (max3 (declared, federated, 2
  peer(s)))` and no peer row (2026-11-02): `doctor` builds them from `/v1/status` `peerHealth`, which the native
  daemon never returns (source-only, 2026-11-02: `local/doctor.rs:71`; no `peerHealth` in `crates/hrc-native/src`).
- **A missing socket is not a fail row.** With no `hrc.sock` file `hrc doctor` prints nothing on stdout, stderr
  "HRC daemon socket not found at …", rc 1; `server status --json` prints a document with `status:
  "not-running"`, `running: false`, no `.api` key, rc 1 (2026-11-02). `hv scratch up` waits on `.api.socketPath`.
- **Live `server subscribers` lists many idle follows** (28–30 active, `enqueued=0`, `awaiting-first-ack`, on the
  Bun daemon through 2026-10-26, `T-10350`, `T-11864`); steady state, not a leak. Not re-driven on native.

## Proven when

Live `server status --json` names an `atomic` release whose `hrcBuild.sourceCommit` you can name,
`.release.runningEqualsInstalled` is `true` and `binaryPath` is under `hrc-owner`; `doctor` exits 0 with
`hrc-daemon`, `node-identity` (declared, federated), `federation-config` and `placement-skew` ok; the scratch
reports `unmanaged`, `releaseId null`, a derived single-node identity and four `+` doctor rows, and its serve log
says `server.listening {owner:"rusthrc", role:"native"}`; `server serve` with `CLAUDECODE=1` on an empty root
reaches store admission (no guard) and `--listen-socket rel` refuses rc 1.

Driven 2026-11-02 on a native scratch (rusthrc, release-20261102082222127-69529, 9861ae0e), evidence
`~/praesidium/var/wrkq-artifacts/T-12291/{01-server-health,02-runtime-lifecycle,evidence/t-12291}`.
