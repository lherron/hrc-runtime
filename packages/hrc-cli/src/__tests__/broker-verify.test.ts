import { describe, expect, it } from 'bun:test'

import type { CaptureVerificationReport, VerificationCandidate } from 'hrc-capture-verifier'

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
