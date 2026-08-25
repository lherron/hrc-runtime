import { describe, expect, test } from 'bun:test'

import { CliUsageError } from 'cli-kit'
import type { HrcMonitorState } from 'hrc-core'
import { openHrcDatabase } from 'hrc-store-sqlite'

import {
  makeSeededFixture,
  ts,
} from '../../../hrc-server/src/__tests__/broker-event-mapper-fixtures'
import { MonitorWaitExit, cmdMonitorWait } from '../monitor/wait-command'
import { cmdMonitorWatch } from '../monitor/watch-command'

const TASK_ID = 'T-06575'
const OBSERVED_AT = '2026-07-18T20:00:00.000Z'

type RuntimeStatus =
  | 'ready'
  | 'idle'
  | 'busy'
  | 'awaiting_input'
  | 'dead'
  | 'stale'
  | 'terminated'
  | 'stopped'
  | 'failed'
  | 'disposed'
  | 'crashed'
  | 'exited'
  | 'starting'
  | 'stopping'
  | 'adopted'

type Member = {
  agent: string
  status: RuntimeStatus
  changedAt?: string | undefined
}

type MonitorRun = {
  exitCode: number
  stdout: string
  stderr: string
  stdoutEvents: Record<string, unknown>[]
  stderrEvents: Record<string, unknown>[]
}

function scopeRef(member: Member): string {
  return `agent:${member.agent}:project:hrc-runtime:task:${TASK_ID}`
}

function sessionRef(member: Member): string {
  return `${scopeRef(member)}/lane:main`
}

function runtimeId(member: Member): string {
  return `runtime-${member.agent}`
}

function hostSessionId(member: Member): string {
  return `host-${member.agent}`
}

function makeState(
  members: readonly Member[],
  events: Array<Record<string, unknown>> = []
): HrcMonitorState {
  return {
    daemon: { pid: 6575, status: 'healthy', startedAt: OBSERVED_AT },
    socket: { path: '/tmp/t06575.sock', responsive: true },
    tmux: { socketPath: '/tmp/t06575-tmux.sock', sessionCount: 0, windowCount: 0, paneCount: 0 },
    sessions: members.map((member) => ({
      sessionRef: sessionRef(member),
      scopeRef: scopeRef(member),
      laneRef: 'main',
      hostSessionId: hostSessionId(member),
      generation: 1,
      runtimeId: runtimeId(member),
      status: 'active',
      activeTurnId:
        member.status === 'busy' || member.status === 'awaiting_input'
          ? `turn-${member.agent}`
          : null,
      createdAt: OBSERVED_AT,
      updatedAt: OBSERVED_AT,
      ancestorScopeRefs: [],
    })),
    runtimes: members.map((member) => ({
      runtimeId: runtimeId(member),
      hostSessionId: hostSessionId(member),
      scopeRef: scopeRef(member),
      laneRef: 'main',
      generation: 1,
      transport: 'headless',
      harness: 'codex-cli',
      provider: 'openai',
      status: member.status,
      statusChangedAt: member.changedAt ?? OBSERVED_AT,
      supportsInflightInput: false,
      adopted: false,
      activeTurnId:
        member.status === 'busy' || member.status === 'awaiting_input'
          ? `turn-${member.agent}`
          : null,
      createdAt: OBSERVED_AT,
      updatedAt: OBSERVED_AT,
    })),
    messages: members.map((member, index) => ({
      messageId: `msg-${member.agent}`,
      messageSeq: 6575 + index,
      sessionRef: sessionRef(member),
      hostSessionId: hostSessionId(member),
      runtimeId: runtimeId(member),
      runId: `turn-${member.agent}`,
      scopeRef: scopeRef(member),
      laneRef: 'main',
      direction: 'outbound',
      sender: 'room-tester',
      body: 'test',
      createdAt: OBSERVED_AT,
    })),
    events: events as HrcMonitorState['events'],
  } as HrcMonitorState
}

function transitionEvent(member: Member, seq: number, event: string): Record<string, unknown> {
  return {
    seq,
    hrcSeq: seq,
    streamSeq: seq,
    ts: member.changedAt ?? OBSERVED_AT,
    event,
    eventKind: event,
    category: 'runtime',
    sessionRef: sessionRef(member),
    scopeRef: scopeRef(member),
    laneRef: 'main',
    hostSessionId: hostSessionId(member),
    generation: 1,
    runtimeId: runtimeId(member),
    result: member.status === 'dead' ? 'runtime_dead' : member.status,
  }
}

