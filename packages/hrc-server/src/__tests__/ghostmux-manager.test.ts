import { describe, expect, it } from 'bun:test'

import { GhostmuxManager, parseGhostmuxSurfaceState } from '../ghostmux'

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

describe('GhostmuxManager.ensureHeadlessViewer', () => {
  const scopeRef = 'agent:clod:project:hrc-runtime:task:primary'

  it('creates an unfocused window, tags it, and sends the attach command', async () => {
    const calls: string[][] = []
    const manager = new GhostmuxManager('ghostmux', async (args) => {
      calls.push(args)
      const key = args.join(' ')
      if (key === 'list-surfaces --json')
        return { stdout: JSON.stringify({ terminals: [] }), stderr: '' }
      if (args[0] === 'new') return { stdout: JSON.stringify({ id: 'viewer-1' }), stderr: '' }
      return { stdout: '{}', stderr: '' }
    })

    const result = await manager.ensureHeadlessViewer({
      scopeRef,
      runtimeId: 'rt-9',
      attachCommand: 'hrc attach rt-9',
      title: `hrc headless ${scopeRef}`,
    })

    expect(result).toEqual({ status: 'created', surfaceId: 'viewer-1' })
    // new window must NOT request focus
    expect(calls).toContainEqual([
      'new',
      '--window',
      '--title',
      `hrc headless ${scopeRef}`,
      '--json',
    ])
    expect(calls.flat()).not.toContain('--focus')
    expect(calls).toContainEqual([
      'metadata',
      'set',
      '-t',
      'viewer-1',
      JSON.stringify({
        hrc_role: 'hrc-headless-viewer',
        hrc_scope_ref: scopeRef,
        hrc_runtime_id: 'rt-9',
      }),
      '--window',
      '--json',
    ])
    expect(calls).toContainEqual(['send-keys', '-t', 'viewer-1', 'hrc attach rt-9'])
  })

  it('reuses an existing viewer for the same scope and does not create a new window', async () => {
    const calls: string[][] = []
    const manager = new GhostmuxManager('ghostmux', async (args) => {
      calls.push(args)
      const key = args.join(' ')
      if (key === 'list-surfaces --json') {
        return { stdout: JSON.stringify({ terminals: [{ id: 'existing-viewer' }] }), stderr: '' }
      }
      if (key === 'metadata get -t existing-viewer --window --json') {
        return {
          stdout: JSON.stringify({ hrc_role: 'hrc-headless-viewer', hrc_scope_ref: scopeRef }),
          stderr: '',
        }
      }
      return { stdout: '{}', stderr: '' }
    })

    const result = await manager.ensureHeadlessViewer({
      scopeRef,
      runtimeId: 'rt-10',
      attachCommand: 'hrc attach rt-10',
      title: 'hrc headless',
    })

    expect(result).toEqual({ status: 'reused', surfaceId: 'existing-viewer' })
    expect(calls.some((c) => c[0] === 'new')).toBe(false)
    expect(calls.some((c) => c[0] === 'send-keys')).toBe(false)
  })

  it('returns failed (never throws) when ghostmux is unavailable', async () => {
    const manager = new GhostmuxManager('ghostmux', async () => {
      throw new Error('libghostty API call failed [error code: surface_not_realized]')
    })

    const result = await manager.ensureHeadlessViewer({
      scopeRef,
      runtimeId: 'rt-11',
      attachCommand: 'hrc attach rt-11',
      title: 'hrc headless',
    })

    expect(result.status).toBe('failed')
  })

  const statusBar = {
    left: '◆ CLOD',
    center: 'hrc-runtime',
    right: '▶ running',
    fg: '#F2EEE6',
    bg: '#6B4FB0',
  }

  it('applies the status bar on the created path (off the critical path)', async () => {
    const calls: string[][] = []
    const manager = new GhostmuxManager('ghostmux', async (args) => {
      calls.push(args)
      if (args.join(' ') === 'list-surfaces --json')
        return { stdout: JSON.stringify({ terminals: [] }), stderr: '' }
      if (args[0] === 'new') return { stdout: JSON.stringify({ id: 'viewer-x' }), stderr: '' }
      return { stdout: '{}', stderr: '' }
    })

    const result = await manager.ensureHeadlessViewer({
      scopeRef,
      runtimeId: 'rt-12',
      attachCommand: 'hrc attach rt-12',
      title: 'hrc headless',
      statusBar,
      terminalBg: '#1e1631',
    })
    await Promise.resolve()

    expect(result.status).toBe('created')
    expect(calls).toContainEqual([
      'statusbar',
      'set',
      '-t',
      'viewer-x',
      '◆ CLOD|hrc-runtime|▶ running',
      '--fg',
      '#F2EEE6',
      '--bg',
      '#6B4FB0',
    ])
    // color identity comes from the terminal tint, applied on the created path
    expect(calls).toContainEqual(['set-bg', '-t', 'viewer-x', '#1e1631', '--json'])
  })

  it('refreshes metadata and repaints the bar on the reused path', async () => {
    const calls: string[][] = []
    const manager = new GhostmuxManager('ghostmux', async (args) => {
      calls.push(args)
      const key = args.join(' ')
      if (key === 'list-surfaces --json')
        return { stdout: JSON.stringify({ terminals: [{ id: 'existing-viewer' }] }), stderr: '' }
      if (key === 'metadata get -t existing-viewer --window --json')
        return {
          stdout: JSON.stringify({ hrc_role: 'hrc-headless-viewer', hrc_scope_ref: scopeRef }),
          stderr: '',
        }
      return { stdout: '{}', stderr: '' }
    })

    const result = await manager.ensureHeadlessViewer({
      scopeRef,
      runtimeId: 'rt-13',
      attachCommand: 'hrc attach rt-13',
      title: 'hrc headless',
      statusBar,
      terminalBg: '#1e1631',
    })
    await Promise.resolve()

    expect(result).toEqual({ status: 'reused', surfaceId: 'existing-viewer' })
    expect(calls.some((c) => c[0] === 'new')).toBe(false)
    // tint reapplied on reuse too
    expect(calls).toContainEqual(['set-bg', '-t', 'existing-viewer', '#1e1631', '--json'])
    // metadata refreshed to the CURRENT runtime id
    expect(calls).toContainEqual([
      'metadata',
      'set',
      '-t',
      'existing-viewer',
      JSON.stringify({
        hrc_role: 'hrc-headless-viewer',
        hrc_scope_ref: scopeRef,
        hrc_runtime_id: 'rt-13',
      }),
      '--window',
      '--json',
    ])
    expect(calls.some((c) => c[0] === 'statusbar')).toBe(true)
  })

  it('does not fail or delay the viewer when the status bar write throws', async () => {
    const manager = new GhostmuxManager('ghostmux', async (args) => {
      if (args.join(' ') === 'list-surfaces --json')
        return { stdout: JSON.stringify({ terminals: [] }), stderr: '' }
      if (args[0] === 'new') return { stdout: JSON.stringify({ id: 'viewer-y' }), stderr: '' }
      if (args[0] === 'statusbar') throw new Error('boom')
      return { stdout: '{}', stderr: '' }
    })

    const result = await manager.ensureHeadlessViewer({
      scopeRef,
      runtimeId: 'rt-14',
      attachCommand: 'hrc attach rt-14',
      title: 'hrc headless',
      statusBar,
    })

    expect(result).toEqual({ status: 'created', surfaceId: 'viewer-y' })
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
