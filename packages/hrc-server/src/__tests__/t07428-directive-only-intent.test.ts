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
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture.js'

const SCOPE_REF = 'agent:t07428:project:hrc-runtime:task:T-07428'
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
  it('keeps the F1 admission run in correlation but omits it for the format2 input route', async () => {
    const session = await seedStoredIntent()
    const f1 = normalizeDispatchIntent(STORED_INTENT, session, 'run-t08207-f1')
    const f2 = normalizeDispatchIntent(STORED_INTENT, session, undefined)

    expect(f1.placement?.correlation).toMatchObject({ runId: 'run-t08207-f1' })
    expect(f2.placement?.correlation).not.toHaveProperty('runId')
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
