import { describe, expect, it } from 'bun:test'
import { CAPTURE_VERIFIER_SCHEMA, hashPayload, verifyInvocation } from '../index.js'
import { createSqliteCaptureVerificationStore } from '../sqlite.js'

import {
  INVOCATION_ID,
  OPERATION_ID,
  RUNTIME_ID,
  RUN_ID,
  SCOPE_REF,
  makeFixture,
  seedBrokerEvent,
  seedLifecycle,
  sha256FileBytes,
  transcriptFixture,
  ts,
  writeCodexTranscript,
} from './capture-verifier.fixture.js'
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
