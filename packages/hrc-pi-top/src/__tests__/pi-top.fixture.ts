import { expect } from 'bun:test'
import type { HrcLifecycleEvent, HrcTargetView } from 'hrc-core'
import { type HrcTopActionExecutor, buildReadModel } from 'hrc-top'

import { HrcPiTopApp } from '../index.js'

export const capabilities: HrcTargetView['capabilities'] = {
  state: 'bound',
  modesSupported: ['tmux'],
  defaultMode: 'tmux',
  dmReady: true,
  sendReady: true,
  peekReady: true,
}

export function target(overrides: Partial<HrcTargetView> = {}): HrcTargetView {
  return {
    sessionRef: 'agent:cody:project:hrc-runtime:task:T-05449/lane:main',
    scopeRef: 'agent:cody:project:hrc-runtime:task:T-05449',
    laneRef: 'main',
    state: 'bound',
    activeHostSessionId: 'hsid-pi-top-1',
    generation: 7,
    runtime: {
      runtimeId: 'rt-pi-top-1',
      transport: 'tmux',
      status: 'ready',
      supportsLiteralSend: true,
      supportsCapture: true,
      operatorAttachable: true,
      lastActivityAt: '2026-07-02T12:00:00.000Z',
    },
    capabilities,
    ...overrides,
  }
}

export function createApp(
  input: { targets?: HrcTargetView[] | undefined; onQuit?: () => void } = {}
): {
  app: HrcPiTopApp
  renders: () => number
  commands: string[][]
  executorCalls: string[]
  attachRuntimeIds: string[]
} {
  const targets = input.targets ?? [
    target({
      sessionRef: 'agent:clod:project:agent-spaces:task:primary/lane:main',
      scopeRef: 'agent:clod:project:agent-spaces:task:primary',
      state: 'dormant',
      runtime: undefined,
      continuation: { provider: 'openai', key: 'conv-pi-top-1' },
    }),
    target(),
  ]
  let renderCount = 0
  const commands: string[][] = []
  const executorCalls: string[] = []
  const attachRuntimeIds: string[] = []
  const executor: HrcTopActionExecutor = {
    async attachRuntime(runtimeId) {
      executorCalls.push('attachRuntime')
      attachRuntimeIds.push(runtimeId)
      return { argv: ['true'] }
    },
    async spawnAttachDescriptor() {
      executorCalls.push('spawnAttachDescriptor')
      return { status: 'executed' }
    },
    async runCommand(argv) {
      executorCalls.push('runCommand')
      commands.push(argv)
      return { status: 'executed' }
    },
  }
  const app = new HrcPiTopApp({
    client: {
      async listTargets() {
        return targets
      },
    },
    executor,
    initialModel: buildReadModel(targets, new Date('2026-07-02T12:05:00.000Z')),
    scope: { projectId: 'hrc-runtime' },
    viewportHeight: () => 18,
    requestRender: () => {
      renderCount += 1
    },
    onQuit: input.onQuit ?? (() => undefined),
  })
  return { app, renders: () => renderCount, commands, executorCalls, attachRuntimeIds }
}

export function withMessageContext(row: ReturnType<typeof buildReadModel>['rows'][number]) {
  return {
    ...row,
    message: {
      messageId: 'msg-pi-top-1',
      messageSeq: 73,
      createdAt: '2026-07-04T12:03:00.000Z',
      phase: 'queued',
      from: { kind: 'session', sessionRef: 'operator@hrc-runtime:primary' },
      to: { kind: 'session', sessionRef: row.sessionRef },
      bodyPreview: 'confirm the target can reply',
    },
  }
}

export function createMessageApp(input: { includeMessage: boolean }): {
  app: HrcPiTopApp
  commands: string[][]
} {
  const selected = target()
  const model = buildReadModel([selected], new Date('2026-07-02T12:05:00.000Z'))
  const initialModel = input.includeMessage
    ? { ...model, rows: model.rows.map((row) => withMessageContext(row)) }
    : model
  const commands: string[][] = []
  const executor: HrcTopActionExecutor = {
    async attachRuntime() {
      return { argv: ['true'] }
    },
    async spawnAttachDescriptor() {
      return { status: 'executed' }
    },
    async runCommand(argv) {
      commands.push(argv)
      return { status: 'executed' }
    },
  }
  const app = new HrcPiTopApp({
    client: {
      async listTargets() {
        return [selected]
      },
    },
    executor,
    initialModel,
    scope: { projectId: 'hrc-runtime' },
    viewportHeight: () => 18,
    requestRender: () => undefined,
    onQuit: () => undefined,
  })
  return { app, commands }
}

export function lifecycleEvent(overrides: Partial<HrcLifecycleEvent> = {}): HrcLifecycleEvent {
  return {
    hrcSeq: 41,
    streamSeq: 41,
    ts: '2026-07-02T12:04:30.000Z',
    hostSessionId: 'hsid-pi-top-1',
    scopeRef: 'agent:cody:project:hrc-runtime:task:T-05449',
    laneRef: 'main',
    generation: 7,
    runtimeId: 'rt-pi-top-1',
    runId: 'run-pi-top-1',
    category: 'turn',
    eventKind: 'turn.started',
    transport: 'tmux',
    replayed: true,
    payload: { promptPreview: 'inspect the queue state' },
    ...overrides,
  }
}

