import { afterEach, describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { openHrcDatabase } from 'hrc-store-sqlite'
import type {
  CaptureObservationType,
  CaptureVerificationStore,
  ParsedProviderTranscript,
} from '../index.js'
import {
  CAPTURE_VERIFIER_SCHEMA,
  hashPayload,
  lifecycleKey,
  parseProviderTranscript,
  verifyInvocation,
} from '../index.js'
import { createSqliteCaptureVerificationStore } from '../sqlite.js'

const SCOPE_REF = 'agent:cody:project:hrc-runtime:task:T-04861'
const HOST_SESSION_ID = 'hsid_verify'
const RUNTIME_ID = 'rt_verify'
const OPERATION_ID = 'op_verify'
const INVOCATION_ID = 'inv_verify'
const RUN_ID = 'run_verify'

type Fixture = Awaited<ReturnType<typeof makeFixture>>

const fixtures: Fixture[] = []

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    fixture.db.close()
    await rm(fixture.dir, { recursive: true, force: true })
  }
})

describe('provider transcript adapters', () => {
  it('normalizes minimized Codex JSONL with line numbers and tool correlation ids', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hrc-capture-verifier-jsonl-'))
    const path = join(dir, 'codex.jsonl')
    await writeFile(
      path,
      [
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'hello' }],
          },
        }),
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'function_call',
            call_id: 'call-1',
            name: 'exec_command',
            arguments: '{"cmd":"date"}',
          },
        }),
        JSON.stringify({
          type: 'response_item',
          payload: { type: 'function_call_output', call_id: 'call-1', output: 'Tue' },
        }),
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'function_call',
            call_id: 'call-2',
            name: 'write_stdin',
            arguments: '{}',
          },
        }),
        JSON.stringify({
          type: 'response_item',
          payload: { type: 'function_call_output', call_id: 'call-2', output: 'ignored' },
        }),
      ].join('\n')
    )

    try {
      const transcript = await parseProviderTranscript({ path })
      expect(transcript.provider).toBe('codex')
      expect(
        transcript.observations.map((event) => [event.line, event.type, event.correlationKey])
      ).toEqual([
        [1, 'assistant.message.completed', undefined],
        [2, 'tool.call.started', 'call-1'],
        [3, 'tool.call.completed', 'call-1'],
      ])
      expect(transcript.warnings).toContain(
        'line 4: Codex function_call write_stdin is outside broker JSONL v1 scope'
      )
      expect(transcript.totalLines).toBe(5)
      expect(transcript.parsedRecords).toBe(5)
      expect(transcript.invalidJsonRecords).toBe(0)
      expect(transcript.applicableObservations).toBe(3)
      expect(transcript.ignoredRecords).toBe(1)
      expect(transcript.unsupportedRecords).toBe(1)
      expect(transcript.unknownRecords).toBe(0)
      expect(transcript.warningCount).toBe(1)
      expect(transcript.observationsByType).toMatchObject({
        'assistant.message.completed': 1,
        'tool.call.started': 1,
        'tool.call.completed': 1,
      })
      expect(transcript.observations[1]?.normalizedPayload).toEqual({
        toolCallId: 'call-1',
        name: 'command',
        input: { cmd: 'date' },
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('normalizes minimized Claude JSONL user, assistant, tool_use, and tool_result records', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hrc-capture-verifier-claude-'))
    const path = join(dir, 'claude.jsonl')
    await writeFile(
      path,
      [
        JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }),
        JSON.stringify({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'toolu-1', name: 'Bash', input: { command: 'pwd' } }],
          },
        }),
        JSON.stringify({
          type: 'user',
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'toolu-1', content: 'ok' }],
          },
        }),
      ].join('\n')
    )

    try {
      const transcript = await parseProviderTranscript({ path })
      expect(transcript.provider).toBe('claude-code')
      expect(
        transcript.observations.map((event) => [event.line, event.type, event.correlationKey])
      ).toEqual([
        [1, 'user.message', undefined],
        [2, 'tool.call.started', 'toolu-1'],
        [3, 'tool.call.completed', 'toolu-1'],
      ])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('ignores Codex pending exec placeholders as non-final tool output', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hrc-capture-verifier-pending-'))
    const path = join(dir, 'codex-pending.jsonl')
    await writeFile(
      path,
      [
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'function_call',
            call_id: 'call-pending',
            name: 'exec_command',
            arguments: '{"cmd":"sleep 1"}',
          },
        }),
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'function_call_output',
            call_id: 'call-pending',
            output:
              'Chunk ID: abc\nWall time: 10.0000 seconds\nProcess running with session ID 42\nOriginal token count: 0\nOutput:\n',
          },
        }),
      ].join('\n')
    )

    try {
      const transcript = await parseProviderTranscript({ path })
      expect(transcript.provider).toBe('codex')
      expect(
        transcript.observations.map((event) => [event.line, event.type, event.correlationKey])
      ).toEqual([[1, 'tool.call.started', 'call-pending']])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('reports parser disposition stats without deriving them from warnings', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hrc-capture-verifier-stats-'))
    const path = join(dir, 'stats.jsonl')
    await writeFile(
      path,
      [
        '{bad json',
        JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user' } }),
        JSON.stringify({
          type: 'response_item',
          payload: { type: 'function_call', call_id: 'call-x', name: 'write_stdin' },
        }),
        JSON.stringify({ type: 'session_meta', sessionId: 's1' }),
        JSON.stringify({
          type: 'response_item',
          payload: { type: 'message', role: 'assistant', content: 'one' },
        }),
        JSON.stringify({
          type: 'response_item',
          payload: { type: 'message', role: 'assistant', content: 'two' },
        }),
      ].join('\n')
    )

    try {
      const transcript = await parseProviderTranscript({ path })
      expect(transcript.totalLines).toBe(6)
      expect(transcript.parsedRecords).toBe(5)
      expect(transcript.invalidJsonRecords).toBe(1)
      expect(transcript.ignoredRecords).toBe(1)
      expect(transcript.unsupportedRecords).toBe(1)
      expect(transcript.unknownRecords).toBe(1)
      expect(transcript.warningCount).toBe(3)
      expect(transcript.applicableObservations).toBe(2)
      expect(transcript.observationsByType['assistant.message.completed']).toBe(2)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

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
})

describe('sqlite adapter', () => {
  it('lists candidates by exact scope using invocation_id as stable id', async () => {
    const fixture = await makeFixture()
    seedBrokerEvent(fixture, 1, 'user.message', { content: 'hello' })
    fixture.db.brokerInvocations.insert({
      invocationId: 'inv_verify_second',
      operationId: 'op_verify_second',
      runtimeId: RUNTIME_ID,
      runId: RUN_ID,
      brokerProtocol: 'harness-broker/0.2',
      brokerDriver: 'codex-app-server',
      invocationState: 'completed',
      capabilitiesJson: '{}',
      specHash: 'sha256:spec2',
      startRequestHash: 'sha256:req2',
      selectedProfileHash: 'sha256:profile2',
      createdAt: ts(10),
      updatedAt: ts(10),
    })

    const store = createSqliteCaptureVerificationStore(fixture.db)
    const candidates = await store.listVerificationCandidates({ scopeRef: SCOPE_REF })
    expect(candidates.map((candidate) => candidate.invocationId)).toContain(INVOCATION_ID)
    expect(candidates.map((candidate) => candidate.invocationId)).toContain('inv_verify_second')
    expect(candidates.every((candidate) => candidate.schema === CAPTURE_VERIFIER_SCHEMA)).toBe(true)
    expect(candidates[0]?.rawMirrorCount).toBeGreaterThanOrEqual(0)
  })

  it('loads sqlite snapshots equivalent to fake-store verification', async () => {
    const fixture = await makeFixture()
    seedBrokerEvent(fixture, 1, 'user.message', { content: 'hello' })
    seedLifecycle(fixture, 'turn.user_prompt', { type: 'message_end' })

    const report = await verifyInvocation({
      store: createSqliteCaptureVerificationStore(fixture.db),
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

    expect(report.ok).toBe(true)
    expect(report.rawMirror).toEqual({ checked: 1, matched: 1 })
  })

  it('auto-resolves only the matching operation transcript artifact when no explicit JSONL is supplied', async () => {
    const fixture = await makeFixture()
    seedBrokerEvent(fixture, 1, 'assistant.message.completed', { content: 'artifact transcript' })
    const matchingPath = await writeCodexTranscript(fixture.dir, 'matching.jsonl', [
      'artifact transcript',
    ])
    const otherPath = await writeCodexTranscript(fixture.dir, 'other-operation.jsonl', [
      'wrong operation transcript',
    ])

    fixture.db.runtimeArtifacts.insert({
      artifactId: 'art-provider-transcript-matching',
      operationId: OPERATION_ID,
      artifactKind: 'provider-transcript-jsonl',
      mediaType: 'application/x-ndjson',
      storageKind: 'file-path',
      contentHash: sha256FileBytes(
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'artifact transcript' }],
          },
        })
      ),
      artifactPath: matchingPath,
      artifactJson: JSON.stringify({
        schema: 'hrc.provider-transcript-artifact/v1',
        invocationId: INVOCATION_ID,
        runtimeId: RUNTIME_ID,
        runId: RUN_ID,
        provider: 'codex',
        brokerDriver: 'codex-app-server',
        harnessGeneration: 1,
        brokerSeq: 1,
        hashAlgorithm: 'sha256',
      }),
      createdAt: ts(30),
    })
    fixture.db.runtimeArtifacts.insert({
      artifactId: 'art-provider-transcript-other-operation',
      operationId: 'op_other_operation',
      artifactKind: 'provider-transcript-jsonl',
      mediaType: 'application/x-ndjson',
      storageKind: 'file-path',
      contentHash: sha256FileBytes(
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'wrong operation transcript' }],
          },
        })
      ),
      artifactPath: otherPath,
      artifactJson: JSON.stringify({
        schema: 'hrc.provider-transcript-artifact/v1',
        invocationId: 'inv_other_operation',
        runtimeId: RUNTIME_ID,
        provider: 'codex',
        brokerDriver: 'codex-app-server',
        harnessGeneration: 1,
        brokerSeq: 99,
        hashAlgorithm: 'sha256',
      }),
      createdAt: ts(31),
    })

    // T-04863: omitted --jsonl must use the durable artifact linked by this
    // invocation's operation_id, not a heuristic scan or another operation's row.
    const report = await verifyInvocation({
      store: createSqliteCaptureVerificationStore(fixture.db),
      invocationId: INVOCATION_ID,
    })

    expect(report.transcriptPath).toBe(matchingPath)
    expect(report.analytics.providerJsonl).toMatchObject({
      path: matchingPath,
      applicableObservations: 1,
    })
    expect(report.providerMatches[0]?.status).toBe('matched')
    expect(report.analytics.brokerLedger.eventCount).toBe(1)
    expect(report.lifecycle[0]?.status).toBe('missing')
  })

  it('keeps explicit JSONL precedence when a stored transcript artifact exists', async () => {
    const fixture = await makeFixture()
    seedBrokerEvent(fixture, 1, 'assistant.message.completed', { content: 'explicit transcript' })
    const storedPath = await writeCodexTranscript(fixture.dir, 'stored.jsonl', [
      'stored transcript',
    ])
    const explicitPath = await writeCodexTranscript(fixture.dir, 'explicit.jsonl', [
      'explicit transcript',
    ])

    fixture.db.runtimeArtifacts.insert({
      artifactId: 'art-provider-transcript-stored',
      operationId: OPERATION_ID,
      artifactKind: 'provider-transcript-jsonl',
      mediaType: 'application/x-ndjson',
      storageKind: 'file-path',
      contentHash: sha256FileBytes(
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'stored transcript' }],
          },
        })
      ),
      artifactPath: storedPath,
      artifactJson: JSON.stringify({
        schema: 'hrc.provider-transcript-artifact/v1',
        invocationId: INVOCATION_ID,
        runtimeId: RUNTIME_ID,
        provider: 'codex',
        brokerDriver: 'codex-app-server',
        harnessGeneration: 1,
        brokerSeq: 1,
        hashAlgorithm: 'sha256',
      }),
      createdAt: ts(30),
    })

    const report = await verifyInvocation({
      store: createSqliteCaptureVerificationStore(fixture.db),
      invocationId: INVOCATION_ID,
      transcriptPath: explicitPath,
    })

    expect(report.transcriptPath).toBe(explicitPath)
    expect(report.analytics.providerJsonl).toMatchObject({
      path: explicitPath,
      applicableObservations: 1,
    })
    expect(report.providerMatches[0]?.status).toBe('matched')
  })
})

