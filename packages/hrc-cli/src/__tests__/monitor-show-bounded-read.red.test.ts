import { afterEach, describe, expect, it, spyOn } from 'bun:test'

import { HrcClient } from 'hrc-sdk'
import { MessageRepository } from '../../../hrc-store-sqlite/src/message-repository'
import { HrcLifecycleEventRepository } from '../../../hrc-store-sqlite/src/repositories/event-repositories'
import { cmdMonitorShow } from '../monitor-show'

const SCOPE_REF = 'agent:test:project:hrc-runtime:task:status-summary'
const SESSION_REF = `${SCOPE_REF}/lane:main`
const HOST_SESSION_ID = 'hsid-bounded'
const RUNTIME_ID = 'rt-bounded'
const MESSAGE_ID = 'msg-bounded'

const session = {
  hostSessionId: HOST_SESSION_ID,
  scopeRef: SCOPE_REF,
  laneRef: 'default',
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
  laneRef: 'default',
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
  body: 'bounded lookup fixture',
  bodyFormat: 'text',
  execution: {
    state: 'completed',
    sessionRef: SESSION_REF,
    hostSessionId: HOST_SESSION_ID,
    generation: 1,
    runtimeId: RUNTIME_ID,
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
  // Compatibility data lets the pre-fix path finish so spies expose every forbidden read.
  sessions: [{ session, activeRuntime: { runtime, surfaceBindings: [] } }],
}

const restored: Array<{ mockRestore(): void }> = []

function track<T extends { mockRestore(): void }>(mock: T): T {
  restored.push(mock)
  return mock
}

afterEach(() => {
  while (restored.length > 0) restored.pop()?.mockRestore()
})

describe('hrc monitor show bounded snapshot reads', () => {
  it('uses summary status and targeted reads for bare, session, runtime, and message selectors', async () => {
    const getStatus = track(
      spyOn(HrcClient.prototype, 'getStatus').mockImplementation(async () => status as never)
    )
    const listRuntimes = track(
      spyOn(HrcClient.prototype, 'listRuntimes').mockImplementation(async () => [runtime] as never)
    )
    const listMessages = track(
      spyOn(HrcClient.prototype, 'listMessages').mockImplementation(
        async () =>
          ({
            messages: [message],
          }) as never
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
    const listFromHrcSeq = track(
      spyOn(HrcLifecycleEventRepository.prototype, 'listFromHrcSeq').mockReturnValue([])
    )
    const maxHrcSeq = track(
      spyOn(HrcLifecycleEventRepository.prototype, 'maxHrcSeq').mockReturnValue(1_000_000)
    )
    const getMessageById = track(
      spyOn(MessageRepository.prototype, 'getById').mockReturnValue(message as never)
    )
    const stdout = track(spyOn(process.stdout, 'write').mockImplementation(() => true))

    for (const selector of [
      undefined,
      `session:${SESSION_REF}`,
      `runtime:${RUNTIME_ID}`,
      `msg:${MESSAGE_ID}`,
    ]) {
      await cmdMonitorShow([...(selector ? [selector] : []), '--json'])
    }

    expect(getStatus).toHaveBeenCalledTimes(4)
    expect(getStatus.mock.calls.every(([options]) => options?.includeSessions === false)).toBe(true)
    expect(maxHrcSeq).toHaveBeenCalledTimes(4)
    expect(resolveSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionRef: SESSION_REF, create: false })
    )
    expect(inspectRuntime).toHaveBeenCalledWith({ runtimeId: RUNTIME_ID })
    expect(getMessageById).toHaveBeenCalledWith(MESSAGE_ID)

    expect(listRuntimes).not.toHaveBeenCalled()
    expect(listMessages).not.toHaveBeenCalled()
    expect(listFromHrcSeq).not.toHaveBeenCalled()
    expect(stdout).toHaveBeenCalledTimes(4)
  })
})
