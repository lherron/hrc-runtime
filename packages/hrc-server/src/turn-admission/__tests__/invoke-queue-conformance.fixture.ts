import { expect, test } from 'bun:test'
import type { HrcServerTestFixture } from '../../__tests__/fixtures/hrc-test-fixture'
import type { HrcServerInstanceForHandlers } from '../../server-instance-context'
import { fakeBrokerClient } from './broker-boundary.fixture'
import {
  CONFORMANCE_INVOCATION_ID as invocationId,
  CONFORMANCE_RUNTIME_ID as runtimeId,
} from './driver-graph.fixture'
import type { Driver } from './expected-admission'

/** Invoke reporting must match the physical broker admission class. */
export function registerInvokeQueueConformance({
  context,
  getFixture,
  seedDriver,
  post,
}: {
  context: () => HrcServerInstanceForHandlers
  getFixture: () => HrcServerTestFixture
  seedDriver: (driver: Driver) => void
  post: (door: 'submission' | 'turns', intent: string, patch?: object) => Promise<Response>
}) {
  async function expectQueueInvoke(
    door: 'submission' | 'turns',
    capabilities: object,
    codex = false
  ) {
    seedDriver('format1-headless')
    const ctx = context()
    const fixture = getFixture()
    ctx.db.brokerInvocations.update(invocationId, {
      capabilitiesJson: JSON.stringify(capabilities),
      ...(codex ? { brokerDriver: 'codex-app-server' } : {}),
      updatedAt: fixture.now(),
    })
    const client = fakeBrokerClient(ctx, runtimeId, invocationId)
    let enqueues = 0
    const enqueue = client.enqueue.bind(client)
    client.enqueue = async (request) => {
      enqueues++
      return enqueue(request)
    }
    client.invoke = async () => {
      throw new Error('unexpected exclusive invoke')
    }
    ctx.getHarnessBrokerController().active.set(runtimeId, {
      runtimeId,
      invocationId,
      client,
      closing: false,
    })
    const response = await post(door, 'invoke')
    if (codex) expect(response.status).toBe(202)
    else expect([200, 202]).toContain(response.status)
    expect(enqueues).toBe(1)
    const receipt = await response.json()
    expect(receipt.admission).toBe('admitted')
    const event = ctx.db.hrcEvents.listByKind('submission.admission')[0]
    expect((event?.payload as { effectiveDoor: string }).effectiveDoor).toBe('enqueue')
    const diagnostics = ctx.db.runtimes.getByRuntimeId(runtimeId)?.runtimeStateJson?.[
      'brokerDispatchDiagnostics'
    ] as { submissions: { admissionClass: string; door: string }[] }
    expect(diagnostics.submissions[0]?.admissionClass).toBe('queue')
    expect(diagnostics.submissions[0]?.door).toBe('enqueue')
    expect(ctx.db.hrcEvents.listByKind('submission.door_downgraded')).toHaveLength(1)
    expect(receipt).toMatchObject({
      effectiveDoor: 'enqueue',
      requestedDoor: 'invoke',
      downgradeReason: 'invoke_exclusive_not_supported',
    })
    await Bun.sleep(30)
  }
  for (const door of ['submission', 'turns'] as const) {
    test(`${door}/invoke: admission capability agrees with broker queue class`, async () => {
      await expectQueueInvoke(door, { admission: { classes: ['queue'] } })
    })
  }
  test('turns/invoke: codex-app-server without exclusive physically enqueues and reports its downgrade', async () => {
    await expectQueueInvoke(
      'turns',
      {
        admission: { classes: ['steer', 'queue'] },
        bracketMintingMode: 'observed',
        queue: { cancelHarnessLocal: false },
        turns: { concurrency: 'single', interrupt: 'protocol' },
      },
      true
    )
  })
}
