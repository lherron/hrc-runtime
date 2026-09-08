/**
 * T-08294 — WHEN external lifecycle ownership becomes true.
 *
 * `isExternalLifecycleOwner` is the single field that stops HRC reaping,
 * restarting or terminalizing something it does not own. The original
 * implementation stamped it on the runtime `controller.start()` RETURNED, which
 * reads as correct and is not: `persistStartGraph` INSERTS the runtime row
 * before `startInvocationFromRequest` is awaited, and `client.onClose(...)` is
 * registered before that. So the row was observable — to the broker close
 * handler, to the zombie sweep, to startup reconcile — while still looking
 * HRC-owned, and a post-start admission failure then REBUILT `runtimeStateJson`
 * wholesale and dropped the field entirely.
 *
 * The invariant these tests hold is stronger than "eventually owned": there is
 * no moment at which a desktop observer runtime EXISTS and is not owned. Each
 * test therefore pins a specific earlier-than-return observation point, and the
 * first one carries its own control — without the control it would pass just as
 * happily against the broken version.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import type { HrcRuntimeSnapshot } from 'hrc-core'

import { HarnessBrokerController } from '../broker/controller'
import { isExternalLifecycleOwner } from '../external-participant-lifecycle'

import {
  FakeBrokerClient,
  NOW,
  type TestFixture,
  capabilityRequirements,
  invocationCapabilities,
  makeFixture,
  makeStartInput,
} from './fixtures/broker-controller.fixture'

let fixture: TestFixture

beforeEach(async () => {
  fixture = await makeFixture()
})

afterEach(async () => {
  await fixture.cleanup()
})

function controllerFor(fake: FakeBrokerClient): HarnessBrokerController {
  return new HarnessBrokerController({
    db: fixture.db,
    brokerClientFactory: async () => fake,
    now: () => NOW,
    serverInstanceId: 'server-test',
  })
}

function runtimeRow(): HrcRuntimeSnapshot | null {
  return fixture.db.runtimes.getByRuntimeId('runtime_w2')
}

describe('desktop observer external ownership timing', () => {
  it('is already true at onAccepted — the earliest point the runtime row exists', async () => {
    const fake = new FakeBrokerClient()
    const input = makeStartInput()
    // `onAccepted` is awaited immediately after `persistStartGraph` and BEFORE
    // `startInvocationFromRequest`. If ownership is not established here, it is
    // not established for the crash, the exit, or the failed start either.
    let ownedAtAccept: boolean | undefined
    let stateAtAccept: unknown
    const result = await controllerFor(fake).start({
      ...input,
      brokerClient: fake,
      lifecycleOwner: 'external',
      onAccepted: (graph) => {
        ownedAtAccept = isExternalLifecycleOwner(graph.runtime)
        stateAtAccept = graph.runtime.runtimeStateJson?.['lifecycleOwner']
      },
    })

    expect(result.ok).toBe(true)
    expect(ownedAtAccept).toBe(true)
    expect(stateAtAccept).toBe('external')
    // The row on disk at that moment, not just the in-memory graph object.
    expect(fake.callOrder.indexOf('start')).toBeGreaterThanOrEqual(0)
  })

  it('CONTROL: an ordinary start is NOT externally owned at the same point', async () => {
    // Without this, the test above proves only that the field can be read. It is
    // also the reproducer for the original defect: the desktop path used to look
    // exactly like this until `start()` returned.
    const fake = new FakeBrokerClient()
    const input = makeStartInput()
    let ownedAtAccept: boolean | undefined
    const result = await controllerFor(fake).start({
      ...input,
      brokerClient: fake,
      onAccepted: (graph) => {
        ownedAtAccept = isExternalLifecycleOwner(graph.runtime)
      },
    })

    expect(result.ok).toBe(true)
    expect(ownedAtAccept).toBe(false)
    expect(isExternalLifecycleOwner(runtimeRow()!)).toBe(false)
  })

  it('survives the post-start rebuild of runtimeStateJson', async () => {
    // A SUCCESSFUL start replaces `runtimeStateJson` wholesale via
    // `buildRuntimeStateJson`. A field stamped only at insert would be erased
    // here — by the success path, which is the last place anyone would look.
    const fake = new FakeBrokerClient()
    const result = await controllerFor(fake).start({
      ...makeStartInput(),
      brokerClient: fake,
      lifecycleOwner: 'external',
    })

    expect(result.ok).toBe(true)
    expect(isExternalLifecycleOwner(result.ok ? result.runtime : runtimeRow()!)).toBe(true)
    expect(isExternalLifecycleOwner(runtimeRow()!)).toBe(true)
  })

  it('survives a post-start admission FAILURE', async () => {
    // `markStartedInvocationFailed` also rebuilds `runtimeStateJson` wholesale,
    // with `status: 'failed'`. This is the worst case to lose ownership in: the
    // runtime looks dead and unowned, so the ordinary reaper would treat a live
    // desktop conversation's observer as its own corpse.
    const fake = new FakeBrokerClient()
    // The started invocation no longer offers what the profile REQUIRES. Both
    // halves are needed: the shared fixture profile declares
    // `expectedCapabilities: {}`, so degrading the response alone admits fine.
    fake.startResponse = {
      ...fake.startResponse,
      capabilities: {
        ...invocationCapabilities(),
        input: { ...invocationCapabilities().input, user: false },
      },
    }
    const input = makeStartInput()
    const result = await controllerFor(fake).start({
      ...input,
      profile: {
        ...input.profile,
        expectedCapabilities: capabilityRequirements(),
      } as typeof input.profile,
      brokerClient: fake,
      lifecycleOwner: 'external',
    })

    expect(result.ok).toBe(false)
    const row = runtimeRow()
    expect(row).not.toBeNull()
    expect(row?.status).toBe('failed')
    expect(isExternalLifecycleOwner(row!)).toBe(true)
  })

  it('survives a broker that dies mid-start, after the row exists', async () => {
    // The crash window the design cares about: the row is inserted, the close
    // handler is live, and the invocation start never completes.
    const fake = new FakeBrokerClient()
    fake.startInvocationFromRequest = async () => {
      throw new Error('simulated broker death during invocation start')
    }
    const result = await controllerFor(fake).start({
      ...makeStartInput(),
      brokerClient: fake,
      lifecycleOwner: 'external',
    })

    expect(result.ok).toBe(false)
    const row = runtimeRow()
    expect(row).not.toBeNull()
    expect(isExternalLifecycleOwner(row!)).toBe(true)
  })
})
