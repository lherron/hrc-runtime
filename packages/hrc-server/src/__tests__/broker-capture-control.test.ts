import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { BrokerRpcError } from 'spaces-harness-broker-client'
import type { CaptureStateView } from 'spaces-harness-broker-protocol'

import { HarnessBrokerController } from '../broker/controller'
import {
  FakeBrokerClient,
  NOW,
  makeFixture,
  makeStartInput,
} from './fixtures/broker-controller.fixture'
import type { TestFixture } from './fixtures/broker-controller.fixture'

describe('broker capture control', () => {
  let fixture: TestFixture

  beforeEach(async () => {
    fixture = await makeFixture()
  })

  afterEach(async () => {
    await fixture.cleanup()
  })

  test('sends the exact release request over the active client and records operator authority', async () => {
    const fake = new FakeBrokerClient()
    const controller = new HarnessBrokerController({
      db: fixture.db,
      brokerClientFactory: async () => fake,
      now: () => NOW,
      serverInstanceId: 'server-test',
    })
    expect((await controller.start({ ...makeStartInput(), brokerClient: fake })).ok).toBe(true)

    const result = await controller.captureRelease(
      'runtime_w2',
      {
        rawRecordId: 'raw-blocked',
        disposition: 'ignored-known',
        note: 'operator classified this native row',
      },
      'human:lherron'
    )

    expect(result.ok).toBe(true)
    if (!result.ok) throw result.error
    expect(result.response).toBe(fake.captureReleaseResponse)
    expect(fake.captureReleaseCalls).toEqual([
      {
        invocationId: 'invocation_w2',
        rawRecordId: 'raw-blocked',
        disposition: 'ignored-known',
        note: 'operator classified this native row',
      },
    ])
    expect(fixture.db.runtimes.getByRuntimeId('runtime_w2')?.runtimeStateJson?.['capture']).toEqual(
      fake.captureReleaseResponse.capture
    )
    const event = fixture.db.hrcEvents.listByKind('runtime.capture_released', {
      runtimeId: 'runtime_w2',
    })[0]
    expect(event).toBeDefined()
    expect(event?.payload).toMatchObject({
      operatorPrincipal: 'human:lherron',
      request: { rawRecordId: 'raw-blocked', disposition: 'ignored-known' },
      response: { releasedSeq: 7 },
    })
  })

  test('projects the fresh status snapshot and preserves typed broker refusal data', async () => {
    const fake = new FakeBrokerClient()
    const blocked: CaptureStateView = {
      state: 'blocked',
      blockedOn: {
        rawRecordId: 'raw-current',
        nativeType: 'queue.future_op',
        family: 'input-admission',
        message: 'unknown queue operation',
        sinceIso: '2026-09-01T19:00:00.000Z',
      },
      deferredCount: 1,
    }
    fake.snapshotResponse = { ...fake.snapshotResponse, capture: blocked }
    const controller = new HarnessBrokerController({
      db: fixture.db,
      brokerClientFactory: async () => fake,
      now: () => NOW,
      serverInstanceId: 'server-test',
    })
    expect((await controller.start({ ...makeStartInput(), brokerClient: fake })).ok).toBe(true)

    const status = await controller.captureStatus('runtime_w2')
    expect(status).toEqual({ ok: true, response: blocked })
    expect(fixture.db.runtimes.getByRuntimeId('runtime_w2')?.runtimeStateJson?.['capture']).toEqual(
      blocked
    )

    fake.captureReleaseError = new BrokerRpcError({
      code: -32602,
      message: 'raw record is not the blocking record',
      data: {
        reason: 'raw_record_not_blocked',
        blockedOn: blocked.blockedOn,
      },
    })
    const refused = await controller.captureRelease(
      'runtime_w2',
      { rawRecordId: 'raw-other', disposition: 'ignored-known' },
      'human:lherron'
    )
    expect(refused.ok).toBe(false)
    if (refused.ok) throw new Error('expected typed broker refusal')
    expect(refused.error.detail).toMatchObject({
      brokerRpcCode: -32602,
      reason: 'raw_record_not_blocked',
      blockedOn: blocked.blockedOn,
    })
  })
})
