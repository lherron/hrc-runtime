import { describe, expect, it } from 'bun:test'

import { GhostmuxManager, deriveHeadlessTabIdentity, parseGhostmuxSurfaceState } from '../ghostmux'

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

describe('parseGhostmuxSurfaceState', () => {
  it('parses list/new style terminal JSON', () => {
    const state = parseGhostmuxSurfaceState(
      JSON.stringify({
        id: 'surface-1',
        short_id: 'surface',
        name: 'calm-field',
        title: 'Claude Surfaces',
        working_directory: '/tmp/project',
        rows: 40,
        columns: 120,
        focused: true,
      })
    )

    expect(state).toEqual({
      kind: 'ghostty',
      surfaceId: 'surface-1',
      shortId: 'surface',
      name: 'calm-field',
      title: 'Claude Surfaces',
      cwd: '/tmp/project',
      rows: 40,
      columns: 120,
      focused: true,
      createdBy: 'ghostmux',
    })
  })
})

describe('GhostmuxManager', () => {
  it('discovers the shared Claude tab and creates runtime panes with metadata', async () => {
    const calls: string[][] = []
    const manager = new GhostmuxManager('ghostmux', async (args) => {
      calls.push(args)
      const key = args.join(' ')
      if (key === 'list-surfaces --json') {
        return {
          stdout: JSON.stringify({
            terminals: [{ id: 'anchor-1', title: 'Claude Surfaces', columns: 160, rows: 40 }],
          }),
          stderr: '',
        }
      }
      if (key === 'metadata get -t anchor-1 --window --json') {
        return {
          stdout: JSON.stringify({ hrc_role: 'claude-surfaces', hrc_project: 'hrc-runtime' }),
          stderr: '',
        }
      }
      if (key === 'new-pane -t anchor-1 -d right --cwd /tmp/project --json') {
        return {
          stdout: JSON.stringify({ id: 'pane-1', title: '/tmp/project' }),
          stderr: '',
        }
      }
      return { stdout: '{}', stderr: '' }
    })

    const surface = await manager.ensureSurface('hsid-1', 'reuse_pty', {
      cwd: '/tmp/project',
      title: 'claude-code: cody@hrc-runtime:T-01588',
      runtimeId: 'rt-1',
      hostSessionId: 'hsid-1',
      scopeRef: 'agent:cody:project:hrc-runtime:task:T-01588',
      generation: 1,
      projectId: 'hrc-runtime',
    })

    expect(surface.surfaceId).toBe('pane-1')
    expect(surface.anchorSurfaceId).toBe('anchor-1')
    expect(calls).toContainEqual(['equalize-panes', '-t', 'anchor-1'])
    expect(calls).toContainEqual([
      'new-pane',
      '-t',
      'anchor-1',
      '-d',
      'right',
      '--cwd',
      '/tmp/project',
      '--json',
    ])
    expect(calls).toContainEqual([
      'set-title',
      '-t',
      'pane-1',
      'claude-code: cody@hrc-runtime:T-01588',
    ])
    expect(calls).toContainEqual([
      'metadata',
      'set',
      '-t',
      'pane-1',
      JSON.stringify({
        hrc_role: 'claude-runtime',
        hrc_runtime_id: 'rt-1',
        hrc_host_session_id: 'hsid-1',
        hrc_scope_ref: 'agent:cody:project:hrc-runtime:task:T-01588',
        hrc_generation: 1,
      }),
      '--json',
    ])
    expect(calls).toContainEqual(['equalize-panes', '-t', 'pane-1'])
  })

  it('understands ghostmux metadata responses wrapped in data', async () => {
    const calls: string[][] = []
    const manager = new GhostmuxManager('ghostmux', async (args) => {
      calls.push(args)
      const key = args.join(' ')
      if (key === 'list-surfaces --json') {
        return {
          stdout: JSON.stringify({
            terminals: [{ id: 'anchor-1', title: 'Claude Surfaces', columns: 160, rows: 40 }],
          }),
          stderr: '',
        }
      }
      if (key === 'metadata get -t anchor-1 --window --json') {
        return {
          stdout: JSON.stringify({
            data: { hrc_role: 'claude-surfaces', hrc_project: 'agent-spaces' },
          }),
          stderr: '',
        }
      }
      if (key === 'new-pane -t anchor-1 -d right --cwd /tmp/agent-spaces --json') {
        return {
          stdout: JSON.stringify({ id: 'pane-1', title: '/tmp/agent-spaces' }),
          stderr: '',
        }
      }
      return { stdout: '{}', stderr: '' }
    })

    const surface = await manager.ensureSurface('hsid-1', 'reuse_pty', {
      cwd: '/tmp/agent-spaces',
      title: 'claude-code: clod@agent-spaces:primary',
      runtimeId: 'rt-1',
      hostSessionId: 'hsid-1',
      scopeRef: 'agent:clod:project:agent-spaces:task:primary',
      generation: 1,
      projectId: 'agent-spaces',
    })

    expect(surface.anchorSurfaceId).toBe('anchor-1')
    expect(calls).not.toContainEqual([
      'new',
      '--tab',
      '--cwd',
      '/tmp/agent-spaces',
      '--title',
      'Claude Surfaces',
      '--json',
    ])
  })

  it('sends literal text without enter and enter separately', async () => {
    const calls: string[][] = []
    const manager = new GhostmuxManager('ghostmux', async (args) => {
      calls.push(args)
      return { stdout: '{}', stderr: '' }
    })

    await manager.sendLiteral('pane-1', 'hello')
    await manager.sendEnter('pane-1')
    await manager.sendKeys('pane-1', 'launch command')
    await manager.interrupt('pane-1')
    await manager.terminate('pane-1')

    expect(manager.getAttachDescriptor('pane-1').argv).toEqual([
      'ghostmux',
      'stream-surface',
      '-t',
      'pane-1',
    ])
    expect(calls).toEqual([
      ['send-keys', '-t', 'pane-1', '-l', '--no-enter', 'hello'],
      ['send-key', '-t', 'pane-1', 'Enter'],
      ['send-keys', '-t', 'pane-1', '-l', 'launch command'],
      ['send-key', '-t', 'pane-1', 'C-c'],
      ['kill-surface', '-t', 'pane-1', '--force'],
    ])
  })
})

