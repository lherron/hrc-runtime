/**
 * T-07121 — first-class windows API cutover.
 *
 * The keyed viewer window stops being an anchor PANE carrying `hrc_window_key`
 * and becomes a real managed window found-or-created atomically by that key.
 * Covered here:
 *
 *  - the once-per-process capability probe, both ways,
 *  - the exact `new --window --find-or-create-by` call shape and its reuse
 *    (`created: false`) behavior,
 *  - fresh tabs by `--window-id` instead of `--parent <anchorSurface>`,
 *  - the RESIDENCY FENCE (daedalus #17988): a pane whose metadata matches
 *    `(hrc_window_key, hrc_tab_key)` but which physically lives in another
 *    window is NOT a split target,
 *  - the mandatory order of operations (find-or-create BEFORE candidate
 *    evaluation),
 *  - operator adoption by window-metadata stamp,
 *  - and the untouched legacy anchor path on an old build.
 *
 * The fake models the pinned upstream semantics verbatim: `new --window` answers
 * a WINDOW object (never a surface), find-or-create is AND-equality returning the
 * OLDEST match with its metadata untouched, every terminal reports its live
 * `window_id`, and both `--parent` and `--window-id` targets are validated.
 */

import { describe, expect, it } from 'bun:test'

import { GhostmuxManager } from '../ghostmux'

type FakeSurface = {
  windowId: string
  surfaceMeta: Record<string, unknown>
  windowMeta: Record<string, unknown>
  title?: string | undefined
  columns: number
  rows: number
}

type FakeWindow = {
  metadata: Record<string, unknown>
  /** Creation order — find-or-create returns the OLDEST match. */
  seq: number
  title?: string | undefined
}

const WINDOWS_UNSUPPORTED = 'server does not support the windows API; update ScriptableGhostty'

