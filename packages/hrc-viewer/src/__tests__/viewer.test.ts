import { describe, expect, test } from 'bun:test'

import type { HeadlessViewerPane } from '../ghostmux.js'
import { HrcViewer, type HrcViewerClient, type ViewerGhostmux, type ViewerLog } from '../viewer.js'

const SCOPE = 'agent:cody:project:hrc-runtime:task:primary'
type Event = Parameters<HrcViewer['handleEvent']>[0]

function event(eventKind: string, overrides: Partial<Event> = {}): Event {
  return {
    hrcSeq: 1,
    eventId: 'evt-1',
    ts: '2026-08-26T12:00:00.000Z',
    hostSessionId: 'hs-1',
    scopeRef: SCOPE,
    laneRef: 'main',
    generation: 1,
    runtimeId: 'rt-1',
    category: 'runtime',
    eventKind,
    replayed: false,
    payload: {},
    ...overrides,
  } as Event
}

function presentationRow(overrides: Record<string, unknown> = {}) {
  return {
    runtimeId: 'rt-1',
    hostSessionId: 'hs-1',
    scopeRef: SCOPE,
    laneRef: 'main',
    generation: 1,
    status: 'idle',
    presentation: { operatorAttachable: true, viewerRequested: true },
    tmux: { socketPath: '/tmp/viewer.sock', attachTarget: 'viewer:tui' },
    ...overrides,
  }
}

function makeHarness(input?: {
  rows?: ReturnType<typeof presentationRow>[]
  panes?: HeadlessViewerPane[]
  latest?: Event[]
  lingerSeconds?: number
  /** Task id -> wrkq title. Omit to answer every batch with an empty map. */
  taskTitles?: Record<string, string>
  /** Force the batched title read to fail, as a deleted id or a missing wrkq does. */
  titleReadFails?: boolean
}) {
  const rows = input?.rows ?? []
  const panes = input?.panes ?? []
  const latest = input?.latest ?? []
  const ensureCalls: Array<Record<string, unknown>> = []
  const rebindCalls: Array<Record<string, unknown>> = []
  const titleCalls: Array<{ surfaceId: string; title: string }> = []
  const statusCalls: Array<{ surfaceId: string; right: string }> = []
  const secondaryCalls: Array<{ surfaceId: string; left: string; center: string; right: string }> =
    []
  const secondaryHides: string[] = []
  const titleReads: string[][] = []
  const reapCalls: Array<{ surfaceId: string; runtimeId: string }> = []
  const scheduled: Array<() => void> = []
  const logs: Array<{ event: string; fields: Record<string, unknown> }> = []
  const client = {
    async health() {
      return { ok: true }
    },
    async tailEvents() {
      return { events: [], ledgerIncarnationId: 'ledger-1', headHrcSeq: 1, truncated: false }
    },
    async *watchBoundedEvents() {},
    async listLatestEventBySession() {
      return latest
    },
    async listPresentationRuntimes() {
      return { ok: true as const, runtimes: rows }
    },
  } as unknown as HrcViewerClient
  const ghostmux: ViewerGhostmux = {
    async ensureHeadlessViewer(options) {
      ensureCalls.push(options)
      return { status: 'created', surfaceId: `surface-${ensureCalls.length}`, tabKey: 'tab' }
    },
    async findHeadlessViewerSurfaceByRuntimeId(runtimeId) {
      return panes.find((pane) => pane.runtimeId === runtimeId)?.surfaceId ?? null
    },
    async listHeadlessViewerPanes() {
      return panes
    },
    async rebindHeadlessViewerPane(surfaceId, options) {
      rebindCalls.push({ surfaceId, ...options })
    },
    async setHeadlessViewerTitle(surfaceId, title) {
      titleCalls.push({ surfaceId, title })
    },
    async setStatusBar(surfaceId, spec) {
      statusCalls.push({ surfaceId, right: spec.right })
    },
    async setSecondaryStatusBar(surfaceId, spec) {
      secondaryCalls.push({ surfaceId, ...spec })
    },
    async hideSecondaryStatusBar(surfaceId) {
      secondaryHides.push(surfaceId)
    },
    async reapHeadlessAgentPane(surfaceId, runtimeId) {
      reapCalls.push({ surfaceId, runtimeId })
      return { status: 'reaped', surfaceId, tabCollapsed: true }
    },
  }
  const log: ViewerLog = (_level, name, fields = {}) => logs.push({ event: name, fields })
  const viewer = new HrcViewer({
    client,
    ghostmux,
    log,
    lingerSeconds: input?.lingerSeconds ?? 300,
    now: () => Date.parse('2026-08-26T12:00:00.000Z'),
    schedule(fn) {
      scheduled.push(fn)
      return {} as ReturnType<typeof setTimeout>
    },
    clearScheduled() {},
    async readTaskTitles(taskIds) {
      titleReads.push([...taskIds])
      if (input?.titleReadFails === true) return new Map()
      const titles = new Map<string, string>()
      for (const taskId of taskIds) {
        const title = input?.taskTitles?.[taskId]
        if (title !== undefined) titles.set(taskId, title)
      }
      return titles
    },
  })
  return {
    viewer,
    ensureCalls,
    rebindCalls,
    titleCalls,
    statusCalls,
    secondaryCalls,
    secondaryHides,
    titleReads,
    reapCalls,
    scheduled,
    logs,
  }
}

