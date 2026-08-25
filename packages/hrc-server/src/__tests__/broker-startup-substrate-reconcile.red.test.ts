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
import type { HrcServer } from '../index'
import * as reconcile from '../startup-reconcile'
import * as ph4 from './fixtures/broker-endpoint-substrate.fixture'
import type { HrcServerTestFixture } from './fixtures/hrc-test-fixture'

// ─────────────────────────────────────────────────────────────────────────────
// Shared fixture constants
// ─────────────────────────────────────────────────────────────────────────────

let dir: string
let dbPath: string
let db: HrcDatabase

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
describe('Scenario 2: interactive runtime with normalized shape reattaches', () => {
  it('reconcileDurableBrokerRuntimeReattach returns broker-attached for a normalized-shape interactive runtime', async () => {
    ph4.seedInteractiveNormalizedRuntime(db)

    const client = new ph4.MockDurableBrokerClient()
    const snap = ph4.emptySnapshot(ph4.INTERACTIVE_INVOCATION_ID, {
      currentSeq: 1,
      retentionFloorSeq: 1,
    })
    client.snapshotResponse = snap
    client.attachResponse = ph4.attachResponseFor(
      ph4.INTERACTIVE_RUNTIME_ID,
      ph4.INTERACTIVE_INVOCATION_ID,
      snap
    )
    client.queueEventsSince({
      events: [
        ph4.makeEnvelope(ph4.INTERACTIVE_INVOCATION_ID, 'invocation.ready', 1, { state: 'ready' }),
      ],
      currentSeq: 1,
      retentionFloorSeq: 1,
    })

    const controller = makeController()
    const outcome = await reconcile.reconcileDurableBrokerRuntimeReattach(
      db,
      readRuntime(ph4.INTERACTIVE_RUNTIME_ID),
      {
        runtimeRoot: ph4.RUNTIME_ROOT,
        controller,
        brokerUnixClientFactory: async () => client,
        resolveAttachToken: async () => ph4.ATTACH_TOKEN,
        probeBrokerLease: async () => ({
          brokerSocketLive: true,
          // Probe carries the matching identity from the normalized substrate.
          brokerWindow: ph4.INTERACTIVE_BROKER_WINDOW,
          tuiWindow: ph4.TUI_WINDOW, // presentation.tmux-tui requires tuiWindow
        }),
      }
    )

    // Ph4: normalized shape must be handled by parseBrokerRuntimeHostingState
    // + brokerLeaseIdentityMatches → broker-attached.
    // AT HEAD: brokerLeaseWindowsMatch reads flat broker['brokerWindow']=undefined
    // (absent in normalized shape) → returns false → stale.
    expect(outcome.state).toBe('broker-attached')
    expect(outcome.brokerAttached).toBe(true)
    expect(client.calls).toContain('attach')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 3: Legacy daemon-child headless → broker_legacy_no_durable_endpoint_on_restart
//
// RED: At HEAD, reconcileDurableBrokerStartup skips the legacy runtime (no
// durable endpoint → filtered out), so it is NOT in outcomes and the staling
// happens (with wrong reason broker_orphaned_on_restart) only via the blanket
// GC loop in reconcileStartupState. After Ph4: reconcileDurableBrokerStartup
// processes ALL nonterminal harness-broker runtimes and stales legacy ones with
// the precise reason broker_legacy_no_durable_endpoint_on_restart.
// ─────────────────────────────────────────────────────────────────────────────
describe('Scenario 3: legacy daemon-child headless → broker_legacy_no_durable_endpoint_on_restart', () => {
  it('reconcileDurableBrokerStartup stales a legacy headless runtime with the precise reason', async () => {
    ph4.seedLegacyDaemonChildRuntime(db)

    const outcomes = await reconcile.reconcileDurableBrokerStartup(db, {
      runtimeRoot: ph4.RUNTIME_ROOT,
      controller: makeController(),
      brokerUnixClientFactory: async () => {
        throw new Error('must not be called for legacy/v0.1 classify-once path')
      },
      resolveAttachToken: async () => undefined,
      probeBrokerLease: async () => {
        throw new Error('must not probe legacy daemon-child runtime')
      },
      sweepOrphans: async () => {},
    })

    // Ph4: legacy runtime must appear in outcomes with specific reason.
    // AT HEAD: outcomes is empty for this runtime → headlessOutcome is undefined.
    const legacyOutcome = outcomes.find((o) => o.runtimeId === ph4.LEGACY_RUNTIME_ID)
    expect(legacyOutcome).toBeDefined()
    expect(legacyOutcome?.state).toBe('stale')
    expect(legacyOutcome?.reason).toBe('broker_legacy_no_durable_endpoint_on_restart')

    // Runtime must actually be staled in DB with the correct staleReason.
    const runtime = readRuntime(ph4.LEGACY_RUNTIME_ID)
    expect(runtime.status).toBe('stale')
    const staleReason = (runtime.runtimeStateJson as Record<string, unknown>)?.['staleReason']
    expect(staleReason).toBe('broker_legacy_no_durable_endpoint_on_restart')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 4: v0.1 row (endpoint=stdio) → broker_protocol_legacy_unsupported_on_startup
//
// RED: At HEAD, v0.1 row (transport='tmux', endpoint=stdio) is skipped by
// reconcileDurableBrokerStartup (no unix endpoint → filtered). After Ph4:
// classify-once with precedence v0.1 > no-endpoint stales it with
// broker_protocol_legacy_unsupported_on_startup.
// ─────────────────────────────────────────────────────────────────────────────
describe('Scenario 4: v0.1 row → broker_protocol_legacy_unsupported_on_startup', () => {
  it('reconcileDurableBrokerStartup stales a v0.1 stdio-endpoint row with the legacy protocol reason', async () => {
    ph4.seedV01Row(db)

    const outcomes = await reconcile.reconcileDurableBrokerStartup(db, {
      runtimeRoot: ph4.RUNTIME_ROOT,
      controller: makeController(),
      brokerUnixClientFactory: async () => {
        throw new Error('must not be called for v0.1 rows')
      },
      resolveAttachToken: async () => undefined,
      probeBrokerLease: async () => {
        throw new Error('must not probe v0.1 row')
      },
      sweepOrphans: async () => {},
    })

    // Ph4: v0.1 row must appear in outcomes with the protocol-legacy reason.
    // AT HEAD: outcomes is empty (no unix endpoint → filter skips it).
    const v01Outcome = outcomes.find((o) => o.runtimeId === ph4.V01_RUNTIME_ID)
    expect(v01Outcome).toBeDefined()
    expect(v01Outcome?.state).toBe('stale')
    expect(v01Outcome?.reason).toBe('broker_protocol_legacy_unsupported_on_startup')

    // Precedence: v0.1 (stdio endpoint present) before no-durable-endpoint.
    const runtime = readRuntime(ph4.V01_RUNTIME_ID)
    expect(runtime.status).toBe('stale')
    const staleReason = (runtime.runtimeStateJson as Record<string, unknown>)?.['staleReason']
    expect(staleReason).toBe('broker_protocol_legacy_unsupported_on_startup')
  })

  it('classify-once precedence: v0.1 stales with protocol reason, not no-endpoint reason', async () => {
    // Verify v0.1 gets protocol reason even though it also lacks a durable endpoint.
    ph4.seedV01Row(db)

    const outcomes = await reconcile.reconcileDurableBrokerStartup(db, {
      runtimeRoot: ph4.RUNTIME_ROOT,
      controller: makeController(),
      brokerUnixClientFactory: async () => {
        throw new Error('unused')
      },
      resolveAttachToken: async () => undefined,
      probeBrokerLease: async () => {
        throw new Error('unused')
      },
      sweepOrphans: async () => {},
    })

    const v01Outcome = outcomes.find((o) => o.runtimeId === ph4.V01_RUNTIME_ID)
    // Must be protocol-legacy, NOT broker_legacy_no_durable_endpoint_on_restart.
    expect(v01Outcome?.reason).not.toBe('broker_legacy_no_durable_endpoint_on_restart')
    expect(v01Outcome?.reason).toBe('broker_protocol_legacy_unsupported_on_startup')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 5 (G4): reconcileDurableBrokerRuntimeReattach for headless (presentation.none)
// requires only brokerWindow, NOT tuiWindow
//
// RED: At HEAD, brokerLeaseWindowsMatch:
//   const persisted = getPersistedBrokerWindows(runtime)
//   if (!persisted?.brokerWindow || !persisted.tuiWindow) return false  ← fails for headless
// For a headless runtime, broker['tuiWindow'] is absent → persisted.tuiWindow = undefined
// → brokerLeaseWindowsMatch returns false → stale with broker_window_identity_mismatch.
// After Ph4: uses brokerLeaseIdentityMatches which skips tuiWindow when
// presentation.kind === 'none' → reattach succeeds.
// ─────────────────────────────────────────────────────────────────────────────
describe('Scenario 5 (G4): headless reattach requires only brokerWindow, not tuiWindow', () => {
  it('reconcileDurableBrokerRuntimeReattach with probe.tuiWindow=null succeeds for presentation.none', async () => {
    ph4.seedHeadlessDurableRuntime(db)

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
          brokerWindow: ph4.BROKER_WINDOW, // matching brokerWindow
          tuiWindow: null, // no TUI window — presentation.none
        }),
      }
    )

    // Ph4: presentation.none → only brokerWindow identity required → reattach.
    // AT HEAD: brokerLeaseWindowsMatch requires !persisted.tuiWindow to be falsy,
    // but ALSO requires persisted.tuiWindow to exist in the second branch →
    // the function returns false → outcome.state === 'stale'.
    expect(outcome.state).toBe('broker-attached')
    expect(outcome.brokerAttached).toBe(true)
    expect(client.calls).toContain('attach')
  })

  it('interactive reattach (presentation.tmux-tui) still fails when tuiWindow is missing from probe', async () => {
    // G4 counterpart: for presentation.tmux-tui, tuiWindow IS required.
    ph4.seedInteractiveNormalizedRuntime(db)

    const outcome = await reconcile.reconcileDurableBrokerRuntimeReattach(
      db,
      readRuntime(ph4.INTERACTIVE_RUNTIME_ID),
      {
        runtimeRoot: ph4.RUNTIME_ROOT,
        controller: makeController(),
        brokerUnixClientFactory: async () => {
          throw new Error('must not dial when identity check fails')
        },
        resolveAttachToken: async () => ph4.ATTACH_TOKEN,
        probeBrokerLease: async () => ({
          brokerSocketLive: true,
          brokerWindow: ph4.INTERACTIVE_BROKER_WINDOW,
          tuiWindow: null, // missing → identity mismatch for tmux-tui
        }),
      }
    )

    // For presentation.tmux-tui, tuiWindow is REQUIRED. Probe missing it → stale.
    // This should PASS after Ph4 (the tmux-tui gate is stricter).
    // At HEAD: also stale (brokerLeaseWindowsMatch requires tuiWindow) — may already pass.
    // Kept as a regression guard.
    expect(outcome.state).toBe('stale')
    expect(outcome.brokerAttached).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Scenarios 6 & 7: Orphan sweeper with real tmux + createHrcServer
// These follow the pattern from broker-pane-lease-orphan-sweep.red.test.ts.
// ─────────────────────────────────────────────────────────────────────────────

const _GRACE_ENV = 'HRC_BROKER_ORPHAN_SWEEP_GRACE_MS'

let _serverFixture: HrcServerTestFixture
const _liveServers: HrcServer[] = []
const _leaseSockets: string[] = []
let _priorGrace: string | undefined

// Use separate beforeEach/afterEach for the server-level tests.
// Bun runs describes in sequence so these are scoped to this block.