function makeFakeGhostmux(options: { windowsApi?: boolean } = {}) {
  const windowsApi = options.windowsApi ?? true
  const surfaces = new Map<string, FakeSurface>()
  const windows = new Map<string, FakeWindow>()
  const calls: string[][] = []
  let surfaceSeq = 0
  let windowSeq = 0

  const argAfter = (args: string[], flag: string): string | undefined => {
    const index = args.indexOf(flag)
    return index >= 0 ? args[index + 1] : undefined
  }
  const allocWindow = (metadata: Record<string, unknown>, title?: string | undefined): string => {
    windowSeq += 1
    const id = `win-${windowSeq}`
    windows.set(id, { metadata, seq: windowSeq, title })
    return id
  }
  const allocSurface = (windowId: string, title?: string | undefined): string => {
    surfaceSeq += 1
    const id = `surf-${surfaceSeq}`
    surfaces.set(id, { windowId, surfaceMeta: {}, windowMeta: {}, title, columns: 120, rows: 40 })
    return id
  }
  const terminalJson = (id: string) => {
    const surface = surfaces.get(id)
    return {
      id,
      title: surface?.title,
      window_id: surface?.windowId,
      columns: surface?.columns,
      rows: surface?.rows,
    }
  }
  const windowJson = (id: string) => ({
    id,
    title: windows.get(id)?.title ?? '',
    focused: false,
    terminal_ids: [...surfaces.entries()]
      .filter(([, s]) => s.windowId === id)
      .map(([surfaceId]) => surfaceId),
    metadata: windows.get(id)?.metadata ?? {},
  })

  /** `metadata get|set`, in both the surface scope and the managed-window scope. */
  const runMetadata = (args: string[]) => {
    const write = args[1] === 'set'
    const windowId = argAfter(args, '--window-id')
    if (windowId !== undefined) {
      if (!windowsApi) throw new Error(WINDOWS_UNSUPPORTED)
      const window = windows.get(windowId)
      if (!window) throw new Error(`error: window_not_found: ${windowId}`)
      if (!write) return { stdout: JSON.stringify({ data: window.metadata }), stderr: '' }
      window.metadata = { ...window.metadata, ...(JSON.parse(args[3] ?? '{}') as object) }
      return { stdout: '{}', stderr: '' }
    }
    const surface = surfaces.get(argAfter(args, '-t') ?? '')
    const windowScope = args.includes('--window')
    if (!write) {
      const meta = windowScope ? surface?.windowMeta : surface?.surfaceMeta
      return { stdout: JSON.stringify({ data: meta ?? {} }), stderr: '' }
    }
    if (surface) {
      const payload = JSON.parse(args[4] ?? '{}') as Record<string, unknown>
      if (windowScope) surface.windowMeta = { ...surface.windowMeta, ...payload }
      else surface.surfaceMeta = { ...surface.surfaceMeta, ...payload }
    }
    return { stdout: '{}', stderr: '' }
  }

  /** `new --window [--find-or-create-by <json>] [--metadata <json>]`. */
  const runNewWindow = (args: string[]) => {
    const title = argAfter(args, '--title')
    const rawFindBy = argAfter(args, '--find-or-create-by')
    const rawMetadata = argAfter(args, '--metadata')
    if ((rawFindBy !== undefined || rawMetadata !== undefined) && !windowsApi) {
      throw new Error(WINDOWS_UNSUPPORTED)
    }
    const created = (id: string) => JSON.stringify({ ...windowJson(id), created: true })
    if (rawFindBy === undefined) {
      // Legacy `new --window --title` — still a WINDOW object on the wire.
      const id = allocWindow({}, title)
      allocSurface(id, title)
      return { stdout: created(id), stderr: '' }
    }
    const findBy = JSON.parse(rawFindBy) as Record<string, unknown>
    const hit = [...windows.entries()]
      .filter(([, w]) => Object.entries(findBy).every(([k, v]) => w.metadata[k] === v))
      .sort((a, b) => a[1].seq - b[1].seq)[0]
    if (hit) {
      // Pinned semantics: metadata untouched, create payload ignored.
      return { stdout: JSON.stringify({ ...windowJson(hit[0]), created: false }), stderr: '' }
    }
    // Miss: create with metadata merged, find-or-create pairs winning on conflict.
    const metadata = {
      ...((rawMetadata ? JSON.parse(rawMetadata) : {}) as Record<string, unknown>),
      ...findBy,
    }
    const id = allocWindow(metadata, title)
    allocSurface(id, title)
    return { stdout: created(id), stderr: '' }
  }

  const runner = async (args: string[]) => {
    calls.push(args)

    if (args[0] === 'list-windows') {
      if (!windowsApi) throw new Error(WINDOWS_UNSUPPORTED)
      return {
        stdout: JSON.stringify({ windows: [...windows.keys()].map(windowJson) }),
        stderr: '',
      }
    }

    if (args.join(' ') === 'list-surfaces --json') {
      return {
        stdout: JSON.stringify({ terminals: [...surfaces.keys()].map(terminalJson) }),
        stderr: '',
      }
    }

    if (args[0] === 'metadata') return runMetadata(args)

    if (args[0] === 'new' && args.includes('--window')) return runNewWindow(args)

    if (args[0] === 'new') {
      const title = argAfter(args, '--title')
      const windowId = argAfter(args, '--window-id')
      const parent = argAfter(args, '--parent')
      if (windowId !== undefined) {
        if (!windowsApi) throw new Error(WINDOWS_UNSUPPORTED)
        if (!windows.has(windowId)) throw new Error(`error: window_not_found: ${windowId}`)
        return { stdout: JSON.stringify(terminalJson(allocSurface(windowId, title))), stderr: '' }
      }
      const parentSurface = parent === undefined ? undefined : surfaces.get(parent)
      if (parent !== undefined && !parentSurface) {
        throw new Error(`error: Terminal not found: ${parent}`)
      }
      const target = parentSurface?.windowId ?? allocWindow({}, title)
      return { stdout: JSON.stringify(terminalJson(allocSurface(target, title))), stderr: '' }
    }

    if (args[0] === 'new-pane') {
      const target = argAfter(args, '-t')
      const sibling = target === undefined ? undefined : surfaces.get(target)
      if (!sibling) throw new Error(`error: Terminal not found: ${target}`)
      return { stdout: JSON.stringify(terminalJson(allocSurface(sibling.windowId))), stderr: '' }
    }

    if (args[0] === 'set-title') {
      const surface = surfaces.get(argAfter(args, '-t') ?? '')
      if (surface) surface.title = args[3]
      return { stdout: '{}', stderr: '' }
    }

    if (args[0] === 'kill-surface') {
      surfaces.delete(argAfter(args, '-t') ?? '')
      return { stdout: '{}', stderr: '' }
    }

    return { stdout: '{}', stderr: '' }
  }

  /**
   * Upstream managed+managed hand-merge (macOS native tab drag): the SENIOR entry
   * wins, the junior window id AND its metadata retire, and the junior's panes
   * survive inside the winner — still wearing their old `hrc_window_key`.
   */
  const handMerge = (loserWindowId: string, winnerWindowId: string) => {
    for (const surface of surfaces.values()) {
      if (surface.windowId === loserWindowId) surface.windowId = winnerWindowId
    }
    windows.delete(loserWindowId)
  }

  const agentPanes = () =>
    [...surfaces.entries()].filter(([, s]) => s.surfaceMeta['hrc_role'] === 'headless-agent-pane')
  const anchors = () =>
    [...surfaces.entries()].filter(
      ([, s]) => s.surfaceMeta['hrc_role'] === 'headless-window-anchor'
    )
  const windowFor = (key: string) =>
    [...windows.entries()].find(([, w]) => w.metadata['hrc_window_key'] === key)?.[0]

  return {
    runner,
    calls,
    surfaces,
    windows,
    agentPanes,
    anchors,
    handMerge,
    windowFor,
    allocWindow,
    allocSurface,
  }
}