function jsonLines(text: string): Record<string, unknown>[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

async function invokeWatch(
  argv: string[],
  states: readonly HrcMonitorState[]
): Promise<MonitorRun> {
  const stdout: string[] = []
  const stderr: string[] = []
  let readIndex = 0
  let exitCode: number
  try {
    exitCode =
      (await cmdMonitorWatch(argv, {
        buildMonitorState: async () => states[Math.min(readIndex++, states.length - 1)]!,
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
      })) ?? 0
  } catch (error) {
    if (!(error instanceof CliUsageError)) throw error
    exitCode = 2
    stderr.push(`error: ${error.message}\n`)
  }
  const stdoutText = stdout.join('')
  const stderrText = stderr.join('')
  return {
    exitCode,
    stdout: stdoutText,
    stderr: stderrText,
    stdoutEvents: jsonLines(stdoutText),
    stderrEvents: jsonLines(stderrText),
  }
}

async function invokeWait(
  argv: string[],
  stateOrStates: HrcMonitorState | readonly HrcMonitorState[]
): Promise<MonitorRun> {
  const stdout: string[] = []
  const stderr: string[] = []
  const states = Array.isArray(stateOrStates) ? stateOrStates : [stateOrStates]
  const state = states[0]!
  let readIndex = 1
  const priorFixture = process.env['HRC_MONITOR_FIXTURE_STATE_JSON']
  const originalStdout = process.stdout.write
  const originalStderr = process.stderr.write
  process.env['HRC_MONITOR_FIXTURE_STATE_JSON'] = JSON.stringify(state)
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
      argv,
      Array.isArray(stateOrStates)
        ? {
            initialState: state,
            buildMonitorState: async () => states[Math.min(readIndex++, states.length - 1)]!,
          }
        : undefined
    )
  } catch (error) {
    if (error instanceof MonitorWaitExit) {
      exitCode = error.code
    } else if (error instanceof CliUsageError) {
      exitCode = 2
      stderr.push(`error: ${error.message}\n`)
    } else {
      throw error
    }
  } finally {
    process.stdout.write = originalStdout
    process.stderr.write = originalStderr
    if (priorFixture === undefined) process.env['HRC_MONITOR_FIXTURE_STATE_JSON'] = undefined
    else process.env['HRC_MONITOR_FIXTURE_STATE_JSON'] = priorFixture
  }

  const stdoutText = stdout.join('')
  const stderrText = stderr.join('')
  return {
    exitCode,
    stdout: stdoutText,
    stderr: stderrText,
    stdoutEvents: jsonLines(stdoutText),
    stderrEvents: jsonLines(stderrText),
  }
}

function lastEvent(run: MonitorRun): Record<string, unknown> {
  const event = run.stdoutEvents.at(-1)
  expect(event).toBeDefined()
  return event!
}

function expectNoDrainClaim(value: unknown): void {
  if (Array.isArray(value)) {
    for (const entry of value) expectNoDrainClaim(entry)
    return
  }
  if (value === null || typeof value !== 'object') return
  for (const [key, entry] of Object.entries(value)) {
    expect(['drainSafe', 'drained', 'stillTrue']).not.toContain(key)
    expectNoDrainClaim(entry)
  }
}

void transitionEvent
void expectNoDrainClaim

