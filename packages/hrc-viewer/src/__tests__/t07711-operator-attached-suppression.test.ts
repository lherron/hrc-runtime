/**
 * T-07711: a foreign dispatch (another agent's `wrkc say`) landing on a runtime
 * an operator is already attached to must NOT mint a second Ghostty window.
 *
 * `invocation.operatorAttachPending` is invocation-local and can only ever be
 * true for the terminal doing the attaching, so the foreign dispatch publishes
 * false, the monotone `viewerRequested` flips, and the viewer reaches its create
 * branch. The discriminator is the tmux client list: on the create branch the
 * viewer owns no pane for the runtime, so any attached client is an operator.
 */
import { describe, expect, it } from 'bun:test'

import { GhostmuxManager } from '../ghostmux'
import type { HeadlessViewerPane } from '../ghostmux.js'
import { createTmuxClientProbe, parseTmuxClientList } from '../tmux-clients.js'
import { HrcViewer, type HrcViewerClient, type ViewerGhostmux, type ViewerLog } from '../viewer.js'

const SCOPE = 'agent:mable:project:hrc-runtime:task:primary'
const SOCKET = '/tmp/t07711-viewer.sock'
const TARGET = 'hrc-claude-code-tmux-rt-1:tui'

/** Minimal metadata-modeling fake ghostmux; enough to exercise create vs reuse. */
function makeFakeGhostmux() {
  type Surf = { surfaceMeta: Record<string, unknown>; title?: string | undefined }
  const surfaces = new Map<string, Surf>()
  const calls: string[][] = []
  let counter = 0
  const alloc = (title?: string | undefined): string => {
    counter += 1
    const id = `surf-${counter}`
    surfaces.set(id, { surfaceMeta: {}, title })
    return id
  }
  const runner = async (args: string[]) => {
    calls.push(args)
    if (args[0] === 'list-windows') {
      throw new Error('server does not support the windows API; update ScriptableGhostty')
    }
    if (args.join(' ') === 'list-surfaces --json') {
      return {
        stdout: JSON.stringify({
          terminals: [...surfaces.entries()].map(([id, s]) => ({
            id,
            title: s.title,
            columns: 120,
            rows: 40,
          })),
        }),
        stderr: '',
      }
    }
    if (args[0] === 'metadata' && args[1] === 'get') {
      return {
        stdout: JSON.stringify({ data: surfaces.get(args[3] ?? '')?.surfaceMeta ?? {} }),
        stderr: '',
      }
    }
    if (args[0] === 'metadata' && args[1] === 'set') {
      const s = surfaces.get(args[3] ?? '')
      if (s && !args.includes('--window')) {
        s.surfaceMeta = { ...s.surfaceMeta, ...(JSON.parse(args[4] ?? '{}') as object) }
      }
      return { stdout: '{}', stderr: '' }
    }
    if (args[0] === 'new') {
      const titleIdx = args.indexOf('--title')
      return {
        stdout: JSON.stringify({ id: alloc(titleIdx >= 0 ? args[titleIdx + 1] : undefined) }),
        stderr: '',
      }
    }
    if (args[0] === 'new-pane') return { stdout: JSON.stringify({ id: alloc() }), stderr: '' }
    return { stdout: '{}', stderr: '' }
  }
  const agentPanes = () =>
    [...surfaces.entries()].filter(([, s]) => s.surfaceMeta['hrc_role'] === 'headless-agent-pane')
  return { runner, calls, agentPanes }
}

