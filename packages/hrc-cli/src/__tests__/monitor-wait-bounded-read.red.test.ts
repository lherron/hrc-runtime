import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { HrcClient } from 'hrc-sdk'
import { openHrcDatabase } from 'hrc-store-sqlite'
import { MonitorWaitExit, cmdMonitorWait } from '../monitor-wait'

const TASK_ID = 'T-90001'
const SCOPE_REF = `agent:test:project:hrc-runtime:task:${TASK_ID}`
const SESSION_REF = `${SCOPE_REF}/lane:main`
const HOST_SESSION_ID = 'hsid-wait-bounded'
const RUNTIME_ID = 'rt-wait-bounded'
const MESSAGE_ID = 'msg-wait-bounded'
const RUN_ID = 'run-wait-bounded'
const session = {
  hostSessionId: HOST_SESSION_ID,
  scopeRef: SCOPE_REF,
  laneRef: 'main',
  generation: 1,
  status: 'active',
  createdAt: '2026-07-18T12:00:00.000Z',
  updatedAt: '2026-07-18T12:00:00.000Z',
  ancestorScopeRefs: [],
}

const runtime = {
  runtimeId: RUNTIME_ID,
  hostSessionId: HOST_SESSION_ID,
  scopeRef: SCOPE_REF,
  laneRef: 'main',
  generation: 1,
  transport: 'headless',
  harness: 'codex',
  provider: 'openai',
  status: 'ready',
  supportsInflightInput: true,
  adopted: false,
  activeRunId: null,
  createdAt: '2026-07-18T12:00:00.000Z',
  updatedAt: '2026-07-18T12:00:00.000Z',
}

const message = {
  messageId: MESSAGE_ID,
  messageSeq: 77,
  createdAt: '2026-07-18T12:00:00.000Z',
  kind: 'dm',
  phase: 'response',
  from: { kind: 'entity', entity: 'system' },
  to: { kind: 'session', sessionRef: SESSION_REF },
  rootMessageId: MESSAGE_ID,
  body: 'bounded wait fixture',
  bodyFormat: 'text',
  execution: {
    state: 'completed',
    sessionRef: SESSION_REF,
    hostSessionId: HOST_SESSION_ID,
    generation: 1,
    runtimeId: RUNTIME_ID,
    runId: RUN_ID,
  },
}

const status = {
  ok: true,
  uptime: 1,
  startedAt: '2026-07-18T12:00:00.000Z',
  runtimeRoot: '/tmp/hrc-runtime',
  stateRoot: '/tmp/hrc-state',
  socketPath: '/tmp/hrc-runtime/hrc.sock',
  dbPath: ':memory:',
  cwd: '/tmp',
  binaryPath: '/tmp/hrc-server',
  packagePath: '/tmp/hrc-server-package',
  sessionCount: 6_738,
  runtimeCount: 8_666,
  apiVersion: 'v1',
  capabilities: {
    semanticCore: {},
    platform: {},
    bridgeDelivery: {},
    backend: { tmux: { available: false } },
  },
}

type Restorable = { mockRestore(): void }
const restored: Restorable[] = []
let stateRoot = ''
let originalStateDir: string | undefined

const prototypeDb = openHrcDatabase(':memory:')
const messageRepositoryPrototype = Object.getPrototypeOf(
  prototypeDb.messages
) as typeof prototypeDb.messages
const runtimeRepositoryPrototype = Object.getPrototypeOf(
  prototypeDb.runtimes
) as typeof prototypeDb.runtimes
const lifecycleRepositoryPrototype = Object.getPrototypeOf(
  prototypeDb.hrcEvents
) as typeof prototypeDb.hrcEvents
prototypeDb.close()

function track<T extends Restorable>(mock: T): T {
  restored.push(mock)
  return mock
}

function appendLifecycleEvent(eventKind: string, scopeRef = SCOPE_REF): number {
  const db = openHrcDatabase(join(stateRoot, 'state.sqlite'))
  try {
    return db.hrcEvents.append({
      ts: '2026-07-18T12:00:01.000Z',
      hostSessionId: HOST_SESSION_ID,
      scopeRef,
      laneRef: 'main',
      generation: 1,
      runtimeId: RUNTIME_ID,
      runId: RUN_ID,
      category: eventKind.startsWith('runtime.') ? 'runtime' : 'turn',
      eventKind,
      payload: eventKind === 'turn.completed' ? { success: true } : {},
    }).hrcSeq
  } finally {
    db.close()
  }
}

