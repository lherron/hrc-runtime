import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { HrcMonitorState } from 'hrc-core'
import { HrcClient } from 'hrc-sdk'
import { openHrcDatabase } from 'hrc-store-sqlite'
import { cmdMonitorWatch } from '../monitor-watch'
import { parseMonitorSelectors } from '../monitor/selector-shape'
import { createLiveMonitorStateSource } from '../monitor/wait-command'

const TASK_ID = 'T-90002'
const SCOPE_REF = `agent:test:project:hrc-runtime:task:${TASK_ID}`
const HOST_SESSION_ID = 'hsid-watch-bounded'
const RUNTIME_ID = 'rt-watch-bounded'
const RUN_ID = 'run-watch-bounded'

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

const baseStatus = {
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
  sessionCount: 1,
  runtimeCount: 1,
  apiVersion: 'v1',
  capabilities: {
    semanticCore: {},
    platform: {},
    bridgeDelivery: {},
    backend: { tmux: { available: false } },
  },
  // Compatibility data keeps the pre-fix full-status path running to expose
  // the forbidden collection reads.
  sessions: [{ session, activeRuntime: { runtime, surfaceBindings: [] } }],
}

type Restorable = { mockRestore(): void }
const restored: Restorable[] = []
let stateRoot = ''
let originalStateDir: string | undefined

function track<T extends Restorable>(mock: T): T {
  restored.push(mock)
  return mock
}

function state(events: HrcMonitorState['events'] = []): HrcMonitorState {
  return {
    daemon: { status: 'healthy' },
    socket: { path: '/tmp/hrc.sock', responsive: true },
    sessions: [],
    runtimes: [],
    messages: [],
    events,
    eventGlobalHighWaterSeq: events.at(-1)?.seq ?? 0,
  }
}

function monitorEvent(seq: number): HrcMonitorState['events'][number] {
  return {
    seq,
    hrcSeq: seq,
    streamSeq: seq,
    ts: new Date().toISOString(),
    event: 'turn.message',
    eventKind: 'turn.message',
    sessionRef: `${SCOPE_REF}/lane:main`,
    scopeRef: SCOPE_REF,
    laneRef: 'main',
    hostSessionId: HOST_SESSION_ID,
    generation: 1,
    category: 'turn',
    runtimeId: RUNTIME_ID,
    turnId: RUN_ID,
    runId: RUN_ID,
    payload: { seq },
  }
}

async function invokeLiveWatch(args: string[]): Promise<number> {
  class CliExit extends Error {
    constructor(readonly code: number) {
      super(`CLI exit ${code}`)
    }
  }

  track(
    spyOn(process.stdout, 'write').mockImplementation(((
      _chunk: string | Uint8Array,
      callback?: () => void
    ) => {
      callback?.()
      return true
    }) as typeof process.stdout.write)
  )
  track(
    spyOn(process.stderr, 'write').mockImplementation(((
      _chunk: string | Uint8Array,
      callback?: () => void
    ) => {
      callback?.()
      return true
    }) as typeof process.stderr.write)
  )
  track(
    spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new CliExit(code ?? 0)
    }) as typeof process.exit)
  )

  try {
    await cmdMonitorWatch(args)
  } catch (error) {
    if (error instanceof CliExit) return error.code
    throw error
  }
  throw new Error('monitor watch did not exit')
}

beforeEach(() => {
  originalStateDir = process.env['HRC_STATE_DIR']
  stateRoot = mkdtempSync(join(tmpdir(), 'hrc-monitor-watch-bounded-'))
  process.env['HRC_STATE_DIR'] = stateRoot
  const db = openHrcDatabase(join(stateRoot, 'state.sqlite'))
  try {
    db.sessions.insert(session as never)
    db.runtimes.insert(runtime as never)
  } finally {
    db.close()
  }
})

afterEach(() => {
  while (restored.length > 0) restored.pop()?.mockRestore()
  if (originalStateDir === undefined) Reflect.deleteProperty(process.env, 'HRC_STATE_DIR')
  else process.env['HRC_STATE_DIR'] = originalStateDir
  rmSync(stateRoot, { recursive: true, force: true })
})

