# 1. Server health

How you tell whether a daemon is up, which build it runs, and whether its node is healthy. Code:
`packages/hrc-cli/src/cli/handlers-server.ts` (`server status|restart|stop|serve|subscribers|tmux`),
`packages/hrc-cli/src/cli/handlers-federation.ts` (`cmdDoctor`, the node rows) and
`packages/hrc-cli/src/target/live-commands.ts` (`targetDoctorChecks`, the target rows),
`packages/hrc-cli/src/harness-guard.ts`,
`packages/hrc-server/src/server-status-methods.ts` and `release-provenance.ts`; the front-door mode in `justfile`
(`front-door-*`) and `scripts/front-door.ts`. Docs: `docs/cli-surface.md`, `docs/operations-runbook.md`.

## Sub-features

- `hrc server status` (human) and `--json`: pid, socket responsiveness, lock, tmux, store schema
  (`0127_permission_audit_removal (matches this release)` on 2026-10-26; `--json` `.schema` is `{readable,
  storeVersion, releaseVersion, pending, schemaAhead}`), the `release` block (`mode` atomic,
  `releaseId`, `hrcBuild.sourceCommit`, `aspContracts`, `runningEqualsInstalled`), `node` (nodeId, mode,
  peers) and `api.aspd` (configured, reachable, aspd release). `.api.listenSocketPath` is the socket Bun binds:
  equal to `.api.socketPath` on a direct node; behind a front door (T-11822) Bun listens on
  `<runtime>/hrc-bun.sock`, `rusthrc` answers on `hrc.sock`, and the human render adds a `listen: … (behind front
  door)` line. `just front-door-status` (read-only) prints `mode: direct|fronted`, both launchd jobs' state and
  which of the two sockets answers health.
- `hrc doctor [target] [--json] [--strict]`: rows `hrc-daemon`, `node-identity`, `federation-config`,
  `federation-peer:<node>`, `placement-skew`, `placement-policy` (warn per unreadable declaration); with a
  target also `target-lookup`, `target-health` (`ok` with the target state, `fail` when broken),
  `dm-capability`, `runtime`; a target that doesn't resolve gives one `target-resolve` fail row instead, and exit 1. A peer that
  isn't healthy is a warn, not a fail. An unreachable daemon gives a single `hrc-daemon` fail row and exit 1.
  `placement-skew` is a warn when the bindings scan stopped at its 20 s budget (d9214d03; feature 5).
  `--json` is an array of `{name, status, detail}`. Exit 0 with warns, 1 with `--strict` and a warn.
- `hrc info`: the agent runbook, including every `server status --json` path.
- `hrc server subscribers [--json]`: follow-stream admission and consumer-receipt accounting (`active`,
  `recentlyClosed`; per subscriber `route`, `selector`, `enqueuedCount`, `pendingCount`, `receiptState`).
- `hrc server tmux status [--json]`: the daemon's tmux socket (`available`, `version`, `running`,
  `sessions`, broker-tmux `leases`). `server tmux kill` is operator only.
