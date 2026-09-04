import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import type { ResolveSessionResponse, ResumeContinuationResponse } from 'hrc-core'
import { openHrcDatabase } from 'hrc-store-sqlite'

import { createHrcServer } from '../index'
import type { HrcServer } from '../index'
import { createHrcTestFixture } from './fixtures/hrc-test-fixture'
import type { HrcServerTestFixture } from './fixtures/hrc-test-fixture'

const SCOPE_REF = 'agent:t07899:project:hrc-runtime:task:resume-keyless-successor'
const SESSION_REF = `${SCOPE_REF}/lane:default`
const CONTINUATION = {
  provider: 'anthropic' as const,
  kind: 'session',
  key: 'continuation-before-drop-context',
}

let fixture: HrcServerTestFixture
let server: HrcServer

beforeEach(async () => {
  fixture = await createHrcTestFixture('hrc-t07899-resume-')
  server = await createHrcServer(fixture.serverOpts())
})

afterEach(async () => {
  await server.stop()
  await fixture.cleanup()
})

function seedDropContextSuccessor(
  options: {
    successorContinuation?: typeof CONTINUATION | undefined
    liveRuntime?: boolean | undefined
  } = {}
): void {
  const db = openHrcDatabase(fixture.dbPath)
  const now = fixture.now()
  try {
    db.sessions.insert({
      hostSessionId: 'hsid-t07899-prior',
      scopeRef: SCOPE_REF,
      laneRef: 'default',
      generation: 1,
      status: 'archived',
      createdAt: now,
      updatedAt: now,
      ancestorScopeRefs: [],
      continuation: CONTINUATION,
    })
    db.sessions.insert({
      hostSessionId: 'hsid-t07899-successor',
      scopeRef: SCOPE_REF,
      laneRef: 'default',
      generation: 2,
      status: 'active',
      priorHostSessionId: 'hsid-t07899-prior',
      createdAt: now,
      updatedAt: now,
      ancestorScopeRefs: [],
      ...(options.successorContinuation ? { continuation: options.successorContinuation } : {}),
    })
    db.continuities.upsert({
      scopeRef: SCOPE_REF,
      laneRef: 'default',
      activeHostSessionId: 'hsid-t07899-successor',
      updatedAt: now,
    })
    if (options.liveRuntime) {
      db.runtimes.insert({
        runtimeId: 'rt-t07899-successor',
        hostSessionId: 'hsid-t07899-successor',
        scopeRef: SCOPE_REF,
        laneRef: 'default',
        generation: 2,
        transport: 'headless',
        harness: 'agent-sdk',
        provider: 'anthropic',
        status: 'ready',
        supportsInflightInput: false,
        adopted: false,
        createdAt: now,
        updatedAt: now,
      })
    }
  } finally {
    db.close()
  }
}

describe('T-07899 explicit resume successor binding', () => {
  it('binds the selected key to an existing inactive keyless successor', async () => {
    seedDropContextSuccessor()

    const response = await fixture.postJson('/v1/sessions/resume-continuation', {
      sessionRef: SESSION_REF,
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as ResumeContinuationResponse
    expect(body.hostSessionId).toBe('hsid-t07899-successor')
    expect(body.continuation).toEqual(CONTINUATION)

    const db = openHrcDatabase(fixture.dbPath)
    try {
      expect(db.sessions.getByHostSessionId('hsid-t07899-successor')?.continuation).toEqual(
        CONTINUATION
      )
      expect(db.sessions.isContinuationReuseDisabled('hsid-t07899-successor')).toBe(false)
    } finally {
      db.close()
    }

    const resolved = await fixture.postJson('/v1/sessions/resolve', {
      sessionRef: SESSION_REF,
      create: false,
    })
    expect(resolved.status).toBe(200)
    const resolvedBody = (await resolved.json()) as ResolveSessionResponse
    expect(resolvedBody.session?.continuation).toEqual(CONTINUATION)
  })

  it('conflicts instead of mutating a keyless successor with a live runtime', async () => {
    seedDropContextSuccessor({ liveRuntime: true })

    const response = await fixture.postJson('/v1/sessions/resume-continuation', {
      sessionRef: SESSION_REF,
    })
    expect(response.status).toBe(409)

    const db = openHrcDatabase(fixture.dbPath)
    try {
      expect(db.sessions.getByHostSessionId('hsid-t07899-successor')?.continuation).toBeUndefined()
    } finally {
      db.close()
    }
  })

  it('branches from a pinned historical key when the current successor has a different key', async () => {
    seedDropContextSuccessor({
      successorContinuation: {
        provider: 'anthropic',
        kind: 'session',
        key: 'different-successor-key',
      },
    })

    const response = await fixture.postJson('/v1/sessions/resume-continuation', {
      sessionRef: SESSION_REF,
      priorHostSessionId: 'hsid-t07899-prior',
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as ResumeContinuationResponse
    expect(body).toMatchObject({
      generation: 3,
      priorHostSessionId: 'hsid-t07899-prior',
      continuation: CONTINUATION,
    })
    expect(body.hostSessionId).not.toBe('hsid-t07899-successor')

    const db = openHrcDatabase(fixture.dbPath)
    try {
      expect(db.sessions.getByHostSessionId('hsid-t07899-successor')?.continuation?.key).toBe(
        'different-successor-key'
      )
      expect(db.sessions.getByHostSessionId(body.hostSessionId)?.continuation).toEqual(CONTINUATION)
    } finally {
      db.close()
    }
  })

  it('keeps an unpinned resume on the newest continuation', async () => {
    seedDropContextSuccessor({
      successorContinuation: {
        provider: 'anthropic',
        kind: 'session',
        key: 'newest-successor-key',
      },
    })

    const response = await fixture.postJson('/v1/sessions/resume-continuation', {
      sessionRef: SESSION_REF,
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as ResumeContinuationResponse
    expect(body).toMatchObject({
      generation: 3,
      priorHostSessionId: 'hsid-t07899-successor',
      continuation: {
        provider: 'anthropic',
        kind: 'session',
        key: 'newest-successor-key',
      },
    })
  })
})
