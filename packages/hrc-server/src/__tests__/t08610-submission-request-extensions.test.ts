import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import type { ColdBirthPromptMode, HrcRuntimeIntent, HrcTargetView } from 'hrc-core'
import { openHrcDatabase } from 'hrc-store-sqlite'

import { createHrcServer } from '../index'
import type { HrcServer } from '../index'
import type { HrcServerInstanceForHandlers } from '../server-instance-context.js'
import { parseSubmissionRequest } from '../server-parsers.js'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture.js'

/**
 * T-08610 contract: `POST /v1/submissions/invoke` gains `ttlMs` and
 * `coldBirth.promptMode`; `POST /v1/targets/ensure` gains `persistIntent`.
 * Dispatch is doubled at `dispatchTurnForSession` (established pattern) so the
 * request plumbing is asserted without a broker; the double decides nothing.
 *
 * Run with: TMPDIR=/tmp bun run --filter hrc-server test t08610-submission-request-extensions
 */

const SCOPE = 'agent:t08610:project:hrc-runtime:task:extensions'
const SESSION_REF = `${SCOPE}/lane:main`

const runtimeIntent: HrcRuntimeIntent = {
  placement: {
    agentRoot: '/tmp/agent',
    projectRoot: '/tmp/project',
    cwd: '/tmp/project',
    runMode: 'task',
    bundle: { kind: 'compose', compose: [] },
    dryRun: true,
  },
  harness: { provider: 'openai', id: 'codex', interactive: false },
  execution: { preferredMode: 'headless', allowInteractiveSurfaceReuse: false },
}

type CapturedOptions = {
  ttlMs?: number | undefined
  coldBirthPromptMode?: ColdBirthPromptMode | undefined
}

let fixture: HrcServerTestFixture
let server: HrcServer
let internal: HrcServerInstanceForHandlers
let hostSessionId: string
let captured: CapturedOptions[]

function invokeBody(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    target: hostSessionId,
    body: 'cold summon body',
    origin: { principalRef: 'agent:muse', envelopeId: 'en-t08610' },
    runtimeIntent,
    wait: false,
    ...extra,
  }
}

function installDispatchDouble(): void {
  internal.dispatchTurnForSession = (async (
    session: { hostSessionId: string },
    _intent: unknown,
    _prompt: string,
    options: CapturedOptions
  ) => {
    captured.push({
      ...(options.ttlMs !== undefined ? { ttlMs: options.ttlMs } : {}),
      ...(options.coldBirthPromptMode !== undefined
        ? { coldBirthPromptMode: options.coldBirthPromptMode }
        : {}),
    })
    return Response.json({
      submissionId: 'sub-t08610',
      admission: 'admitted',
      runId: 'run-t08610',
      hostSessionId: session.hostSessionId,
      generation: 1,
      runtimeId: 'rt-t08610',
      transport: 'headless',
      status: 'started',
      supportsInFlightInput: false,
      startIdentity: { kind: 'broker', invocationId: 'inv-t08610' },
      observation: {
        lifecycle: {
          selector: { runId: 'run-t08610', runtimeId: 'rt-t08610', generation: 1 },
          fromSeq: 41,
        },
        broker: {
          selector: {
            invocationId: 'inv-t08610',
            runId: 'run-t08610',
            runtimeId: 'rt-t08610',
            generation: 1,
          },
          afterSeq: 73,
        },
      },
    })
  }) as typeof internal.dispatchTurnForSession
}

beforeEach(async () => {
  fixture = await createHrcTestFixture('hrc-t08610-')
  server = await createHrcServer(fixture.serverOpts())
  internal = server as unknown as HrcServerInstanceForHandlers
  hostSessionId = (await fixture.resolveSession('t08610-session')).hostSessionId
  captured = []
  installDispatchDouble()
})

afterEach(async () => {
  if (server) {
    await server.stop()
  }
  await fixture.cleanup()
})

