/**
 * RED tests: hostSessionId + generation isolation for events and messages.
 *
 * These tests prove that the current store layer does NOT properly filter
 * lifecycle events or messages by hostSessionId and generation.
 * Phase 1b will add the missing filter paths and turn these green.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { HrcMessageAddress } from 'hrc-core'
import { openHrcDatabase } from '../index'
import type { HrcDatabase } from '../index'

let tmpDir: string
let db: HrcDatabase

function ts(): string {
  return new Date().toISOString()
}

function scopeRef(key: string): string {
  return `agent:test:project:gen-iso:task:${key}`
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'hrc-gen-iso-test-'))
  db = openHrcDatabase(join(tmpDir, 'test.sqlite'))
})

afterEach(async () => {
  db.close()
  await rm(tmpDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function seedSession(hostSessionId: string, key: string, generation = 1) {
  const now = ts()
  db.sessions.insert({
    hostSessionId,
    scopeRef: scopeRef(key),
    laneRef: 'default',
    generation,
    status: 'active',
    createdAt: now,
    updatedAt: now,
    ancestorScopeRefs: [],
  })
}

const humanAddr: HrcMessageAddress = { kind: 'entity', entity: 'human' }
function sessionAddr(ref: string): HrcMessageAddress {
  return { kind: 'session', sessionRef: ref }
}

// ===========================================================================
// DELIVERABLE 1: Events — hostSessionId isolation
// ===========================================================================

describe('hrcEvents hostSessionId isolation', () => {
  it('events with same scopeRef but different hostSessionId do NOT mix when filtered by hostSessionId', () => {
    // Two sessions sharing the same scopeRef but with different hostSessionIds
    seedSession('hsid-A', 'shared')
    seedSession('hsid-B', 'shared')

    const base = {
      ts: ts(),
      scopeRef: scopeRef('shared'),
      laneRef: 'default',
      generation: 1,
      category: 'turn' as const,
      eventKind: 'turn.started',
      payload: {},
    }

    // Append 2 events for hsid-A, 1 for hsid-B
    db.hrcEvents.append({ ...base, hostSessionId: 'hsid-A', payload: { tag: 'A1' } })
    db.hrcEvents.append({ ...base, hostSessionId: 'hsid-A', payload: { tag: 'A2' } })
    db.hrcEvents.append({ ...base, hostSessionId: 'hsid-B', payload: { tag: 'B1' } })

    // Filter by hsid-A should return exactly 2 events
    const eventsA = db.hrcEvents.listFromHrcSeq(1, { hostSessionId: 'hsid-A' })
    expect(eventsA).toHaveLength(2)
    expect(eventsA.every((e) => e.hostSessionId === 'hsid-A')).toBe(true)

    // Filter by hsid-B should return exactly 1 event
    const eventsB = db.hrcEvents.listFromHrcSeq(1, { hostSessionId: 'hsid-B' })
    expect(eventsB).toHaveLength(1)
    expect(eventsB[0]!.hostSessionId).toBe('hsid-B')
  })
})

// ===========================================================================
// DELIVERABLE 2: Messages — hostSessionId isolation
// ===========================================================================

describe('messages hostSessionId isolation', () => {
  it('messages with same sessionRef but different hostSessionId do NOT mix when filtered', () => {
    const sharedSessionRef = 'agent:cody:project:gen-iso/lane:main'
    const codyAddr = sessionAddr(sharedSessionRef)

    // Insert messages with different hostSessionIds in their execution context
    db.messages.insert({
      messageId: 'msg-hsA-1',
      kind: 'dm',
      phase: 'request',
      from: humanAddr,
      to: codyAddr,
      body: 'Hello from session A',
      execution: {
        state: 'completed',
        sessionRef: sharedSessionRef,
        hostSessionId: 'hsid-A',
        generation: 1,
      },
    })
    db.messages.insert({
      messageId: 'msg-hsA-2',
      kind: 'dm',
      phase: 'response',
      from: codyAddr,
      to: humanAddr,
      body: 'Reply from session A',
      execution: {
        state: 'completed',
        sessionRef: sharedSessionRef,
        hostSessionId: 'hsid-A',
        generation: 1,
      },
    })
    db.messages.insert({
      messageId: 'msg-hsB-1',
      kind: 'dm',
      phase: 'request',
      from: humanAddr,
      to: codyAddr,
      body: 'Hello from session B',
      execution: {
        state: 'completed',
        sessionRef: sharedSessionRef,
        hostSessionId: 'hsid-B',
        generation: 1,
      },
    })

    // Query filtering by hostSessionId — this filter does NOT exist today
    // on HrcMessageFilter, so we expect this to fail (return all 3).
    const messagesA = db.messages.query({
      hostSessionId: 'hsid-A',
    } as any)

    // Phase 1b will add hostSessionId to HrcMessageFilter and the query method.
    // Until then, this assertion proves the gap: we expect 2, but the filter
    // is ignored and we get all 3 (or 0, depending on implementation).
    expect(messagesA).toHaveLength(2)
    expect(messagesA.every((m) => m.execution.hostSessionId === 'hsid-A')).toBe(true)
  })
})

// ===========================================================================
// DELIVERABLE 3: Generation filter — events + messages
// ===========================================================================

describe('hrcEvents generation filter', () => {
  it('same hostSessionId, different generation → filter excludes wrong generation', () => {
    // Single session, but events spanning two generations
    seedSession('hsid-gen', 'gen-test')

    const base = {
      ts: ts(),
      hostSessionId: 'hsid-gen',
      scopeRef: scopeRef('gen-test'),
      laneRef: 'default',
      category: 'turn' as const,
      eventKind: 'turn.started',
      payload: {},
    }

    // Gen 1 events
    db.hrcEvents.append({ ...base, generation: 1, payload: { gen: 1, idx: 1 } })
    db.hrcEvents.append({ ...base, generation: 1, payload: { gen: 1, idx: 2 } })

    // Gen 2 events
    db.hrcEvents.append({ ...base, generation: 2, payload: { gen: 2, idx: 1 } })

    // Filter by generation — this filter does NOT exist today on
    // HrcLifecycleQueryFilters, so we expect it to fail.
    const gen1Events = db.hrcEvents.listFromHrcSeq(1, {
      hostSessionId: 'hsid-gen',
      generation: 1,
    } as any)

    expect(gen1Events).toHaveLength(2)
    expect(gen1Events.every((e) => e.generation === 1)).toBe(true)

    const gen2Events = db.hrcEvents.listFromHrcSeq(1, {
      hostSessionId: 'hsid-gen',
      generation: 2,
    } as any)

    expect(gen2Events).toHaveLength(1)
    expect(gen2Events[0]!.generation).toBe(2)
  })
})

describe('messages generation filter', () => {
  it('same hostSessionId, different generation → filter excludes wrong generation', () => {
    const sessionRef = 'agent:cody:project:gen-iso/lane:main'
    const codyAddr = sessionAddr(sessionRef)

    // Messages in generation 1
    db.messages.insert({
      messageId: 'msg-g1-1',
      kind: 'dm',
      phase: 'request',
      from: humanAddr,
      to: codyAddr,
      body: 'Gen 1 message',
      execution: {
        state: 'completed',
        sessionRef,
        hostSessionId: 'hsid-gen',
        generation: 1,
      },
    })

    // Messages in generation 2
    db.messages.insert({
      messageId: 'msg-g2-1',
      kind: 'dm',
      phase: 'request',
      from: humanAddr,
      to: codyAddr,
      body: 'Gen 2 message',
      execution: {
        state: 'completed',
        sessionRef,
        hostSessionId: 'hsid-gen',
        generation: 2,
      },
    })
    db.messages.insert({
      messageId: 'msg-g2-2',
      kind: 'dm',
      phase: 'response',
      from: codyAddr,
      to: humanAddr,
      body: 'Gen 2 reply',
      execution: {
        state: 'completed',
        sessionRef,
        hostSessionId: 'hsid-gen',
        generation: 2,
      },
    })

    // Query filtering by hostSessionId + generation — neither filter exists
    // on HrcMessageFilter today.
    const gen2Msgs = db.messages.query({
      hostSessionId: 'hsid-gen',
      generation: 2,
    } as any)

    expect(gen2Msgs).toHaveLength(2)
    expect(gen2Msgs.every((m) => m.execution.generation === 2)).toBe(true)

    const gen1Msgs = db.messages.query({
      hostSessionId: 'hsid-gen',
      generation: 1,
    } as any)

    expect(gen1Msgs).toHaveLength(1)
    expect(gen1Msgs[0]!.execution.generation).toBe(1)
  })
})
