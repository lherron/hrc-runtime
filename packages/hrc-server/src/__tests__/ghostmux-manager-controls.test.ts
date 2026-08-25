import { describe, expect, it } from 'bun:test'

import { GhostmuxManager } from '../ghostmux'

/**
 * A metadata-modeling fake ghostmux (T-05237). Tracks live surfaces with both
 * surface-level and window-level metadata so the topology the code derives FROM
 * metadata (its only authority) is observable. `new`/`new-pane` allocate ids;
 * `kill-surface` removes them; `metadata set/get` round-trips per scope.
 */
function makeFakeGhostmux() {
  type Surf = {
    surfaceMeta: Record<string, unknown>
    windowMeta: Record<string, unknown>
    title?: string | undefined
    columns: number
    rows: number
  }
  const surfaces = new Map<string, Surf>()
  const calls: string[][] = []
  let counter = 0
  const alloc = (title?: string | undefined): string => {
    counter += 1
    const id = `surf-${counter}`
    surfaces.set(id, { surfaceMeta: {}, windowMeta: {}, title, columns: 120, rows: 40 })
    return id
  }
  const runner = async (args: string[]) => {
    calls.push(args)
    const key = args.join(' ')
    // Pinned to a PRE-windows-API build (T-07121): this suite is the legacy
    // anchor-path regression, and the capability probe must fail closed onto it.
    if (args[0] === 'list-windows') {
      throw new Error('server does not support the windows API; update ScriptableGhostty')
    }
    if (key === 'list-surfaces --json') {
      return {
        stdout: JSON.stringify({
          terminals: [...surfaces.entries()].map(([id, s]) => ({
            id,
            title: s.title,
            columns: s.columns,
            rows: s.rows,
          })),
        }),
        stderr: '',
      }
    }
    if (args[0] === 'metadata' && args[1] === 'get') {
      const s = surfaces.get(args[3] ?? '')
      const meta = args.includes('--window') ? s?.windowMeta : s?.surfaceMeta
      return { stdout: JSON.stringify({ data: meta ?? {} }), stderr: '' }
    }
    if (args[0] === 'metadata' && args[1] === 'set') {
      const s = surfaces.get(args[3] ?? '')
      if (s) {
        const payload = JSON.parse(args[4] ?? '{}') as Record<string, unknown>
        if (args.includes('--window')) s.windowMeta = { ...s.windowMeta, ...payload }
        else s.surfaceMeta = { ...s.surfaceMeta, ...payload }
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
    if (args[0] === 'new-pane') {
      return { stdout: JSON.stringify({ id: alloc() }), stderr: '' }
    }
    if (args[0] === 'set-title') {
      const s = surfaces.get(args[2] ?? '')
      if (s) s.title = args[3]
      return { stdout: '{}', stderr: '' }
    }
    if (args[0] === 'kill-surface') {
      surfaces.delete(args[2] ?? '')
      return { stdout: '{}', stderr: '' }
    }
    return { stdout: '{}', stderr: '' }
  }
  const surfaceMeta = (id: string) => surfaces.get(id)?.surfaceMeta
  const liveIds = () => [...surfaces.keys()]
  const agentPanes = () =>
    [...surfaces.entries()].filter(([, s]) => s.surfaceMeta['hrc_role'] === 'headless-agent-pane')
  const anchors = () =>
    [...surfaces.entries()].filter(
      ([, s]) => s.surfaceMeta['hrc_role'] === 'headless-window-anchor'
    )
  return { runner, calls, surfaces, surfaceMeta, liveIds, agentPanes, anchors }
}

describe('GhostmuxManager.reapHeadlessAgentPane (runtime-fenced, daedalus C4)', () => {
  const cloRef = 'agent:clod:project:hrc-runtime:task:T-05237'
  const curlyRef = 'agent:curly:project:hrc-runtime:task:T-05237'

  it('reaps the pane bound to the terminating runtime and reports tab collapse', async () => {
    const fake = makeFakeGhostmux()
    const manager = new GhostmuxManager('ghostmux', fake.runner)
    await manager.ensureHeadlessViewer({ scopeRef: cloRef, runtimeId: 'rt-1', attachCommand: 'a' })
    const paneId = fake.agentPanes()[0]?.[0] ?? ''

    const result = await manager.reapHeadlessAgentPane(paneId, 'rt-1')
    expect(result).toEqual({ status: 'reaped', surfaceId: paneId, tabCollapsed: true })
    expect(fake.liveIds()).not.toContain(paneId)
  })

  it('does NOT collapse the tab while a sibling agent pane survives', async () => {
    const fake = makeFakeGhostmux()
    const manager = new GhostmuxManager('ghostmux', fake.runner)
    await manager.ensureHeadlessViewer({ scopeRef: cloRef, runtimeId: 'rt-1', attachCommand: 'a' })
    await manager.ensureHeadlessViewer({
      scopeRef: curlyRef,
      runtimeId: 'rt-2',
      attachCommand: 'b',
    })
    const cloPane =
      fake.agentPanes().find(([, s]) => s.surfaceMeta['hrc_agent_id'] === 'clod')?.[0] ?? ''

    const result = await manager.reapHeadlessAgentPane(cloPane, 'rt-1')
    expect(result).toEqual({ status: 'reaped', surfaceId: cloPane, tabCollapsed: false })
    expect(fake.agentPanes()).toHaveLength(1)
  })

  it('FENCE: refuses to reap a pane already rebound to a newer runtime', async () => {
    const fake = makeFakeGhostmux()
    const manager = new GhostmuxManager('ghostmux', fake.runner)
    await manager.ensureHeadlessViewer({ scopeRef: cloRef, runtimeId: 'rt-1', attachCommand: 'a' })
    const paneId = fake.agentPanes()[0]?.[0] ?? ''
    // Reuse rebinds to rt-2.
    await manager.ensureHeadlessViewer({ scopeRef: cloRef, runtimeId: 'rt-2', attachCommand: 'a2' })

    // A stale terminal event for rt-1 must NOT kill the pane.
    const result = await manager.reapHeadlessAgentPane(paneId, 'rt-1')
    expect(result).toEqual({ status: 'skipped', reason: 'runtime_rebound' })
    expect(fake.liveIds()).toContain(paneId)
  })

  it('never kills the window anchor', async () => {
    const fake = makeFakeGhostmux()
    const manager = new GhostmuxManager('ghostmux', fake.runner)
    await manager.ensureHeadlessViewer({ scopeRef: cloRef, runtimeId: 'rt-1', attachCommand: 'a' })
    const anchorId = fake.anchors()[0]?.[0] ?? ''

    const result = await manager.reapHeadlessAgentPane(anchorId, 'rt-1')
    expect(result).toEqual({ status: 'skipped', reason: 'not_agent_pane' })
    expect(fake.liveIds()).toContain(anchorId)
  })
})

describe('GhostmuxManager.setStatusBar', () => {
  it('emits the canonical statusbar set argv', async () => {
    const calls: string[][] = []
    const manager = new GhostmuxManager('ghostmux', async (args) => {
      calls.push(args)
      return { stdout: '{}', stderr: '' }
    })

    await manager.setStatusBar('surf-1', {
      left: '◆ CODY',
      center: 'wrkq · T-1',
      right: '✓ idle',
      fg: '#F2EEE6',
      bg: '#1F7A78',
    })

    expect(calls).toEqual([
      [
        'statusbar',
        'set',
        '-t',
        'surf-1',
        '◆ CODY|wrkq · T-1|✓ idle',
        '--fg',
        '#F2EEE6',
        '--bg',
        '#1F7A78',
      ],
    ])
  })

  it('sanitizes pipe/newline characters out of fields', async () => {
    const calls: string[][] = []
    const manager = new GhostmuxManager('ghostmux', async (args) => {
      calls.push(args)
      return { stdout: '{}', stderr: '' }
    })

    await manager.setStatusBar('surf-1', {
      left: 'a|b',
      center: 'c\nd',
      right: 'e',
    })

    expect(calls[0]?.[4]).toBe('a b|c d|e')
  })

  it('swallows failures and never throws', async () => {
    const manager = new GhostmuxManager('ghostmux', async () => {
      throw new Error('transient surface error')
    })
    await expect(
      manager.setStatusBar('surf-1', { left: 'a', center: 'b', right: 'c' })
    ).resolves.toBeUndefined()
  })

  it('memoizes an unsupported-statusbar capability and stops calling ghostmux', async () => {
    let count = 0
    const manager = new GhostmuxManager('ghostmux', async () => {
      count++
      throw new Error('error: unknown command "statusbar"')
    })

    await manager.setStatusBar('surf-1', { left: 'a', center: 'b', right: 'c' })
    await manager.setStatusBar('surf-1', { left: 'a', center: 'b', right: 'c' })

    expect(count).toBe(1)
  })
})

describe('GhostmuxManager.setTerminalBackground', () => {
  it('emits the set-bg argv', async () => {
    const calls: string[][] = []
    const manager = new GhostmuxManager('ghostmux', async (args) => {
      calls.push(args)
      return { stdout: '{}', stderr: '' }
    })
    await manager.setTerminalBackground('surf-1', '#241B36')
    expect(calls).toEqual([['set-bg', '-t', 'surf-1', '#241B36', '--json']])
  })

  it('swallows failures and never throws', async () => {
    const manager = new GhostmuxManager('ghostmux', async () => {
      throw new Error('no such surface')
    })
    await expect(manager.setTerminalBackground('surf-1', '#241B36')).resolves.toBeUndefined()
  })

  it('memoizes set-bg unsupported SEPARATELY from statusbar', async () => {
    let setBgCalls = 0
    let statusBarCalls = 0
    const manager = new GhostmuxManager('ghostmux', async (args) => {
      if (args[0] === 'set-bg') {
        setBgCalls++
        throw new Error('error: unknown command "set-bg"')
      }
      statusBarCalls++
      return { stdout: '{}', stderr: '' }
    })

    await manager.setTerminalBackground('surf-1', '#241B36')
    await manager.setTerminalBackground('surf-1', '#241B36')
    // set-bg memoized off after the first failure
    expect(setBgCalls).toBe(1)
    // statusbar capability is unaffected by the set-bg memo
    await manager.setStatusBar('surf-1', { left: 'a', center: 'b', right: 'c' })
    expect(statusBarCalls).toBe(1)
  })
})