describe('T-06587 monitor watch bounded memory', () => {
  it('anchors the default replay at the global high-water instead of sequence one', async () => {
    track(
      spyOn(HrcClient.prototype, 'getStatus').mockImplementation(
        async () => ({ ...baseStatus, dbPath: join(stateRoot, 'state.sqlite') }) as never
      )
    )
    track(spyOn(HrcClient.prototype, 'listMessages').mockResolvedValue({ messages: [] }))
    const db = openHrcDatabase(join(stateRoot, 'state.sqlite'))
    const repositoryPrototype = Object.getPrototypeOf(db.hrcEvents) as typeof db.hrcEvents
    db.close()
    const maxHrcSeq = track(spyOn(repositoryPrototype, 'maxHrcSeq').mockReturnValue(1_000_000))
    const listFromHrcSeq = track(spyOn(repositoryPrototype, 'listFromHrcSeq'))

    expect(await invokeLiveWatch(['--format', 'ndjson'])).toBe(0)

    expect(maxHrcSeq).toHaveBeenCalled()
    expect(listFromHrcSeq).toHaveBeenCalledWith(999_901)
    expect(listFromHrcSeq).not.toHaveBeenCalledWith(1)
  })

  it('uses targeted incremental state for an idle task follow', async () => {
    const getStatus = track(
      spyOn(HrcClient.prototype, 'getStatus').mockImplementation(
        async () => ({ ...baseStatus, dbPath: join(stateRoot, 'state.sqlite') }) as never
      )
    )
    const listMessages = track(
      spyOn(HrcClient.prototype, 'listMessages').mockResolvedValue({ messages: [] })
    )

    expect(
      await invokeLiveWatch([TASK_ID, '--follow', '--format', 'ndjson', '--stall-after', '120ms'])
    ).toBe(21)

    expect(getStatus).toHaveBeenCalled()
    expect(getStatus.mock.calls.every(([options]) => options?.includeSessions === false)).toBe(true)
    expect(listMessages).not.toHaveBeenCalled()
  })

  it('keeps the incremental source event window bounded across a burst', async () => {
    track(
      spyOn(HrcClient.prototype, 'getStatus').mockImplementation(
        async () => ({ ...baseStatus, dbPath: join(stateRoot, 'state.sqlite') }) as never
      )
    )
    const source = await createLiveMonitorStateSource({
      selectorSpecs: parseMonitorSelectors([TASK_ID]),
      condition: 'turn-finished',
    })

    const db = openHrcDatabase(join(stateRoot, 'state.sqlite'))
    try {
      for (let index = 0; index < 600; index += 1) {
        db.hrcEvents.append({
          ts: new Date().toISOString(),
          hostSessionId: HOST_SESSION_ID,
          scopeRef: SCOPE_REF,
          laneRef: 'main',
          generation: 1,
          runtimeId: RUNTIME_ID,
          runId: RUN_ID,
          category: 'turn',
          eventKind: 'turn.message',
          payload: { index },
        })
      }
    } finally {
      db.close()
    }

    const observed = new Set<number>()
    for (let refresh = 0; refresh < 4; refresh += 1) {
      const refreshed = await source.buildMonitorState()
      expect(refreshed.events.length).toBeLessThanOrEqual(256)
      for (const event of refreshed.events) observed.add(event.seq)
    }
    expect(observed.size).toBe(600)
  })

  it('waits for stdout drain before polling or emitting the next event', async () => {
    const abort = new AbortController()
    const initial = state()
    const live = state([monitorEvent(1), monitorEvent(2), monitorEvent(3)])
    let builds = 0
    let pendingWrites = 0
    let maxPendingWrites = 0
    let builtWhileBackpressured = false

    const result = await cmdMonitorWatch(
      {
        follow: true,
        forever: true,
        format: 'ndjson',
        signal: abort.signal,
      },
      {
        async buildMonitorState() {
          if (pendingWrites > 0) builtWhileBackpressured = true
          builds += 1
          return builds === 1 ? initial : live
        },
        stdout: {
          write(chunk) {
            pendingWrites += 1
            maxPendingWrites = Math.max(maxPendingWrites, pendingWrites)
            if (chunk.includes('"seq":3')) abort.abort()
            return false
          },
          async drain() {
            await Promise.resolve()
            pendingWrites = 0
          },
        },
        stderr: { write: () => true },
      }
    )

    expect(result).toBe(130)
    expect(builtWhileBackpressured).toBe(false)
    expect(maxPendingWrites).toBe(1)
  })
})