- The harness guard: `hrc server serve` exits 2 with "refusing to boot in the foreground" when any of
  `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, `CODEX_SANDBOX` is set. There is deliberately no override flag.
  After the guard, a runtime root whose worst-case socket path can't fit 104 bytes refuses to boot
  (T-10330; feature 2 Gotchas). `server serve --listen-socket <abs>` (the front door's private socket) refuses a
  relative path with rc 2 before the guard runs ("--listen-socket must be an absolute path: rel").
- `hrc server restart|stop --reason`: operator only (Mable primary). Named here, never driven.
- The daemon log: `~/praesidium/var/logs/hrc-runtime/hrc-server.log`, one JSON object per line (`ts, level,
  component, event, data`) on stdout since T-10854; `hrc-server.err.log` beside it is empty. The old
  `~/praesidium/var/logs/hrc-server.err.log` (text, frozen 2026-10-14) is a decoy.
- Capabilities (`sessionRestart`, `federatedSessionRead`, …) are on `GET /v1/status` `.capabilities`, not in
  `server status --json`. Since T-11542 `platform.legacyLocalBridges` is `[]` and every `bridgeDelivery` flag
  is `false`.

## How to get to it

Live: run `hrc server status` and `hrc doctor` from any shell. Scratch: `hv scratch up --name <task>`, then
`hv run <task> -- hrc server status --json` and `hv run <task> -- hrc doctor`.

## Driving it

```bash
hrc server status --json | jq '{rel: .release.runningEqualsInstalled, src: .release.hrcBuild.sourceCommit, top: .runningEqualsInstalled, aspd: .api.aspd.reachable, schema: .schema.storeVersion, direct: (.api.listenSocketPath == .api.socketPath)}'
cd ~/praesidium/hrc-runtime && just front-door-status   # mode: direct; hrc-bun.sock: no answer
hrc server status                                     # human render; same facts
hrc doctor --json | jq -c '(map(.status)|group_by(.)|map({(.[0]):length})|add)'
hrc doctor --strict >/dev/null; echo "strict rc=$?"   # 1 while any warn row exists
hrc doctor clod@hrc-runtime:<task> --json | jq -c '.[] | select(.name|test("target|dm|runtime"))'
hv run <task> -- hrc doctor                           # single-node: no peers, no bindings
hv run <task> -- hrc doctor no-such-agent@nowhere:x --json; echo "rc=$?"   # target-resolve fail, rc 1
hrc server subscribers --json | jq -c '{active: (.active|length), recentlyClosed: (.recentlyClosed|length)}'
hv run <task> -- hrc server tmux status --json
C=/tmp/hv/<task>/release/packages/hrc-cli/src/cli.ts   # the scratch's copy, never the installed tree (Gotchas)
HRC_RUNTIME_DIR=/tmp/hv-guard/run HRC_STATE_DIR=/tmp/hv-guard/state bun $C server serve; echo "rc=$?"   # guard: rc 2
HRC_RUNTIME_DIR=/tmp/hv-guard/run HRC_STATE_DIR=/tmp/hv-guard/state bun $C server serve --listen-socket rel; echo "rc=$?"   # rc 2, before the guard
rm -rf /tmp/hv-guard                                  # the probe creates state/ before it refuses
hrc info | head -40
curl -s --unix-socket ~/praesidium/var/run/hrc/hrc.sock http://hrc/v1/status | jq -c .capabilities
```

## Gotchas

- **`top` is null on purpose.** `runningEqualsInstalled` lives at `.release.runningEqualsInstalled` (and
  `.api.release…`); the top-level read answers `null` exactly like a dead field (2026-10-05,
  `T-10297/01-server-health/drive.txt`). Assert `.release.mode == "atomic"` first.
- **The harness guard fires in every agent shell.** Starting a scratch daemon from an agent's Bash tool
  refuses (rc 2). `hv scratch up` launches it in a clean ghostmux tab instead. `hrc server start --daemon`
  is not an isolation path either: it delegates to launchd, whose plist environment ignores your
  `HRC_RUNTIME_DIR`/`HRC_STATE_DIR` (`docs/isolated-daemon-smoke-recipe.md`).
- **`~ placement-policy` warns are normal on max3.** Seven on 2026-10-05, five on 2026-10-19 and 2026-10-26: task scopes whose worktree is gone
  (`ENOENT … .Trash/…`), ambiguous (`multiple worktrees match T-…`) or whose project root is not canonical.
  They don't stop a drive; they make `--strict` exit 1.
- **Live `server subscribers` lists many idle follows.** 28 active on 2026-10-05: one `broker-events`
  (`mail`, 11254 accepted) and 27 `events` follows on old scopes and lanes (`…steering-e2e-1778176114`,
  `discord-…`), each `enqueued=0`, `receipt=awaiting-first-ack` (`T-10350/01-server-health/drive.txt`). That
  is the steady state of follow consumers on quiet scopes, not a leak this skill has proven (30 active, 29
  `events` + 1 `broker-events`, 12 recently closed on 2026-10-19; 29 active, 0 recently closed on 2026-10-26); a
  fresh scratch answers `{"active": [], "recentlyClosed": []}`.
- **Probe the guard with the scratch's copy, not `hrc`.** The guard is the only thing between an agent shell and
  a foreground daemon; if it ever let `hrc server serve` through, the installed tree would boot `atomic` and
  prune the live release directory (SKILL.md, Launch). The copy boots `unmanaged` and prunes nothing.
- `hrc server status` with a scratch's two env vars and no daemon behind them prints nulls rather than
  refusing; `hv scratch up` waits for `.api.socketPath` to be non-null for that reason.

## Proven when

Live `server status --json` names an atomic release whose `hrcBuild.sourceCommit` you can name and
`.release.runningEqualsInstalled` is `true`; `doctor` exits 0 with `hrc-daemon` ok and every federation peer
`healthy`; `listenSocketPath` equals `socketPath` and `front-door-status` says `direct` (or, fronted, the
private socket is the one that answers behind `rusthrc`); the scratch `doctor` shows single-node with no
bindings; the guard refuses with rc 2 and names the detected variables.

Driven 2026-10-26 (T-11864 upkeep) on installed 02661aeb (release-20261026064522711-87287, front door `direct`),
aspd 15dbde97, live and scratch `t-11864` (an `unmanaged` copy of that release):
`var/wrkq-artifacts/T-11864/01-server-health/drive.txt`.