describe('package boundaries', () => {
  it('keeps hrc-store-sqlite out of the root public API implementation', () => {
    const rootSources = [
      'src/index.ts',
      'src/provider-transcript.ts',
      'src/verifier.ts',
      'src/types.ts',
    ]
    for (const relativePath of rootSources) {
      const source = readFileSync(resolve(import.meta.dir, '..', '..', relativePath), 'utf8')
      expect(source).not.toContain('hrc-store-sqlite')
      expect(source).not.toContain('hrc-server')
      expect(source).not.toContain('hrc-cli')
      expect(source).not.toContain('gateway-discord')
    }
  })
})

async function makeFixture(): Promise<{
  dir: string
  dbPath: string
  db: ReturnType<typeof openHrcDatabase>
}> {
  const dir = await mkdtemp(join(tmpdir(), 'hrc-capture-verifier-'))
  const dbPath = join(dir, 'state.sqlite')
  const db = openHrcDatabase(dbPath)
  fixtures.push({ dir, dbPath, db })
  const now = ts()

  db.sessions.insert({
    hostSessionId: HOST_SESSION_ID,
    scopeRef: SCOPE_REF,
    laneRef: 'main',
    generation: 1,
    status: 'active',
    createdAt: now,
    updatedAt: now,
    ancestorScopeRefs: [],
  })
  db.runtimes.insert({
    runtimeId: RUNTIME_ID,
    hostSessionId: HOST_SESSION_ID,
    scopeRef: SCOPE_REF,
    laneRef: 'main',
    generation: 1,
    transport: 'headless',
    harness: 'codex-cli',
    provider: 'openai',
    status: 'busy',
    supportsInflightInput: false,
    adopted: false,
    controllerKind: 'harness-broker',
    activeOperationId: OPERATION_ID,
    createdAt: now,
    updatedAt: now,
  })
  db.runs.insert({
    runId: RUN_ID,
    hostSessionId: HOST_SESSION_ID,
    runtimeId: RUNTIME_ID,
    scopeRef: SCOPE_REF,
    laneRef: 'main',
    generation: 1,
    transport: 'headless',
    status: 'started',
    acceptedAt: now,
    startedAt: now,
    updatedAt: now,
    operationId: OPERATION_ID,
    invocationId: INVOCATION_ID,
  })
  db.brokerInvocations.insert({
    invocationId: INVOCATION_ID,
    operationId: OPERATION_ID,
    runtimeId: RUNTIME_ID,
    runId: RUN_ID,
    brokerProtocol: 'harness-broker/0.2',
    brokerDriver: 'codex-app-server',
    invocationState: 'turn_active',
    capabilitiesJson: '{}',
    specHash: 'sha256:spec',
    startRequestHash: 'sha256:req',
    selectedProfileHash: 'sha256:profile',
    currentHarnessGeneration: 1,
    currentTurnAttempt: 1,
    createdAt: now,
    updatedAt: now,
  })
  return { dir, dbPath, db }
}