const CLOD = 'agent:clod:project:hrc-runtime:task:primary'
const CURLY = 'agent:curly:project:hrc-runtime:task:primary'
const MOE = 'agent:moe:project:hrc-runtime:task:primary'
const TAB_KEY = 'project:hrc-runtime:primary'

const findOrCreateCalls = (calls: string[][]) =>
  calls.filter((c) => c[0] === 'new' && c.includes('--find-or-create-by'))
const windowIdTabCalls = (calls: string[][]) =>
  calls.filter((c) => c[0] === 'new' && c.includes('--tab') && c.includes('--window-id'))

describe('T-07121 windows-API capability probe', () => {
  it('probes once per manager and takes the managed path', async () => {
    const fake = makeFakeGhostmux()
    const manager = new GhostmuxManager('ghostmux', fake.runner)

    await manager.ensureHeadlessViewer({ scopeRef: CLOD, runtimeId: 'rt-1', attachCommand: 'a1' })
    await manager.ensureHeadlessViewer({ scopeRef: CURLY, runtimeId: 'rt-2', attachCommand: 'a2' })
    await manager.ensureHeadlessViewer({
      scopeRef: MOE,
      runtimeId: 'rt-3',
      attachCommand: 'a3',
      windowKey: 'console',
    })

    expect(fake.calls.filter((c) => c[0] === 'list-windows')).toHaveLength(1)
    // No anchor pane is ever created or stamped on the managed path.
    expect(fake.anchors()).toHaveLength(0)
    expect(fake.calls.filter((c) => c.includes('--parent'))).toHaveLength(0)
  })

  it('memoizes the probe OFF on an old build and keeps the legacy anchor path', async () => {
    const fake = makeFakeGhostmux({ windowsApi: false })
    const manager = new GhostmuxManager('ghostmux', fake.runner)

    await manager.ensureHeadlessViewer({
      scopeRef: CLOD,
      runtimeId: 'rt-1',
      attachCommand: 'a1',
      windowKey: 'console',
    })
    await manager.ensureHeadlessViewer({
      scopeRef: CURLY,
      runtimeId: 'rt-2',
      attachCommand: 'a2',
      windowKey: 'other',
    })

    expect(fake.calls.filter((c) => c[0] === 'list-windows')).toHaveLength(1)
    expect(findOrCreateCalls(fake.calls)).toHaveLength(0)
    expect(windowIdTabCalls(fake.calls)).toHaveLength(0)
    // The legacy anchor: a plain `new --window --title`, stamped with both roles,
    // and the `--parent` target for the task tab.
    expect(fake.anchors()).toHaveLength(2)
    const anchorIds = fake.anchors().map(([id]) => id)
    const parents = fake.calls
      .filter((c) => c.includes('--parent'))
      .map((c) => c[c.indexOf('--parent') + 1])
    expect(parents.sort()).toEqual(anchorIds.sort())
    expect(fake.agentPanes()).toHaveLength(2)
  })

  it('does not memoize a transient probe failure', async () => {
    let failNext = true
    const fake = makeFakeGhostmux()
    const manager = new GhostmuxManager('ghostmux', async (args) => {
      if (args[0] === 'list-windows' && failNext) {
        failNext = false
        throw new Error('ghostmux: could not connect to the Ghostty API socket')
      }
      return fake.runner(args)
    })

    await manager.ensureHeadlessViewer({ scopeRef: CLOD, runtimeId: 'rt-1', attachCommand: 'a1' })
    await manager.ensureHeadlessViewer({ scopeRef: CURLY, runtimeId: 'rt-2', attachCommand: 'a2' })

    // First dispatch fell back to legacy; the second re-probed and went managed.
    expect(findOrCreateCalls(fake.calls)).toHaveLength(1)
  })
})

