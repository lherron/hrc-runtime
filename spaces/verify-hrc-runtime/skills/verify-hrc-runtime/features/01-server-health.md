# 1. Server health

How you tell whether a daemon is up, which build it runs, and whether its node is healthy. Code:
`packages/hrc-cli/src/cli/handlers-server.ts` (`server status|restart|stop|serve|subscribers|tmux`),
`packages/hrc-cli/src/cli/handlers-federation.ts` (`cmdDoctor`, the node rows) and
`packages/hrc-cli/src/target/live-commands.ts` (`targetDoctorChecks`, the target rows),
`packages/hrc-cli/src/harness-guard.ts`,
`packages/hrc-server/src/server-status-methods.ts` and `release-provenance.ts`. Docs: `docs/cli-surface.md`,
`docs/operations-runbook.md`.

## Sub-features

- `hrc server status` (human) and `--json`: pid, socket responsiveness, lock, tmux, store schema
  (`0122_session_identity_metadata (matches this release)` on 2026-10-05), the `release` block (`mode` atomic,
  `releaseId`, `hrcBuild.sourceCommit`, `aspContracts`, `runningEqualsInstalled`), `node` (nodeId, mode,
  peers) and `api.aspd` (configured, reachable, aspd release).
- `hrc doctor [target] [--json] [--strict]`: rows `hrc-daemon`, `node-identity`, `federation-config`,
  `federation-peer:<node>`, `placement-skew`, `placement-policy` (warn per unreadable declaration); with a
  target also `target-lookup`, `dm-capability`, `runtime` (and `target-health`, only when the target is
  broken); a target that doesn't resolve gives one `target-resolve` fail row instead, and exit 1. A peer that
  isn't healthy is a warn, not a fail. An unreachable daemon gives a single `hrc-daemon` fail row and exit 1.
  `--json` is an array of `{name, status, detail}`. Exit 0 with warns, 1 with `--strict` and a warn.
- `hrc info`: the agent runbook, including every `server status --json` path.
- `hrc server subscribers [--json]`: follow-stream admission and consumer-receipt accounting (`active`,
  `recentlyClosed`; per subscriber `route`, `selector`, `enqueuedCount`, `pendingCount`, `receiptState`).
- `hrc server tmux status [--json]`: the daemon's tmux socket (`available`, `version`, `running`,
  `sessions`, broker-tmux `leases`). `server tmux kill` is operator only.
- The harness guard: `hrc server serve` exits 2 with "refusing to boot in the foreground" when any of
  `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, `CODEX_SANDBOX` is set. There is deliberately no override flag.
- `hrc server restart|stop --reason`: operator only (Mable primary). Named here, never driven.

## How to get to it

Live: run `hrc server status` and `hrc doctor` from any shell. Scratch: `hv scratch up --name <task>`, then
`hv run <task> -- hrc server status --json` and `hv run <task> -- hrc doctor`.

## Driving it

```bash
hrc server status --json | jq '{rel: .release.runningEqualsInstalled, src: .release.hrcBuild.sourceCommit, top: .runningEqualsInstalled, aspd: .api.aspd.reachable}'
hrc server status                                     # human render; same facts
hrc doctor --json | jq -c '(map(.status)|group_by(.)|map({(.[0]):length})|add)'
hrc doctor --strict >/dev/null; echo "strict rc=$?"   # 1 while any warn row exists
hrc doctor clod@hrc-runtime:<task> --json | jq -c '.[] | select(.name|test("target|dm|runtime"))'
hv run <task> -- hrc doctor                           # single-node: no peers, no bindings
hv run <task> -- hrc doctor no-such-agent@nowhere:x --json; echo "rc=$?"   # target-resolve fail, rc 1
hrc server subscribers --json | jq -c '{active: (.active|length), recentlyClosed: (.recentlyClosed|length)}'
hv run <task> -- hrc server tmux status --json
HRC_RUNTIME_DIR=/tmp/hv-guard/run HRC_STATE_DIR=/tmp/hv-guard/state hrc server serve; echo "rc=$?"   # guard: rc 2
hrc info | head -40
```

## Gotchas

- **`top` is null on purpose.** `runningEqualsInstalled` lives at `.release.runningEqualsInstalled` (and
  `.api.release…`); the top-level read answers `null` exactly like a dead field (2026-10-05,
  `T-10297/01-server-health/drive.txt`). Assert `.release.mode == "atomic"` first.
- **The harness guard fires in every agent shell.** Starting a scratch daemon from an agent's Bash tool
  refuses (rc 2). `hv scratch up` launches it in a clean ghostmux tab instead. `hrc server start --daemon`
  is not an isolation path either: it delegates to launchd, whose plist environment ignores your
  `HRC_RUNTIME_DIR`/`HRC_STATE_DIR` (`docs/isolated-daemon-smoke-recipe.md`).
- **`~ placement-policy` warns are normal on max3.** Seven on 2026-10-05: task scopes whose worktree is gone
  (`ENOENT … .Trash/…`), ambiguous (`multiple worktrees match T-…`) or whose project root is not canonical.
  They don't stop a drive; they make `--strict` exit 1.
- `target-health` appears only for a broken target, despite the help listing it with every target.
- **Live `server subscribers` lists many idle follows.** 28 active on 2026-10-05: one `broker-events`
  (`mail`, 11254 accepted) and 27 `events` follows on old scopes and lanes (`…steering-e2e-1778176114`,
  `discord-…`), each `enqueued=0`, `receipt=awaiting-first-ack` (`T-10350/01-server-health/drive.txt`). That
  is the steady state of follow consumers on quiet scopes, not a leak this skill has proven; a fresh scratch
  answers `{"active": [], "recentlyClosed": []}`.
- `hrc server status` with a scratch's two env vars and no daemon behind them prints nulls rather than
  refusing; `hv scratch up` waits for `.api.socketPath` to be non-null for that reason.

## Proven when

Live `server status --json` names an atomic release whose `hrcBuild.sourceCommit` you can name and
`.release.runningEqualsInstalled` is `true`; `doctor` exits 0 with `hrc-daemon` ok and every federation peer
`healthy`; the scratch `doctor` shows single-node with no bindings; the guard refuses with rc 2 and names
the detected variables.

Driven 2026-10-05 (T-10350 upkeep) on installed 5bdb6c4e (release-20261005161155036-36654), aspd e5e729af,
live and scratch `t-10350`: `var/wrkq-artifacts/T-10350/01-server-health/drive.txt`.
