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
    }

    expect(renderReportHuman(report)).toContain('status: pass')
    expect(renderReportHuman(report)).toContain(
      'No broker capture or projection integrity issues found.'
    )
  })
})
