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
}) {
  const rows = input?.rows ?? []
  const panes = input?.panes ?? []
  const latest = input?.latest ?? []
  const ensureCalls: Array<Record<string, unknown>> = []
  const rebindCalls: Array<Record<string, unknown>> = []
  const titleCalls: Array<{ surfaceId: string; title: string }> = []
  const statusCalls: Array<{ surfaceId: string; right: string }> = []
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
  })
  return {
    viewer,
    ensureCalls,
    rebindCalls,
    titleCalls,
    statusCalls,
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
})