function seedBrokerEvent(
  fixture: Fixture,
  seq: number,
  type: string,
  payload: unknown,
  options: {
    projectionStatus?: 'pending' | 'applied' | 'failed'
    mirrorPayload?: unknown
    skipMirror?: boolean
  } = {}
): void {
  let hrcEventSeq: number | undefined
  if (!options.skipMirror) {
    const mirror = fixture.db.events.append({
      ts: ts(seq),
      hostSessionId: HOST_SESSION_ID,
      scopeRef: SCOPE_REF,
      laneRef: 'main',
      generation: 1,
      runId: RUN_ID,
      runtimeId: RUNTIME_ID,
      source: 'broker',
      eventKind: `broker.${type}`,
      eventJson: {
        invocationId: INVOCATION_ID,
        seq,
        type,
        time: ts(seq),
        payload: options.mirrorPayload ?? payload,
      },
    })
    hrcEventSeq = mirror.seq
  }
  fixture.db.brokerInvocationEvents.appendEvent({
    invocationId: INVOCATION_ID,
    seq,
    time: ts(seq),
    type,
    runtimeId: RUNTIME_ID,
    runId: RUN_ID,
    harnessGeneration: 1,
    turnAttempt: 1,
    payload,
    ...(hrcEventSeq !== undefined ? { hrcEventSeq } : {}),
    projectionStatus: options.projectionStatus ?? 'applied',
  })
}

