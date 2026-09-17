/** T-08566 X5/F0y: monitor renders retained rows but never uses them as authority. */
import { expect, test } from 'bun:test'
import {
  SELECTOR,
  createFixtureState,
  event,
  invokeWatch,
} from './fixtures/cli-test-fixture'

function terminal(origin?: 'retained') {
  return event(41, 'turn.completed', {
    runId: 'run-origin',
    turnId: 'run-origin',
    payload: { success: true },
    ...(origin ? { evidenceOrigin: origin } : {}),
  } as never)
}

test('live terminal remains renderable (positive control)', async () => {
  const result = await invokeWatch(
    { selector: SELECTOR, follow: false },
    createFixtureState({ activeTurnId: 'run-origin', events: [terminal()] })
  )
  expect(result.exitCode).toBe(0)
  expect(result.events.some((entry) => entry['event'] === 'turn.completed')).toBe(true)
})

test('retained terminal remains renderable with origin but cannot satisfy monitor wait', async () => {
  const result = await invokeWatch(
    { selector: SELECTOR, until: 'turn-finished', follow: true, timeoutMs: 1, fromSeq: 0 },
    createFixtureState({ activeTurnId: 'run-origin', events: [terminal('retained') as never] })
  )
  expect(result.events.some((event) => event['evidenceOrigin'] === 'retained')).toBe(true)
  expect(result.exitCode).toBe(20)
})

test('live catch-up without an origin can satisfy a wait armed below its sequence', async () => {
  const result = await invokeWatch(
    { selector: SELECTOR, until: 'turn-finished', follow: true, timeoutMs: 5, fromSeq: 0 },
    createFixtureState({ activeTurnId: 'run-origin', events: [terminal()] })
  )
  expect(result.exitCode).toBe(0)
})
