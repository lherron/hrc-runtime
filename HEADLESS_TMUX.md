# T-01862: Make leased tmux the default harness-broker substrate

## Observed behavior

Headless `harness-broker` runtimes do not survive `hrc-server` restart. If a restart occurs while a headless turn is in flight, the active broker process is killed and the turn is lost.

The session continuation persists, so the next turn can resume the conversation, but the in-flight turn does not complete gracefully. It may fail with `runtime_unavailable` and later zombie due to run timeout.

Observed on `2026-06-04` with `larry@hrc-runtime:T-01854`:

- `rt-72f25c7b` went stale with `runtime.stale reason="broker_orphaned_on_restart"` at `01:36:16Z`.
- Its last event before restart was a `turn.tool_call` at `01:36:15.057Z`.
- The run later zombied with `turn.zombied/run_zombie_timeout`.
- `rt-863f9ce9` failed the same way at `02:04:42Z`, about one second after a mid-tool-exec event.
- Both runtimes used `controller_kind=harness-broker` and `transport=headless`.
- Both active `runs` rows failed with `error_code=runtime_unavailable` at `server.start.ready`.

The important practical failure is that multi-file implementation work can be left half-finished on disk while the active turn that knew what it was doing disappears.

## Diagnosed root cause

This is current design, not a regression.

Durable broker survival exists only for broker runtimes whose process tree is anchored in a leased tmux server. That leased tmux server lives outside the `hrc-server` daemon process tree, under:

```text
<runtimeRoot>/btmux/<driver>-<runtimeId>.sock
```

On daemon restart, `startup-reconcile.ts` can inspect the persisted tmux lease, verify the pane/session identity, and re-associate the existing runtime/invocation.

Current behavior in [`startup-reconcile.ts`](/Users/lherron/praesidium/hrc-runtime/packages/hrc-server/src/startup-reconcile.ts:216):

```ts
if (runtime.transport === 'tmux') {
  if (await reassociateBrokerTmuxLease(runtime)) {
    emitBrokerTmuxReassociated(db, runtime)
    continue
  }
  gcBrokerRuntimeOnRestart(db, runtime, 'broker_tmux_lease_stale_on_restart')
  continue
}

gcBrokerRuntimeOnRestart(db, runtime, 'broker_orphaned_on_restart')
```

Headless broker runtimes do not have this durable lease. Their broker child process is parented by the old daemon, so daemon restart kills the child. After restart, HRC has persisted runtime/invocation rows that may still look usable, but there is no live broker process behind them. The startup reconcile path therefore marks those runtimes stale and disposes the orphaned invocation.

There is also a separate compounding issue: `hrc server restart` normally gates on in-flight non-tmux work, but the caller’s own run is self-excluded to avoid deadlock. In the observed case, Larry restarted the server from inside its own turn, so the gate did not block the restart. That explains why this incident happened, but it is not the core durability problem.

## Proposed solution

Reframe the architecture: **leased tmux should be the default execution substrate for all `harness-broker` runtimes**.

Do not think of this as “rehosting headless on tmux.” Instead, tmux should become the canonical broker substrate. A broker runtime always gets a daemon-independent leased tmux server/session that owns the durable broker process and IPC endpoint.

Interactivity should be modeled as an optional presentation layer on top of that substrate.

Suggested terminology:

- **Broker substrate:** the leased tmux process container that hosts the durable broker process.
- **Presentation window:** an optional tmux window/pane that hosts an operator-facing harness TUI.
- **Headless runtime:** broker substrate only; no presentation window is created or advertised.
- **Interactive runtime:** broker substrate plus a presentation window that users/operators can attach to.

The key architectural statement:

> HRC’s default `harness-broker` substrate is a leased tmux server that outlives the daemon. Headless broker runtimes use that substrate without exposing an attachable UI. Interactive broker runtimes use the same substrate and add a presentation window for the TUI.

## Implementation implications

The broker process should always run inside the leased tmux substrate, regardless of whether the runtime is headless or interactive.

Startup reconciliation should no longer treat headless broker runtimes as inherently orphaned. Instead, it should reconcile all broker runtimes through the durable lease path where possible:

- Inspect the persisted lease socket/session.
- Verify pane/window ids match persisted runtime state.
- Reconnect durable broker IPC using the existing attach token / lease probe / `BrokerClient.connectUnix` path.
- Keep the runtime and invocation intact if the lease is live.
- GC only when the lease is genuinely stale or identity checks fail.

Interactive runtimes should keep their attach UX, but the TUI should be modeled as a presentation surface attached to the durable broker substrate, not as the thing that defines durability.

## Transport/modeling question

The main design choice is how to represent this in runtime metadata.

Options:

- Keep `transport=headless` and store substrate details separately.
- Use `transport=tmux` for all broker runtimes, with a separate `presentation=headless|tui` dimension.
- Introduce something like `substrate=tmux` and keep `transport` for operator interaction semantics.
- Introduce `headless-tmux`, though that risks encoding an implementation transition rather than the intended model.

The cleanest long-term shape is probably to separate durable substrate from presentation/interaction mode. Existing code branches heavily on `runtime.transport`, so this needs a careful audit across admission, reuse, inspect/status, sweep/reconcile, target routing, and interactive attach handlers.

## Acceptance criteria

A valid fix should prove:

- A headless broker turn survives `hrc-server` restart while mid-flight.
- The same runtime/invocation is re-associated after restart.
- No `runtime.stale reason=broker_orphaned_on_restart` is emitted for a live leased broker.
- The turn completes or remains correctly active after restart rather than failing `runtime_unavailable`.
- Interactive broker-tmux restart survival remains unchanged.
- Dead or leaked leased tmux servers are still swept correctly by the orphan lease sweeper.
- Lease socket paths remain under the Unix socket length limit.
- Validation uses a real installed HRC binary and a real restart, not only unit tests.

## Related work

- `T-01801`: durable broker IPC and tmux-only survival machinery.
- `T-01773`: broker tmux runtime cannot reaccept input after restart.
- `T-01776`: btmux socket path length hardening.
- `T-01785` / `T-01800`: headless broker routing and PTY reuse correctness.
- `T-01860`: restart initiator attribution.
- Follow-up, separate from this proposal: harden restart gating so a runtime cannot silently kill its own in-flight turn.