async function runWait(args: string[]): Promise<number> {
  try {
    await cmdMonitorWait([...args, '--json'])
  } catch (error) {
    if (error instanceof MonitorWaitExit) return error.code
    throw error
  }
  throw new Error('cmdMonitorWait did not report an exit code')
}

function installTargetedSpies() {
  const getStatus = track(
    spyOn(HrcClient.prototype, 'getStatus').mockImplementation(
      async () => ({ ...status, dbPath: join(stateRoot, 'state.sqlite') }) as never
    )
  )
  const resolveSession = track(
    spyOn(HrcClient.prototype, 'resolveSession').mockImplementation(
      async () =>
        ({
          found: true,
          hostSessionId: HOST_SESSION_ID,
          generation: 1,
          created: false,
          session,
        }) as never
    )
  )
  const inspectRuntime = track(
    spyOn(HrcClient.prototype, 'inspectRuntime').mockImplementation(
      async () =>
        ({
          ...runtime,
          createdAgeSec: 1,
          lastActivityAt: null,
          lastActivityAgeSec: null,
          wrapperPid: null,
          childPid: null,
          continuation: null,
          continuationKey: null,
          continuationStale: false,
        }) as never
    )
  )
  const getMessageById = track(spyOn(messageRepositoryPrototype, 'getById'))
  return { getStatus, resolveSession, inspectRuntime, getMessageById }
}

function captureForbiddenReads() {
  const fullSessionSql: string[] = []
  const originalQuery = Database.prototype.query
  const query = track(
    spyOn(Database.prototype, 'query').mockImplementation(function (sql: string) {
      if (/FROM\s+sessions\s+ORDER\s+BY\s+scope_ref/i.test(sql)) fullSessionSql.push(sql)
      return originalQuery.call(this, sql)
    })
  )
  const listAll = track(spyOn(runtimeRepositoryPrototype, 'listAll'))
  const queryMessages = track(spyOn(messageRepositoryPrototype, 'query'))
  const listFromHrcSeq = track(spyOn(lifecycleRepositoryPrototype, 'listFromHrcSeq'))
  return { fullSessionSql, query, listAll, queryMessages, listFromHrcSeq }
}

function expectNoFullReads(forbidden: ReturnType<typeof captureForbiddenReads>): void {
  expect(forbidden.fullSessionSql).toEqual([])
  expect(forbidden.listAll).not.toHaveBeenCalled()
  expect(forbidden.queryMessages).not.toHaveBeenCalled()
  expect(forbidden.listFromHrcSeq).not.toHaveBeenCalled()
}

beforeEach(() => {
  originalStateDir = process.env['HRC_STATE_DIR']
  stateRoot = mkdtempSync(join(tmpdir(), 'hrc-monitor-wait-bounded-'))
  process.env['HRC_STATE_DIR'] = stateRoot
  const db = openHrcDatabase(join(stateRoot, 'state.sqlite'))
  try {
    db.sessions.insert(session as never)
    db.runtimes.insert(runtime as never)
    db.messages.insert({
      messageId: MESSAGE_ID,
      kind: 'dm',
      phase: 'response',
      from: { kind: 'entity', entity: 'system' },
      to: { kind: 'session', sessionRef: SESSION_REF },
      body: 'bounded wait fixture',
      execution: message.execution as never,
    })
  } finally {
    db.close()
  }
  track(spyOn(process.stdout, 'write').mockImplementation(() => true))
})

afterEach(() => {
  while (restored.length > 0) restored.pop()?.mockRestore()
  if (originalStateDir === undefined) Reflect.deleteProperty(process.env, 'HRC_STATE_DIR')
  else process.env['HRC_STATE_DIR'] = originalStateDir
  rmSync(stateRoot, { recursive: true, force: true })
})

