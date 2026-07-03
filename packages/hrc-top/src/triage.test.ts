import { describe, expect, it } from 'bun:test'
import type { HrcTargetOperatorDisplayState } from 'hrc-core'

import {
  TRIAGE_BUCKET_ORDER,
  groupTriageRows,
  isActionableBucket,
  triageBucketFor,
  triageCounts,
} from './triage.js'
import type { HrcTopTriageRow } from './triage.js'

function row(
  id: string,
  displayState: HrcTargetOperatorDisplayState,
  overrides: Partial<HrcTopTriageRow> = {}
): HrcTopTriageRow {
  return { id, displayState, hasValidContinuation: false, ...overrides }
}

describe('triage bucket policy (pure, over projected state)', () => {
  it('maps every projected display state to a bucket without reclassifying truth', () => {
    expect(triageBucketFor({ displayState: 'input', hasValidContinuation: false })).toBe('needsYou')
    expect(triageBucketFor({ displayState: 'busy', hasValidContinuation: false })).toBe('working')
    expect(triageBucketFor({ displayState: 'starting', hasValidContinuation: false })).toBe(
      'working'
    )
    expect(triageBucketFor({ displayState: 'ready', hasValidContinuation: false })).toBe('idle')
    expect(triageBucketFor({ displayState: 'headless', hasValidContinuation: false })).toBe('idle')
    expect(triageBucketFor({ displayState: 'broken', hasValidContinuation: false })).toBe(
      'attention'
    )
    expect(triageBucketFor({ displayState: 'ambiguous', hasValidContinuation: false })).toBe(
      'attention'
    )
  })

  it('routes dormant/stale by continuation validity (resumable vs stuck)', () => {
    expect(triageBucketFor({ displayState: 'dormant', hasValidContinuation: true })).toBe(
      'resumable'
    )
    expect(triageBucketFor({ displayState: 'dormant', hasValidContinuation: false })).toBe(
      'attention'
    )
    expect(triageBucketFor({ displayState: 'stale', hasValidContinuation: true })).toBe('resumable')
    expect(triageBucketFor({ displayState: 'stale', hasValidContinuation: false })).toBe(
      'attention'
    )
  })

  it('treats every bucket but idle as actionable', () => {
    expect(isActionableBucket('needsYou')).toBe(true)
    expect(isActionableBucket('working')).toBe(true)
    expect(isActionableBucket('resumable')).toBe(true)
    expect(isActionableBucket('attention')).toBe(true)
    expect(isActionableBucket('idle')).toBe(false)
  })
})

describe('triage grouping + urgency sort', () => {
  it('puts awaiting-input first and idle last, in canonical bucket order', () => {
    const groups = groupTriageRows([
      row('a', 'ready'),
      row('b', 'input'),
      row('c', 'dormant', { hasValidContinuation: true }),
      row('d', 'busy'),
      row('e', 'broken'),
    ])
    expect(groups.map((group) => group.bucket)).toEqual([
      'needsYou',
      'working',
      'resumable',
      'attention',
      'idle',
    ])
    // The declared order matches the exported constant.
    expect(TRIAGE_BUCKET_ORDER).toEqual(['needsYou', 'working', 'resumable', 'attention', 'idle'])
  })

  it('omits empty buckets', () => {
    const groups = groupTriageRows([row('a', 'ready'), row('b', 'input')])
    expect(groups.map((group) => group.bucket)).toEqual(['needsYou', 'idle'])
  })

  it('sorts needsYou oldest-first (longest wait is most urgent)', () => {
    const groups = groupTriageRows([
      row('recent', 'input', { lastActivityAt: '2026-07-02T12:00:00.000Z' }),
      row('oldest', 'input', { lastActivityAt: '2026-07-02T09:00:00.000Z' }),
      row('mid', 'input', { lastActivityAt: '2026-07-02T11:00:00.000Z' }),
    ])
    expect(groups[0]?.rows.map((r) => r.id)).toEqual(['oldest', 'mid', 'recent'])
  })

  it('sorts non-needsYou buckets most-recent-first, undefined timestamps last', () => {
    const groups = groupTriageRows([
      row('stale-ts', 'busy', { lastActivityAt: '2026-07-02T09:00:00.000Z' }),
      row('no-ts', 'busy'),
      row('fresh-ts', 'busy', { lastActivityAt: '2026-07-02T12:00:00.000Z' }),
    ])
    expect(groups[0]?.rows.map((r) => r.id)).toEqual(['fresh-ts', 'stale-ts', 'no-ts'])
  })

  it('counts rows per bucket', () => {
    const counts = triageCounts([
      row('a', 'input'),
      row('b', 'busy'),
      row('c', 'ready'),
      row('d', 'ready'),
      row('e', 'dormant', { hasValidContinuation: true }),
    ])
    expect(counts).toEqual({ needsYou: 1, working: 1, resumable: 1, attention: 0, idle: 2 })
  })
})