describe('T-07711 ghostmux create veto', () => {
  it('a vetoing predicate skips the create and mints no surface at all', async () => {
    const fake = makeFakeGhostmux()
    const manager = new GhostmuxManager('ghostmux', fake.runner)

    const result = await manager.ensureHeadlessViewer({
      scopeRef: SCOPE,
      runtimeId: 'rt-1',
      attachCommand: 'tmux attach',
      skipCreateWhen: async () => true,
    })

    expect(result.status).toBe('skipped')
    expect(fake.agentPanes()).toHaveLength(0)
    // Vetoed BEFORE the keyed window is resolved: no window is left behind.
    expect(fake.calls.some((c) => c[0] === 'new')).toBe(false)
  })

  it('a non-vetoing predicate creates exactly as before', async () => {
    const fake = makeFakeGhostmux()
    const manager = new GhostmuxManager('ghostmux', fake.runner)

    const result = await manager.ensureHeadlessViewer({
      scopeRef: SCOPE,
      runtimeId: 'rt-1',
      attachCommand: 'tmux attach',
      skipCreateWhen: async () => false,
    })

    expect(result.status).toBe('created')
    expect(fake.agentPanes()).toHaveLength(1)
  })

  it('the predicate is never consulted on reuse — an existing pane always wins', async () => {
    const fake = makeFakeGhostmux()
    const manager = new GhostmuxManager('ghostmux', fake.runner)
    await manager.ensureHeadlessViewer({
      scopeRef: SCOPE,
      runtimeId: 'rt-1',
      attachCommand: 'tmux attach',
    })

    let consulted = 0
    const result = await manager.ensureHeadlessViewer({
      scopeRef: SCOPE,
      runtimeId: 'rt-2',
      attachCommand: 'tmux attach',
      skipCreateWhen: async () => {
        consulted += 1
        return true
      },
    })

    expect(result.status).toBe('reused')
    expect(consulted).toBe(0)
  })
})

describe('T-07711 tmux client probe (fails open)', () => {
  it('parses one tty per line and drops blanks', () => {
    expect(parseTmuxClientList('/dev/ttys014\n/dev/ttys070\n\n')).toEqual([
      '/dev/ttys014',
      '/dev/ttys070',
    ])
    expect(parseTmuxClientList('')).toEqual([])
  })

  it('answers [] when the tmux binary cannot be spawned', async () => {
    const probe = createTmuxClientProbe({ tmuxBin: '/nonexistent/t07711-tmux' })
    expect(await probe(SOCKET, TARGET)).toEqual([])
  })

  it('answers [] on a non-zero exit (no server / no such session)', async () => {
    const probe = createTmuxClientProbe({ tmuxBin: '/usr/bin/false' })
    expect(await probe(SOCKET, TARGET)).toEqual([])
  })

  it('reports clients only on a zero exit with non-empty output', async () => {
    const probe = createTmuxClientProbe({ tmuxBin: '/bin/echo' })
    expect(await probe(SOCKET, TARGET)).toHaveLength(1)
  })
})

type Event = Parameters<HrcViewer['handleEvent']>[0]

function presentationEvent(): Event {
  return {
    hrcSeq: 1,
    eventId: 'evt-1',
    ts: '2026-08-29T18:33:03.594Z',
    hostSessionId: 'hs-1',
    scopeRef: SCOPE,
    laneRef: 'main',
    generation: 1,
    runtimeId: 'rt-1',
    category: 'runtime',
    eventKind: 'runtime.presentation',
    replayed: false,
    // The shape the broker-reuse branch publishes for a FOREIGN dispatch: the
    // sender never attaches, so `operatorAttachPending` is false and the
    // monotone `viewerRequested` has already flipped true.
    payload: {
      invocation: { operatorAttachPending: false },
      presentation: { operatorAttachable: true, viewerRequested: true },
      tmux: { socketPath: SOCKET, attachTarget: TARGET },
    },
  } as Event
}

