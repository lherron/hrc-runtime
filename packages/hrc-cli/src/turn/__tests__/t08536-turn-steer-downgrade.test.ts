/**
 * T-08536 — `hrc turn` surfaces a steer the server downgraded to enqueue: a
 * stderr notice on every output mode, the fields on the JSON response line,
 * and the watch follows the enqueued RUN (the seat's next terminal may be the
 * turn it waits behind).
 */
import { afterAll, describe, expect, it } from 'bun:test'
import type { HrcLifecycleEvent } from 'hrc-core'
import type { HrcClient, WatchOptions } from 'hrc-sdk'

import { installOldEngineDaemon } from '../../__tests__/old-engine-daemon.js'
import {
  createTurnClient,
  makeLifecycleEvent,
  makeSteerResponse,
  runTurnCommand,
} from './turn-test-harness.js'

const oldEngineDaemon = installOldEngineDaemon()
afterAll(() => oldEngineDaemon.stop())

describe('hrc turn — steer downgraded to enqueue (T-08536)', () => {
  it('a steer downgraded to enqueue follows its own RUN and says so on stderr', async () => {
    let capturedWatchOptions: WatchOptions | undefined
    const client = {
      ...createTurnClient({
        sessionFound: true,
        steer: makeSteerResponse({
          effectiveDoor: 'enqueue',
          requestedDoor: 'steer',
          downgradeReason: 'steer_not_supported',
        }),
      }),
      async *watch(options?: WatchOptions): AsyncIterable<HrcLifecycleEvent> {
        capturedWatchOptions = options
        yield makeLifecycleEvent({ eventKind: 'turn.completed', runId: 'run-steer', hrcSeq: 501 })
      },
    } as HrcClient

    const result = await runTurnCommand(client, { format: 'ndjson' }, ['cody@agent-spaces', 'now'])

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toContain(
      'notice: steer downgraded to enqueue (steer_not_supported): the message runs after the current turn'
    )
    expect(capturedWatchOptions?.runId).toBe('run-steer')
  })

  it('--wait final prints the downgrade fields and the notice', async () => {
    const client = createTurnClient({
      sessionFound: true,
      steer: makeSteerResponse({
        stage: 'terminal',
        effectiveDoor: 'enqueue',
        requestedDoor: 'steer',
        downgradeReason: 'steer_not_supported',
        disposition: { type: 'executed', turnId: 'turn-queued' },
        terminal: { turnId: 'turn-queued', status: 'completed', finalMessage: 'AFTER' },
      }),
    })

    const result = await runTurnCommand(client, { wait: 'final' }, ['cody@agent-spaces', 'x'])

    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({
      effectiveDoor: 'enqueue',
      requestedDoor: 'steer',
      downgradeReason: 'steer_not_supported',
      terminal: { finalMessage: 'AFTER' },
    })
    expect(result.stderr).toContain('steer downgraded to enqueue')
  })

  it('prints no notice for an undowngraded steer — the control', async () => {
    const client = createTurnClient({
      sessionFound: true,
      steer: makeSteerResponse({ stage: 'terminal', effectiveDoor: 'steer' }),
    })
    const result = await runTurnCommand(client, { wait: 'final' }, ['cody@agent-spaces', 'x'])
    expect(result.stderr).not.toContain('downgraded')
  })
})
