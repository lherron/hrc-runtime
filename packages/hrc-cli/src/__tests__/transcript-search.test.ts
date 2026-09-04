import { describe, expect, it } from 'bun:test'

import type { TranscriptSearchHit, TranscriptSearchResponse } from 'hrc-sdk'

import { renderTranscriptSearch } from '../transcript-search.js'

function hit(overrides: Partial<TranscriptSearchHit> = {}): TranscriptSearchHit {
  return {
    turnRowid: 1,
    invocationId: 'inv-a',
    runtimeId: 'rt-a',
    scopeRef: 'agent:cody:project:hrc-runtime:task:T-08015',
    generation: 2,
    scopeGenerationCount: 3,
    seqFrom: 41,
    seqTo: 58,
    startedAt: '2026-08-30T14:00:00.000Z',
    completedAt: '2026-08-30T14:02:00.000Z',
    terminalStatus: 'completed',
    messageCount: 2,
    truncated: false,
    userText: '',
    finalText: 'preflight found an additional busy runtime',
    midText: '',
    score: 10,
    snippet: 'preflight found an [additional] busy runtime',
    ...overrides,
  }
}

const stats = {
  turnsIndexed: 16_108,
  lastEventId: 709_000,
  ledgerMaxEventId: 709_000,
  lagEvents: 0,
  invocationsReindexed: 7,
}

describe('transcript search rendering', () => {
  it('renders ranked discovery pointers nested under scope', () => {
    const response: TranscriptSearchResponse = {
      mode: 'discovery',
      hits: [hit(), hit({ turnRowid: 2, seqFrom: 70, seqTo: 80, score: 9 })],
      index: stats,
    }
    const rendered = renderTranscriptSearch(response)
    expect(rendered).toContain('cody@hrc-runtime:T-08015   (3 generations)')
    expect(rendered).toContain('2 hits   best seq 41..58')
    expect(rendered).toContain('hrc monitor transcript rt-a --seq 41..58')
    expect(rendered).toContain('index: 16,108 turns, behind by 0 events')
  })

  it('renders within-runtime hits in seq order with terminal tags', () => {
    const response: TranscriptSearchResponse = {
      mode: 'within_runtime',
      hits: [hit(), hit({ turnRowid: 2, seqFrom: 60, seqTo: 63, terminalStatus: 'failed' })],
      index: stats,
    }
    expect(renderTranscriptSearch(response)).toContain('seq 60..63  14:02  [failed]')
  })
})
