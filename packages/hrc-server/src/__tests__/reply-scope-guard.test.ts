import { describe, expect, it } from 'bun:test'

import { HrcDomainError } from 'hrc-core'
import type { HrcMessageAddress, HrcMessageRecord } from 'hrc-core'

import { assertReplyScopeMatches } from '../target-message-handlers'

// T-04767: a `--reply-to` anchor must thread within one conversation scope.
// The guard compares the target's scopeRef against the parent message's session
// participants (from/to), so a completion can't silently land in the wrong scope.

const REFACWRK = 'agent:clod:project:agent-loop:task:refacwrk'
const PRIMARY = 'agent:clod:project:agent-loop:task:primary'

function session(scopeRef: string, lane = 'main'): HrcMessageAddress {
  return { kind: 'session', sessionRef: `${scopeRef}/lane:${lane}` }
}

function parent(from: HrcMessageAddress, to: HrcMessageAddress): HrcMessageRecord {
  return {
    messageSeq: 1,
    messageId: 'msg-parent',
    createdAt: '2026-06-15T00:00:00Z',
    kind: 'dm',
    phase: 'request',
    from,
    to,
    rootMessageId: 'msg-parent',
    body: 'original request',
    bodyFormat: 'text/plain',
    execution: { state: 'not_applicable' },
  }
}

describe('assertReplyScopeMatches', () => {
  it('passes when the target shares the parent originator scope', () => {
    // The real incident's corrected shape: reply to a refacwrk request, target refacwrk.
    const p = parent(session(REFACWRK), { kind: 'entity', entity: 'human' })
    expect(() => assertReplyScopeMatches(p, session(REFACWRK), undefined)).not.toThrow()
  })

  it('passes when the target matches the parent recipient scope', () => {
    // Replying back to whoever sent you the request (from=other, to=you).
    const p = parent(session(PRIMARY), session(REFACWRK))
    expect(() => assertReplyScopeMatches(p, session(PRIMARY), undefined)).not.toThrow()
  })

  it('passes across lanes within the same scope', () => {
    const p = parent(session(REFACWRK, 'main'), { kind: 'entity', entity: 'human' })
    expect(() => assertReplyScopeMatches(p, session(REFACWRK, 'repair'), undefined)).not.toThrow()
  })

  it('throws reply_to_scope_mismatch on a genuine cross-scope reply (the incident)', () => {
    // Parent lives in refacwrk; completion is mistakenly aimed at primary.
    const p = parent(session(REFACWRK), { kind: 'entity', entity: 'human' })
    let caught: unknown
    try {
      assertReplyScopeMatches(p, session(PRIMARY), undefined)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(HrcDomainError)
    const err = caught as HrcDomainError
    expect(err.code).toBe('reply_to_scope_mismatch')
    expect(err.detail['replyToScope']).toBe(REFACWRK)
    expect(err.detail['targetScope']).toBe(PRIMARY)
    // Both scopes named so the agent can self-correct.
    expect(err.message).toContain(REFACWRK)
    expect(err.message).toContain(PRIMARY)
  })

  it('allows the cross-scope reply when explicitly opted in', () => {
    const p = parent(session(REFACWRK), { kind: 'entity', entity: 'human' })
    expect(() => assertReplyScopeMatches(p, session(PRIMARY), true)).not.toThrow()
  })

  it('does not guard entity targets (human/system)', () => {
    const p = parent(session(REFACWRK), { kind: 'entity', entity: 'human' })
    expect(() =>
      assertReplyScopeMatches(p, { kind: 'entity', entity: 'human' }, undefined)
    ).not.toThrow()
  })

  it('does not guard when the parent has no session participant', () => {
    const p = parent({ kind: 'entity', entity: 'human' }, { kind: 'entity', entity: 'system' })
    expect(() => assertReplyScopeMatches(p, session(PRIMARY), undefined)).not.toThrow()
  })
})