function makeHarness(clients: readonly string[]) {
  const rows = [
    {
      runtimeId: 'rt-1',
      hostSessionId: 'hs-1',
      scopeRef: SCOPE,
      laneRef: 'main',
      generation: 1,
      status: 'idle',
      presentation: { operatorAttachable: true, viewerRequested: true },
      tmux: { socketPath: SOCKET, attachTarget: TARGET },
    },
  ]
  const createdCalls: Array<Record<string, unknown>> = []
  const probeCalls: Array<{ socketPath: string; attachTarget: string }> = []
  const logs: Array<{ event: string; fields: Record<string, unknown> }> = []
  const panes: HeadlessViewerPane[] = []
  const client = {
    async health() {
      return { ok: true }
    },
    async tailEvents() {
      return { events: [], ledgerIncarnationId: 'ledger-1', headHrcSeq: 1, truncated: false }
    },
    async *watchBoundedEvents() {},
    async listLatestEventBySession() {
      return []
    },
    async listPresentationRuntimes() {
      return { ok: true as const, runtimes: rows }
    },
  } as unknown as HrcViewerClient
  // Honours the veto the way GhostmuxManager does, so this layer proves the
  // viewer asks the right question — not merely that it passes a callback.
  const ghostmux: ViewerGhostmux = {
    async ensureHeadlessViewer(options) {
      if (options.skipCreateWhen !== undefined && (await options.skipCreateWhen())) {
        return { status: 'skipped', reason: 'create_vetoed' }
      }
      createdCalls.push(options)
      return { status: 'created', surfaceId: `surface-${createdCalls.length}`, tabKey: 'tab' }
    },
    async findHeadlessViewerSurfaceByRuntimeId() {
      return null
    },
    async listHeadlessViewerPanes() {
      return panes
    },
    async rebindHeadlessViewerPane() {},
    async setHeadlessViewerTitle() {},
    async setStatusBar() {},
    async reapHeadlessAgentPane(surfaceId) {
      return { status: 'reaped', surfaceId, tabCollapsed: true }
    },
  }
  const log: ViewerLog = (_level, name, fields = {}) => logs.push({ event: name, fields })
  const viewer = new HrcViewer({
    client,
    ghostmux,
    log,
    now: () => Date.parse('2026-08-29T18:33:03.594Z'),
    schedule() {
      return {} as ReturnType<typeof setTimeout>
    },
    clearScheduled() {},
    async probeTmuxClients(socketPath, attachTarget) {
      probeCalls.push({ socketPath, attachTarget })
      return clients
    },
  })
  return { viewer, createdCalls, probeCalls, logs }
}

describe('T-07711 viewer suppression on an operator-attached runtime', () => {
  it('a foreign dispatch does NOT mint a window while an operator is attached', async () => {
    const harness = makeHarness(['/dev/ttys014'])

    await harness.viewer.handleEvent(presentationEvent())

    expect(harness.createdCalls).toHaveLength(0)
    expect(harness.probeCalls).toEqual([{ socketPath: SOCKET, attachTarget: TARGET }])
    // The reclassification line: a positive record naming what it deferred to,
    // so the fix is provable from the log rather than from a missing `created`.
    const skipped = harness.logs.find(
      (entry) => entry.event === 'broker_headless_viewer.skipped_operator_attached'
    )
    expect(skipped?.fields).toMatchObject({
      runtimeId: 'rt-1',
      scopeRef: SCOPE,
      attachTarget: TARGET,
      clients: ['/dev/ttys014'],
    })
    expect(harness.logs.some((entry) => entry.event === 'broker_headless_viewer.created')).toBe(
      false
    )
  })

  it('with nobody attached the same dispatch still mints the viewer', async () => {
    const harness = makeHarness([])

    await harness.viewer.handleEvent(presentationEvent())

    expect(harness.createdCalls).toHaveLength(1)
    expect(harness.logs.some((entry) => entry.event === 'broker_headless_viewer.created')).toBe(
      true
    )
  })

  it('the 5-minute reconcile respawn is suppressed too', async () => {
    // `viewerRequested` is monotone and never clears, so reconcile re-creates a
    // window for any row with no managed pane. Same guard, same seam.
    const harness = makeHarness(['/dev/ttys014'])

    await harness.viewer.reconcile('timer')

    expect(harness.createdCalls).toHaveLength(0)
    expect(
      harness.logs.some(
        (entry) => entry.event === 'broker_headless_viewer.skipped_operator_attached'
      )
    ).toBe(true)
  })
})
