/**
 * T-09746: POST /v1/app-sessions/ensure must not block on the first provider
 * turn.
 *
 * Since 78b1077b (T-08716) an ensure whose birth leaves a live v2 headless
 * runtime routes its auto-dispatch through the headless broker door. Without
 * an explicit waitForCompletion:false that door waits for the turn to COMPLETE,
 * so ensure — including a grantless ensure with no prompt — hung until the
 * provider finished (forever against a broker that never completes a turn).
 * The same function already refuses that wait for the submission door ("do
 * not make the fresh v2 birth wait for the first provider turn").
 *
 * The broker double here admits the turn and never completes it, so a
 * blocking ensure cannot return inside the bound.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import {
  APP_ID,
  KEY,
  baseIntent,
  bootAspdBirthServer,
  internal,
  ledger,
  post,
  setUpAppSessionBirthFixture,
  tearDownAppSessionBirthFixture,
} from './fixtures/app-session-birth.fixture'

const ENSURE_RETURN_BOUND_MS = 5_000

beforeEach(setUpAppSessionBirthFixture)
afterEach(tearDownAppSessionBirthFixture)

describe('T-09746 app-session ensure on a reused live v2 headless runtime', () => {
  it('returns before the auto-dispatched turn completes', async () => {
    await bootAspdBirthServer()
    const started = Date.now()
    const outcome = await Promise.race([
      post('/v1/app-sessions/ensure', {
        selector: { appId: APP_ID, appSessionKey: KEY },
        spec: { kind: 'harness', runtimeIntent: baseIntent() },
      }),
      new Promise<'blocked'>((resolve) =>
        setTimeout(() => resolve('blocked'), ENSURE_RETURN_BOUND_MS)
      ),
    ])

    expect(outcome).not.toBe('blocked')
    expect(Date.now() - started).toBeLessThan(ENSURE_RETURN_BOUND_MS)
    if (outcome === 'blocked') return
    expect(outcome.status).toBe(200)

    // The runtime is the one the birth started, and its turn is still open:
    // ensure returned on admission, not on completion.
    expect(ledger?.startCalls.length).toBe(1)
    const runtimes = internal.db.runtimes
      .listAvailable()
      .filter((runtime) => runtime.transport === 'headless')
    expect(runtimes).toHaveLength(1)
  })
})
