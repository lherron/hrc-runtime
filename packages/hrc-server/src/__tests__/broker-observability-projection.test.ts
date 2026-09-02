import { describe, expect, test } from 'bun:test'

import type {
  CaptureStateView,
  EventProvenance,
  InvocationEventEnvelope,
} from 'spaces-harness-broker-protocol'
import { validateEventEnvelope } from 'spaces-harness-broker-protocol'

import { BrokerEventMapper } from '../broker/event-mapper'
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

  test('warns immediately for blocked unknown capture and rate-limits repeats by source key', () => {
    const calls: Array<{
      level: string
      event: string
      details: Record<string, unknown> | undefined
    }> = []
    let rateLimitNow = 0
    const mapper = new BrokerEventMapper({
      db: harness.fixture.db,
      now: () => '2026-05-27T12:01:40.000Z',
      rateLimitNow: () => rateLimitNow,
      serverLog: (level, event, details) => calls.push({ level, event, details }),
    })
    mapper.projectCaptureState(RUNTIME_ID, { state: 'open', deferredCount: 0 })

    const warning = (seq: number, family = 'input-admission') =>
      ({
        ...envelope('capture.warning', seq, {
          kind: 'blocked_unknown',
          message: 'unknown load-bearing provider record',
          raw: {
            rawRecordId: `raw-${seq}`,
            nativeType: 'queue.future_op',
            family,
          },
        }),
        driver: { kind: 'codex-app-server' },
      }) satisfies InvocationEventEnvelope

    mapper.apply(warning(1))
    rateLimitNow = 30_000
    mapper.apply(warning(2))
    rateLimitNow = 59_999
    mapper.apply(warning(3))
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual({
      level: 'WARN',
      event: 'broker.capture_blocked_unknown',
      details: {
        runtimeId: RUNTIME_ID,
        scopeRef: 'agent:smokey:project:hrc-runtime:task:T-01696',
        invocationId: INVOCATION_ID,
        driver: 'codex-app-server',
        harness: 'codex-cli',
        family: 'input-admission',
        nativeType: 'queue.future_op',
        rawRecordId: 'raw-1',
        message: 'unknown load-bearing provider record',
        capture: { state: 'open', deferredCount: 0 },
        count: 1,
      },
    })

    rateLimitNow = 60_000
    mapper.apply(warning(4))
    expect(calls).toHaveLength(2)
    expect(calls[1]?.details).toMatchObject({ count: 4, rawRecordId: 'raw-4' })

    mapper.apply(warning(5, 'turn-bracket'))
    expect(calls).toHaveLength(3)
    expect(calls[2]?.details).toMatchObject({ family: 'turn-bracket', count: 1 })
  })

  test('warns with operator disposition when capture is released', () => {
    const calls: Array<{
      level: string
      event: string
      details: Record<string, unknown> | undefined
    }> = []
    const mapper = new BrokerEventMapper({
      db: harness.fixture.db,
      now: () => '2026-05-27T12:01:40.000Z',
      serverLog: (level, event, details) => calls.push({ level, event, details }),
    })

    mapper.projectCaptureRelease(
      RUNTIME_ID,
      'user:lance',
      {
        invocationId: INVOCATION_ID,
        rawRecordId: 'raw-blocked',
        disposition: 'ignored-known',
      },
      {
        released: true,
        invocationId: INVOCATION_ID,
        rawRecordId: 'raw-blocked',
        disposition: 'ignored-known',
        releasedSeq: 7,
        resumedRecords: 2,
        capture: { state: 'open', deferredCount: 0 },
      }
    )

    expect(calls).toEqual([
      {
        level: 'WARN',
        event: 'broker.capture_released',
        details: {
          runtimeId: RUNTIME_ID,
          scopeRef: 'agent:smokey:project:hrc-runtime:task:T-01696',
          invocationId: INVOCATION_ID,
          operatorPrincipal: 'user:lance',
          rawRecordId: 'raw-blocked',
          disposition: 'ignored-known',
          resumedRecords: 2,
        },
      },
    ])
  })
})
