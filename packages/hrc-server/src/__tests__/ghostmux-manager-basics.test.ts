import { describe, expect, it } from 'bun:test'

import {
  GhostmuxManager,
  deriveHeadlessSessionIdentity,
  deriveHeadlessTabIdentity,
  parseGhostmuxSurfaceState,
} from '../ghostmux'

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

void makeFakeGhostmux

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

  it('gives a named non-task scope (roster slot) its OWN tab key (T-07142)', () => {
    const nova = deriveHeadlessTabIdentity('agent:mable:project:hrc-runtime:task:primary-nova')
    expect(nova.tabKey).toBe('project:hrc-runtime:primary-nova')
    expect(nova.label).toBe('hrc · primary-nova')
    const comet = deriveHeadlessTabIdentity('agent:mable:project:hrc-runtime:task:primary-comet')
    expect(comet.tabKey).toBe('project:hrc-runtime:primary-comet')
    const primary = deriveHeadlessTabIdentity('agent:mable:project:hrc-runtime:task:primary')
    expect(nova.tabKey).not.toBe(comet.tabKey)
    expect(nova.tabKey).not.toBe(primary.tabKey)
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

// ---------------------------------------------------------------------------
// T-06321: canonical pane key from normalized (scopeRef, laneRef)
// ---------------------------------------------------------------------------
describe('deriveHeadlessSessionIdentity', () => {
  it('keeps the shared tab but distinguishes the pane key by role', () => {
    const tester = deriveHeadlessSessionIdentity(
      'agent:cody:project:agent-loop:task:T-06319:role:tester'
    )
    const impl = deriveHeadlessSessionIdentity(
      'agent:cody:project:agent-loop:task:T-06319:role:implementer'
    )
    // Same task tab...
    expect(tester.tab.tabKey).toBe('task:T-06319')
    expect(impl.tab.tabKey).toBe('task:T-06319')
    // ...but distinct pane keys and role names.
    expect(tester.paneKey).not.toBe(impl.paneKey)
    expect(tester.roleName).toBe('tester')
    expect(impl.roleName).toBe('implementer')
    expect(tester.laneRef).toBe('main')
  })

  it('distinguishes the pane key by lane for one scope', () => {
    const scope = 'agent:cody:project:agent-loop:task:T-06319'
    const main = deriveHeadlessSessionIdentity(scope)
    const forked = deriveHeadlessSessionIdentity(scope, 'lane:forked')
    expect(main.tab.tabKey).toBe(forked.tab.tabKey)
    expect(main.paneKey).not.toBe(forked.paneKey)
    expect(main.laneRef).toBe('main')
    expect(forked.laneRef).toBe('lane:forked')
  })

  it('an omitted lane normalizes to main; explicit main is identical', () => {
    const scope = 'agent:clod:project:hrc-runtime:task:T-06321'
    expect(deriveHeadlessSessionIdentity(scope).paneKey).toBe(
      deriveHeadlessSessionIdentity(scope, 'main').paneKey
    )
    expect(deriveHeadlessSessionIdentity(scope).roleName).toBeUndefined()
  })

  it('falls back to an unparsed pane key for a malformed ref (never throws)', () => {
    const id = deriveHeadlessSessionIdentity('::::garbage::::', 'lane:x')
    expect(id.paneKey.startsWith('unparsed:')).toBe(true)
    expect(id.paneKey.endsWith('#lane:x')).toBe(true)
    expect(id.tab.tabKey.startsWith('unparsed:')).toBe(true)
  })
})
