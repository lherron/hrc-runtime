/**
 * RED tests — T-01875 / T-01862 Ph4: endpoint/substrate-driven startup
 * reconciliation, orphan sweeper, lazy dispatch reattach, and zombie/activity
 * handling.
 *
 * Ph4 replaces the transport-driven broker GC loop with endpoint/substrate-driven
 * reconciliation keyed off `parseBrokerRuntimeHostingState` + predicates from
 * broker/runtime-hosting.ts. The following 10 scenarios all fail at HEAD because
 * the current code uses `runtime.transport === 'tmux'` as the gate:
 *
 *  Scenario 1  — reconcileDurableBrokerStartup REATTACHES a headless durable
 *                runtime after daemon restart; NO broker_orphaned_on_restart event.
 *                AT HEAD: transport guard skips headless → runtime absent from outcomes.
 *
 *  Scenario 2  — reconcileDurableBrokerRuntimeReattach handles an interactive
 *                runtime persisted in the NORMALIZED hosting-state shape
 *                (broker.substrate / broker.presentation keys). brokerLeaseWindowsMatch
 *                reads flat-shape only → window check fails → stale instead of reattach.
 *
 *  Scenario 3  — reconcileDurableBrokerStartup stales a legacy daemon-child headless
 *                row with broker_legacy_no_durable_endpoint_on_restart.
 *                AT HEAD: runtime skipped → not in outcomes.
 *
 *  Scenario 4  — reconcileDurableBrokerStartup stales a nonterminal v0.1 row
 *                (endpoint=stdio-jsonrpc-ndjson) with
 *                broker_protocol_legacy_unsupported_on_startup.
 *                AT HEAD: transport+endpoint guard skips it → not in outcomes.
 *
 *  Scenario 5  (G4) — reconcileDurableBrokerRuntimeReattach for a HEADLESS runtime
 *                (presentation.none): probe with matching brokerWindow but null
 *                tuiWindow REATTACHES. brokerLeaseWindowsMatch requires tuiWindow
 *                for ALL leased substrates → fails for presentation.none.
 *
 *  Scenario 6  — Orphan sweeper PRESERVES a headless (transport='headless') runtime
 *                with leased-tmux substrate pointing to a live socket.
 *                AT HEAD: sweeper gates on transport==='tmux' → headless not claimed
 *                → socket killed.
 *
 *  Scenario 7  — Orphan sweeper still REAPS an unclaimed/dead leased substrate
 *                regardless of the headless-claim fix. (Sanity check that the
 *                substrate-based claim detection doesn't over-protect.)
 *
 *  Scenario 8  (G5) — reattachDurableBrokerForDispatch reattaches a HEADLESS
 *                runtime (presentation.none) when the broker socket is live.
 *                AT HEAD: brokerLeaseWindowsMatch fails (no tuiWindow) → returns false.
 *
 *  Scenario 9  (G5/G4) — reattachDurableBrokerForDispatch for a HEADLESS runtime
 *                does NOT attempt direct tmux pane input when reattach fails
 *                (canUseDirectPaneFallback===false guards the pane path).
 *
 *  Scenario 10 (G6) — After a successful broker.attach + replay in
 *                reconcileDurableBrokerRuntimeReattach, the active RUN's activity
 *                timestamp is updated so a recovered in-flight run is NOT zombied by
 *                a subsequent zombie sweep.
 *                AT HEAD: outcome returned without updating run → zombie sweep kills it.
 *
 * Harness fidelity: real HRC SQLite + real HarnessBrokerController + scripted mock
 * DurableBrokerClient. No live broker, no live tmux (except scenarios 6/7 which
 * create real tmux sessions for the orphan sweep, following broker-pane-lease-orphan-
 * sweep.red.test.ts).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { HrcRuntimeSnapshot } from 'hrc-core'
import { openHrcDatabase } from 'hrc-store-sqlite'
import type { HrcDatabase } from 'hrc-store-sqlite'

import { HarnessBrokerController } from '../broker/controller'
import { canUseDirectPaneFallback } from '../broker/runtime-hosting'
import * as reconcile from '../startup-reconcile'
import * as ph4 from './fixtures/broker-endpoint-substrate.fixture'

// ─────────────────────────────────────────────────────────────────────────────
// Shared fixture constants
// ─────────────────────────────────────────────────────────────────────────────

let dir: string
let dbPath: string
let db: HrcDatabase
let serverFixture: HrcServerTestFixture | undefined

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'hrc-ph4-'))
  dbPath = join(dir, 'test.sqlite')
  db = openHrcDatabase(dbPath)
})

afterEach(async () => {
  db.close()
  await rm(dir, { recursive: true, force: true })
})

function readRuntime(runtimeId: string): HrcRuntimeSnapshot {
  const rt = db.runtimes.getByRuntimeId(runtimeId)
  if (!rt) throw new Error(`runtime ${runtimeId} vanished`)
  return rt
}

function makeController(overrideDb?: HrcDatabase): HarnessBrokerController {
  return new HarnessBrokerController({
    db: overrideDb ?? db,
    now: () => ph4.nowTs(),
    serverInstanceId: ph4.SERVER_INSTANCE_ID,
  })
}

// ─────────────────────────────────────────────────────────────────────────────
describe('Scenario 8 (G5): reattachDurableBrokerForDispatch reattaches headless on broker_runtime_not_active', () => {
  it('returns true when broker socket is live and runtime has durable endpoint + leased substrate (presentation.none)', async () => {
    ph4.seedHeadlessDurableRuntime(db)

    const client = new ph4.MockDurableBrokerClient()
    const snap = ph4.emptySnapshot(ph4.HEADLESS_INVOCATION_ID, {
      currentSeq: 1,
      retentionFloorSeq: 1,
    })
    client.snapshotResponse = snap
    client.attachResponse = ph4.attachResponseFor(
      ph4.HEADLESS_RUNTIME_ID,
      ph4.HEADLESS_INVOCATION_ID,
      snap
    )
    client.queueEventsSince({
      events: [
        ph4.makeEnvelope(ph4.HEADLESS_INVOCATION_ID, 'invocation.ready', 1, { state: 'ready' }),
      ],
      currentSeq: 1,
      retentionFloorSeq: 1,
    })

    const controller = makeController()
    const reattached = await reconcile.reattachDurableBrokerForDispatch(
      db,
      readRuntime(ph4.HEADLESS_RUNTIME_ID),
      {
        runtimeRoot: ph4.RUNTIME_ROOT,
        controller,
        inFlightOperations: new Map(),
        brokerUnixClientFactory: async () => client,
        resolveAttachToken: async () => ph4.ATTACH_TOKEN,
        probeBrokerLease: async () => ({
          brokerSocketLive: true,
          brokerWindow: ph4.BROKER_WINDOW,
          tuiWindow: null, // presentation.none — no tuiWindow
        }),
      }
    )

    // Ph4: headless reattach returns true → dispatch retry can proceed.
    // AT HEAD: returns false (brokerLeaseWindowsMatch fails for presentation.none).
    expect(reattached.state).toBe('reattached')
    expect(client.calls).toContain('attach')
  })

  it('headless runtime has canUseDirectPaneFallback=false (no tmux pane for dispatch fallback)', () => {
    // Guard: this predicate must remain false for headless runtimes.
    // Ph4 must NOT wire direct-tmux-pane fallback for presentation.none dispatch.
    ph4.seedHeadlessDurableRuntime(db)
    expect(canUseDirectPaneFallback(readRuntime(ph4.HEADLESS_RUNTIME_ID))).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 9 (G5/G4): reattachDurableBrokerForDispatch reports unavailable for
// headless when broker socket is dead (no direct tmux fallback available).
//
// At HEAD: already returns false (for wrong reason — window check fails).
// After Ph4: returns false for correct reason (socket unavailable, no pane fallback).
// This scenario verifies the correct failure mode, not just the return value.
// ─────────────────────────────────────────────────────────────────────────────
describe('Scenario 9 (G5/G4): headless dispatch: no direct tmux pane fallback when reattach fails', () => {
  it('reattachDurableBrokerForDispatch reports unavailable when broker socket is dead (presentation.none)', async () => {
    ph4.seedHeadlessDurableRuntime(db)

    let dialed = false
    const reattached = await reconcile.reattachDurableBrokerForDispatch(
      db,
      readRuntime(ph4.HEADLESS_RUNTIME_ID),
      {
        runtimeRoot: ph4.RUNTIME_ROOT,
        controller: makeController(),
        inFlightOperations: new Map(),
        brokerUnixClientFactory: async () => {
          dialed = true
          throw new Error('socket unavailable')
        },
        resolveAttachToken: async () => ph4.ATTACH_TOKEN,
        probeBrokerLease: async () => ({
          brokerSocketLive: false, // socket dead
          brokerWindow: null,
          tuiWindow: null,
        }),
      }
    )

    // Reattach must fail (no socket → no attach).
    expect(reattached.state).toBe('unavailable')
    // The unix factory must NOT be called when the socket probe returns dead.
    expect(dialed).toBe(false)

    // The predicate confirms no direct pane fallback is available.
    expect(canUseDirectPaneFallback(readRuntime(ph4.HEADLESS_RUNTIME_ID))).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 10 (G6): Active RUN activity is refreshed on successful broker.attach
// so a recovered in-flight run is NOT zombied by the zombie sweep.
//
// RED: At HEAD, reconcileDurableBrokerRuntimeReattach on success returns
// outcome={state:'broker-attached'} but does NOT update the active run's
// updatedAt. A subsequent zombie sweep with thresholdSeconds=0 kills the run.
// After Ph4: successful attach/replay refreshes run.updatedAt → zombie sweep
// leaves the run alive.
//
// Also covers: retention gap → broker_event_retention_gap emitted by
// attachAndReplay, NOT zombie.
// ─────────────────────────────────────────────────────────────────────────────
describe('Scenario 10 (G6): active RUN activity refreshed on broker.attach/replay', () => {
  it('run is NOT zombied after a successful broker.attach + replay (G6 activity refresh)', async () => {
    // Seed with an OLD run timestamp — zombie would kill it without activity refresh.
    ph4.seedHeadlessDurableRuntime(db, { runStatus: 'running', runUpdatedAt: ph4.oldTs() })

    const client = new ph4.MockDurableBrokerClient()
    const snap = ph4.emptySnapshot(ph4.HEADLESS_INVOCATION_ID, {
      currentSeq: 2,
      retentionFloorSeq: 1,
    })
    client.snapshotResponse = snap
    client.attachResponse = ph4.attachResponseFor(
      ph4.HEADLESS_RUNTIME_ID,
      ph4.HEADLESS_INVOCATION_ID,
      snap
    )
    client.queueEventsSince({
      events: [
        ph4.makeEnvelope(ph4.HEADLESS_INVOCATION_ID, 'invocation.started', 1, {
          pid: 1,
          command: 'claude',
          args: [],
          cwd: '/tmp',
        }),
        ph4.makeEnvelope(ph4.HEADLESS_INVOCATION_ID, 'invocation.ready', 2, { state: 'ready' }),
      ],
      currentSeq: 2,
      retentionFloorSeq: 1,
    })

    const outcome = await reconcile.reconcileDurableBrokerRuntimeReattach(
      db,
      readRuntime(ph4.HEADLESS_RUNTIME_ID),
      {
        runtimeRoot: ph4.RUNTIME_ROOT,
        controller: makeController(),
        brokerUnixClientFactory: async () => client,
        resolveAttachToken: async () => ph4.ATTACH_TOKEN,
        probeBrokerLease: async () => ({
          brokerSocketLive: true,
          brokerWindow: ph4.BROKER_WINDOW,
          tuiWindow: null, // presentation.none
        }),
      }
    )

    // Reattach must succeed.
    expect(outcome.state).toBe('broker-attached')

    // G6: after attach/replay the active run's updatedAt must be refreshed so
    // the zombie sweep cannot kill it.
    const run = db.runs.getByRunId(ph4.HEADLESS_RUN_ID)
    expect(run).toBeDefined()

    // The run must NOT be in a terminal state (failed/zombie).
    expect(run?.status).not.toBe('zombie')
    expect(run?.status).not.toBe('failed')

    // Ph4: run activity timestamp must have been updated from ph4.oldTs() to now.
    // AT HEAD: run.updatedAt remains ph4.oldTs() → zombie sweep (below) kills it.
    // After Ph4: run.updatedAt is refreshed → zombie sweep skips it.
    //
    // Verify by running the zombie sweep with zero threshold.
    // The sweep targets headless runs older than threshold in ('accepted','started','running').
    const sweepResult = await fetch(
      `http+unix://${encodeURIComponent(serverFixture?.socketPath ?? '')}/v1/runs/sweep-zombies`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ thresholdSeconds: 0 }),
      }
    ).catch(() => null)

    if (sweepResult?.ok) {
      // If we managed to reach the server, check the run isn't zombied.
      const runAfterSweep = db.runs.getByRunId(ph4.HEADLESS_RUN_ID)
      expect(runAfterSweep?.status).not.toBe('zombie')
    } else {
      // No server — verify directly that the run timestamp was refreshed.
      // At HEAD: run.updatedAt is still ph4.oldTs() → would be zombie-eligible.
      // After Ph4: run.updatedAt > ph4.oldTs().
      expect(run?.updatedAt).not.toBe(ph4.oldTs())
    }
  })

  it('retention gap on reattach → broker_replay_retention_gap emitted, NOT zombie (G6)', async () => {
    // Seeds headless runtime with a non-zero lastProjectedSeq to create a gap.
    ph4.seedHeadlessDurableRuntime(db, { runStatus: 'running', runUpdatedAt: ph4.oldTs() })

    const client = new ph4.MockDurableBrokerClient()
    // Create a retention gap: retentionFloorSeq=10 but lastProjectedSeq=0 → gap.
    const snap = ph4.emptySnapshot(ph4.HEADLESS_INVOCATION_ID, {
      currentSeq: 10,
      retentionFloorSeq: 10, // floor has advanced past last projected (0+1) → gap
    })
    client.snapshotResponse = snap
    client.attachResponse = ph4.attachResponseFor(
      ph4.HEADLESS_RUNTIME_ID,
      ph4.HEADLESS_INVOCATION_ID,
      snap
    )
    // eventsSince will not be called due to early gap detection in attachAndReplay.

    const outcome = await reconcile.reconcileDurableBrokerRuntimeReattach(
      db,
      readRuntime(ph4.HEADLESS_RUNTIME_ID),
      {
        runtimeRoot: ph4.RUNTIME_ROOT,
        controller: makeController(),
        brokerUnixClientFactory: async () => client,
        resolveAttachToken: async () => ph4.ATTACH_TOKEN,
        probeBrokerLease: async () => ({
          brokerSocketLive: true,
          brokerWindow: ph4.BROKER_WINDOW,
          tuiWindow: null,
        }),
      }
    )

    // Retention gap → reattach fails with a specific reason.
    // The reason must be broker_event_retention_gap (not zombie, not generic stale).
    expect(outcome.state).toBe('stale')
    expect(outcome.reason).toBe('broker_event_retention_gap')
    expect(outcome.brokerAttached).toBe(false)

    // The run must be explicitly failed (not left alive for zombie sweep).
    const run = db.runs.getByRunId(ph4.HEADLESS_RUN_ID)
    expect(run?.status).not.toBe('zombie')
    // Run is marked failed/unavailable due to retention gap.
    expect(run?.status).toMatch(/^(failed|stale)$/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// T-01996: single attach authority + broker.health drain handling
// ─────────────────────────────────────────────────────────────────────────────
describe('T-01996: classification-only pass (attach:false)', () => {
  it('returns broker-attachable WITHOUT attaching for a live, identity-valid durable runtime', async () => {
    ph4.seedInteractiveNormalizedRuntime(db)
    const client = new ph4.MockDurableBrokerClient()

    const outcome = await reconcile.reconcileDurableBrokerRuntimeReattach(
      db,
      readRuntime(ph4.INTERACTIVE_RUNTIME_ID),
      {
        runtimeRoot: ph4.RUNTIME_ROOT,
        attach: false,
        controller: makeController(),
        brokerUnixClientFactory: async () => client,
        // Must NOT be consulted on the classification-only path.
        resolveAttachToken: async () => {
          throw new Error('resolveAttachToken must not run under attach:false')
        },
        probeBrokerLease: async () => ({
          brokerSocketLive: true,
          brokerHealth: 'ok',
          brokerWindow: ph4.INTERACTIVE_BROKER_WINDOW,
          tuiWindow: ph4.TUI_WINDOW,
        }),
      }
    )

    expect(outcome.state).toBe('broker-attachable')
    expect(outcome.brokerAttached).toBe(false)
    // No attach+replay performed: the serving warm owns that.
    expect(client.calls).not.toContain('attach')
    // The runtime is left intact (not staled) for the serving warm to bind.
    expect(readRuntime(ph4.INTERACTIVE_RUNTIME_ID).status).not.toBe('stale')
  })
})

describe('T-01996: broker.health shutting_down is skipped, not staled', () => {
  it('returns broker-shutting-down and leaves the runtime intact', async () => {
    ph4.seedInteractiveNormalizedRuntime(db)
    const client = new ph4.MockDurableBrokerClient()

    const outcome = await reconcile.reconcileDurableBrokerRuntimeReattach(
      db,
      readRuntime(ph4.INTERACTIVE_RUNTIME_ID),
      {
        runtimeRoot: ph4.RUNTIME_ROOT,
        controller: makeController(),
        brokerUnixClientFactory: async () => client,
        resolveAttachToken: async () => ph4.ATTACH_TOKEN,
        probeBrokerLease: async () => ({
          brokerSocketLive: false,
          brokerHealth: 'shutting_down',
          brokerWindow: ph4.INTERACTIVE_BROKER_WINDOW,
          tuiWindow: ph4.TUI_WINDOW,
        }),
      }
    )

    expect(outcome.state).toBe('broker-shutting-down')
    expect(outcome.brokerAttached).toBe(false)
    expect(client.calls).not.toContain('attach')
    // A draining broker is not dead — the runtime must NOT be staled by the probe.
    expect(readRuntime(ph4.INTERACTIVE_RUNTIME_ID).status).not.toBe('stale')
  })
})
