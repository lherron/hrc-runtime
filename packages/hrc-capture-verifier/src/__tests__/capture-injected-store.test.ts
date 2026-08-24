import { describe, expect, it } from 'bun:test'
import { hashPayload, verifyInvocation } from '../index.js'

import {
  INVOCATION_ID,
  brokerEvent,
  fakeStore,
  transcriptFixture,
} from './capture-verifier.fixture.js'
describe('capture verifier with injected stores', () => {
  it('passes clean ledger, raw mirror, lifecycle, and provider matching checks through a fake store', async () => {
    const event = brokerEvent(1, 'user.message', { content: 'hello' })
    const store = fakeStore([event])
    const report = await verifyInvocation({
      store,
      invocationId: INVOCATION_ID,
      transcript: transcriptFixture([
        {
          schema: 'hrc.capture-observation/v1',
          line: 1,
          provider: 'codex',
          type: 'user.message',
          normalizedPayload: { content: 'hello' },
          payloadHash: hashPayload({ content: 'hello' }),
        },
      ]),
    })

    expect(report.status).toBe('pass')
    expect(report.ok).toBe(true)
    expect(report.rawMirror).toEqual({ checked: 1, matched: 1 })
    expect(report.providerMatches[0]?.status).toBe('matched')
    expect(report.lifecycle[0]?.status).toBe('present')
    expect(report.analytics.providerJsonl).toMatchObject({
      totalLines: 1,
      applicableObservations: 1,
    })
    expect(report.analytics.rawEvents).toMatchObject({
      expectedFromBroker: 1,
      found: 1,
      matched: 1,
      missing: 0,
      mismatched: 0,
    })
    expect(report.analytics.lifecycleProjection).toMatchObject({
      checkedBrokerEvents: 1,
      policyMapped: 1,
      expected: 1,
      present: 1,
      missing: 0,
      suppressed: 0,
      notApplicable: 0,
    })
    expect(report.analytics.crossSink).toMatchObject({
      providerToBroker: { expected: 1, matched: 1, missing: 0, divergent: 0 },
      brokerToRaw: { expected: 1, matched: 1, missing: 0, mismatched: 0 },
      brokerToLifecycle: { expected: 1, present: 1, missing: 0, suppressed: 0 },
    })
  })

  it('omits provider analytics when no JSONL transcript is supplied', async () => {
    const report = await verifyInvocation({
      store: fakeStore([brokerEvent(1, 'user.message', { content: 'hello' })]),
      invocationId: INVOCATION_ID,
    })

    expect(report.analytics.providerJsonl).toBeUndefined()
    expect(report.analytics.crossSink.providerToBroker).toBeUndefined()
    expect(report.analytics.brokerLedger.eventCount).toBe(1)
    expect(report.analytics.rawEvents.expectedFromBroker).toBe(1)
  })

  it('skips the raw-mirror cross-check with one notice when the mirror is absent', async () => {
    const report = await verifyInvocation({
      store: fakeStore([
        brokerEvent(1, 'user.message', { content: 'hello' }, { skipMirror: true }),
        brokerEvent(2, 'turn.completed', {}, { skipMirror: true }),
      ]),
      invocationId: INVOCATION_ID,
    })

    expect(report.status).toBe('pass')
    expect(report.ok).toBe(true)
    expect(report.rawMirror).toEqual({ checked: 0, matched: 0 })
    expect(report.findings).toContainEqual(
      expect.objectContaining({
        severity: 'info',
        layer: 'raw-mirror',
        code: 'raw_mirror_unavailable',
      })
    )
    expect(report.findings.filter((finding) => finding.layer === 'raw-mirror')).toHaveLength(1)
    expect(report.analytics.rawEvents).toMatchObject({
      expectedFromBroker: 0,
      found: 0,
      matched: 0,
      missing: 0,
      mismatched: 0,
    })
    expect(report.analytics.crossSink.brokerToRaw).toEqual({
      expected: 0,
      matched: 0,
      missing: 0,
      mismatched: 0,
    })
  })

  it('fails on seq holes, non-applied rows, and raw mirror mismatches', async () => {
    const report = await verifyInvocation({
      store: fakeStore([
        brokerEvent(
          1,
          'user.message',
          { content: 'hello' },
          { mirrorPayload: { content: 'other' } }
        ),
        brokerEvent(3, 'turn.completed', {}, { projectionStatus: 'pending', skipMirror: true }),
      ]),
      invocationId: INVOCATION_ID,
    })
    expect(report.status).toBe('fail')
    expect(report.findings.map((finding) => finding.code)).toContain('seq_hole')
    expect(report.findings.map((finding) => finding.code)).toContain('projection_not_applied')
    expect(report.findings.map((finding) => finding.code)).toContain('raw_mirror_mismatch')
    expect(report.findings.map((finding) => finding.code)).toContain('raw_mirror_seq_missing')
    expect(report.analytics.brokerLedger.seqHoleCount).toBe(1)
    expect(report.analytics.rawEvents).toMatchObject({
      expectedFromBroker: 2,
      appliedBrokerRows: 1,
      linkedByHrcEventSeq: 1,
      found: 1,
      matched: 0,
      missing: 1,
      mismatched: 1,
      payloadMismatch: 1,
    })
  })

  it('summarizes ledger duplicate, identity, divergence, generation, and attempt evidence', async () => {
    const report = await verifyInvocation({
      store: fakeStore([
        brokerEvent(1, 'user.message', { content: 'hello' }),
        brokerEvent(
          1,
          'assistant.message.completed',
          { content: 'hi' },
          {
            runtimeId: 'rt_other',
            runId: 'run_prior',
            harnessGeneration: 0,
            turnAttempt: 0,
          }
        ),
      ]),
      invocationId: INVOCATION_ID,
    })

    expect(report.analytics.brokerLedger).toMatchObject({
      eventCount: 2,
      duplicateSeqCount: 1,
      runtimeIdentityMismatchCount: 1,
      runDivergenceWarningCount: 1,
      staleGenerationCount: 1,
      staleAttemptCount: 1,
    })
    expect(report.analytics.brokerLedger.eventsByType).toMatchObject({
      'user.message': 1,
      'assistant.message.completed': 1,
    })
  })

  it('summarizes raw mirror mismatch fields with row-level mismatched semantics', async () => {
    const report = await verifyInvocation({
      store: fakeStore([
        brokerEvent(1, 'user.message', { content: 'hello' }, { skipMirror: true }),
        brokerEvent(2, 'user.message', { content: 'hello' }, { omitRawMirror: true }),
        brokerEvent(3, 'user.message', { content: 'hello' }, { rawSource: 'operator' }),
        brokerEvent(4, 'user.message', { content: 'hello' }, { rawEventKind: 'broker.other' }),
        brokerEvent(5, 'user.message', { content: 'hello' }, { rawInvocationId: 'other' }),
        brokerEvent(6, 'user.message', { content: 'hello' }, { rawBrokerSeq: 99 }),
        brokerEvent(7, 'user.message', { content: 'hello' }, { rawBrokerType: 'other' }),
        brokerEvent(8, 'user.message', { content: 'hello' }, { rawEventJson: 'not-json' }),
        brokerEvent(9, 'user.message', { content: 'hello' }, { rawPayloadMissing: true }),
        brokerEvent(
          10,
          'user.message',
          { content: 'hello' },
          { mirrorPayload: { content: 'other' } }
        ),
      ]),
      invocationId: INVOCATION_ID,
    })

    expect(report.analytics.rawEvents).toMatchObject({
      expectedFromBroker: 10,
      linkedByHrcEventSeq: 9,
      found: 8,
      matched: 0,
      missing: 2,
      mismatched: 8,
      wrongSource: 1,
      wrongEventKind: 1,
      wrongInvocation: 1,
      wrongSeq: 1,
      wrongType: 1,
      malformedEventJson: 1,
      malformedPayload: 1,
      payloadMismatch: 1,
    })
    expect(
      report.analytics.rawEvents.wrongSource + report.analytics.rawEvents.wrongEventKind
    ).toBeLessThan(report.analytics.rawEvents.mismatched)
  })

  it('summarizes lifecycle present, missing, suppressed, and not-applicable evidence', async () => {
    const report = await verifyInvocation({
      store: fakeStore([
        brokerEvent(1, 'user.message', { content: 'present' }),
        brokerEvent(2, 'assistant.message.completed', { content: 'missing' }),
        brokerEvent(3, 'provider.internal', {}),
        brokerEvent(4, 'tool.call.started', { toolCallId: 'stale' }, { harnessGeneration: 0 }),
      ]),
      invocationId: INVOCATION_ID,
    })

    expect(report.lifecycle.map((item) => [item.brokerSeq, item.status])).toEqual([
      [1, 'present'],
      [2, 'missing'],
      [3, 'not_applicable'],
      [4, 'suppressed'],
    ])
    expect(report.analytics.lifecycleProjection).toMatchObject({
      checkedBrokerEvents: 4,
      policyMapped: 3,
      expected: 2,
      present: 1,
      missing: 1,
      suppressed: 1,
      notApplicable: 1,
    })
    expect(report.analytics.crossSink.brokerToLifecycle).toMatchObject({
      expected: 2,
      present: 1,
      missing: 1,
      suppressed: 1,
      notApplicable: 1,
    })
  })

  it('reports missing provider events and strict assistant text divergence', async () => {
    const event = brokerEvent(1, 'assistant.message.completed', {
      content: [{ type: 'text', text: 'broker text' }],
    })

    const defaultReport = await verifyInvocation({
      store: fakeStore([event]),
      invocationId: INVOCATION_ID,
      transcript: transcriptFixture([
        {
          schema: 'hrc.capture-observation/v1',
          line: 1,
          provider: 'codex',
          type: 'assistant.message.completed',
          normalizedPayload: { content: 'provider text' },
          payloadHash: hashPayload({ content: 'provider text' }),
          text: 'provider text',
        },
      ]),
    })
    expect(defaultReport.ok).toBe(true)
    expect(defaultReport.providerMatches[0]?.status).toBe('text-mismatch-tolerated')

    const strictReport = await verifyInvocation({
      store: fakeStore([event]),
      invocationId: INVOCATION_ID,
      strictText: true,
      transcript: transcriptFixture([
        {
          schema: 'hrc.capture-observation/v1',
          line: 1,
          provider: 'codex',
          type: 'assistant.message.completed',
          normalizedPayload: { content: 'provider text' },
          payloadHash: hashPayload({ content: 'provider text' }),
          text: 'provider text',
        },
        {
          schema: 'hrc.capture-observation/v1',
          line: 2,
          provider: 'codex',
          type: 'tool.call.started',
          correlationKey: 'missing',
          normalizedPayload: { toolCallId: 'missing', name: 'Bash', input: {} },
          payloadHash: hashPayload({ toolCallId: 'missing', name: 'Bash', input: {} }),
        },
      ]),
    })
    expect(strictReport.ok).toBe(false)
    expect(strictReport.findings.map((finding) => finding.code)).toContain(
      'provider_event_payload_divergent'
    )
    expect(strictReport.findings.map((finding) => finding.code)).toContain(
      'provider_event_missing_in_broker'
    )
  })

  it('still fails divergent tool input with the same correlation id', async () => {
    const report = await verifyInvocation({
      store: fakeStore([
        brokerEvent(1, 'tool.call.started', {
          toolCallId: 'call-1',
          name: 'command',
          input: { command: '/bin/zsh -lc "pwd"', cwd: '/tmp' },
        }),
      ]),
      invocationId: INVOCATION_ID,
      transcript: transcriptFixture([
        {
          schema: 'hrc.capture-observation/v1',
          line: 1,
          provider: 'codex',
          type: 'tool.call.started',
          correlationKey: 'call-1',
          normalizedPayload: {
            toolCallId: 'call-1',
            name: 'command',
            input: { cmd: 'date', cwd: '/tmp' },
          },
          payloadHash: hashPayload({
            toolCallId: 'call-1',
            name: 'command',
            input: { cmd: 'date', cwd: '/tmp' },
          }),
        },
      ]),
    })

    expect(report.ok).toBe(false)
    expect(report.providerMatches[0]?.status).toBe('divergent')
    expect(report.findings.map((finding) => finding.code)).toContain(
      'provider_event_payload_divergent'
    )
  })

  it('still fails divergent short tool output with the same correlation id', async () => {
    const report = await verifyInvocation({
      store: fakeStore([
        brokerEvent(1, 'tool.call.completed', {
          toolCallId: 'call-1',
          name: 'command',
          result: { output: 'actual output' },
        }),
      ]),
      invocationId: INVOCATION_ID,
      transcript: transcriptFixture([
        {
          schema: 'hrc.capture-observation/v1',
          line: 1,
          provider: 'codex',
          type: 'tool.call.completed',
          correlationKey: 'call-1',
          normalizedPayload: {
            toolCallId: 'call-1',
            result: { output: 'different output' },
          },
          payloadHash: hashPayload({
            toolCallId: 'call-1',
            result: { output: 'different output' },
          }),
        },
      ]),
    })

    expect(report.ok).toBe(false)
    expect(report.providerMatches[0]?.status).toBe('divergent')
    expect(report.findings.map((finding) => finding.code)).toContain(
      'provider_event_payload_divergent'
    )
  })

  it('accepts escaped multiline tool output when the stable lines overlap', async () => {
    const brokerOutput = ['alpha line', 'beta line', 'gamma line', 'delta line'].join('\n')
    const providerOutput = String.raw`alpha line\nbeta line\ngamma line\ndelta line`
    const report = await verifyInvocation({
      store: fakeStore([
        brokerEvent(1, 'tool.call.completed', {
          toolCallId: 'call-1',
          name: 'command',
          result: { output: brokerOutput },
        }),
      ]),
      invocationId: INVOCATION_ID,
      transcript: transcriptFixture([
        {
          schema: 'hrc.capture-observation/v1',
          line: 1,
          provider: 'codex',
          type: 'tool.call.completed',
          correlationKey: 'call-1',
          normalizedPayload: {
            toolCallId: 'call-1',
            result: { output: providerOutput },
          },
          payloadHash: hashPayload({
            toolCallId: 'call-1',
            result: { output: providerOutput },
          }),
        },
      ]),
    })

    expect(report.ok).toBe(true)
    expect(report.providerMatches[0]?.status).toBe('matched')
  })

  it('requires recorded neutral exit codes to agree even when command output matches', async () => {
    const transcript = transcriptFixture([
      {
        schema: 'hrc.capture-observation/v1',
        line: 1,
        provider: 'codex',
        type: 'tool.call.completed',
        correlationKey: 'call-1',
        normalizedPayload: {
          toolCallId: 'call-1',
          result: { output: 'same output', exitCode: 1 },
        },
        payloadHash: hashPayload({
          toolCallId: 'call-1',
          result: { output: 'same output', exitCode: 1 },
        }),
      },
    ])

    const matching = await verifyInvocation({
      store: fakeStore([
        brokerEvent(1, 'tool.call.completed', {
          toolCallId: 'call-1',
          name: 'command',
          result: { output: 'same output', exitCode: 1 },
        }),
      ]),
      invocationId: INVOCATION_ID,
      transcript,
    })
    expect(matching.ok).toBe(true)
    expect(matching.providerMatches[0]?.status).toBe('matched')

    const divergent = await verifyInvocation({
      store: fakeStore([
        brokerEvent(1, 'tool.call.completed', {
          toolCallId: 'call-1',
          name: 'command',
          result: { output: 'same output', exitCode: 2 },
        }),
      ]),
      invocationId: INVOCATION_ID,
      transcript,
    })
    expect(divergent.ok).toBe(false)
    expect(divergent.providerMatches[0]?.status).toBe('divergent')

    const unavailable = await verifyInvocation({
      store: fakeStore([
        brokerEvent(1, 'tool.call.completed', {
          toolCallId: 'call-1',
          name: 'command',
          result: { output: 'same output' },
        }),
      ]),
      invocationId: INVOCATION_ID,
      transcript,
    })
    expect(unavailable.ok).toBe(true)
    expect(unavailable.providerMatches[0]?.status).toBe('matched')
  })

  it('requires domain isError signals to agree without changing the completed event type', async () => {
    const transcript = transcriptFixture([
      {
        schema: 'hrc.capture-observation/v1',
        line: 1,
        provider: 'claude-code',
        type: 'tool.call.completed',
        correlationKey: 'toolu-1',
        normalizedPayload: {
          toolCallId: 'toolu-1',
          result: { output: 'permission denied' },
          isError: true,
        },
        payloadHash: hashPayload({
          toolCallId: 'toolu-1',
          result: { output: 'permission denied' },
          isError: true,
        }),
      },
    ])

    const matching = await verifyInvocation({
      store: fakeStore([
        brokerEvent(1, 'tool.call.completed', {
          toolCallId: 'toolu-1',
          name: 'Bash',
          result: { output: 'permission denied' },
          isError: true,
        }),
      ]),
      invocationId: INVOCATION_ID,
      transcript,
    })
    expect(matching.ok).toBe(true)

    const divergent = await verifyInvocation({
      store: fakeStore([
        brokerEvent(1, 'tool.call.completed', {
          toolCallId: 'toolu-1',
          name: 'Bash',
          result: { output: 'permission denied' },
          isError: false,
        }),
      ]),
      invocationId: INVOCATION_ID,
      transcript,
    })
    expect(divergent.ok).toBe(false)
    expect(divergent.providerMatches[0]?.status).toBe('divergent')

    const unavailable = await verifyInvocation({
      store: fakeStore([
        brokerEvent(1, 'tool.call.completed', {
          toolCallId: 'toolu-1',
          name: 'Bash',
          result: { output: 'permission denied' },
        }),
      ]),
      invocationId: INVOCATION_ID,
      transcript,
    })
    expect(unavailable.ok).toBe(true)
    expect(unavailable.providerMatches[0]?.status).toBe('matched')
  })
})
