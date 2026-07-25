import { describe, expect, test } from 'bun:test'
import type { HrcMonitorState } from 'hrc-core'

import { cmdMonitorWatch } from '../monitor-watch.js'

const BASE = 'agent:observer:project:hrc-runtime:task:T-05113'
const VERIFY = `${BASE}:role:verify`
const RED = `${BASE}:role:red`

function fixture(): HrcMonitorState {
  return {
    sessions: [
      {
        sessionRef: `${VERIFY}/lane:main`,
        scopeRef: VERIFY,
        laneRef: 'main',
        hostSessionId: 'host-verify',
        generation: 2,
        runtimeId: 'runtime-verify',
        status: 'active',
        activeTurnId: 'run-verify',
      },
      {
        sessionRef: `${RED}/lane:main`,
        scopeRef: RED,
        laneRef: 'main',
        hostSessionId: 'host-red',
        generation: 1,
        runtimeId: 'runtime-red',
        status: 'active',
        activeTurnId: null,
      },
    ],
    runtimes: [
      {
        runtimeId: 'runtime-verify',
        hostSessionId: 'host-verify',
        status: 'busy',
        transport: 'headless',
        activeTurnId: 'run-verify',
      },
      {
        runtimeId: 'runtime-red',
        hostSessionId: 'host-red',
        status: 'idle',
        transport: 'headless',
        activeTurnId: null,
      },
    ],
    events: [
      {
        seq: 501,
        event: 'runtime.busy',
        scopeRef: VERIFY,
        sessionRef: `${VERIFY}/lane:default`,
        laneRef: 'default',
        hostSessionId: 'host-verify',
        runtimeId: 'runtime-verify',
      },
      {
        seq: 502,
        event: 'runtime.idle',
        scopeRef: RED,
        sessionRef: `${RED}/lane:main`,
        laneRef: 'main',
        hostSessionId: 'host-red',
        runtimeId: 'runtime-red',
      },
    ],
    eventGlobalHighWaterSeq: 700,
  }
}

async function run(
  selector: string,
  state: HrcMonitorState,
  options: { follow?: boolean; until?: string } = {}
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const stdout: string[] = []
  const stderr: string[] = []
  const exitCode = await cmdMonitorWatch(
    {
      selector,
      fromSeq: options.follow ? undefined : 1,
      follow: options.follow,
      until: options.until,
      timeoutMs: 50,
      format: 'ndjson',
    },
    {
      buildMonitorState: async () => state,
      stdout: {
        write(chunk) {
          stdout.push(chunk)
          return true
        },
      },
      stderr: {
        write(chunk) {
          stderr.push(chunk)
          return true
        },
      },
    }
  )
  return { exitCode: exitCode ?? 0, stdout: stdout.join(''), stderr: stderr.join('') }
}

describe('monitor role-tree CLI paths (T-05113)', () => {
  test('exact slash-role watch replays only the role runtime', async () => {
    const result = await run('observer@hrc-runtime:T-05113/verify', fixture())

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout).toContain('"runtimeId":"runtime-verify"')
    expect(result.stdout).not.toContain('"runtimeId":"runtime-red"')
  })

  test('role-less watch replays immediate role-child events', async () => {
    const result = await run('observer@hrc-runtime:T-05113', fixture())

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('"runtimeId":"runtime-verify"')
    expect(result.stdout).toContain('"runtimeId":"runtime-red"')
  })

  test('condition follow rejects an ambiguous role-less selector with actionable detail', async () => {
    const result = await run('observer@hrc-runtime:T-05113', fixture(), {
      follow: true,
      until: 'idle',
    })

    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain('ambiguous monitor selector')
    expect(result.stderr).toContain('exact slash-role handle')
  })
})