describe('T-07121 keyed window find-or-create', () => {
  it('resolves the keyed window in ONE call with the pinned shape', async () => {
    const fake = makeFakeGhostmux()
    const manager = new GhostmuxManager('ghostmux', fake.runner)

    await manager.ensureHeadlessViewer({
      scopeRef: CLOD,
      runtimeId: 'rt-1',
      attachCommand: 'a1',
      windowKey: 'console',
    })

    const [call] = findOrCreateCalls(fake.calls)
    expect(call).toBeDefined()
    expect(call?.[0]).toBe('new')
    expect(call).toContain('--window')
    expect(call?.[call.indexOf('--find-or-create-by') + 1]).toBe('{"hrc_window_key":"console"}')
    expect(JSON.parse(call?.[call.indexOf('--metadata') + 1] ?? '{}')).toEqual({
      hrc_role: 'headless-sessions-window',
      hrc_window_key: 'console',
    })
    expect(call).toContain('--json')
    // The window itself carries the key — no anchor pane involved.
    expect(fake.windows.get(fake.windowFor('console') ?? '')?.metadata).toMatchObject({
      hrc_role: 'headless-sessions-window',
      hrc_window_key: 'console',
    })
  })

  it('a second session reuses the same window (created:false) and splits the shared tab', async () => {
    const fake = makeFakeGhostmux()
    const manager = new GhostmuxManager('ghostmux', fake.runner)

    await manager.ensureHeadlessViewer({
      scopeRef: CLOD,
      runtimeId: 'rt-1',
      attachCommand: 'a1',
      windowKey: 'console',
    })
    await manager.ensureHeadlessViewer({
      scopeRef: CURLY,
      runtimeId: 'rt-2',
      attachCommand: 'a2',
      windowKey: 'console',
    })

    expect(findOrCreateCalls(fake.calls)).toHaveLength(2)
    expect(fake.windows.size).toBe(1)
    // Same tabKey in the same window ⇒ one tab, two panes.
    expect(windowIdTabCalls(fake.calls)).toHaveLength(1)
    expect(fake.calls.filter((c) => c[0] === 'new-pane')).toHaveLength(1)
    expect(fake.agentPanes()).toHaveLength(2)
    expect(new Set(fake.agentPanes().map(([, s]) => s.windowId)).size).toBe(1)
  })

  it('creates fresh tabs by --window-id, never by --parent', async () => {
    const fake = makeFakeGhostmux()
    const manager = new GhostmuxManager('ghostmux', fake.runner)

    await manager.ensureHeadlessViewer({
      scopeRef: 'agent:clod:project:hrc-runtime:task:T-07121',
      runtimeId: 'rt-1',
      attachCommand: 'a1',
      windowKey: 'console',
    })
    await manager.ensureHeadlessViewer({
      scopeRef: 'agent:clod:project:hrc-runtime:task:T-07118',
      runtimeId: 'rt-2',
      attachCommand: 'a2',
      windowKey: 'console',
    })

    const consoleWindow = fake.windowFor('console')
    const tabCalls = windowIdTabCalls(fake.calls)
    expect(tabCalls).toHaveLength(2)
    for (const call of tabCalls) {
      expect(call[call.indexOf('--window-id') + 1]).toBe(consoleWindow)
    }
    expect(fake.calls.filter((c) => c.includes('--parent'))).toHaveLength(0)
  })

  it('window keys stay isolated: a console pane never joins the default window', async () => {
    const fake = makeFakeGhostmux()
    const manager = new GhostmuxManager('ghostmux', fake.runner)

    await manager.ensureHeadlessViewer({ scopeRef: CLOD, runtimeId: 'rt-1', attachCommand: 'a1' })
    await manager.ensureHeadlessViewer({
      scopeRef: CURLY,
      runtimeId: 'rt-2',
      attachCommand: 'a2',
      windowKey: 'console',
    })

    expect(fake.windows.size).toBe(2)
    expect(fake.calls.filter((c) => c[0] === 'new-pane')).toHaveLength(0)
    const panes = fake.agentPanes()
    expect(panes.map(([, s]) => s.surfaceMeta['hrc_tab_key'])).toEqual([TAB_KEY, TAB_KEY])
    expect(new Set(panes.map(([, s]) => s.windowId)).size).toBe(2)
  })

  it('adopts a window an operator stamped by window metadata', async () => {
    const fake = makeFakeGhostmux()
    const manager = new GhostmuxManager('ghostmux', fake.runner)

    // The documented one-time adoption: enumerate windows, stamp the key.
    const adopted = fake.allocWindow(
      { hrc_role: 'headless-sessions-window', hrc_window_key: 'console' },
      'Lance console'
    )
    fake.allocSurface(adopted, 'a real tab Lance uses')

    await manager.ensureHeadlessViewer({
      scopeRef: CLOD,
      runtimeId: 'rt-1',
      attachCommand: 'a1',
      windowKey: 'console',
    })

    expect(fake.windows.size).toBe(1)
    const tabCall = windowIdTabCalls(fake.calls)[0]
    expect(tabCall?.[tabCall.indexOf('--window-id') + 1]).toBe(adopted)
    expect(fake.agentPanes()[0]?.[1].windowId).toBe(adopted)
  })
})