describe('HrcViewer event reactions (§4.3)', () => {
  test('operator-attach pending skips only that invocation; a later detached invocation mints', async () => {
    const harness = makeHarness()
    await harness.viewer.handleEvent(
      event('runtime.presentation', {
        payload: {
          invocation: { operatorAttachPending: true },
          presentation: { operatorAttachable: true, viewerRequested: false },
          tmux: { socketPath: '/tmp/viewer.sock', attachTarget: 'viewer:tui' },
        },
      })
    )
    expect(harness.ensureCalls).toHaveLength(0)
    await harness.viewer.handleEvent(
      event('runtime.presentation', {
        payload: {
          invocation: { operatorAttachPending: false },
          presentation: { operatorAttachable: true, viewerRequested: true },
          tmux: { socketPath: '/tmp/viewer.sock', attachTarget: 'viewer:tui' },
        },
      })
    )
    expect(harness.ensureCalls).toHaveLength(1)
    expect(harness.ensureCalls[0]?.['attachCommand']).toContain("attach-session -t 'viewer:tui'")
  })

  test('T-08115: the pane outlives the reaper deadline so the reaper decides the race', async () => {
    // The pane's own `session-report --wait-timeout N; exit` and scheduleReap's
    // timer both count from the same terminal event. Given the same N they are
    // one deadline separated by startup jitter, and whichever won decided
    // whether the log said `reaped` or reported a gone pane as a skip. The
    // pane's timeout must therefore be STRICTLY GREATER than the linger.
    const harness = makeHarness({ lingerSeconds: 300 })
    await harness.viewer.handleEvent(
      event('runtime.presentation', {
        payload: {
          invocation: { operatorAttachPending: false },
          presentation: { operatorAttachable: true, viewerRequested: true },
          tmux: { socketPath: '/tmp/viewer.sock', attachTarget: 'viewer:tui' },
        },
      })
    )
    const attachCommand = String(harness.ensureCalls[0]?.['attachCommand'] ?? '')
    const waitTimeout = Number(/--wait-timeout (\d+)/.exec(attachCommand)?.[1])
    expect(Number.isFinite(waitTimeout)).toBe(true)
    expect(waitTimeout).toBeGreaterThan(300)
  })

  test('viewerRequested=false suppresses the live event path for a detached attachable runtime', async () => {
    const harness = makeHarness()
    await harness.viewer.handleEvent(
      event('runtime.presentation', {
        payload: {
          invocation: { operatorAttachPending: false },
          presentation: { operatorAttachable: true, viewerRequested: false },
          tmux: { socketPath: '/tmp/viewer.sock', attachTarget: 'viewer:tui' },
        },
      })
    )
    expect(harness.ensureCalls).toHaveLength(0)
  })

  test('session.retitled targets by host session and null restores the default title', async () => {
    const harness = makeHarness({
      panes: [{ surfaceId: 'surface-1', windowKey: 'default', hostSessionId: 'hs-1' }],
    })
    await harness.viewer.handleEvent(
      event('session.retitled', {
        category: 'session',
        runtimeId: undefined,
        payload: { title: 'Nova' },
      })
    )
    await harness.viewer.handleEvent(
      event('session.retitled', {
        category: 'session',
        runtimeId: undefined,
        payload: { title: null },
      })
    )
    expect(harness.titleCalls.map((call) => call.title)).toEqual(['Nova', 'hrc · primary · cody'])
  })

  test('terminal event schedules a runtime-fenced reap', async () => {
    const harness = makeHarness({
      panes: [{ surfaceId: 'surface-1', windowKey: 'default', runtimeId: 'rt-1' }],
      lingerSeconds: 0,
    })
    await harness.viewer.handleEvent(event('runtime.crashed'))
    expect(harness.scheduled).toHaveLength(1)
    harness.scheduled[0]?.()
    await Bun.sleep(0)
    expect(harness.reapCalls).toEqual([{ surfaceId: 'surface-1', runtimeId: 'rt-1' }])
  })
})

