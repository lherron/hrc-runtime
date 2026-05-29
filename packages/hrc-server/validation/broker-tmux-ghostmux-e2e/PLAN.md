# broker-tmux ghostmux E2E validation harness

This package is the repeatable manual validation harness for T-01740. It drives
real Ghostty surfaces through `ghostmux`, starts two interactive HRC runtimes,
and records a committed findings directory for each run.

The live run path can restart `hrc-server`. Do not run setup against the shared
daemon while other agents are active or while Lance is away. The scripts expose
`--dry-run` so the harness can be checked without changing daemon state.

## Pinned facts

- Claude driver: `claude-code-tmux`
- Claude target: `clod@hrc-runtime:<run-task>` from `/Users/lherron/praesidium/var/agents/clod/agent-profile.toml`
- Codex driver: `codex-cli-tmux`
- Codex target: `cody@hrc-runtime:<run-task>` from `/Users/lherron/praesidium/var/agents/cody/agent-profile.toml`
- Runtime root: `/Users/lherron/praesidium/var/run/hrc`
- Default tmux socket: `/Users/lherron/praesidium/var/run/hrc/tmux.sock`
- Lease socket root: `/Users/lherron/praesidium/var/run/hrc/btmux/`
- Daemon logs: `/Users/lherron/praesidium/var/logs/hrc-server.log` and `/Users/lherron/praesidium/var/logs/hrc-server.err.log`
- Monitor dump selectors require `runtime:<runtimeId>` or `scope:<agent>@<project>:<task>`
- Monitor dump recipe: record `.eventLog.highWaterSeq` from `hrc monitor show --json`, then dump with `hrc monitor watch runtime:<runtimeId> --from-seq <seq> --json`

## Tiers

Use `--core` for frequent validation and `--full` for milestone validation.

CORE rows:

1. `hrcchat dm <target>`
2. `hrcchat send <target> --enter`
3. `hrcchat turn --stacked <window> <target>`
4. `hrcchat peek <target>`
5. `hrc capture <runtimeId>` and `hrc runtime capture <runtimeId>`
6. `hrc runtime interrupt <runtimeId>`
7. `hrc run <scope>` → detach → `hrc run <scope>` reattaches the SAME runtime (legacy
   reattach semantics — no new session; `--force-restart` is the only path to a fresh PTY)
8. Cross-cutting default socket invariant

FULL adds:

1. `hrcchat summon`, `doctor`, `who`
2. `hrc monitor show`, `watch`, `wait`
3. `hrc runtime list --transport tmux`, `inspect`
4. `hrc runtime sweep --dry-run`
5. `hrc runtime adopt`
6. `hrc attach --dry-run`
7. `hrc surface bind`, `unbind`, `list`
8. `hrc bridge target`, `deliver-text`, `deliver`, `list`, `close`
9. `hrc server tmux status`
10. `hrc server tmux kill --yes` by code-read only on the shared daemon; execute only on an isolated daemon
11. `RECONCILE-ACROSS-RESTART`
12. `scripts/pre-hrc-broker-matrix-e2e.ts`

## Runbook

1. Check that monitor fixes are installed:

   ```bash
   hrc monitor watch runtime:<known-runtime> --from-seq <old-seq> --json
   ```

   The JSON lines must include `payload`, `generation`, `scopeRef`, `runId`,
   `launchId`, and `streamSeq`.

   In this repo `hrc` runs the CLI source directly through Bun. Do not run
   `just install` as part of this harness unless the current operator asks for
   a full reinstall; it can wipe shared `node_modules` during collaboration.

2. Dry-check setup:

   ```bash
   packages/hrc-server/validation/broker-tmux-ghostmux-e2e/bin/setup.sh --core --dry-run
   ```

3. Confirm no important runtimes are busy:

   ```bash
   hrc runtime list --json | jq '.[] | select(.status == "busy" or .status == "starting") | {scopeRef,runtimeId,status,transport}'
   hrcchat messages
   ```

4. If `/Users/lherron/praesidium/var/run/hrc/btmux/` contains stale dead lease
   sockets, clear them before the run. H-00031 item 1 calls out approximately
   13 stale sockets from earlier testing.

5. Start the run. This flips the broker flags and bootout/bootstrap reloads
   `hrc-server` only if the flags are not already enabled:

   ```bash
   packages/hrc-server/validation/broker-tmux-ghostmux-e2e/bin/setup.sh --core --allow-restart
   ```

   For the full matrix:

   ```bash
   packages/hrc-server/validation/broker-tmux-ghostmux-e2e/bin/setup.sh --full --allow-restart --watch
   ```

6. Open the generated run directory printed by setup. It contains:

   - `env.json`
   - `default-sock.baseline`
   - `timeline.md`
   - `findings.md`
   - ignored heavy evidence under `evidence/`
   - ignored event journals under `events/`

7. For each matrix row, run the command manually against both targets, then snap
   evidence:

   ```bash
   RUN_DIR=packages/hrc-server/validation/broker-tmux-ghostmux-e2e/runs/<UTC-ts>
   packages/hrc-server/validation/broker-tmux-ghostmux-e2e/bin/snap.sh core-dm "$RUN_DIR"
   ```

   Fill the corresponding `findings.md` row inline as PASS, FAIL, or NOTE.

8. Grade every row by this invariant:

   - The operation hits the per-runtime lease socket under `var/run/hrc/btmux/`.
   - The default `var/run/hrc/tmux.sock` inode and mtime match the baseline.
   - No new headless runtime appears for the target.
   - The event journal shows the operation on the lease runtime.

9. End the run:

   ```bash
   packages/hrc-server/validation/broker-tmux-ghostmux-e2e/bin/teardown.sh "$RUN_DIR"
   ```

   Teardown terminates the two runtimes, kills ghostmux surfaces, dumps monitor
   journals, verifies the default socket, and restores the original flag state
   if setup changed it.

10. Commit only the lightweight run artifacts:

   ```bash
   git add packages/hrc-server/validation/broker-tmux-ghostmux-e2e
   git status --short
   ```

   `events/`, `evidence/`, and `watcher-pids` are intentionally ignored.

## Known accepted deviations

Record these as accepted NOTE rows unless the observed behavior gets worse:

- T-01738 F-V1: `hrc runtime inspect` has `tmuxJson=null` for broker-tmux runtimes.
- T-01738 F-V2: `hrc server tmux status` reports the default server only.
- T-01738 F-V3: `hrc server tmux kill --yes` kills the default server only; do not execute on the shared daemon.
- T-01738 F-V4: dead lease socket-file leak.
- T-01738 F-V5: `hrc runtime adopt` does not verify dead-lease liveness.
- Bridge socket plumbing has deferred work on T-01737 if regressions reappear.
- `hrcchat peek` resolver prefer-interactive behavior is a T-01737 follow-up if regressions reappear.

## Files

- `bin/setup.sh`: preflight, flag-state detect/reload, ghostmux launch, runtime discovery, baseline and cursor recording.
- `bin/snap.sh`: per-row lease/ghostmux/default/runtime/log evidence capture and timeline marker.
- `bin/teardown.sh`: idempotent cleanup, event dumps, default-socket verification, optional flag restore/reload.
- `templates/findings.md`: copy used for each run's committed findings.