describe('invoke parser: ttlMs + coldBirth', () => {
  it('accepts both options on invoke and neither is required', () => {
    expect(
      parseSubmissionRequest(
        invokeBody({ ttlMs: 3_600_000, coldBirth: { promptMode: 'replace-priming' } }),
        'invoke'
      )
    ).toMatchObject({ ttlMs: 3_600_000, coldBirth: { promptMode: 'replace-priming' } })
    expect(parseSubmissionRequest(invokeBody(), 'invoke')).not.toHaveProperty('coldBirth')
    expect(parseSubmissionRequest(invokeBody(), 'invoke')).not.toHaveProperty('ttlMs')
  })

  it('rejects bad promptMode, empty coldBirth, and unknown coldBirth fields', () => {
    expect(() =>
      parseSubmissionRequest(invokeBody({ coldBirth: { promptMode: 'launch' } }), 'invoke')
    ).toThrow('coldBirth.promptMode')
    expect(() => parseSubmissionRequest(invokeBody({ coldBirth: {} }), 'invoke')).toThrow(
      'coldBirth.promptMode is required'
    )
    expect(() =>
      parseSubmissionRequest(
        invokeBody({ coldBirth: { promptMode: 'append-to-priming', x: 1 } }),
        'invoke'
      )
    ).toThrow('unknown field "coldBirth.x"')
    expect(() =>
      parseSubmissionRequest(invokeBody({ coldBirth: 'replace-priming' }), 'invoke')
    ).toThrow('coldBirth must be an object')
  })

  it('keeps ttlMs off steer and coldBirth off every other door', () => {
    const steerBody = (extra: Record<string, unknown>) => {
      const { runtimeIntent: _dropped, turnPolicy: _alsoDropped, ...rest } = invokeBody(extra)
      void _dropped
      void _alsoDropped
      return rest
    }
    expect(() => parseSubmissionRequest(steerBody({ ttlMs: 1 }), 'steer')).toThrow(
      'unknown field "ttlMs"'
    )
    expect(() =>
      parseSubmissionRequest(steerBody({ coldBirth: { promptMode: 'replace-priming' } }), 'steer')
    ).toThrow('unknown field "coldBirth"')
    expect(() =>
      parseSubmissionRequest(
        invokeBody({ coldBirth: { promptMode: 'replace-priming' } }),
        'enqueue'
      )
    ).toThrow('unknown field "coldBirth"')
    expect(() =>
      parseSubmissionRequest(
        invokeBody({ coldBirth: { promptMode: 'replace-priming' } }),
        'preempt'
      )
    ).toThrow('unknown field "coldBirth"')
    expect(parseSubmissionRequest(invokeBody({ ttlMs: 5 }), 'enqueue')).toMatchObject({ ttlMs: 5 })
    expect(parseSubmissionRequest(invokeBody({ ttlMs: 5 }), 'preempt')).toMatchObject({ ttlMs: 5 })
  })
})

describe('POST /v1/submissions/invoke option flow', () => {
  it('carries ttlMs and coldBirth.promptMode into dispatch', async () => {
    const res = await fixture.postJson(
      '/v1/submissions/invoke',
      invokeBody({ ttlMs: 3_600_000, coldBirth: { promptMode: 'replace-priming' } })
    )
    expect(res.status).toBe(202)
    expect(captured).toHaveLength(1)
    expect(captured[0]).toEqual({ ttlMs: 3_600_000, coldBirthPromptMode: 'replace-priming' })
  })

  it('omits both when absent, preserving the legacy derivation', async () => {
    const res = await fixture.postJson('/v1/submissions/invoke', invokeBody())
    expect(res.status).toBe(202)
    expect(captured).toHaveLength(1)
    expect(captured[0]).toEqual({})
  })

  it('carries append-to-priming explicitly', async () => {
    const res = await fixture.postJson(
      '/v1/submissions/invoke',
      invokeBody({ coldBirth: { promptMode: 'append-to-priming' } })
    )
    expect(res.status).toBe(202)
    expect(captured[0]).toEqual({ coldBirthPromptMode: 'append-to-priming' })
  })
})

describe('POST /v1/targets/ensure persistIntent', () => {
  const persistIntentBody = (persistIntent?: boolean | undefined) => ({
    sessionRef: SESSION_REF,
    runtimeIntent,
    ...(persistIntent !== undefined ? { persistIntent } : {}),
  })

  function lastAppliedIntentJson(): unknown {
    const db = openHrcDatabase(fixture.dbPath)
    try {
      const sessions = db.sessions.listByScopeRef(SCOPE)
      expect(sessions).toHaveLength(1)
      return sessions[0]?.lastAppliedIntentJson ?? null
    } finally {
      db.close()
    }
  }

  it('persists the intent by default', async () => {
    const res = await fixture.postJson('/v1/targets/ensure', persistIntentBody())
    expect(res.status).toBe(200)
    expect(((await res.json()) as HrcTargetView).sessionRef).toBe(SESSION_REF)
    expect(lastAppliedIntentJson()).toMatchObject({ harness: { provider: 'openai' } })
  })

  it('persistIntent:false leaves the stored intent alone', async () => {
    const first = await fixture.postJson('/v1/targets/ensure', persistIntentBody())
    expect(first.status).toBe(200)
    const before = lastAppliedIntentJson()
    const otherIntent = {
      ...runtimeIntent,
      harness: { ...runtimeIntent.harness, id: 'claude-code' as const },
    }
    const second = await fixture.postJson('/v1/targets/ensure', {
      sessionRef: SESSION_REF,
      runtimeIntent: otherIntent,
      persistIntent: false,
    })
    expect(second.status).toBe(200)
    expect(lastAppliedIntentJson()).toEqual(before)
  })

  it('400s a non-boolean persistIntent', async () => {
    const res = await fixture.postJson('/v1/targets/ensure', {
      sessionRef: SESSION_REF,
      runtimeIntent,
      persistIntent: 'yes',
    })
    expect(res.status).toBe(400)
  })
})
