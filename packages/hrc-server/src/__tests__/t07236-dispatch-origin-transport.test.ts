/**
 * T-07236 — the dispatch-origin transport: wire → options → run row.
 *
 * This is the seam ACP's launcher work depends on, and it is also the seam that
 * T-07235 proved is easy to break silently: `firstTurnTimeoutMs` was dropped at
 * two hand-copied hops and only a live dispatch revealed it. These tests pin
 * each link of the chain independently so a dropped hop fails here rather than
 * in production, where the symptom would be a silently unattributed trip.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { openHrcDatabase } from 'hrc-store-sqlite'

import { resolveBridgedOrigin } from '../acp-event-bridge'
import { parseDispatchTurnRequest } from '../parsers/runtime'
import { dispatchOriginRunFields, dispatchRunPersistence } from '../server-types'

const BASE_REQUEST = { hostSessionId: 'hsid-t07236', prompt: 'hello' }

describe('T-07236 wire parsing', () => {
  it('accepts a full origin block and normalizes whitespace', () => {
    const parsed = parseDispatchTurnRequest({
      ...BASE_REQUEST,
      origin: { actor: ' agent:cody ', kind: 'agent', causationRef: ' jrun-12 ' },
    })
    expect(parsed.origin).toEqual({
      actor: 'agent:cody',
      kind: 'agent',
      causationRef: 'jrun-12',
    })
  })

  it('accepts an absent origin — a dispatch with no attributable initiator is legitimate', () => {
    expect(parseDispatchTurnRequest(BASE_REQUEST).origin).toBe(undefined)
  })

  it('rejects malformed origins rather than dropping them', () => {
    // Dropping any of these would relabel a KNOWN cause as unattributed, which
    // is precisely the policy bypass the transport exists to close.
    const rejected = [
      { origin: 'agent:cody' },
      { origin: {} },
      { origin: { actor: '' } },
      { origin: { kind: 'robot' } },
      { origin: { actor: 'agent:cody', causationRef: '' } },
      { origin: { actor: 'agent:cody', kind: 'agent', causationRef: 7 } },
    ]
    for (const patch of rejected) {
      expect(() => parseDispatchTurnRequest({ ...BASE_REQUEST, ...patch })).toThrow()
    }
  })
})

describe('T-07236 option threading', () => {
  it('carries origin through the shared dispatch-persistence spread', () => {
    const origin = { actor: 'agent:mable', kind: 'agent' as const, causationRef: 'jrun-1' }
    const rethreaded = dispatchRunPersistence({
      dispatchIdempotencyKey: 'key-1',
      firstTurnTimeoutMs: 5_000,
      origin,
    })
    // Every field, not just the new one: this spread exists so a future
    // addition cannot be dropped at one of the hops that use it.
    expect(rethreaded).toEqual({
      dispatchIdempotencyKey: 'key-1',
      firstTurnTimeoutMs: 5_000,
      origin,
    })
  })

  it('projects the origin onto the run row columns', () => {
    expect(
      dispatchOriginRunFields({
        origin: { actor: 'human:lherron', kind: 'human', causationRef: 'jrun-2' },
      })
    ).toEqual({
      originActor: 'human:lherron',
      originKind: 'human',
      originCausationRef: 'jrun-2',
    })
    expect(dispatchOriginRunFields({})).toEqual({
      originActor: undefined,
      originKind: undefined,
      originCausationRef: undefined,
    })
  })
})

describe('T-07236 durable round trip', () => {
  let dir: string
  let db: ReturnType<typeof openHrcDatabase>

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'hrc-origin-'))
    db = openHrcDatabase(join(dir, 'state.sqlite'))
    const now = '2026-08-14T22:00:00.000Z'
    db.sessions.insert({
      hostSessionId: 'hsid-origin',
      scopeRef: 'agent:clod:project:hrc-runtime:task:T-07236',
      laneRef: 'default',
      generation: 1,
      status: 'active',
      createdAt: now,
      updatedAt: now,
      ancestorScopeRefs: [],
    })
  })

  afterEach(async () => {
    db.close()
    await rm(dir, { recursive: true, force: true })
  })

  it('persists and reads back the origin the emitter joins on', () => {
    const now = '2026-08-14T22:01:00.000Z'
    db.runs.insert({
      runId: 'run-origin',
      hostSessionId: 'hsid-origin',
      scopeRef: 'agent:clod:project:hrc-runtime:task:T-07236',
      laneRef: 'default',
      generation: 1,
      transport: 'headless',
      status: 'accepted',
      acceptedAt: now,
      updatedAt: now,
      ...dispatchOriginRunFields({
        origin: { actor: 'agent:cody', kind: 'agent', causationRef: 'jrun-3' },
      }),
    })
    const reread = db.runs.getByRunId('run-origin')
    expect(reread?.originActor).toBe('agent:cody')
    expect(reread?.originKind).toBe('agent')
    expect(reread?.originCausationRef).toBe('jrun-3')
    expect(resolveBridgedOrigin(reread)).toEqual({
      actor: 'agent:cody',
      kind: 'agent',
      causation_ref: 'jrun-3',
    })
  })

  it('reads a run dispatched before the transport existed as unattributed', () => {
    const now = '2026-08-14T22:02:00.000Z'
    db.runs.insert({
      runId: 'run-legacy',
      hostSessionId: 'hsid-origin',
      scopeRef: 'agent:clod:project:hrc-runtime:task:T-07236',
      laneRef: 'default',
      generation: 1,
      transport: 'headless',
      status: 'accepted',
      acceptedAt: now,
      updatedAt: now,
    })
    const reread = db.runs.getByRunId('run-legacy')
    expect(reread?.originActor).toBe(undefined)
    expect(resolveBridgedOrigin(reread)).toEqual({ actor: 'system:hrc', kind: 'system' })
  })
})