function seedLifecycle(fixture: Fixture, eventKind: string, payload: unknown): void {
  fixture.db.hrcEvents.append({
    ts: ts(20),
    hostSessionId: HOST_SESSION_ID,
    scopeRef: SCOPE_REF,
    laneRef: 'main',
    generation: 1,
    runtimeId: RUNTIME_ID,
    runId: RUN_ID,
    category: 'turn',
    eventKind,
    transport: 'headless',
    payload,
  })
}

function fakeStore(events: ReturnType<typeof brokerEvent>[]): CaptureVerificationStore {
  return {
    async listVerificationCandidates() {
      return []
    },
    async loadInvocationCapture() {
      const rawMirrors: Record<number, ReturnType<typeof rawMirror> | undefined> = {}
      const lifecycleProjections: Record<
        string,
        Array<{ hrcSeq: number; eventKind: string; payload: unknown }>
      > = {}
      for (const event of events) {
        if (event.hrcEventSeq !== undefined && !event.__omitRawMirror) {
          rawMirrors[event.hrcEventSeq] = rawMirror(event)
        }
        const lifecycleKind =
          event.type === 'user.message'
            ? 'turn.user_prompt'
            : event.type === 'turn.completed'
              ? 'turn.completed'
              : undefined
        if (lifecycleKind !== undefined) {
          lifecycleProjections[lifecycleKey(event, lifecycleKind)] = [
            { hrcSeq: 100 + event.seq, eventKind: lifecycleKind, payload: {} },
          ]
        }
      }
      return {
        schema: CAPTURE_VERIFIER_SCHEMA,
        invocation: {
          invocationId: INVOCATION_ID,
          operationId: OPERATION_ID,
          runtimeId: RUNTIME_ID,
          runId: RUN_ID,
          brokerDriver: 'codex-app-server',
          brokerProtocol: 'harness-broker/0.2',
          state: 'turn_active',
          currentHarnessGeneration: 1,
          currentTurnAttempt: 1,
          createdAt: ts(),
          updatedAt: ts(),
        },
        brokerEvents: events,
        rawMirrors,
        lifecycleProjections,
      }
    },
  }
}