describe('T-07121 residency-fenced split target (daedalus #17988)', () => {
  it('REJECTS a metadata-matching pane that physically lives in another window', async () => {
    const fake = makeFakeGhostmux()
    const manager = new GhostmuxManager('ghostmux', fake.runner)

    // Two managed keyed windows, each with one pane for the SAME tabKey.
    await manager.ensureHeadlessViewer({
      scopeRef: CLOD,
      runtimeId: 'rt-1',
      attachCommand: 'a1',
      windowKey: 'console',
    })
    await manager.ensureHeadlessViewer({ scopeRef: CURLY, runtimeId: 'rt-2', attachCommand: 'a2' })

    const consoleWindow = fake.windowFor('console')
    const defaultWindow = fake.windowFor('default')
    expect(consoleWindow).toBeDefined()
    expect(defaultWindow).toBeDefined()

    // Operator hand-merges the console window INTO the default one: the console
    // registry entry (id + metadata) retires, but its pane survives in the winner
    // still stamped `hrc_window_key: console`.
    fake.handMerge(consoleWindow ?? '', defaultWindow ?? '')
    const stalePane = fake
      .agentPanes()
      .find(([, s]) => s.surfaceMeta['hrc_window_key'] === 'console')
    expect(stalePane?.[1].windowId).toBe(defaultWindow)

    const before = fake.calls.length
    await manager.ensureHeadlessViewer({
      scopeRef: MOE,
      runtimeId: 'rt-3',
      attachCommand: 'a3',
      windowKey: 'console',
    })
    const after = fake.calls.slice(before)

    // A FRESH console window was created and the new pane landed IN it — not
    // split into the stale-keyed pane sitting in the merge winner.
    const freshConsole = fake.windowFor('console')
    expect(freshConsole).toBeDefined()
    expect(freshConsole).not.toBe(consoleWindow)
    expect(after.filter((c) => c[0] === 'new-pane')).toHaveLength(0)
    const tabCall = windowIdTabCalls(after)[0]
    expect(tabCall?.[tabCall.indexOf('--window-id') + 1]).toBe(freshConsole)
    const newPane = fake.agentPanes().find(([, s]) => s.surfaceMeta['hrc_runtime_id'] === 'rt-3')
    expect(newPane?.[1].windowId).toBe(freshConsole)
    // The stale metadata is left in place — inert, since reuse keys on paneKey.
    expect(stalePane?.[1].surfaceMeta['hrc_window_key']).toBe('console')
  })

  it('ACCEPTS a metadata-matching pane that resides in the returned window', async () => {
    const fake = makeFakeGhostmux()
    const manager = new GhostmuxManager('ghostmux', fake.runner)

    await manager.ensureHeadlessViewer({
      scopeRef: CLOD,
      runtimeId: 'rt-1',
      attachCommand: 'a1',
      windowKey: 'console',
    })
    const before = fake.calls.length
    await manager.ensureHeadlessViewer({
      scopeRef: CURLY,
      runtimeId: 'rt-2',
      attachCommand: 'a2',
      windowKey: 'console',
    })
    const after = fake.calls.slice(before)

    const splitCall = after.find((c) => c[0] === 'new-pane')
    expect(splitCall).toBeDefined()
    expect(splitCall?.[splitCall.indexOf('-t') + 1]).toBe(fake.agentPanes()[0]?.[0])
    expect(windowIdTabCalls(after)).toHaveLength(0)
  })

  it('rejects a candidate whose residency cannot be read (fails closed)', async () => {
    const fake = makeFakeGhostmux()
    // A build that serves the windows API but omits `window_id` on list-surfaces
    // must never be trusted to place by metadata alone.
    const manager = new GhostmuxManager('ghostmux', async (args) => {
      const result = await fake.runner(args)
      if (args.join(' ') !== 'list-surfaces --json') return result
      const parsed = JSON.parse(result.stdout) as { terminals: Record<string, unknown>[] }
      const terminals = parsed.terminals.map(({ window_id: _dropped, ...rest }) => rest)
      return { stdout: JSON.stringify({ terminals }), stderr: '' }
    })

    await manager.ensureHeadlessViewer({
      scopeRef: CLOD,
      runtimeId: 'rt-1',
      attachCommand: 'a1',
      windowKey: 'console',
    })
    const before = fake.calls.length
    await manager.ensureHeadlessViewer({
      scopeRef: CURLY,
      runtimeId: 'rt-2',
      attachCommand: 'a2',
      windowKey: 'console',
    })

    expect(fake.calls.slice(before).filter((c) => c[0] === 'new-pane')).toHaveLength(0)
    expect(windowIdTabCalls(fake.calls.slice(before))).toHaveLength(1)
  })

  it('locks the order: find-or-create runs BEFORE candidate evaluation', async () => {
    const fake = makeFakeGhostmux()
    const manager = new GhostmuxManager('ghostmux', fake.runner)

    await manager.ensureHeadlessViewer({
      scopeRef: CLOD,
      runtimeId: 'rt-1',
      attachCommand: 'a1',
      windowKey: 'console',
    })

    const findOrCreateAt = fake.calls.findIndex((c) => c.includes('--find-or-create-by'))
    const tabCreateAt = fake.calls.findIndex(
      (c) => c[0] === 'new' && c.includes('--window-id') && c.includes('--tab')
    )
    const sweepsAt = fake.calls
      .map((c, index) => ({ c, index }))
      .filter(({ c }) => c.join(' ') === 'list-surfaces --json')
      .map(({ index }) => index)

    expect(findOrCreateAt).toBeGreaterThanOrEqual(0)
    expect(tabCreateAt).toBeGreaterThan(findOrCreateAt)
    // Exactly ONE sweep precedes find-or-create — the global pane-REUSE lookup,
    // which is placement-independent. Any additional pre-window sweep means split
    // candidates were evaluated before the keyed window was resolved, which is the
    // ordering daedalus #17988 forbids.
    expect(sweepsAt.filter((at) => at < findOrCreateAt)).toHaveLength(1)
    // And exactly one AFTER it: the residency-fenced candidate evaluation.
    expect(sweepsAt.filter((at) => at > findOrCreateAt && at < tabCreateAt)).toHaveLength(1)
  })
})

