import { afterEach, describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type {
  CaptureVerificationReport,
  CaptureVerificationStore,
  InvocationCaptureSnapshot,
  VerificationCandidate,
} from 'hrc-capture-verifier'
import { CAPTURE_VERIFIER_SCHEMA } from 'hrc-capture-verifier'

import { cmdBrokerVerifyRun } from '../broker-verify/commands.js'
import { renderCandidatesHuman, renderReportHuman } from '../broker-verify/report.js'

describe('broker verify CLI rendering', () => {
  it('renders candidate DTOs from hrc-capture-verifier without CLI-owned verifier types', () => {
    const candidate: VerificationCandidate = {
      schema: 'hrc.capture-verifier/v1',
      invocationId: 'inv_1',
      scopeRef: 'agent:cody:project:hrc-runtime:task:T-1',
      laneRef: 'main',
      hostSessionId: 'hsid_1',
      runtimeId: 'rt_1',
      generation: 1,
      provider: 'codex',
      driver: 'codex-app-server',
      brokerDriver: 'codex-app-server',
      brokerProtocol: 'harness-broker/0.2',
      state: 'completed',
      createdAt: '2026-06-16T12:00:00.000Z',
      updatedAt: '2026-06-16T12:01:00.000Z',
      eventCount: 3,
      firstSeq: 1,
      lastSeq: 3,
      rawMirrorCount: 3,
      lifecycleProjectionCount: 2,
    }

    expect(renderCandidatesHuman(candidate.scopeRef, [candidate])).toContain(
      'inv_1  codex-app-server  completed  events=3  raw=3  lifecycle=2'
    )
  })

  it('renders the library report DTO shape for human output', () => {
    const report: CaptureVerificationReport = {
      schema: 'hrc.capture-verifier/v1',
      status: 'pass',
      ok: true,
      invocationId: 'inv_1',
      brokerDriver: 'codex-app-server',
      brokerProtocol: 'harness-broker/0.2',
      runtimeId: 'rt_1',
      ledger: { eventCount: 1, firstSeq: 1, lastSeq: 1, statuses: { applied: 1 } },
      rawMirror: { checked: 1, matched: 1 },
      providerMatches: [],
      lifecycle: [
        {
          brokerSeq: 1,
          brokerType: 'user.message',
          lifecycleKind: 'turn.user_prompt',
          status: 'present',
          hrcSeq: 9,
        },
      ],
      findings: [],
      analytics: {
        schema: 'hrc.capture-verifier/v1',
        brokerLedger: {
          invocationId: 'inv_1',
          eventCount: 1,
          firstSeq: 1,
          lastSeq: 1,
          seqHoleCount: 0,
          duplicateSeqCount: 0,
          statuses: { applied: 1 },
          eventsByType: { 'user.message': 1 },
          runtimeIdentityMismatchCount: 0,
          runDivergenceWarningCount: 0,
          staleGenerationCount: 0,
          staleAttemptCount: 0,
        },
        rawEvents: {
          expectedFromBroker: 1,
          appliedBrokerRows: 1,
          linkedByHrcEventSeq: 1,
          found: 1,
          matched: 1,
          missing: 0,
          mismatched: 0,
          wrongSource: 0,
          wrongEventKind: 0,
          wrongInvocation: 0,
          wrongSeq: 0,
          wrongType: 0,
          payloadMismatch: 0,
          malformedEventJson: 0,
          malformedPayload: 0,
        },
        lifecycleProjection: {
          policyId: 'hrc-core.broker-to-hrc-lifecycle/v1',
          policyVersion: 'v1',
          policyHash: 'sha256:test',
          checkedBrokerEvents: 1,
          policyMapped: 1,
          expected: 1,
          present: 1,
          missing: 0,
          suppressed: 0,
          notApplicable: 0,
          byBrokerType: {
            'user.message': {
              policyMapped: 1,
              expected: 1,
              present: 1,
              missing: 0,
              suppressed: 0,
              notApplicable: 0,
            },
          },
          byLifecycleKind: {
            'turn.user_prompt': {
              expected: 1,
              present: 1,
              missing: 0,
              suppressed: 0,
            },
          },
        },
        crossSink: {
          brokerToRaw: { expected: 1, matched: 1, missing: 0, mismatched: 0 },
          brokerToLifecycle: {
            expected: 1,
            present: 1,
            missing: 0,
            suppressed: 0,
            notApplicable: 0,
          },
        },
      },
    }

    expect(renderReportHuman(report)).toContain('status: pass')
    expect(renderReportHuman(report)).toContain('analytics:')
    expect(renderReportHuman(report)).toContain('raw events: matched=1/1 missing=0 mismatched=0')
    expect(renderReportHuman(report)).toContain(
      'No broker capture or projection integrity issues found.'
    )
  })
})

describe('cmdBrokerVerifyRun auto-resolution (T-05375)', () => {
  const cleanups: Array<() => Promise<void>> = []

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()?.()
    }
  })

  async function writeStoredTranscript(): Promise<{ path: string; storedHash: string }> {
    const dir = await mkdtemp(join(tmpdir(), 'hrc-cli-broker-verify-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    const path = join(dir, 'provider-transcript.jsonl')
    const content = `${JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'auto resolve me' }],
      },
    })}\n`
    await writeFile(path, content, 'utf8')
    const storedHash = `sha256:${createHash('sha256').update(content).digest('hex')}`
    return { path, storedHash }
  }

  function storeWithStoredArtifact(
    transcriptPath: string,
    storedHash: string
  ): {
    store: CaptureVerificationStore
    close(): void
  } {
    const invocationId = 'inv_t05375_cli'
    const operationId = 'op_t05375_cli'
    const snapshot: InvocationCaptureSnapshot = {
      schema: CAPTURE_VERIFIER_SCHEMA,
      invocation: {
        invocationId,
        operationId,
        runtimeId: 'rt_t05375_cli',
        runId: 'run_t05375_cli',
        brokerDriver: 'codex-app-server',
        brokerProtocol: 'harness-broker/0.2',
        state: 'turn_active',
        currentHarnessGeneration: 1,
        currentTurnAttempt: 1,
        createdAt: '2026-06-30T00:00:00.000Z',
        updatedAt: '2026-06-30T00:00:00.000Z',
      },
      brokerEvents: [
        {
          invocationId,
          seq: 1,
          time: '2026-06-30T00:00:01.000Z',
          type: 'assistant.message.completed',
          runId: 'run_t05375_cli',
          runtimeId: 'rt_t05375_cli',
          harnessGeneration: 1,
          turnAttempt: 1,
          payload: { content: 'auto resolve me' },
          payloadJsonText: JSON.stringify({ content: 'auto resolve me' }),
          hrcEventSeq: 11,
          projectionStatus: 'applied',
          createdAt: '2026-06-30T00:00:01.000Z',
        },
      ],
      rawMirrors: {
        11: {
          seq: 11,
          source: 'broker',
          eventKind: 'broker.assistant.message.completed',
          eventJson: {
            invocationId,
            seq: 1,
            type: 'assistant.message.completed',
            time: '2026-06-30T00:00:01.000Z',
            payload: { content: 'auto resolve me' },
          },
          eventJsonText: '{}',
        },
      },
      lifecycleProjections: {},
      // The durable provider-transcript artifact HRC persisted for this
      // operation; auto-resolution must pick THIS path when --jsonl is omitted.
      transcriptArtifact: {
        artifactId: `provider-transcript:${invocationId}:1`,
        operationId,
        path: transcriptPath,
        storedHash,
        hashStatus: 'unchecked',
        createdAt: '2026-06-30T00:00:01.000Z',
        artifactJson: JSON.stringify({
          schema: 'hrc.provider-transcript-artifact/v1',
          sourceSchema: 'harness-broker.provider-transcript.codex-jsonrpc-notification-jsonl/v1',
        }),
      },
    }
    return {
      store: {
        async listVerificationCandidates() {
          return []
        },
        async loadInvocationCapture() {
          return snapshot
        },
      },
      close() {},
    }
  }

  it('auto-resolves the stored transcript with no --jsonl and matches the explicit --jsonl status', async () => {
    const { path, storedHash } = await writeStoredTranscript()

    let autoReport: CaptureVerificationReport | undefined
    await cmdBrokerVerifyRun(['--invocation', 'inv_t05375_cli', '--json'], {
      openStore: () => storeWithStoredArtifact(path, storedHash),
      emit: (report) => {
        autoReport = report
      },
    })

    let explicitReport: CaptureVerificationReport | undefined
    await cmdBrokerVerifyRun(['--invocation', 'inv_t05375_cli', '--json', '--jsonl', path], {
      openStore: () => storeWithStoredArtifact(path, storedHash),
      emit: (report) => {
        explicitReport = report
      },
    })

    expect(autoReport).toBeDefined()
    expect(explicitReport).toBeDefined()
    // No --jsonl: the command auto-resolved the durable artifact path.
    expect(autoReport?.transcriptPath).toBe(path)
    // Explicit --jsonl: same transcript path.
    expect(explicitReport?.transcriptPath).toBe(path)
    // Paired result: same verification status and ok regardless of how the
    // transcript was supplied.
    expect(autoReport?.status).toBe(explicitReport?.status)
    expect(autoReport?.ok).toBe(explicitReport?.ok)
    expect(autoReport?.providerMatches.map((m) => m.status)).toEqual(
      explicitReport?.providerMatches.map((m) => m.status)
    )
  })
})