// ---------------------------------------------------------------------------
// T-05237: canonical tab-key derivation (daedalus required test #1)
// ---------------------------------------------------------------------------
describe('deriveHeadlessTabIdentity', () => {
  it('maps a real task scope to task:<T-XXXXX>', () => {
    const id = deriveHeadlessTabIdentity('agent:clod:project:hrc-runtime:task:T-05237')
    expect(id).toEqual({
      tabKey: 'task:T-05237',
      agentId: 'clod',
      taskId: 'T-05237',
      projectId: 'hrc-runtime',
      label: 'hrc · T-05237',
    })
  })

  it('maps a primary scope to a project-qualified key (never bare primary)', () => {
    const id = deriveHeadlessTabIdentity('agent:clod:project:hrc-runtime:task:primary')
    expect(id.tabKey).toBe('project:hrc-runtime:primary')
    expect(id.agentId).toBe('clod')
    expect(id.label).toBe('hrc · primary')
  })

  it('does NOT collide two primary scopes from different projects', () => {
    const a = deriveHeadlessTabIdentity('agent:clod:project:hrc-runtime:task:primary')
    const b = deriveHeadlessTabIdentity('agent:smokey:project:agent-control-plane:task:primary')
    expect(a.tabKey).not.toBe(b.tabKey)
  })

  it('qualifies an agent-only ref by agent root when no project is present', () => {
    const id = deriveHeadlessTabIdentity('agent:daedalus')
    expect(id.tabKey).toBe('project:agent-root-daedalus:primary')
    expect(id.agentId).toBe('daedalus')
  })

  it('falls back to an unparsed key for a malformed ref (never throws)', () => {
    const id = deriveHeadlessTabIdentity('::::garbage::::')
    expect(id.tabKey.startsWith('unparsed:')).toBe(true)
    expect(id.agentId).toBe('unknown')
  })
})

