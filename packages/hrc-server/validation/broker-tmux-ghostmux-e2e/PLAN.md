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
8. `hrc run <scope>` → wait for idle → send `/quit` to the lease pane → `hrc run <scope>`
   starts a NEW broker TUI session with the priming prompt and without continuation
9. Cross-cutting default socket invariant

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

SCENARIO rows (`--scenario`):

These exercise behavior, not just lease-socket routing. Run on both drivers
unless a row says otherwise. Each row still asserts the default-socket invariant.

1. `BUSY-TUI-QUEUE` — dispatch a long turn to a live broker runtime, then while it
   is mid-flight send a second `hrcchat dm <target>` and `hrcchat turn <target>`.
   The second input must QUEUE onto the same interactive runtime (fifo) and run
   after the first completes. PASS requires: no new headless runtime appears
   (headless count unchanged), `transport=tmux`/`runtimeId` is unchanged, the
   second turn's `turn.completed` fires after the first's, and the lease pane
   shows both turns in order. (Regression guard for T-01801.)
2. `COLD-VS-LIVE-ROUTING` — (a) `hrcchat dm`/`turn` to a COLD scope (no live
   runtime) is allowed to produce a HEADLESS turn; record the headless runtimeId.
   (b) `hrc run <scope>` to make it live, then `hrcchat dm`/`turn` again — this
   must route to the INTERACTIVE lease runtime, NOT spawn a new headless one, and
   reuse the same interactive runtimeId. PASS requires the (b) ops land on the
   live lease pane with no headless-count increase.
3. `CONTINUITY-SEMANTICS` — on one live broker runtime: (a) `hrc session clear-context
   <hostSessionId>` rotates the generation (new `generation` in monitor payload)
   and the next turn starts with no prior context; (b) `hrc session drop-continuation
   <hostSessionId>` removes stored continuation so a subsequent cold `hrc run`
   starts fresh; (c) `hrc run <scope>` after a `/quit` shows the priming prompt and
   NO continuation/resume picker (cross-check with `core-quit-restart`).

INTERACTION rows (`--interaction`) — multi-agent, cross-scope, concurrency:

1. `CROSS-AGENT-DM` — agent A (`clod`) `hrcchat dm`/`turn` → agent B (`cody`) at a
   different scope. The message lands on B's lease pane / durable history and B's
   reply threads back via `--reply-to`. Neither runtime headless-forks; each op
   hits the correct per-runtime lease socket.
2. `RESPOND-TO-HUMAN` — `hrcchat turn <B> "…" --respond-to human` (and the `dm`
   `--respond-to human` form): the reply routes back to the originating surface
   (operator/Discord) rather than only to the durable thread. Assert the reply
   message carries the human recipient address.
3. `CONCURRENT-TURNS` — two `hrcchat turn` dispatches race the SAME runtime. They
   must serialize fifo (no interleaved/garbled pane output, no lost turn); both
   emit distinct `turn.completed` with intact `finalBody`. Pairs with `BUSY-TUI-QUEUE`
   but starts both turns near-simultaneously rather than strictly after-busy.

SEMANTIC rows (`--semantic`) — `hrcchat turn` / `hrcchat dm` flag behavior
(routing already covered by CORE; these assert the flags change behavior):

1. `turn --fresh-context` / `--new` — clears context before dispatch; the turn has
   no memory of the prior turn on the same runtime.
2. `turn --dry-run` — resolves and prints the dispatch plan WITHOUT dispatching; no
   `turn.accepted`/`turn.completed` event is emitted and the pane is untouched.
3. `turn --format <tree|compact|ndjson|json>` — each format renders the terminal
   turn frame in the expected shape (`--stacked` already covers ndjson; confirm the
   other three and the `--pretty` non-TTY override).
4. `turn --reply-to <id>` — the dispatched turn threads under the given message ID.
5. `turn --file <path>` — prompt body is read from the file (parity with `- ` stdin).
6. `turn --stall-after <dur>` — a turn idle past the threshold ABORTS with a terminal
   stall/error event rather than hanging.
