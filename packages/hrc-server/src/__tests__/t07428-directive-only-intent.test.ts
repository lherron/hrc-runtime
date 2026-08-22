import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import {
  type HrcDirectiveOnlyIntent,
  HrcErrorCode,
  type HrcRuntimeIntent,
  type HrcSessionRecord,
  HrcUnprocessableEntityError,
} from 'hrc-core'
import { openHrcDatabase } from 'hrc-store-sqlite'

import { normalizeDispatchIntent } from '../dispatch-invocation.js'
import { type HrcServer, createHrcServer } from '../index.js'
import { completeDirectiveOnlyIntent } from '../target-message-handlers.js'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture.js'

const SCOPE_REF = 'agent:t07428:project:hrc-runtime:task:T-07428'
const SESSION_REF = `${SCOPE_REF}/lane:default`
const FRAGMENT = { provision: { model: 'directive-model' } } satisfies HrcDirectiveOnlyIntent
const STORED_INTENT = {
  placement: {
    agentRoot: '/stored/agent',
    projectRoot: '/stored/project',
    cwd: '/stored/project/worktree',
    runMode: 'task',
    bundle: { kind: 'compose', compose: [] },
    dryRun: true,
  },
  harness: { provider: 'anthropic', id: 'claude-code', interactive: false },
  provision: { model: 'stored-model', reasoning: 'high' },
  execution: { preferredMode: 'nonInteractive' },
  launch: {
    env: { T07428: 'stored' },
    unsetEnv: ['OLD_T07428'],
    pathPrepend: ['/stored/bin'],
  },
  initialPrompt: 'stored prompt',
  attachments: [{ kind: 'text', name: 'stored.txt', content: 'stored attachment' }],
  taskContext: {
    taskId: 'T-07428',
    phase: 'implement',
    role: 'implementer',
    requiredEvidenceKinds: ['test'],
    hintsText: 'stored hints',
  },
  presentation: { viewerWindow: 'stored-window' },
} satisfies HrcRuntimeIntent

let fixture: HrcServerTestFixture
let server: HrcServer

beforeEach(async () => {
  fixture = await createHrcTestFixture('h74-')
  server = await createHrcServer(
    fixture.serverOpts({
      otelListenerEnabled: false,
    })
  )
})

afterEach(async () => {
  await server.stop()
  await fixture.cleanup()
})

async function seedStoredIntent(): Promise<HrcSessionRecord> {
  const { hostSessionId } = await fixture.resolveSession(SCOPE_REF)
  const db = openHrcDatabase(fixture.dbPath)
  try {
    db.sessions.updateIntent(hostSessionId, STORED_INTENT, fixture.now())
    const session = db.sessions.getByHostSessionId(hostSessionId)
    if (session === null) throw new Error('seeded session missing')
    return session
  } finally {
    db.close()
  }
}

describe('T-07428 directive-only runtime intent contract', () => {
  it('overlays only provision onto every stored whole-intent field', async () => {
    const session = await seedStoredIntent()
    const stored = session.lastAppliedIntentJson
    if (stored === undefined) throw new Error('seeded intent missing')

    const completed = completeDirectiveOnlyIntent(server, SESSION_REF, FRAGMENT)

    expect(JSON.stringify(completed)).toBe(
      JSON.stringify({ ...stored, provision: FRAGMENT.provision })
    )
    expect(completed?.provision).toBe(FRAGMENT.provision)
  })

  it('returns a whole intent by reference identity', () => {
    expect(completeDirectiveOnlyIntent(server, SESSION_REF, STORED_INTENT)).toBe(STORED_INTENT)
  })

  it('returns undefined when no target session exists', () => {
    expect(
      completeDirectiveOnlyIntent(
        server,
        'agent:missing:project:hrc-runtime/lane:default',
        FRAGMENT
      )
    ).toBeUndefined()
  })

  it('returns undefined when the persisted session intent is JSON null', async () => {
    const { hostSessionId } = await fixture.resolveSession(SCOPE_REF)
    const db = openHrcDatabase(fixture.dbPath)
    try {
      db.sessions.updateIntent(hostSessionId, null, fixture.now())
      const persisted = db.sqlite
        .query<{ last_applied_intent_json: string | null }, [string]>(
          'SELECT last_applied_intent_json FROM sessions WHERE host_session_id = ?'
        )
        .get(hostSessionId)
      expect(persisted?.last_applied_intent_json).toBe('null')
    } finally {
      db.close()
    }

    expect(completeDirectiveOnlyIntent(server, SESSION_REF, FRAGMENT)).toBeUndefined()
  })

  it('repairs a warm-target fragment through the real semantic DM door before dispatch', async () => {
    await seedStoredIntent()
    const dispatched: HrcRuntimeIntent[] = []
    Reflect.set(
      server,
      'dispatchTurnForSession',
      async (
        session: HrcSessionRecord,
        intent: HrcRuntimeIntent,
        _prompt: string,
        options: { runId: string }
      ) => {
        dispatched.push(intent)
        return Response.json({
          status: 'started',
          hostSessionId: session.hostSessionId,
          runtimeId: 'rt-t07428-dispatch',
          runId: options.runId,
          generation: session.generation,
          transport: 'tmux',
        })
      }
    )

    const response = await fixture.postJson('/v1/messages/dm', {
      from: { kind: 'entity', entity: 'human' },
      to: { kind: 'session', sessionRef: SESSION_REF },
      body: 'drive the directive-only fragment through handleSemanticDm',
      runtimeIntent: FRAGMENT,
    })

    expect(response.status).toBe(200)
    expect(dispatched).toHaveLength(1)
    expect(dispatched[0]).toMatchObject({
      placement: STORED_INTENT.placement,
      harness: STORED_INTENT.harness,
      provision: FRAGMENT.provision,
    })
  })

  it('refuses a directive-only fragment on a non-session DM before routing', async () => {
    const response = await fixture.postJson('/v1/messages/dm', {
      from: { kind: 'entity', entity: 'human' },
      to: { kind: 'entity', entity: 'system' },
      body: 'deployment-skew fragment cannot route to a non-session target',
      runtimeIntent: FRAGMENT,
    })
    const body = (await response.json()) as {
      error?: { code?: string; detail?: Record<string, unknown> }
    }

    expect(response.status).toBe(422)
    expect(body.error?.code).toBe(HrcErrorCode.MISSING_RUNTIME_INTENT)
    expect(body.error?.detail).toEqual({ reason: 'directive_only_runtime_intent' })
  })

  it('refuses a deployment-skew fragment at the whole-intent dispatch seam', async () => {
    const { hostSessionId } = await fixture.resolveSession(SCOPE_REF)
    const db = openHrcDatabase(fixture.dbPath)
    let session: HrcSessionRecord | null
    try {
      session = db.sessions.getByHostSessionId(hostSessionId)
    } finally {
      db.close()
    }
    if (session === null) throw new Error('seeded session missing')

    try {
      Reflect.apply(normalizeDispatchIntent, undefined, [FRAGMENT, session, 'run-skew'])
      throw new Error('expected directive-only fragment refusal')
    } catch (error) {
      expect(error).toBeInstanceOf(HrcUnprocessableEntityError)
      if (!(error instanceof HrcUnprocessableEntityError)) throw error
      expect(error.code).toBe(HrcErrorCode.MISSING_RUNTIME_INTENT)
      expect(error.detail).toEqual({ reason: 'directive_only_runtime_intent' })
    }
  })
})