describe('GhostmuxManager.ensureHeadlessViewer (consolidated window/tab/pane)', () => {
  const cloRef = 'agent:clod:project:hrc-runtime:task:T-05237'
  const curlyRef = 'agent:curly:project:hrc-runtime:task:T-05237'

  it('first agent: creates ONE window + a task tab pane, attach-then-title-last', async () => {
    const fake = makeFakeGhostmux()
    const manager = new GhostmuxManager('ghostmux', fake.runner)

    const result = await manager.ensureHeadlessViewer({
      scopeRef: cloRef,
      runtimeId: 'rt-1',
      attachCommand: 'tmux attach; hrc session-report --wait-key --wait-timeout 30; exit',
    })

    expect(result.status).toBe('created')
    expect(result).toMatchObject({ tabKey: 'task:T-05237' })
    // Exactly one anchor window + one agent pane.
    expect(fake.anchors()).toHaveLength(1)
    expect(fake.agentPanes()).toHaveLength(1)
    // First tab created by parenting off the window anchor, NOT a second window.
    const newCalls = fake.calls.filter((c) => c[0] === 'new')
    expect(newCalls.some((c) => c.includes('--window'))).toBe(true)
    expect(newCalls.some((c) => c.includes('--tab') && c.includes('--parent'))).toBe(true)
    expect(fake.calls.flat()).not.toContain('--focus')
    // Ordering: send-keys (attach) BEFORE set-title (last write).
    const sendIdx = fake.calls.findIndex((c) => c[0] === 'send-keys')
    const titleIdx = fake.calls.findIndex((c) => c[0] === 'set-title')
    expect(sendIdx).toBeGreaterThanOrEqual(0)
    expect(titleIdx).toBeGreaterThan(sendIdx)
    // Pane title is "<task> · <agent>".
    const paneId = fake.agentPanes()[0]?.[0]
    expect(fake.surfaces.get(paneId ?? '')?.title).toBe('hrc · T-05237 · clod')
  })

  it('two agents on the same task share ONE window and ONE tab, two panes (no 2nd window)', async () => {
    const fake = makeFakeGhostmux()
    const manager = new GhostmuxManager('ghostmux', fake.runner)

    await manager.ensureHeadlessViewer({
      scopeRef: cloRef,
      runtimeId: 'rt-1',
      attachCommand: 'attach-1',
    })
    await manager.ensureHeadlessViewer({
      scopeRef: curlyRef,
      runtimeId: 'rt-2',
      attachCommand: 'attach-2',
    })

    expect(fake.anchors()).toHaveLength(1)
    const panes = fake.agentPanes()
    expect(panes).toHaveLength(2)
    // Same tab key on both panes.
    expect(new Set(panes.map(([, s]) => s.surfaceMeta['hrc_tab_key']))).toEqual(
      new Set(['task:T-05237'])
    )
    // Distinct agents.
    expect(new Set(panes.map(([, s]) => s.surfaceMeta['hrc_agent_id']))).toEqual(
      new Set(['clod', 'curly'])
    )
    // Only ONE window was ever created.
    expect(fake.calls.filter((c) => c[0] === 'new' && c.includes('--window'))).toHaveLength(1)
    // The second agent split an existing tab pane rather than opening a new tab.
    expect(fake.calls.filter((c) => c[0] === 'new-pane')).toHaveLength(1)
  })

  it('two primary scopes from different projects open SEPARATE tabs in one window', async () => {
    const fake = makeFakeGhostmux()
    const manager = new GhostmuxManager('ghostmux', fake.runner)

    await manager.ensureHeadlessViewer({
      scopeRef: 'agent:clod:project:hrc-runtime:task:primary',
      runtimeId: 'rt-a',
      attachCommand: 'a',
    })
    await manager.ensureHeadlessViewer({
      scopeRef: 'agent:smokey:project:agent-control-plane:task:primary',
      runtimeId: 'rt-b',
      attachCommand: 'b',
    })

    expect(fake.anchors()).toHaveLength(1)
    expect(fake.calls.filter((c) => c[0] === 'new' && c.includes('--window'))).toHaveLength(1)
    // Two distinct tab keys ⇒ two tabs (two `new --tab` parented off the anchor).
    expect(fake.calls.filter((c) => c[0] === 'new' && c.includes('--tab'))).toHaveLength(2)
    expect(fake.calls.filter((c) => c[0] === 'new-pane')).toHaveLength(0)
  })

  it('reuse rebinds the pane to the new runtime and creates no new surface (fence)', async () => {
    const fake = makeFakeGhostmux()
    const manager = new GhostmuxManager('ghostmux', fake.runner)

    await manager.ensureHeadlessViewer({ scopeRef: cloRef, runtimeId: 'rt-1', attachCommand: 'a1' })
    const before = fake.liveIds().length
    const result = await manager.ensureHeadlessViewer({
      scopeRef: cloRef,
      runtimeId: 'rt-2',
      attachCommand: 'a2',
    })

    expect(result.status).toBe('reused')
    expect(fake.liveIds().length).toBe(before)
    // Metadata rebound to the CURRENT runtime BEFORE returning (daedalus C5).
    const paneId = fake.agentPanes()[0]?.[0]
    expect(fake.surfaceMeta(paneId ?? '')?.['hrc_runtime_id']).toBe('rt-2')
  })

  it('serializes concurrent same-task creates into ONE tab (mutex + post-lock recheck)', async () => {
    const fake = makeFakeGhostmux()
    const manager = new GhostmuxManager('ghostmux', fake.runner)

    await Promise.all([
      manager.ensureHeadlessViewer({ scopeRef: cloRef, runtimeId: 'rt-1', attachCommand: 'a1' }),
      manager.ensureHeadlessViewer({ scopeRef: curlyRef, runtimeId: 'rt-2', attachCommand: 'a2' }),
    ])

    // No duplicate window, no duplicate tab for the shared key.
    expect(fake.anchors()).toHaveLength(1)
    expect(fake.calls.filter((c) => c[0] === 'new' && c.includes('--window'))).toHaveLength(1)
    expect(fake.calls.filter((c) => c[0] === 'new' && c.includes('--tab'))).toHaveLength(1)
    expect(fake.agentPanes()).toHaveLength(2)
  })

  it('after a restart (fresh manager, surfaces persist) finds the window/pane from metadata', async () => {
    const fake = makeFakeGhostmux()
    const m1 = new GhostmuxManager('ghostmux', fake.runner)
    await m1.ensureHeadlessViewer({ scopeRef: cloRef, runtimeId: 'rt-1', attachCommand: 'a1' })

    // New manager instance = daemon restart; surfaces (metadata) persist in `fake`.
    const m2 = new GhostmuxManager('ghostmux', fake.runner)
    const result = await m2.ensureHeadlessViewer({
      scopeRef: cloRef,
      runtimeId: 'rt-2',
      attachCommand: 'a2',
    })

    expect(result.status).toBe('reused')
    expect(fake.anchors()).toHaveLength(1)
    expect(fake.calls.filter((c) => c[0] === 'new' && c.includes('--window'))).toHaveLength(1)
  })

  it('returns failed (never throws) when ghostmux is unavailable', async () => {
    const manager = new GhostmuxManager('ghostmux', async () => {
      throw new Error('libghostty API call failed [error code: surface_not_realized]')
    })
    const result = await manager.ensureHeadlessViewer({
      scopeRef: cloRef,
      runtimeId: 'rt-11',
      attachCommand: 'a',
    })
    expect(result.status).toBe('failed')
  })

  it('applies the status bar + tint on the created path', async () => {
    const fake = makeFakeGhostmux()
    const manager = new GhostmuxManager('ghostmux', fake.runner)
    await manager.ensureHeadlessViewer({
      scopeRef: cloRef,
      runtimeId: 'rt-12',
      attachCommand: 'a',
      statusBar: { left: '◆ CLOD', center: 'hrc-runtime', right: '▶ running' },
      terminalBg: '#1e1631',
    })
    await Promise.resolve()
    const paneId = fake.agentPanes()[0]?.[0]
    expect(fake.calls).toContainEqual(['set-bg', '-t', paneId, '#1e1631', '--json'])
    expect(fake.calls.some((c) => c[0] === 'statusbar')).toBe(true)
  })
})

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
