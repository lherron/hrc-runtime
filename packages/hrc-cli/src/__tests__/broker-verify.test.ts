import { describe, expect, it } from 'bun:test'
import type { VerificationCandidate } from 'hrc-capture-verifier'
import { renderCandidatesHuman } from '../broker-verify/report.js'

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
      lifecycleProjectionCount: 2,
    }

    expect(renderCandidatesHuman(candidate.scopeRef, [candidate])).toContain(
      'inv_1  codex-app-server  completed  events=3  lifecycle=2'
    )
  })
})