function brokerEvent(
  seq: number,
  type: string,
  payload: unknown,
  options: {
    projectionStatus?: string
    mirrorPayload?: unknown
    skipMirror?: boolean
    omitRawMirror?: boolean
    rawSource?: string
    rawEventKind?: string
    rawInvocationId?: string
    rawBrokerSeq?: number
    rawBrokerType?: string
    rawEventJson?: unknown
    rawPayloadMissing?: boolean
    runtimeId?: string
    runId?: string
    harnessGeneration?: number
    turnAttempt?: number
  } = {}
) {
  return {
    invocationId: INVOCATION_ID,
    seq,
    time: ts(seq),
    type,
    runId: options.runId ?? RUN_ID,
    runtimeId: options.runtimeId ?? RUNTIME_ID,
    harnessGeneration: options.harnessGeneration ?? 1,
    turnAttempt: options.turnAttempt ?? 1,
    payload,
    payloadJsonText: JSON.stringify(payload),
    ...(options.skipMirror ? {} : { hrcEventSeq: seq + 10 }),
    projectionStatus: options.projectionStatus ?? 'applied',
    createdAt: ts(seq),
    __mirrorPayload: options.mirrorPayload,
    __omitRawMirror: options.omitRawMirror,
    __rawSource: options.rawSource,
    __rawEventKind: options.rawEventKind,
    __rawInvocationId: options.rawInvocationId,
    __rawBrokerSeq: options.rawBrokerSeq,
    __rawBrokerType: options.rawBrokerType,
    __rawEventJson: options.rawEventJson,
    __rawPayloadMissing: options.rawPayloadMissing,
  }
}

