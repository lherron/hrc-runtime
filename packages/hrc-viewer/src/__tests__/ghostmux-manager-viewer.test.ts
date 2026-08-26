import { describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { GhostmuxCommandTimeoutError, GhostmuxManager } from '../ghostmux'

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

describe('GhostmuxManager.ensureHeadlessViewer (consolidated window/tab/pane)', () => {
  const cloRef = 'agent:clod:project:hrc-runtime:task:T-05237'
  const curlyRef = 'agent:curly:project:hrc-runtime:task:T-05237'

  it('first agent: creates ONE window + a task tab pane, attach-then-title-last', async () => {
    const fake = makeFakeGhostmux()
    const manager = new GhostmuxManager('ghostmux', fake.runner)

    const result = await manager.ensureHeadlessViewer({
      scopeRef: cloRef,
      runtimeId: 'rt-1',
      attachCommand: 'tmux attach; hrc monitor session-report --wait-key --wait-timeout 30; exit',
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

  it('bounds a hung command and settles the tab lock for the next viewer attempt', async () => {
    let calls = 0
    const manager = new GhostmuxManager(
      'ghostmux',
      async () => {
        calls += 1
        if (calls === 1) {
          return await new Promise<never>(() => undefined)
        }
        throw new Error('second viewer attempt reached ghostmux')
      },
      10
    )

    const first = await manager.ensureHeadlessViewer({
      scopeRef: cloRef,
      runtimeId: 'rt-timeout-1',
      attachCommand: 'a1',
    })
    const second = await manager.ensureHeadlessViewer({
      scopeRef: cloRef,
      runtimeId: 'rt-timeout-2',
      attachCommand: 'a2',
    })

    expect(first).toEqual({
      status: 'failed',
      error: new GhostmuxCommandTimeoutError(['list-surfaces', '--json'], 10).message,
    })
    expect(second).toEqual({
      status: 'failed',
      error: 'second viewer attempt reached ghostmux',
    })
    expect(calls).toBe(2)
  })

  it('surfaces a typed failure when a direct ghostmux command times out', async () => {
    const manager = new GhostmuxManager(
      'ghostmux',
      async () => await new Promise<never>(() => undefined),
      10
    )

    const error = await manager.initialize().catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(GhostmuxCommandTimeoutError)
    expect(error).toMatchObject({
      code: 'ghostmux_command_timeout',
      args: ['status', '--json'],
      timeoutMs: 10,
    })
  })

  it('kills and reaps a real ghostmux child when the command times out', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hrc-ghostmux-timeout-'))
    const pidFile = join(dir, 'child.pid')
    const bashEnv = join(dir, 'bash-env')
    await Bun.write(bashEnv, `printf '%s' "$$" > '${pidFile}'\nexec /bin/sleep 60\n`)
    const previousBashEnv = process.env.BASH_ENV
    process.env.BASH_ENV = bashEnv

    try {
      // Bash sources BASH_ENV before it tries to open the manager's fixed
      // `status` argument, giving this real child a deterministic hung body.
      const manager = new GhostmuxManager('/bin/bash', undefined, 100)
      const error = await manager.initialize().catch((caught: unknown) => caught)

      expect(error).toBeInstanceOf(GhostmuxCommandTimeoutError)
      const pid = Number(await Bun.file(pidFile).text())
      expect(Number.isInteger(pid)).toBe(true)

      let childIsAlive = true
      try {
        process.kill(pid, 0)
      } catch {
        childIsAlive = false
      }
      expect(childIsAlive).toBe(false)
    } finally {
      if (previousBashEnv === undefined) process.env.BASH_ENV = undefined
      else process.env.BASH_ENV = previousBashEnv
      await rm(dir, { recursive: true, force: true })
    }
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

  // -------------------------------------------------------------------------
  // T-06321: pane identity is (scopeRef, laneRef), not (tabKey, agentId).
  // -------------------------------------------------------------------------
  const codyBase = 'agent:cody:project:agent-loop:task:T-06319'
  const attachSends = (fake: ReturnType<typeof makeFakeGhostmux>) =>
    fake.calls.filter((c) => c[0] === 'send-keys' && c.length === 4 && c[1] === '-t')

  it('same agent+task across THREE roles: one window, one tab, three panes, three attaches', async () => {
    const fake = makeFakeGhostmux()
    const manager = new GhostmuxManager('ghostmux', fake.runner)

    await manager.ensureHeadlessViewer({
      scopeRef: `${codyBase}:role:tester`,
      runtimeId: 'rt-tester',
      attachCommand: 'attach-tester',
    })
    await manager.ensureHeadlessViewer({
      scopeRef: `${codyBase}:role:implementer`,
      runtimeId: 'rt-impl',
      attachCommand: 'attach-impl',
    })
    await manager.ensureHeadlessViewer({
      scopeRef: `${codyBase}:role:observer`,
      runtimeId: 'rt-obs',
      attachCommand: 'attach-obs',
    })

    // One window, one tab (one `new --tab`), two extra splits ⇒ three panes.
    expect(fake.anchors()).toHaveLength(1)
    expect(fake.calls.filter((c) => c[0] === 'new' && c.includes('--window'))).toHaveLength(1)
    expect(fake.calls.filter((c) => c[0] === 'new' && c.includes('--tab'))).toHaveLength(1)
    const panes = fake.agentPanes()
    expect(panes).toHaveLength(3)
    // All share one tab key; each pane has a DISTINCT canonical pane key.
    expect(new Set(panes.map(([, s]) => s.surfaceMeta['hrc_tab_key']))).toEqual(
      new Set(['task:T-06319'])
    )
    expect(new Set(panes.map(([, s]) => s.surfaceMeta['hrc_pane_key'])).size).toBe(3)
    // Same agent id on every pane (presentation, not uniqueness authority).
    expect(new Set(panes.map(([, s]) => s.surfaceMeta['hrc_agent_id']))).toEqual(new Set(['cody']))
    // Distinct role names + role-distinguishable titles + distinct runtime bindings.
    expect(new Set(panes.map(([, s]) => s.surfaceMeta['hrc_role_name']))).toEqual(
      new Set(['tester', 'implementer', 'observer'])
    )
    expect(new Set(panes.map(([, s]) => s.surfaceMeta['hrc_runtime_id']))).toEqual(
      new Set(['rt-tester', 'rt-impl', 'rt-obs'])
    )
    const titles = panes.map(([id]) => fake.surfaces.get(id)?.title)
    expect(titles).toContain('loop · T-06319 · cody · tester')
    expect(titles).toContain('loop · T-06319 · cody · implementer')
    expect(titles).toContain('loop · T-06319 · cody · observer')
    // Three distinct attach-command sends, one per seat.
    expect(attachSends(fake).map((c) => c[3])).toEqual(
      expect.arrayContaining(['attach-tester', 'attach-impl', 'attach-obs'])
    )
    expect(attachSends(fake)).toHaveLength(3)
  })

  it('distinct HRC lanes for one scope produce distinct panes in one tab', async () => {
    const fake = makeFakeGhostmux()
    const manager = new GhostmuxManager('ghostmux', fake.runner)

    await manager.ensureHeadlessViewer({
      scopeRef: codyBase,
      laneRef: 'main',
      runtimeId: 'rt-main',
      attachCommand: 'attach-main',
    })
    await manager.ensureHeadlessViewer({
      scopeRef: codyBase,
      laneRef: 'lane:forked',
      runtimeId: 'rt-forked',
      attachCommand: 'attach-forked',
    })

    expect(fake.anchors()).toHaveLength(1)
    expect(fake.calls.filter((c) => c[0] === 'new' && c.includes('--tab'))).toHaveLength(1)
    const panes = fake.agentPanes()
    expect(panes).toHaveLength(2)
    expect(new Set(panes.map(([, s]) => s.surfaceMeta['hrc_tab_key']))).toEqual(
      new Set(['task:T-06319'])
    )
    expect(new Set(panes.map(([, s]) => s.surfaceMeta['hrc_lane_ref']))).toEqual(
      new Set(['main', 'lane:forked'])
    )
    expect(new Set(panes.map(([, s]) => s.surfaceMeta['hrc_pane_key'])).size).toBe(2)
  })

  it('a newer runtime of the exact same (scope, lane) REUSES its pane (AC7 unchanged)', async () => {
    const fake = makeFakeGhostmux()
    const manager = new GhostmuxManager('ghostmux', fake.runner)

    await manager.ensureHeadlessViewer({
      scopeRef: `${codyBase}:role:tester`,
      runtimeId: 'rt-1',
      attachCommand: 'a1',
    })
    const before = fake.liveIds().length
    const result = await manager.ensureHeadlessViewer({
      scopeRef: `${codyBase}:role:tester`,
      runtimeId: 'rt-2',
      attachCommand: 'a2',
    })

    expect(result.status).toBe('reused')
    expect(fake.liveIds().length).toBe(before)
    expect(fake.agentPanes()).toHaveLength(1)
    expect(fake.agentPanes()[0]?.[1].surfaceMeta['hrc_runtime_id']).toBe('rt-2')
  })
})
