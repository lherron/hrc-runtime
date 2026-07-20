import { describe, expect, test } from 'bun:test'

import { CliUsageError } from 'cli-kit'
import type { HrcMonitorState } from 'hrc-core'
import { openHrcDatabase } from 'hrc-store-sqlite'
import { RUNTIME_STATUS_LEVEL_BY_STATUS } from '../../../hrc-core/src/monitor/status-levels'

import {
  RUNTIME_ID,
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

async function invokeWait(argv: string[], state: HrcMonitorState): Promise<MonitorRun> {
  const stdout: string[] = []
  const stderr: string[] = []
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
    await cmdMonitorWait(argv)
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

describe('T-06575 suite 1 — dynamic set join', () => {
  test.each([
    ['zero-member arm', []],
    ['one-member arm', [{ agent: 'cody', status: 'busy' } satisfies Member]],
  ])('--until-any arms a task set at %s and admits a later scope', async (_label, initial) => {
    const joined = {
      agent: 'clod',
      status: 'idle',
      changedAt: '2026-07-18T20:01:00.000Z',
    } satisfies Member
    const run = await invokeWatch(
      [TASK_ID, '--follow', '--until-any', 'idle', '--timeout', '800ms', '--format', 'ndjson'],
      [
        makeState(initial),
        makeState([...initial, joined], [transitionEvent(joined, 1, 'runtime.idle')]),
      ]
    )

    expect(run.exitCode).toBe(0)
    expect(lastEvent(run)).toMatchObject({
      quantifier: 'any',
      matchedCondition: 'idle',
      scopeRef: scopeRef(joined),
      phase: 'after-arm',
    })
  })
})

describe('T-06575 suite 2 — aggregate seeding', () => {
  test('seeds already-idle members, blocks on busy members, and classifies all-idle arm truth', async () => {
    const idle = {
      agent: 'cody',
      status: 'idle',
      changedAt: '2026-07-18T19:55:00.000Z',
    } satisfies Member
    const busy = {
      agent: 'clod',
      status: 'busy',
      changedAt: '2026-07-18T19:59:00.000Z',
    } satisfies Member
    const becameIdle = {
      ...busy,
      status: 'idle',
      changedAt: '2026-07-18T20:02:00.000Z',
    } satisfies Member
    const mixed = await invokeWatch(
      [TASK_ID, '--follow', '--until-all', 'idle', '--timeout', '800ms', '--format', 'ndjson'],
      [
        makeState([idle, busy]),
        makeState([idle, becameIdle], [transitionEvent(becameIdle, 1, 'runtime.idle')]),
      ]
    )
    expect(mixed.exitCode).toBe(0)
    expect(lastEvent(mixed)).toMatchObject({ quantifier: 'all', matchedCondition: 'idle' })

    const allIdle = await invokeWatch(
      [TASK_ID, '--follow', '--until-all', 'idle', '--timeout', '800ms', '--format', 'ndjson'],
      [makeState([idle, becameIdle])]
    )
    expect(allIdle.exitCode).toBe(10)
    expect(allIdle.stderr).toMatch(/all are already idle.*last one went idle/i)
  })
})

describe('T-06575 suite 3 — OR×ALL aggregate output', () => {
  test('reports heterogeneous per-scope matches and only observational schema fields', async () => {
    const busy = { agent: 'cody', status: 'busy' } satisfies Member
    const dead = { agent: 'clod', status: 'dead' } satisfies Member
    const run = await invokeWatch(
      [
        TASK_ID,
        '--follow',
        '--until-all',
        'busy',
        '--until-all',
        'runtime-dead',
        '--format',
        'ndjson',
      ],
      [makeState([busy, dead])]
    )

    expect(run.exitCode).toBe(10)
    const completed = lastEvent(run)
    expect(completed).toMatchObject({
      quantifier: 'all',
      observedAt: expect.any(String),
      members: expect.arrayContaining([
        expect.objectContaining({ scopeRef: scopeRef(busy), matchedCondition: 'busy' }),
        expect.objectContaining({ scopeRef: scopeRef(dead), matchedCondition: 'runtime-dead' }),
      ]),
    })
    expectNoDrainClaim(completed)
  })
})

describe('T-06575 suite 4 — temporal truth', () => {
  test('classifies every status and preserves causal statusChangedAt independently of housekeeping clocks', async () => {
    expect(RUNTIME_STATUS_LEVEL_BY_STATUS).toEqual({
      ready: 'idle',
      idle: 'idle',
      busy: 'busy',
      awaiting_input: 'busy',
      dead: 'runtime-dead',
      stale: 'runtime-dead',
      terminated: 'runtime-dead',
      stopped: 'runtime-dead',
      failed: 'runtime-dead',
      disposed: 'runtime-dead',
      crashed: 'runtime-dead',
      exited: 'runtime-dead',
      starting: null,
      stopping: null,
      adopted: null,
    })

    const fixture = await makeSeededFixture()
    try {
      const legacy = fixture.db.runtimes.getByRuntimeId(RUNTIME_ID)!
      expect(legacy.statusChangedAt).toBe('unknown')
      expect(legacy.statusChangedAt).not.toBe(legacy.lastActivityAt)
      expect(legacy.statusChangedAt).not.toBe(legacy.updatedAt)

      for (const [status, changedAt] of [
        ['busy', ts(4)],
        ['awaiting_input', ts(5)],
        ['busy', ts(6)],
        ['ready', ts(7)],
        ['dead', ts(8)],
      ] as const) {
        expect(fixture.db.runtimes.updateStatus(RUNTIME_ID, status, changedAt)).toMatchObject({
          status,
          statusChangedAt: changedAt,
        })
      }

      fixture.db.runtimes.update(RUNTIME_ID, {
        status: 'dead',
        statusChangedAt: ts(99),
        lastActivityAt: ts(98),
        updatedAt: ts(100),
      })
      expect(fixture.db.runtimes.getByRuntimeId(RUNTIME_ID)).toMatchObject({
        status: 'dead',
        statusChangedAt: ts(8),
        lastActivityAt: ts(98),
        updatedAt: ts(100),
      })
    } finally {
      await fixture.cleanup()
    }
  })
})

describe('T-06575 suite 5 — exit codes and grammar legality', () => {
  test('exports the frozen nine-code table, including distinct context and observer failures', async () => {
    const modulePath = '../monitor/exit-codes'
    const monitorExits = (await import(modulePath)) as {
      MONITOR_EXIT_CODES: Record<string, number>
    }
    expect(monitorExits.MONITOR_EXIT_CODES).toEqual({
      matchedAfterArm: 0,
      usage: 2,
      alreadyTrueAtArm: 10,
      noSessionEver: 11,
      runtimeDeathObstruction: 12,
      timeout: 20,
      stall: 21,
      contextChange: 22,
      monitorError: 23,
    })
  })

  test.each([
    [
      'named death, exact, at arm',
      ['--until', 'runtime-dead'],
      [{ agent: 'cody', status: 'dead' }],
      10,
    ],
    [
      'named death, exact, after arm',
      ['--until', 'runtime-dead'],
      [{ agent: 'cody', status: 'busy' }],
      0,
    ],
    ['unnamed death, exact, at arm', ['--until', 'idle'], [{ agent: 'cody', status: 'dead' }], 12],
    [
      'unnamed death, exact, after arm',
      ['--until', 'idle'],
      [{ agent: 'cody', status: 'busy' }],
      12,
    ],
    [
      'named death, ALL, at arm',
      ['--until-all', 'runtime-dead'],
      [{ agent: 'cody', status: 'dead' }],
      10,
    ],
    [
      'named death, ALL, after arm',
      ['--until-all', 'runtime-dead'],
      [{ agent: 'cody', status: 'busy' }],
      0,
    ],
    [
      'unnamed death, ALL, at arm',
      ['--until-all', 'idle'],
      [{ agent: 'cody', status: 'dead' }],
      12,
    ],
    [
      'unnamed death, ALL, after arm',
      ['--until-all', 'idle'],
      [{ agent: 'cody', status: 'busy' }],
      12,
    ],
    [
      'named death, ANY, at arm',
      ['--until-any', 'runtime-dead'],
      [{ agent: 'cody', status: 'dead' }],
      10,
    ],
    [
      'named death, ANY, after arm',
      ['--until-any', 'runtime-dead'],
      [{ agent: 'cody', status: 'busy' }],
      0,
    ],
    [
      'unnamed death is local under ANY, at arm',
      ['--until-any', 'idle'],
      [{ agent: 'cody', status: 'dead' }],
      0,
    ],
    [
      'unnamed death is local under ANY, after arm',
      ['--until-any', 'idle'],
      [{ agent: 'cody', status: 'busy' }],
      0,
    ],
  ] as const)('%s', async (_label, flags, initialMembers, expectedExit) => {
    const initial = initialMembers.map((member) => ({ ...member }) satisfies Member)
    const initialMember = initial[0]!
    const finalMember =
      flags[1] === 'runtime-dead'
        ? ({ ...initialMember, status: 'dead', changedAt: ts(10) } satisfies Member)
        : flags[0] === '--until-any'
          ? ({ agent: 'clod', status: 'idle', changedAt: ts(10) } satisfies Member)
          : ({ ...initialMember, status: 'dead', changedAt: ts(10) } satisfies Member)
    const finalMembers =
      flags[0] === '--until-any' && flags[1] === 'idle' ? [...initial, finalMember] : [finalMember]
    const finalEventName = finalMember.status === 'idle' ? 'runtime.idle' : 'runtime.dead'
    const selector = flags[0] === '--until' ? `scope:${scopeRef(initialMember)}` : TASK_ID
    const run = await invokeWatch(
      [selector, '--follow', ...flags, '--timeout', '800ms', '--format', 'ndjson'],
      [
        makeState(initial),
        makeState(finalMembers, [transitionEvent(finalMember, 1, finalEventName)]),
      ]
    )
    expect(run.exitCode).toBe(expectedExit)
  })

  test.each([
    ['msg:msg-cody', ['--until', 'response'], true],
    ['seq:6575', ['--until', 'response'], true],
    ['cody@hrc-runtime:T-06575', ['--until', 'busy'], true],
    [`scope:${scopeRef({ agent: 'cody', status: 'busy' })}`, ['--until', 'busy'], true],
    [`runtime:${runtimeId({ agent: 'cody', status: 'busy' })}`, ['--until', 'busy'], true],
    [`host:${hostSessionId({ agent: 'cody', status: 'busy' })}`, ['--until', 'busy'], true],
    [`session:${sessionRef({ agent: 'cody', status: 'busy' })}`, ['--until', 'busy'], true],
    [TASK_ID, ['--until', 'idle'], false],
    [TASK_ID, ['--until-any', 'idle'], true],
    [TASK_ID, ['--until-all', 'idle'], true],
    [TASK_ID, ['--until-any', 'response'], false],
    [TASK_ID, ['--until-all', 'turn-finished'], false],
  ] as const)(
    'applies the frozen legality row for %s %j in both verbs',
    async (selector, flags, accepted) => {
      const state = makeState([{ agent: 'cody', status: 'busy' }])
      const watch = await invokeWatch(
        [selector, '--follow', ...flags, '--timeout', '5ms', '--format', 'ndjson'],
        [state]
      )
      const wait = await invokeWait([selector, ...flags, '--timeout', '5ms', '--json'], state)
      expect(watch.exitCode === 2).toBe(!accepted)
      expect(wait.exitCode === 2).toBe(!accepted)
    }
  )

  test('uses the explicit default OR pair for the local C-0004 projection', async () => {
    const busy = { agent: 'cody', status: 'busy' } satisfies Member
    const dead = { ...busy, status: 'dead', changedAt: ts(10) } satisfies Member
    const run = await invokeWatch(
      [`scope:${scopeRef(busy)}`, '--follow', '--timeout', '800ms', '--format', 'ndjson'],
      [makeState([busy]), makeState([dead], [transitionEvent(dead, 1, 'runtime.dead')])]
    )
    expect(run.exitCode).toBe(0)
    expect(lastEvent(run)).toMatchObject({ conditions: ['turn-finished', 'runtime-dead'] })
    // T-06675: the former second half read agent-loop's C-0004 artifacts from
    // a sibling checkout. That migration is agent-loop-owned and is not a
    // portable HRC test dependency. The HRC-owned OR-pair behavior remains
    // pinned above at the actual monitor projection seam.
  })
})

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
