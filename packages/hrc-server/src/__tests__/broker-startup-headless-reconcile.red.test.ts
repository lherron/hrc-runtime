import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { HrcRuntimeSnapshot } from 'hrc-core'
import { openHrcDatabase } from 'hrc-store-sqlite'
import type { HrcDatabase } from 'hrc-store-sqlite'

import { HarnessBrokerController } from '../broker/controller'
import {
  canUseDirectPaneFallback,
  hasDurableBrokerEndpoint,
  hasLeasedBrokerSubstrate,
} from '../broker/runtime-hosting'
import * as reconcile from '../startup-reconcile'
import * as ph4 from './fixtures/broker-endpoint-substrate.fixture'

let dir: string
let db: HrcDatabase

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'hrc-ph4-startup-'))
  db = openHrcDatabase(join(dir, 'test.sqlite'))
})

afterEach(async () => {
  db.close()
  await rm(dir, { recursive: true, force: true })
})

function readRuntime(runtimeId: string): HrcRuntimeSnapshot {
  const runtime = db.runtimes.getByRuntimeId(runtimeId)
  if (!runtime) throw new Error(`runtime ${runtimeId} vanished`)
  return runtime
}

function makeController(): HarnessBrokerController {
  return new HarnessBrokerController({
    db,
    now: () => ph4.nowTs(),
    serverInstanceId: ph4.SERVER_INSTANCE_ID,
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 1: reconcileDurableBrokerStartup REATTACHES a headless durable runtime
//
// RED: At HEAD, reconcileDurableBrokerStartup has `runtime.transport !== 'tmux'`
// guard that skips headless runtimes entirely → outcomes is empty for headless.
// After Ph4 impl: uses hasDurableBrokerEndpoint + hasLeasedBrokerSubstrate instead
// of transport → headless durable runtime IS processed → outcomes includes
// broker-attached entry.
// ─────────────────────────────────────────────────────────────────────────────
describe('Scenario 1: reconcileDurableBrokerStartup reattaches headless durable runtime', () => {
  it('headless durable runtime (transport=headless) is included in outcomes with state=broker-attached', async () => {
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
    const outcomes = await reconcile.reconcileDurableBrokerStartup(db, {
      runtimeRoot: ph4.RUNTIME_ROOT,
      controller,
      brokerUnixClientFactory: async () => client,
      resolveAttachToken: async () => ph4.ATTACH_TOKEN,
      probeBrokerLease: async () => ({
        brokerSocketLive: true,
        brokerWindow: ph4.BROKER_WINDOW,
        tuiWindow: null, // presentation.none — no TUI window
      }),
      sweepOrphans: async () => {},
    })

    // Ph4 impl must include the headless runtime in outcomes with broker-attached.
    // AT HEAD: outcomes is empty → fails here.
    const headlessOutcome = outcomes.find((o) => o.runtimeId === ph4.HEADLESS_RUNTIME_ID)
    expect(headlessOutcome).toBeDefined()
    expect(headlessOutcome?.state).toBe('broker-attached')
    expect(headlessOutcome?.brokerAttached).toBe(true)

    // The runtime must NOT be staled.
    expect(readRuntime(ph4.HEADLESS_RUNTIME_ID).status).not.toBe('stale')

    // No runtime.stale event with reason broker_orphaned_on_restart must be emitted.
    const staleEvents = db.hrcEvents.listByKind('runtime.stale')
    const orphanedEvent = staleEvents.find(
      (e) =>
        (e.payload as Record<string, unknown>)?.['reason'] === 'broker_orphaned_on_restart' &&
        (e.payload as Record<string, unknown>)?.['runtimeId'] === ph4.HEADLESS_RUNTIME_ID
    )
    expect(orphanedEvent).toBeUndefined()
  })

  it('headless predicates confirm the seeded runtime has durable endpoint + leased substrate', () => {
    ph4.seedHeadlessDurableRuntime(db)
    const runtime = readRuntime(ph4.HEADLESS_RUNTIME_ID)
    // Predicate checks (already green from Ph1) — confirming fixture correctness.
    expect(hasDurableBrokerEndpoint(runtime)).toBe(true)
    expect(hasLeasedBrokerSubstrate(runtime)).toBe(true)
    expect(canUseDirectPaneFallback(runtime)).toBe(false) // presentation=none
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 2: reconcileDurableBrokerRuntimeReattach handles NORMALIZED shape
//
// RED: At HEAD, brokerLeaseWindowsMatch reads broker['brokerWindow'] and
// broker['tuiWindow'] (flat shape). A runtime persisted with the normalized
// shape (broker.substrate.brokerWindow, broker.presentation.tuiWindow) has
// NO flat keys → window check fails → stale.
// After Ph4: uses brokerLeaseIdentityMatches from runtime-hosting.ts which
// calls parseBrokerRuntimeHostingState → handles normalized shape → reattach.
