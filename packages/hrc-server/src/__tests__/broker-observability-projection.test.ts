import { describe, expect, test } from 'bun:test'

import type {
  CaptureStateView,
  EventProvenance,
  InvocationEventEnvelope,
} from 'spaces-harness-broker-protocol'
import { validateEventEnvelope } from 'spaces-harness-broker-protocol'

import { INVOCATION_ID, RUNTIME_ID, envelope } from './broker-event-mapper-fixtures'
import { createBrokerEventMapperTestFixture } from './broker-event-mapper.test.fixture'

describe('broker observability projection', () => {
  const harness = createBrokerEventMapperTestFixture()

  test('preserves optional provenance verbatim in the durable broker envelope', () => {
    const provenance: EventProvenance = {
      rawRecordId: 'raw-17',
      sourceKind: 'provider-jsonl',
      sourceEpoch: 'epoch-a',
      sourceCursor: { line: 17, byteOffset: 811 },
      nativeType: 'assistant/analysis',
      nativeId: 'native-17',
      rawSha256: `sha256:${'a'.repeat(64)}`,
      normalizer: { name: 'claude-code-jsonl', version: '0.1.0' },
    }
    const withProvenance = {
      ...envelope('driver.notice', 1, {
        message: 'provider evidence observed',
        source: 'driver',
      }),
      provenance,
    } satisfies InvocationEventEnvelope
    const withoutProvenance = envelope('driver.notice', 2, {
      message: 'legacy driver notice',
      source: 'driver',
    })

    expect(validateEventEnvelope(withProvenance)).toBe(withProvenance)
    expect(validateEventEnvelope(withoutProvenance)).toBe(withoutProvenance)

    harness.makeMapper().apply(withProvenance)
    harness.makeMapper().apply(withoutProvenance)

    const storedWith = harness.fixture.db.brokerInvocationEvents.getByInvocationAndSeq(
      INVOCATION_ID,
      1
    )
    const storedWithout = harness.fixture.db.brokerInvocationEvents.getByInvocationAndSeq(
      INVOCATION_ID,
      2
    )
    expect(JSON.parse(storedWith!.brokerEnvelopeJson!)).toEqual(withProvenance)
    expect(JSON.parse(storedWith!.brokerEnvelopeJson!).provenance).toEqual(provenance)
    expect(JSON.parse(storedWithout!.brokerEnvelopeJson!)).not.toHaveProperty('provenance')
  })

  test('refreshes capture only on authoritative signals and projects state verbatim', () => {
    const mapper = harness.makeMapper()
    const warning = envelope('capture.warning', 1, {
      kind: 'blocked_unknown',
      message: 'unknown load-bearing provider record',
      raw: {
        rawRecordId: 'raw-blocked',
        nativeType: 'queue.future_op',
        family: 'input-admission',
      },
    })
    const blocked: CaptureStateView = {
      state: 'blocked',
      blockedOn: {
        rawRecordId: 'raw-blocked',
        nativeType: 'queue.future_op',
        family: 'input-admission',
        message: 'unknown load-bearing provider record',
        sinceIso: '2026-05-27T12:00:01.000Z',
      },
      deferredCount: 2,
    }

    expect(mapper.apply(warning).captureStateRefresh).toBe(true)
    const blockedEvent = mapper.projectCaptureState(RUNTIME_ID, blocked)
    expect(blockedEvent?.eventKind).toBe('runtime.capture_state_changed')
    expect(
      harness.fixture.db.runtimes.getByRuntimeId(RUNTIME_ID)?.runtimeStateJson?.['capture']
    ).toEqual(blocked)
    expect(mapper.projectCaptureState(RUNTIME_ID, blocked)).toBeUndefined()

    const warningReplay = mapper.apply(warning)
    expect(warningReplay.idempotent).toBe(true)
    expect(warningReplay.captureStateRefresh).not.toBe(true)

    const released = envelope('capture.released', 2, {
      rawRecordId: 'raw-blocked',
      disposition: 'ignored-known',
      nativeType: 'queue.future_op',
      family: 'input-admission',
      resumedRecords: 2,
    })
    const open: CaptureStateView = { state: 'open', deferredCount: 0 }

    expect(mapper.apply(released).captureStateRefresh).toBe(true)
    const openEvent = mapper.projectCaptureState(RUNTIME_ID, open)
    expect(openEvent?.eventKind).toBe('runtime.capture_state_changed')
    expect(
      harness.fixture.db.runtimes.getByRuntimeId(RUNTIME_ID)?.runtimeStateJson?.['capture']
    ).toEqual(open)
    expect(mapper.apply(released).captureStateRefresh).not.toBe(true)
    expect(
      harness.fixture.db.hrcEvents.listByKind('runtime.capture_state_changed', {
        runtimeId: RUNTIME_ID,
      })
    ).toHaveLength(2)
  })
})