7. `dm --follow <dur>` — `dm` dispatches as a tracked turn and streams `turn_stacked`
   ndjson at the interval (the Monitor-tool path), distinct from a bare status-note `dm`.
8. `dm --respond-to <human|agent|system>` — the durable reply carries the correct
   recipient kind for each value.
9. `dm <target> --reply-to <id>` and `dm human|system` targets — threading and the
   `human`/`system` pseudo-targets resolve and deliver.

TRANSPORT rows (`--transport-matrix`) — `hrcchat turn` / `hrcchat dm` across all
three transports, not just the interactive tmux broker:

1. `headless` — `hrcchat dm`/`turn` to a cold scope produces a headless runtime; the
   turn completes and `turn.completed` fires on a `transport=headless` runtime.
2. `tmux` (broker) — the interactive lease path already validated by CORE `core-dm`
   / `core-turn-stacked`; cross-reference rather than re-run.
3. `sdk` — if an sdk-transport driver is live, `hrcchat dm`/`turn` completes on a
   `transport=sdk` runtime; otherwise record as N/A (no sdk driver configured).
   Confirm `hrc runtime list --transport <t>` lists the runtime under the expected
   transport for each case.

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

9. Validate `/quit` recovery for each target:

   ```bash
   TARGET=clod@hrc-runtime:<run-task>
   TASK_FRAGMENT="task:<run-task>"
   SURFACE_ID=$(ghostmux new --cwd /Users/lherron/praesidium/hrc-runtime --title "btmux-quit-$TARGET" --command "hrc run $TARGET" --json | jq -r '.short_id')
   # Wait until the TUI is idle and all startup processing has finished.
   BEFORE_RUNTIME_ID=$(hrc runtime list --json | jq -r --arg task "$TASK_FRAGMENT" 'map(select(.controllerKind == "harness-broker" and .transport == "tmux" and (.scopeRef | contains($task)))) | last | .runtimeId')
   hrc runtime list --json | jq --arg rt "$BEFORE_RUNTIME_ID" '.[] | select(.runtimeId == $rt) | {runtimeId,status,controllerKind,activeInvocationId,runtimeStateJson}'
   ghostmux send-keys -t "$SURFACE_ID" /quit
   # Confirm the terminal exited and HRC reconciles it to a terminal/stale state.
   hrc runtime list --json | jq --arg rt "$BEFORE_RUNTIME_ID" '.[] | select(.runtimeId == $rt) | {runtimeId,status,activeInvocationId,runtimeStateJson}'
   SECOND_SURFACE_ID=$(ghostmux new --cwd /Users/lherron/praesidium/hrc-runtime --title "btmux-quit-$TARGET-2" --command "hrc run $TARGET" --json | jq -r '.short_id')
   AFTER_RUNTIME_ID=$(hrc runtime list --json | jq -r --arg task "$TASK_FRAGMENT" 'map(select(.controllerKind == "harness-broker" and .transport == "tmux" and (.scopeRef | contains($task)))) | last | .runtimeId')
   test "$AFTER_RUNTIME_ID" != "$BEFORE_RUNTIME_ID"
   ghostmux capture-pane -t "$SECOND_SURFACE_ID" -S - -E - | rg "Priming Prompt|working on <run-task>|Continue here"
   ```

   The second `hrc run` must not return `runtime_unavailable`. It must allocate a
   new broker runtime/session for the same scope, not resume or continue the
   exited TUI. Validate that the new runtime id differs from the pre-quit id,
   `runtimeStateJson.status` is live for the new runtime, the old runtime is
   stale or terminated with a terminal/disposed broker invocation, and the pane
   shows the normal priming prompt/startup content rather than a continuation
   picker.

10. End the run:

   ```bash
   packages/hrc-server/validation/broker-tmux-ghostmux-e2e/bin/teardown.sh "$RUN_DIR"
   ```

   Teardown terminates the two runtimes, kills ghostmux surfaces, dumps monitor
   journals, verifies the default socket, and restores the original flag state
   if setup changed it.

11. Commit only the lightweight run artifacts:

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