describe('Bundle 1 — monitor wait bounded live reads', () => {
  it('applies --timeout as a hard ceiling to the initial daemon read', async () => {
    track(spyOn(HrcClient.prototype, 'getStatus').mockImplementation(() => new Promise(() => {})))
    const startedAt = performance.now()

    expect(await runWait([`runtime:${RUNTIME_ID}`, '--until', 'idle', '--timeout', '20ms'])).toBe(1)
    expect(performance.now() - startedAt).toBeLessThan(250)
  })

  it('uses targeted message state and a high-water-anchored filtered read', async () => {
    const targeted = installTargetedSpies()
    const forbidden = captureForbiddenReads()
    const maxHrcSeq = track(spyOn(lifecycleRepositoryPrototype, 'maxHrcSeq'))
    const filtered = track(spyOn(lifecycleRepositoryPrototype, 'listFromHrcSeqFiltered'))

    expect(await runWait([`msg:${MESSAGE_ID}`, '--until', 'response', '--timeout', '25ms'])).toBe(0)

    expectNoFullReads(forbidden)
    expect(targeted.getStatus).toHaveBeenCalledWith({ includeSessions: false })
    expect(targeted.getMessageById).toHaveBeenCalledWith(MESSAGE_ID)
    expect(maxHrcSeq).toHaveBeenCalled()
    expect(filtered).toHaveBeenCalled()
  })

  it('uses targeted runtime state without full sessions, runtimes, messages, or events', async () => {
    const targeted = installTargetedSpies()
    const forbidden = captureForbiddenReads()
    const maxHrcSeq = track(spyOn(lifecycleRepositoryPrototype, 'maxHrcSeq'))
    const filtered = track(spyOn(lifecycleRepositoryPrototype, 'listFromHrcSeqFiltered'))

    expect(await runWait([`runtime:${RUNTIME_ID}`, '--until', 'idle', '--timeout', '25ms'])).toBe(0)

    expectNoFullReads(forbidden)
    expect(targeted.getStatus).toHaveBeenCalledWith({ includeSessions: false })
    expect(targeted.inspectRuntime).toHaveBeenCalledWith({ runtimeId: RUNTIME_ID })
    expect(maxHrcSeq).toHaveBeenCalled()
    expect(filtered).toHaveBeenCalled()
  })

  it('narrows a task selector in SQLite without full collection materialization', async () => {
    const targeted = installTargetedSpies()
    const forbidden = captureForbiddenReads()
    const terminalSeq = appendLifecycleEvent('turn.completed')
    const maxHrcSeq = track(spyOn(lifecycleRepositoryPrototype, 'maxHrcSeq'))
    const filtered = track(spyOn(lifecycleRepositoryPrototype, 'listFromHrcSeqFiltered'))

    expect(await runWait([TASK_ID, '--until', 'terminal', '--since', `${terminalSeq}`])).toBe(0)

    expectNoFullReads(forbidden)
    expect(targeted.getStatus).toHaveBeenCalledWith({ includeSessions: false })
    expect(maxHrcSeq).toHaveBeenCalled()
    expect(filtered).toHaveBeenCalledWith(
      expect.any(Number),
      expect.objectContaining({ taskIds: [TASK_ID] })
    )
  })

  it('holds the cursor and reads only newly appended rows on poll iterations', async () => {
    installTargetedSpies()
    const forbidden = captureForbiddenReads()
    const initialHighWater = appendLifecycleEvent('turn.started')
    track(spyOn(lifecycleRepositoryPrototype, 'maxHrcSeq'))
    const filtered = track(spyOn(lifecycleRepositoryPrototype, 'listFromHrcSeqFiltered'))
    const appendTimer = setTimeout(() => appendLifecycleEvent('turn.completed'), 50)

    try {
      expect(
        await runWait([`runtime:${RUNTIME_ID}`, '--until', 'turn-finished', '--timeout', '750ms'])
      ).toBe(0)
    } finally {
      clearTimeout(appendTimer)
    }

    expectNoFullReads(forbidden)
    expect(filtered.mock.calls.length).toBeGreaterThanOrEqual(2)
    const fromSeqs = filtered.mock.calls.map(([fromSeq]) => fromSeq)
    expect(fromSeqs[1]).toBeGreaterThan(fromSeqs[0] ?? 0)
    expect(fromSeqs[1]).toBe(initialHighWater + 1)
  })
})

describe('Bundle 2 — wait parity and cursor fences', () => {
  it('preserves initial wait outcomes while filtered reads retain the global high-water fence', async () => {
    installTargetedSpies()
    const forbidden = captureForbiddenReads()
    const terminalSeq = appendLifecycleEvent('turn.completed')
    const globalHighWater = appendLifecycleEvent(
      'turn.started',
      'agent:other:project:hrc-runtime:task:T-99999'
    )
    const maxHrcSeq = track(spyOn(lifecycleRepositoryPrototype, 'maxHrcSeq'))
    const filtered = track(spyOn(lifecycleRepositoryPrototype, 'listFromHrcSeqFiltered'))

    expect(
      await runWait([
        `runtime:${RUNTIME_ID}`,
        '--until',
        'terminal',
        '--since',
        `${terminalSeq}`,
        '--timeout',
        '25ms',
      ])
    ).toBe(0)

    expectNoFullReads(forbidden)
    expect(maxHrcSeq).toHaveReturnedWith(globalHighWater)
    expect(filtered).toHaveBeenCalledWith(
      terminalSeq,
      expect.objectContaining({ runtimeId: RUNTIME_ID })
    )
  })
})
