/** T-08566 X5/F0y: monitor renders retained rows but never uses them as authority. */
import { expect, test } from 'bun:test'
import { MonitorWaitExit, cmdMonitorWait } from '../monitor/wait-command'
import { SELECTOR, createFixtureState, event, invokeWatch } from './fixtures/cli-test-fixture'

type FixtureState = ReturnType<typeof createFixtureState>

function terminal(origin?: 'retained', seq = 41) {
  const row = event(seq, 'turn.completed', {
    runId: 'run-origin',
    turnId: 'run-origin',
    payload: { success: true },
  })
  return origin ? ({ ...row, evidenceOrigin: origin } as never) : row
}

async function invokeWait(
  states: readonly FixtureState[],
  options: { since?: number; timeout?: string } = {}
) {
  const stdout: string[] = []
  const stderr: string[] = []
  const originalStdoutWrite = process.stdout.write
  const originalStderrWrite = process.stderr.write
  const servedStateIndexes: number[] = []
  let nextStateIndex = 1
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
    return true
  }) as typeof process.stdout.write
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
    return true
  }) as typeof process.stderr.write

  let exitCode = 0
  try {
    await cmdMonitorWait(
      [
        SELECTOR,
        '--until',
        'turn-finished',
        '--since',
        String(options.since ?? 41),
        '--timeout',
        options.timeout ?? '20ms',
        '--json',
      ],
      {
        initialState: states[0] as never,
        buildMonitorState: async () => {
          const index = Math.min(nextStateIndex++, states.length - 1)
          servedStateIndexes.push(index)
          return states[index] as never
        },
      }
    )
  } catch (error) {
    if (error instanceof MonitorWaitExit) exitCode = error.code
    else throw error
  } finally {
    process.stdout.write = originalStdoutWrite
    process.stderr.write = originalStderrWrite
  }
  return {
    exitCode,
    stdout: stdout.join(''),
    stderr: stderr.join(''),
    servedStateIndexes,
  }
}

test('watch renders a live terminal (positive control)', async () => {
  const result = await invokeWatch(
    { selector: SELECTOR, follow: false },
    createFixtureState({ activeTurnId: 'run-origin', events: [terminal()] })
  )
  expect(result.exitCode).toBe(0)
  expect(result.events.some((entry) => entry['event'] === 'turn.completed')).toBe(true)
})

test('watch preserves retained evidence origin while rendering', async () => {
  const result = await invokeWatch(
    { selector: SELECTOR, follow: false },
    createFixtureState({ activeTurnId: 'run-origin', events: [terminal('retained')] })
  )
  expect(result.exitCode).toBe(0)
  expect(result.events.some((entry) => entry['evidenceOrigin'] === 'retained')).toBe(true)
})

test('monitor wait --since accepts an unmarked pre-arm terminal at the fence', async () => {
  const state = createFixtureState({ activeTurnId: 'run-origin', events: [terminal()] })
  expect((await invokeWait([state])).exitCode).toBe(0)
})

test('monitor wait --since cannot accept the identical retained pre-arm terminal', async () => {
  const state = createFixtureState({
    activeTurnId: 'run-origin',
    events: [terminal('retained')],
  })
  expect((await invokeWait([state])).exitCode).toBe(20)
})

test('monitor wait follows past a retained terminal and completes only on a later live terminal', async () => {
  const started = event(40, 'turn.started', {
    runId: 'run-origin',
    turnId: 'run-origin',
  })
  const initial = createFixtureState({ activeTurnId: 'run-origin', events: [started] })
  const withRetained = createFixtureState({
    activeTurnId: 'run-origin',
    events: [started, terminal('retained')],
  })
  const withLive = createFixtureState({
    activeTurnId: 'run-origin',
    events: [started, terminal('retained'), terminal(undefined, 42)],
  })
  const result = await invokeWait([initial, withRetained, withLive], { timeout: '1s' })
  expect(result.exitCode).toBe(0)
  expect(result.servedStateIndexes).toContain(2)
})