describe('T-07121 untouched paths', () => {
  it('pane reuse stays GLOBAL and wins over placement', async () => {
    const fake = makeFakeGhostmux()
    const manager = new GhostmuxManager('ghostmux', fake.runner)

    await manager.ensureHeadlessViewer({ scopeRef: CLOD, runtimeId: 'rt-1', attachCommand: 'a1' })
    const result = await manager.ensureHeadlessViewer({
      scopeRef: CLOD,
      runtimeId: 'rt-2',
      attachCommand: 'a2',
      windowKey: 'console',
    })

    expect(result.status).toBe('reused')
    expect(fake.agentPanes()).toHaveLength(1)
    expect(fake.agentPanes()[0]?.[1].surfaceMeta['hrc_runtime_id']).toBe('rt-2')
    // Reuse never even resolves a keyed window.
    expect(findOrCreateCalls(fake.calls)).toHaveLength(1)
  })

  it('reap stays runtime-fenced and metadata-only', async () => {
    const fake = makeFakeGhostmux()
    const manager = new GhostmuxManager('ghostmux', fake.runner)

    await manager.ensureHeadlessViewer({
      scopeRef: CLOD,
      runtimeId: 'rt-1',
      attachCommand: 'a1',
      windowKey: 'console',
    })
    await manager.ensureHeadlessViewer({ scopeRef: CURLY, runtimeId: 'rt-2', attachCommand: 'a2' })
    const consolePane = fake
      .agentPanes()
      .find(([, s]) => s.surfaceMeta['hrc_window_key'] === 'console')?.[0]

    expect(await manager.reapHeadlessAgentPane(consolePane ?? '', 'rt-9')).toMatchObject({
      status: 'skipped',
      reason: 'runtime_rebound',
    })
    expect(await manager.reapHeadlessAgentPane(consolePane ?? '', 'rt-1')).toMatchObject({
      status: 'reaped',
      tabCollapsed: true,
    })
  })

  it('stamps the same agent-pane metadata as before the cutover', async () => {
    const fake = makeFakeGhostmux()
    const manager = new GhostmuxManager('ghostmux', fake.runner)

    await manager.ensureHeadlessViewer({
      scopeRef: 'agent:clod:project:hrc-runtime:task:T-07121',
      runtimeId: 'rt-1',
      attachCommand: 'a1',
      windowKey: 'console',
    })

    expect(fake.agentPanes()[0]?.[1].surfaceMeta).toMatchObject({
      hrc_role: 'headless-agent-pane',
      hrc_window_key: 'console',
      hrc_tab_key: 'task:T-07121',
      hrc_pane_key: 'agent:clod:project:hrc-runtime:task:T-07121#main',
      hrc_agent_id: 'clod',
      hrc_runtime_id: 'rt-1',
    })
  })
})