export function ambiguousTargets(): HrcTargetView[] {
  return [
    target({
      activeHostSessionId: 'hsid-ambiguity-newer',
      generation: 3,
      runtime: {
        ...target().runtime!,
        runtimeId: 'rt-ambiguity-newer',
        status: 'busy',
        lastActivityAt: '2026-07-02T12:04:00.000Z',
      },
    }),
    target({
      activeHostSessionId: 'hsid-ambiguity-older',
      generation: 2,
      runtime: {
        ...target().runtime!,
        runtimeId: 'rt-ambiguity-older',
        status: 'ready',
        lastActivityAt: '2026-07-02T12:03:00.000Z',
      },
    }),
  ]
}

export function createTailApp(input: {
  events: HrcLifecycleEvent[]
  refreshEvents?: HrcLifecycleEvent[] | undefined
  latestHrcSeq?: number | undefined
  target?: HrcTargetView | undefined
}): {
  app: HrcPiTopApp
  watchCalls: unknown[]
  commands: string[][]
} {
  const selected = input.target ?? target({ state: 'busy' })
  const watchCalls: unknown[] = []
  const commands: string[][] = []
  const executor: HrcTopActionExecutor = {
    async attachRuntime() {
      return { argv: ['true'] }
    },
    async spawnAttachDescriptor() {
      return { status: 'executed' }
    },
    async runCommand(argv) {
      commands.push(argv)
      return { status: 'executed' }
    },
  }
  const client = {
    async listTargets() {
      return [selected]
    },
    async listLatestEventBySession() {
      const latestHrcSeq =
        input.latestHrcSeq ?? input.events.reduce((max, event) => Math.max(max, event.hrcSeq), 0)
      return latestHrcSeq > 0 ? [lifecycleEvent({ hrcSeq: latestHrcSeq })] : []
    },
    async *watch(options: unknown) {
      watchCalls.push(options)
      const events = watchCalls.length === 1 ? input.events : (input.refreshEvents ?? [])
      for (const event of events) yield event
    },
  }

  const app = new HrcPiTopApp({
    client,
    executor,
    initialModel: buildReadModel([selected], new Date('2026-07-02T12:05:00.000Z')),
    scope: { projectId: 'hrc-runtime' },
    viewportHeight: () => 18,
    requestRender: () => undefined,
    onQuit: () => undefined,
  })

  return { app, watchCalls, commands }
}

export type RestoreFakeTui = {
  readonly started: boolean
  start(): void
  stop(): void
  addInputListener(listener: (data: string) => boolean | undefined): () => void
  requestRender(force?: boolean): void
}

export type RestoreFakeApp = {
  invalidate(): void
  handleInput(data: string): void
}

export type SpawnRestoreCoordinator = {
  beforeSpawn(): void
  afterSpawn(): void
  isSuspended(): boolean
}

export type SpawnRestoreCoordinatorFactory = (input: {
  tui: RestoreFakeTui
  app: RestoreFakeApp
}) => SpawnRestoreCoordinator

export async function loadSpawnRestoreCoordinatorFactory(): Promise<
  SpawnRestoreCoordinatorFactory | undefined
> {
  const mod = (await import('../index.js')) as Record<string, unknown>
  const factory = mod.createHrcPiTopSpawnRestoreCoordinator
  expect(typeof factory).toBe('function')
  return typeof factory === 'function' ? (factory as SpawnRestoreCoordinatorFactory) : undefined
}

export function createRestoreHarness(createCoordinator: SpawnRestoreCoordinatorFactory) {
  const calls: string[] = []
  const forwardedInput: string[] = []
  let closed = false
  let started = true
  let listener: ((data: string) => boolean | undefined) | undefined
  const tui: RestoreFakeTui = {
    get started() {
      return started
    },
    start() {
      calls.push('tui.start')
      started = true
    },
    stop() {
      calls.push('tui.stop')
      started = false
    },
    addInputListener(nextListener) {
      calls.push('tui.addInputListener')
      listener = nextListener
      return () => {
        calls.push('restoreListener.dispose')
        if (listener === nextListener) listener = undefined
      }
    },
    requestRender(force) {
      calls.push(`tui.requestRender:${String(force)}`)
    },
  }
  const app: RestoreFakeApp = {
    invalidate() {
      calls.push('app.invalidate')
    },
    handleInput(data) {
      calls.push(`app.handleInput:${JSON.stringify(data)}`)
      forwardedInput.push(data)
      if (data === 'q') closed = true
    },
  }
  const coordinator = createCoordinator({ tui, app })
  return {
    app,
    calls,
    coordinator,
    forwardedInput,
    get closed() {
      return closed
    },
    get listener() {
      return listener
    },
  }
}

export function deliverRestoreInput(
  harness: ReturnType<typeof createRestoreHarness>,
  data: string
): void {
  const consumed = harness.listener?.(data) === true
  if (!consumed) harness.app.handleInput(data)
}
