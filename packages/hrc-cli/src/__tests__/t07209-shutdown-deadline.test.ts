import { expect, test } from 'bun:test'

import { ServerShutdownTimeoutError, stopServerWithinDeadline } from '../cli/handlers-server'

test('foreground shutdown rejects within its deadline when server.stop never settles', async () => {
  const timeoutMs = 25
  const startedAt = performance.now()

  const outcome = await stopServerWithinDeadline(
    () => new Promise<void>(() => undefined),
    timeoutMs
  ).then(
    () => ({ kind: 'resolved' as const }),
    (error: unknown) => ({ kind: 'rejected' as const, error })
  )

  expect(outcome.kind).toBe('rejected')
  if (outcome.kind !== 'rejected') return
  expect(outcome.error).toBeInstanceOf(ServerShutdownTimeoutError)
  expect((outcome.error as ServerShutdownTimeoutError).timeoutMs).toBe(timeoutMs)
  expect(performance.now() - startedAt).toBeLessThan(500)
})

test('foreground shutdown preserves an immediate server.stop failure', async () => {
  const failure = new Error('cleanup failed')

  const outcome = await stopServerWithinDeadline(() => Promise.reject(failure), 250).catch(
    (error: unknown) => error
  )

  expect(outcome).toBe(failure)
})