describe('T-06575 suite 6 — daemon single-cut integrity', () => {
  test('never assembles cross-cut state and keeps observation identity opaque', async () => {
    const fixture = await makeSeededFixture()
    const writer = openHrcDatabase(fixture.dbPath)
    try {
      const firstScope = `agent:cody:project:hrc-runtime:task:${TASK_ID}`
      fixture.db.sessions.insert({
        hostSessionId: 'host-cut-1',
        scopeRef: firstScope,
        laneRef: 'main',
        generation: 1,
        status: 'active',
        createdAt: ts(),
        updatedAt: ts(),
        ancestorScopeRefs: [],
      })
      fixture.db.runtimes.insert({
        runtimeId: 'runtime-cut-1',
        hostSessionId: 'host-cut-1',
        scopeRef: firstScope,
        laneRef: 'main',
        generation: 1,
        transport: 'headless',
        harness: 'codex-cli',
        provider: 'openai',
        status: 'idle',
        statusChangedAt: ts(1),
        supportsInflightInput: false,
        adopted: false,
        createdAt: ts(),
        updatedAt: ts(),
      })
      const secondScope = `agent:clod:project:hrc-runtime:task:${TASK_ID}`
      fixture.db.sessions.insert({
        hostSessionId: 'host-cut-2',
        scopeRef: secondScope,
        laneRef: 'main',
        generation: 1,
        status: 'active',
        createdAt: ts(),
        updatedAt: ts(),
        ancestorScopeRefs: [],
      })
      fixture.db.runtimes.insert({
        runtimeId: 'runtime-cut-2',
        hostSessionId: 'host-cut-2',
        scopeRef: secondScope,
        laneRef: 'main',
        generation: 1,
        transport: 'headless',
        harness: 'codex-cli',
        provider: 'openai',
        status: 'busy',
        statusChangedAt: ts(2),
        supportsInflightInput: false,
        adopted: false,
        createdAt: ts(),
        updatedAt: ts(),
      })

      const modulePath = '../../../hrc-server/src/monitor-condition-cut'
      const cutModule = (await import(modulePath)) as {
        readMonitorConditionCut: (
          db: typeof fixture.db,
          request: { selectors: string[]; quantifier: 'all'; conditions: string[] },
          hooks?: { afterMembershipRead?: () => void }
        ) => Promise<Record<string, unknown>> | Record<string, unknown>
      }
      const cut = await cutModule.readMonitorConditionCut(
        fixture.db,
        { selectors: [TASK_ID], quantifier: 'all', conditions: ['idle'] },
        {
          afterMembershipRead() {
            writer.runtimes.updateStatus('runtime-cut-2', 'idle', ts(3))
          },
        }
      )

      expect(cut).toMatchObject({
        observedAt: expect.any(String),
        members: expect.arrayContaining([
          expect.objectContaining({ runtimeId: 'runtime-cut-1', status: 'idle' }),
          expect.objectContaining({ runtimeId: 'runtime-cut-2', status: 'busy' }),
        ]),
      })
      expect(cut).not.toHaveProperty('hrcSeq')
      expect(cut).not.toHaveProperty('registryRevision')
      if (typeof cut['observationId'] === 'string') {
        expect(cut['observationId']).not.toMatch(/^\d+$/)
      }
    } finally {
      writer.close()
      await fixture.cleanup()
    }
  })
})

describe('T-06575 suite 7 — verb parity', () => {
  test('keeps replay condition-free and gives blocking watch/wait the same arm and final schema', async () => {
    const idle = { agent: 'cody', status: 'idle', changedAt: ts(7) } satisfies Member
    const state = makeState([idle])
    const selector = `scope:${scopeRef(idle)}`
    const replay = await invokeWatch([selector, '--format', 'ndjson'], [state])
    expect(replay.exitCode).toBe(0)
    expect(replay.stdoutEvents.some((event) => event['event'] === 'monitor.armed')).toBe(false)
    expect(replay.stdoutEvents.some((event) => event['event'] === 'monitor.completed')).toBe(false)

    const watch = await invokeWatch(
      [selector, '--follow', '--until', 'idle', '--format', 'ndjson'],
      [state]
    )
    const wait = await invokeWait([selector, '--until', 'idle', '--json'], state)
    expect(watch.exitCode).toBe(10)
    expect(wait.exitCode).toBe(10)
    expect(Object.keys(lastEvent(watch)).sort()).toEqual(Object.keys(lastEvent(wait)).sort())
    expect(watch.stderrEvents.map((event) => Object.keys(event).sort())).toEqual(
      wait.stderrEvents.map((event) => Object.keys(event).sort())
    )
  })

  test.each([
    [[TASK_ID, '--until', 'idle'], false],
    [[TASK_ID, '--until-any', 'idle'], true],
    [[TASK_ID, '--until-all', 'turn-finished'], false],
  ] as const)(
    'rejects legality row %j identically across watch and wait',
    async (args, accepted) => {
      const state = makeState([{ agent: 'cody', status: 'busy' }])
      const watch = await invokeWatch(
        [...args, '--follow', '--timeout', '5ms', '--format', 'ndjson'],
        [state]
      )
      const wait = await invokeWait([...args, '--timeout', '5ms', '--json'], state)
      expect(watch.exitCode === 2).toBe(!accepted)
      expect(wait.exitCode === 2).toBe(!accepted)
      if (!accepted) {
        expect(watch.stderr.replace(/^error:\s*/, '')).toBe(wait.stderr.replace(/^error:\s*/, ''))
      }
    }
  )
})