describe('HrcViewer reconcile (§4.5 / §5.5)', () => {
  test('record-less and viewerRequested=false rows never mint panes', async () => {
    const harness = makeHarness({
      rows: [
        presentationRow({ runtimeId: 'rt-recordless', presentation: undefined }),
        presentationRow({
          runtimeId: 'rt-suppressed',
          presentation: { operatorAttachable: true, viewerRequested: false },
        }),
      ],
    })
    await harness.viewer.reconcile('start')
    expect(harness.ensureCalls).toHaveLength(0)
  })

  test('adopts a record-less pane, rebinds generation metadata, and status-paints it', async () => {
    const harness = makeHarness({
      rows: [presentationRow({ presentation: undefined, title: 'Adopted' })],
      panes: [
        {
          surfaceId: 'surface-old',
          windowKey: 'default',
          paneKey: 'agent:cody:project:hrc-runtime:task:primary#main',
          runtimeId: 'rt-old',
        },
      ],
      latest: [event('turn.awaiting_input')],
    })
    await harness.viewer.reconcile('start')
    expect(harness.ensureCalls).toHaveLength(0)
    expect(harness.rebindCalls[0]).toMatchObject({
      surfaceId: 'surface-old',
      runtimeId: 'rt-1',
      hostSessionId: 'hs-1',
      generation: 1,
    })
    expect(harness.titleCalls).toContainEqual({ surfaceId: 'surface-old', title: 'Adopted' })
    expect(harness.statusCalls).toContainEqual({
      surfaceId: 'surface-old',
      right: '⏸ awaiting input',
    })
  })

  test('viewerRequested=true with attachability and tmux mints the missing pane', async () => {
    const harness = makeHarness({ rows: [presentationRow()] })
    await harness.viewer.reconcile('timer')
    expect(harness.ensureCalls).toHaveLength(1)
    expect(harness.ensureCalls[0]).toMatchObject({
      runtimeId: 'rt-1',
      hostSessionId: 'hs-1',
      generation: 1,
    })
  })

  test('normalizes an unprefixed legacy lane without aborting reconcile', async () => {
    const harness = makeHarness({
      rows: [presentationRow({ laneRef: 'viewer-smoke' })],
    })
    await harness.viewer.reconcile('start')
    expect(harness.ensureCalls).toHaveLength(1)
    expect(harness.ensureCalls[0]).toMatchObject({
      laneRef: 'lane:viewer-smoke',
    })
    expect(
      harness.logs.some((entry) => entry.event === 'broker_headless_viewer.reconcile_failed')
    ).toBe(false)
  })
})

/**
 * T-08331: the secondary status bar is a TITLE bar. It answers "what task is
 * this pane?" — a fact — so it is stamped on every reconcile pass regardless of
 * what the runtime's latest event was, and it must render byte-identically to
 * what hcs writes on its own context panes until T-08332 removes that writer.
 */