function rawMirror(event: ReturnType<typeof brokerEvent>) {
  if (event.__rawEventJson !== undefined) {
    return {
      seq: event.hrcEventSeq ?? 0,
      source: event.__rawSource ?? 'broker',
      eventKind: event.__rawEventKind ?? `broker.${event.type}`,
      eventJson: event.__rawEventJson,
      eventJsonText: '{}',
    }
  }
  const eventJson: Record<string, unknown> = {
    invocationId: event.__rawInvocationId ?? event.invocationId,
    seq: event.__rawBrokerSeq ?? event.seq,
    type: event.__rawBrokerType ?? event.type,
    time: event.time,
  }
  if (!event.__rawPayloadMissing) {
    eventJson.payload = event.__mirrorPayload ?? event.payload
  }
  return {
    seq: event.hrcEventSeq ?? 0,
    source: event.__rawSource ?? 'broker',
    eventKind: event.__rawEventKind ?? `broker.${event.type}`,
    eventJson,
    eventJsonText: '{}',
  }
}

function transcriptFixture(
  observations: ParsedProviderTranscript['observations']
): ParsedProviderTranscript {
  return {
    schema: CAPTURE_VERIFIER_SCHEMA,
    path: 'fixture.jsonl',
    provider: 'codex',
    warnings: [],
    lineCount: observations.length,
    totalLines: observations.length,
    parsedRecords: observations.length,
    invalidJsonRecords: 0,
    applicableObservations: observations.length,
    ignoredRecords: 0,
    unsupportedRecords: 0,
    unknownRecords: 0,
    warningCount: 0,
    observationsByType: observationCounts(observations),
    observations,
  }
}

function observationCounts(
  observations: ParsedProviderTranscript['observations']
): Record<CaptureObservationType, number> {
  const counts: Record<CaptureObservationType, number> = {
    'user.message': 0,
    'assistant.message.completed': 0,
    'tool.call.started': 0,
    'tool.call.completed': 0,
    'tool.call.failed': 0,
  }
  for (const observation of observations) {
    counts[observation.type] += 1
  }
  return counts
}

async function writeCodexTranscript(
  dir: string,
  filename: string,
  messages: string[]
): Promise<string> {
  const lines = messages.map((text) =>
    JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text }],
      },
    })
  )
  const path = join(dir, filename)
  await writeFile(path, lines.join('\n'))
  return path
}

function sha256FileBytes(content: string): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`
}

function ts(offsetSeconds = 0): string {
  return new Date(Date.UTC(2026, 5, 16, 12, 0, offsetSeconds)).toISOString()
}
