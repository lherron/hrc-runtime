/** T-08576 R-B7(g5,g7) grant-edge acceptance tests. */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { HrcDatabase } from 'hrc-store-sqlite'

import {
  APP_ID,
  baseIntent,
  bootAspdBirthServer,
  capturedRefusal,
  dispatchedIdentityEnv,
  frozenPreparations,
  hostEffectCounts,
  identityProjection,
  internal,
  ledger,
  post,
  seedAppIdentity,
  setUpAppSessionBirthFixture,
  tearDownAppSessionBirthFixture,
} from './fixtures/app-session-birth.fixture'

beforeEach(setUpAppSessionBirthFixture)
afterEach(tearDownAppSessionBirthFixture)

describe('T-08576 app-session birth grant edges', () => {
  it('R-B7(g5) apply create with an initial turn grants its single birth', async () => {
    await bootAspdBirthServer()
    const intent = { ...baseIntent(), initialPrompt: 'apply-carried initial turn' }
    const response = await post('/v1/app-sessions/apply', {
      appId: APP_ID,
      sessions: [
        { appSessionKey: 'apply-prompted', spec: { kind: 'harness', runtimeIntent: intent } },
      ],
    })
    expect(response.status).toBe(200)
    const hostSessionId = internal.db.appManagedSessions.findByKey(APP_ID, 'apply-prompted')
      ?.activeHostSessionId as string
    const env = dispatchedIdentityEnv()
    const runId = env.HRC_RUN_ID
    const row = internal.db.runs.getByRunId(runId)
    expect({
      birthCount: ledger?.startCalls.length,
      env: identityProjection(env),
      correlation: frozenPreparations(hostSessionId)[0]?.intent?.placement?.correlation,
      row,
    }).toEqual({
      birthCount: 2,
      env: {
        AGENT_HOST_SESSION_ID: hostSessionId,
        HRC_HOST_SESSION_ID: hostSessionId,
        AGENT_RUN_ID: runId,
        HRC_RUN_ID: runId,
        AGENT_GENERATION: '1',
        HRC_GENERATION: '1',
      },
      correlation: { hostSessionId, generation: 1, runId },
      row: expect.objectContaining({ hostSessionId, generation: 1, runtimeId: expect.any(String) }),
    })
  })

  it('R-B7(g7) [green-phase grant seam] refuses an ungranted app compile identity before graph writes', async () => {
    const hostSessionId = seedAppIdentity(baseIntent(), 'g7')
    const session = internal.db.sessions.getByHostSessionId(hostSessionId)
    if (session === null) throw new Error('R-B7(g7) fixture session missing')
    const effectsBefore = hostEffectCounts(hostSessionId)
    const identity = await import('../app-session-identity')
    const assertStartGraph = Reflect.get(identity, 'assertAppStartGraphRunIdentity') as
      | ((db: HrcDatabase, target: typeof session, runId: string) => void)
      | undefined
    const refusal = await capturedRefusal(() =>
      assertStartGraph?.(internal.db, session, 'run-t08576-g7-ungranted')
    )
    expect({
      exportPresent: typeof assertStartGraph,
      refusal,
      effects: hostEffectCounts(hostSessionId),
    }).toEqual({
      exportPresent: 'function',
      refusal: {
        code: 'stale_context',
        reason: 'app-birth-run-grant-invalid',
        runId: 'run-t08576-g7-ungranted',
      },
      effects: effectsBefore,
    })
  })
})