describe('HrcViewer secondary status bar (T-08331)', () => {
  const TASK_SCOPE = 'agent:cody:project:wrkq:task:T-08259'
  const TASK_PANE_KEY = 'agent:cody:project:wrkq:task:T-08259#main'

  function taskHarness(input?: Parameters<typeof makeHarness>[0]) {
    return makeHarness({
      rows: [presentationRow({ scopeRef: TASK_SCOPE })],
      panes: [
        {
          surfaceId: 'surface-task',
          windowKey: 'default',
          paneKey: TASK_PANE_KEY,
          runtimeId: 'rt-1',
          scopeRef: TASK_SCOPE,
        },
      ],
      taskTitles: { 'T-08259': 'wrkq: teach cat to take many ids' },
      ...input,
    })
  }

  test('stamps `▸ <title>` in left with center and right empty, matching hcs byte for byte', async () => {
    const harness = taskHarness()
    await harness.viewer.reconcile('start')
    expect(harness.secondaryCalls).toContainEqual({
      surfaceId: 'surface-task',
      left: '▸ wrkq: teach cat to take many ids',
      center: '',
      right: '',
    })
  })

  test('stamps a pane whose latest event has no viewer state — the state gate must not cover it', async () => {
    // `session.retitled` is not one of the eight kinds viewerStateForEventKind
    // maps, so paintFromLatest returns early and writes no primary bar. A title
    // bar behind that gate would hold a stale title until the next turn boundary.
    const harness = taskHarness({
      latest: [event('session.retitled', { scopeRef: TASK_SCOPE })],
    })
    await harness.viewer.reconcile('timer')
    expect(harness.statusCalls).toHaveLength(0)
    expect(harness.secondaryCalls).toHaveLength(1)
    expect(harness.secondaryCalls[0]?.left).toBe('▸ wrkq: teach cat to take many ids')
  })

  test('one batched read covers every task-scoped pane in the pass', async () => {
    const harness = makeHarness({
      rows: [
        presentationRow({ scopeRef: TASK_SCOPE }),
        presentationRow({ runtimeId: 'rt-2', hostSessionId: 'hs-2', scopeRef: SCOPE }),
        presentationRow({
          runtimeId: 'rt-3',
          hostSessionId: 'hs-3',
          scopeRef: 'agent:clod:project:hrc-runtime:task:T-08296',
        }),
      ],
      taskTitles: { 'T-08259': 'first', 'T-08296': 'second' },
    })
    await harness.viewer.reconcile('start')
    // Exactly one read, carrying both task ids; the `:primary` scope contributes none.
    expect(harness.titleReads).toHaveLength(1)
    expect(harness.titleReads[0]?.sort()).toEqual(['T-08259', 'T-08296'])
  })

  test('a `:primary` seat is HIDDEN, not skipped, so a recycled pane drops the old title', async () => {
    const harness = makeHarness({
      rows: [presentationRow()],
      panes: [
        {
          surfaceId: 'surface-primary',
          windowKey: 'default',
          paneKey: 'agent:cody:project:hrc-runtime:task:primary#main',
          runtimeId: 'rt-1',
          scopeRef: SCOPE,
        },
      ],
    })
    await harness.viewer.reconcile('start')
    expect(harness.secondaryHides).toContain('surface-primary')
    expect(harness.secondaryCalls).toHaveLength(0)
  })

  test('a failed title read degrades to the last-known title and never blanks the bar', async () => {
    const harness = taskHarness()
    await harness.viewer.reconcile('start')
    expect(harness.secondaryCalls).toHaveLength(1)

    // Same viewer, now with wrkq answering nothing — a deleted id failing the
    // whole batch, or wrkq gone from PATH.
    const failing = taskHarness({ titleReadFails: true })
    await failing.viewer.reconcile('start')
    expect(failing.secondaryHides).toHaveLength(0)
    // Never seen: no title to hold, so the bar is left exactly as it was.
    expect(failing.secondaryCalls).toHaveLength(0)
  })

  test('a retitled task is restamped on the next reconcile with no lifecycle event', async () => {
    const titles: Record<string, string> = { 'T-08259': 'before' }
    const harness = makeHarness({
      rows: [presentationRow({ scopeRef: TASK_SCOPE })],
      panes: [
        {
          surfaceId: 'surface-task',
          windowKey: 'default',
          paneKey: TASK_PANE_KEY,
          runtimeId: 'rt-1',
          scopeRef: TASK_SCOPE,
        },
      ],
      taskTitles: titles,
    })
    await harness.viewer.reconcile('start')
    titles['T-08259'] = 'after'
    await harness.viewer.reconcile('timer')
    expect(harness.secondaryCalls.map((call) => call.left)).toEqual(['▸ before', '▸ after'])
  })

  test('a terminal runtime hides the bar so a lingering pane sheds its title', async () => {
    const harness = taskHarness()
    await harness.viewer.handleEvent(
      event('runtime.terminated', { scopeRef: TASK_SCOPE, runtimeId: 'rt-1' })
    )
    expect(harness.secondaryHides).toContain('surface-task')
  })

  test('a pane with no presentation row hides the bar on its way to the reaper', async () => {
    const harness = makeHarness({
      panes: [
        {
          surfaceId: 'surface-orphan',
          windowKey: 'default',
          paneKey: TASK_PANE_KEY,
          runtimeId: 'rt-gone',
          scopeRef: TASK_SCOPE,
        },
      ],
    })
    await harness.viewer.reconcile('start')
    expect(harness.secondaryHides).toContain('surface-orphan')
  })
})
