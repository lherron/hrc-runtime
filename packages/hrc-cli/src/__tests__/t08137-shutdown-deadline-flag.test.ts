import { afterAll, expect, test } from 'bun:test'

import { ServerShutdownTimeoutError, stopServerWithinDeadline } from '../cli/handlers-server'
import { installOldEngineDaemon } from './old-engine-daemon.js'

const oldEngineDaemon = installOldEngineDaemon()
afterAll(() => oldEngineDaemon.stop())

/**
 * T-08137 rev 4: when the foreground deadline fires, the lifecycle is marked
 * `shutdown_deadline_expired` synchronously BEFORE the rejection is observed,
 * so a stop() that finishes late (during the pidfile unlink before exit) can
 * never append server.stopped.
 */
test('the deadline marks the lifecycle expired before the timeout rejection is observed', async () => {
  const order: string[] = []
  const outcome = await stopServerWithinDeadline(
    () => new Promise<void>(() => undefined),
    25,
    () => order.push('expired')
  ).catch((error: unknown) => {
    order.push('rejected')
    return error
  })

  expect(outcome).toBeInstanceOf(ServerShutdownTimeoutError)
  expect(order).toEqual(['expired', 'rejected'])
})

test('a stop that settles in time never marks the deadline expired', async () => {
  let expired = false
  await stopServerWithinDeadline(
    () => Promise.resolve(),
    250,
    () => {
      expired = true
    }
  )
  await Bun.sleep(300)
  expect(expired).toBe(false)
})
