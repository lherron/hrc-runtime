/**
 * T-07118 Part A — viewer window placement hint.
 *
 * Covers the four properties the composite `(windowKey, tabKey)` tab identity
 * has to hold, plus the persistence path that carries the hint from
 * `hrc start --viewer-window` to every later viewer respawn:
 *
 *  - window-fenced `findTaskTab`: a keyed pane never splits into a same-tabKey
 *    tab in another window,
 *  - keyless back-compat: metadata written before this change (no
 *    `hrc_window_key`) reads as the implicit default key, so today's live
 *    topology matches without a restamp,
 *  - global pane reuse: reuse still wins over placement,
 *  - lock keying: differently-keyed windows do not serialize against each other
 *    and same-composite creates still serialize into one tab.
 */

import { describe, expect, it } from 'bun:test'

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HrcRuntimeIntent } from 'hrc-core'
import { openHrcDatabase } from 'hrc-store-sqlite'

import { DEFAULT_HEADLESS_WINDOW_KEY, GhostmuxManager, normalizeWindowKey } from '../ghostmux'
import { parseRuntimeIntent } from '../parsers/runtime'

type Surf = {
  surfaceMeta: Record<string, unknown>
  windowMeta: Record<string, unknown>
  title?: string | undefined
  columns: number
  rows: number
}

function makeFakeGhostmux() {
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
    if (args.join(' ') === 'list-surfaces --json') {
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
    if (args[0] === 'new-pane') return { stdout: JSON.stringify({ id: alloc() }), stderr: '' }
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
  const agentPanes = () =>
    [...surfaces.entries()].filter(([, s]) => s.surfaceMeta['hrc_role'] === 'headless-agent-pane')
  const anchors = () =>
    [...surfaces.entries()].filter(
      ([, s]) => s.surfaceMeta['hrc_role'] === 'headless-window-anchor'
    )
  return { runner, calls, surfaces, agentPanes, anchors, alloc }
}

const CLOD = 'agent:clod:project:hrc-runtime:task:primary'
const CURLY = 'agent:curly:project:hrc-runtime:task:primary'

describe('T-07118 normalizeWindowKey', () => {
  it('maps absent/blank to the implicit default key', () => {
    expect(normalizeWindowKey(undefined)).toBe(DEFAULT_HEADLESS_WINDOW_KEY)
    expect(normalizeWindowKey('')).toBe(DEFAULT_HEADLESS_WINDOW_KEY)
    expect(normalizeWindowKey('   ')).toBe(DEFAULT_HEADLESS_WINDOW_KEY)
  })

  it('keeps a key safe inside a `:`-delimited metadata key', () => {
    expect(normalizeWindowKey('console')).toBe('console')
    expect(normalizeWindowKey('my console:x')).toBe('my-console-x')
  })
})

describe('T-07118 composite (windowKey, tabKey) tab identity', () => {
  it('an absent hint reproduces today’s topology exactly', async () => {
    const fake = makeFakeGhostmux()
    const manager = new GhostmuxManager('ghostmux', fake.runner)

    await manager.ensureHeadlessViewer({ scopeRef: CLOD, runtimeId: 'rt-1', attachCommand: 'a1' })
    await manager.ensureHeadlessViewer({ scopeRef: CURLY, runtimeId: 'rt-2', attachCommand: 'a2' })

    expect(fake.anchors()).toHaveLength(1)
    expect(fake.calls.filter((c) => c[0] === 'new' && c.includes('--window'))).toHaveLength(1)
    // Same tab, split into a second pane — the pre-change behavior.
    expect(fake.calls.filter((c) => c[0] === 'new' && c.includes('--tab'))).toHaveLength(1)
    expect(fake.calls.filter((c) => c[0] === 'new-pane')).toHaveLength(1)
    // The default window's title is untouched.
    const anchorId = fake.anchors()[0]?.[0]
    expect(fake.surfaces.get(anchorId ?? '')?.title).toBe('Headless Sessions')
  })

  it('window-fences findTaskTab: a console-keyed pane never splits into the default tab', async () => {
    const fake = makeFakeGhostmux()
    const manager = new GhostmuxManager('ghostmux', fake.runner)

    // Same tabKey (`project:hrc-runtime:primary`), different window keys.
    await manager.ensureHeadlessViewer({ scopeRef: CLOD, runtimeId: 'rt-1', attachCommand: 'a1' })
    await manager.ensureHeadlessViewer({
      scopeRef: CURLY,
      runtimeId: 'rt-2',
      attachCommand: 'a2',
      windowKey: 'console',
    })

    const panes = fake.agentPanes()
    expect(panes).toHaveLength(2)
    expect(new Set(panes.map(([, s]) => s.surfaceMeta['hrc_tab_key']))).toEqual(
      new Set(['project:hrc-runtime:primary'])
    )
    expect(panes.map(([, s]) => s.surfaceMeta['hrc_window_key']).sort()).toEqual([
      'console',
      'default',
    ])
    // TWO keyed windows, TWO tabs, and NOT a split into the default window's tab.
    expect(fake.anchors()).toHaveLength(2)
    expect(fake.calls.filter((c) => c[0] === 'new' && c.includes('--window'))).toHaveLength(2)
    expect(fake.calls.filter((c) => c[0] === 'new-pane')).toHaveLength(0)
  })

  it('two console-keyed panes for one tabKey share ONE tab in the console window', async () => {
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

    expect(fake.anchors()).toHaveLength(1)
    expect(fake.calls.filter((c) => c[0] === 'new' && c.includes('--tab'))).toHaveLength(1)
    expect(fake.calls.filter((c) => c[0] === 'new-pane')).toHaveLength(1)
    expect(fake.agentPanes()).toHaveLength(2)
  })

  it('stamps hrc_window_key on the window role, the anchor role, and every agent pane', async () => {
    const fake = makeFakeGhostmux()
    const manager = new GhostmuxManager('ghostmux', fake.runner)

    await manager.ensureHeadlessViewer({
      scopeRef: CLOD,
      runtimeId: 'rt-1',
      attachCommand: 'a1',
      windowKey: 'console',
    })

    const [anchorId, anchor] = fake.anchors()[0] ?? []
    expect(anchor?.surfaceMeta).toMatchObject({
      hrc_role: 'headless-window-anchor',
      hrc_window_key: 'console',
    })
    expect(anchor?.windowMeta).toMatchObject({
      hrc_role: 'headless-sessions-window',
      hrc_window_key: 'console',
    })
    expect(anchorId).toBeDefined()
    expect(fake.agentPanes()[0]?.[1].surfaceMeta).toMatchObject({ hrc_window_key: 'console' })
  })

  it('adopts a pre-stamped keyed window instead of creating another', async () => {
    const fake = makeFakeGhostmux()
    const manager = new GhostmuxManager('ghostmux', fake.runner)

    // The documented one-time console adoption stamp, applied by hand.
    const adopted = fake.alloc('Lance console')
    const surf = fake.surfaces.get(adopted)
    if (!surf) throw new Error('fixture surface missing')
    surf.surfaceMeta = { hrc_role: 'headless-window-anchor', hrc_window_key: 'console' }
    surf.windowMeta = { hrc_role: 'headless-sessions-window', hrc_window_key: 'console' }

    await manager.ensureHeadlessViewer({
      scopeRef: CLOD,
      runtimeId: 'rt-1',
      attachCommand: 'a1',
      windowKey: 'console',
    })

    expect(fake.calls.filter((c) => c[0] === 'new' && c.includes('--window'))).toHaveLength(0)
    const tabCall = fake.calls.find((c) => c[0] === 'new' && c.includes('--tab'))
    expect(tabCall?.[tabCall.indexOf('--parent') + 1]).toBe(adopted)
    // HRC never reaps anchors, so adopting a real user tab stays safe.
    expect(fake.surfaces.get(adopted)?.title).toBe('Lance console')
  })

  it('keyless legacy metadata reads as the default key (no restamp needed)', async () => {
    const fake = makeFakeGhostmux()
    const manager = new GhostmuxManager('ghostmux', fake.runner)

    // Topology written before T-07118: no `hrc_window_key` anywhere.
    const legacyAnchor = fake.alloc('Headless Sessions')
    const legacyAnchorSurf = fake.surfaces.get(legacyAnchor)
    if (!legacyAnchorSurf) throw new Error('fixture surface missing')
    legacyAnchorSurf.surfaceMeta = { hrc_role: 'headless-window-anchor' }
    const legacyPane = fake.alloc('hrc · primary · clod')
    const legacyPaneSurf = fake.surfaces.get(legacyPane)
    if (!legacyPaneSurf) throw new Error('fixture surface missing')
    legacyPaneSurf.surfaceMeta = {
      hrc_role: 'headless-agent-pane',
      hrc_tab_key: 'project:hrc-runtime:primary',
      hrc_pane_key: `${CLOD}#main`,
      hrc_runtime_id: 'rt-old',
    }

    // An unhinted new agent joins that legacy tab — no new window, no new tab.
    await manager.ensureHeadlessViewer({ scopeRef: CURLY, runtimeId: 'rt-2', attachCommand: 'a2' })

    expect(fake.calls.filter((c) => c[0] === 'new' && c.includes('--window'))).toHaveLength(0)
    expect(fake.calls.filter((c) => c[0] === 'new' && c.includes('--tab'))).toHaveLength(0)
    const newPaneCall = fake.calls.find((c) => c[0] === 'new-pane')
    expect(newPaneCall?.[newPaneCall.indexOf('-t') + 1]).toBe(legacyPane)
  })

  it('pane identity stays GLOBAL: a newly-hinted respawn reuses the existing pane', async () => {
    const fake = makeFakeGhostmux()
    const manager = new GhostmuxManager('ghostmux', fake.runner)

    await manager.ensureHeadlessViewer({ scopeRef: CLOD, runtimeId: 'rt-1', attachCommand: 'a1' })
    const before = [...fake.surfaces.keys()].length

    const result = await manager.ensureHeadlessViewer({
      scopeRef: CLOD,
      runtimeId: 'rt-2',
      attachCommand: 'a2',
      windowKey: 'console',
    })

    // Reuse wins over placement — one live viewer pane per HRC session.
    expect(result.status).toBe('reused')
    expect([...fake.surfaces.keys()].length).toBe(before)
    expect(fake.agentPanes()).toHaveLength(1)
    const pane = fake.agentPanes()[0]?.[1]
    expect(pane?.surfaceMeta['hrc_runtime_id']).toBe('rt-2')
    // The reused pane records the hint it was last asked for.
    expect(pane?.surfaceMeta['hrc_window_key']).toBe('console')
  })

  it('serializes same-composite creates but not differently-keyed windows', async () => {
    const fake = makeFakeGhostmux()
    const manager = new GhostmuxManager('ghostmux', fake.runner)

    await Promise.all([
      manager.ensureHeadlessViewer({ scopeRef: CLOD, runtimeId: 'rt-1', attachCommand: 'a1' }),
      manager.ensureHeadlessViewer({ scopeRef: CURLY, runtimeId: 'rt-2', attachCommand: 'a2' }),
      manager.ensureHeadlessViewer({
        scopeRef: 'agent:moe:project:hrc-runtime:task:primary',
        runtimeId: 'rt-3',
        attachCommand: 'a3',
        windowKey: 'console',
      }),
    ])

    // One default window (two panes, one tab) + one console window (one pane).
    expect(fake.anchors()).toHaveLength(2)
    expect(fake.agentPanes()).toHaveLength(3)
    expect(fake.calls.filter((c) => c[0] === 'new' && c.includes('--window'))).toHaveLength(2)
    expect(fake.calls.filter((c) => c[0] === 'new' && c.includes('--tab'))).toHaveLength(2)
    expect(fake.calls.filter((c) => c[0] === 'new-pane')).toHaveLength(1)
  })

  it('reap collapses a tab only when the composite tab has no surviving sibling', async () => {
    const fake = makeFakeGhostmux()
    const manager = new GhostmuxManager('ghostmux', fake.runner)

    await manager.ensureHeadlessViewer({ scopeRef: CLOD, runtimeId: 'rt-1', attachCommand: 'a1' })
    await manager.ensureHeadlessViewer({
      scopeRef: CURLY,
      runtimeId: 'rt-2',
      attachCommand: 'a2',
      windowKey: 'console',
    })
    const consolePane = fake
      .agentPanes()
      .find(([, s]) => s.surfaceMeta['hrc_window_key'] === 'console')?.[0]

    // The default-window sibling shares the tabKey but NOT the window; killing
    // the console pane must therefore collapse the console tab.
    const result = await manager.reapHeadlessAgentPane(consolePane ?? '', 'rt-2')
    expect(result).toMatchObject({ status: 'reaped', tabCollapsed: true })
  })
})

describe('T-07118 presentation intent round-trips', () => {
  it('parseRuntimeIntent preserves presentation.viewerWindow', () => {
    const intent = parseRuntimeIntent({
      placement: 'workspace',
      harness: { provider: 'anthropic', id: 'claude-code', interactive: true },
      presentation: { viewerWindow: ' console ' },
    })
    expect(intent.presentation).toEqual({ viewerWindow: 'console' })
  })

  it('parseRuntimeIntent leaves an absent hint absent', () => {
    const intent = parseRuntimeIntent({
      placement: 'workspace',
      harness: { provider: 'anthropic', id: 'claude-code', interactive: true },
    })
    expect(intent.presentation).toBeUndefined()
  })

  it('parseRuntimeIntent rejects a blank viewerWindow', () => {
    expect(() =>
      parseRuntimeIntent({
        placement: 'workspace',
        harness: { provider: 'anthropic', id: 'claude-code', interactive: true },
        presentation: { viewerWindow: '   ' },
      })
    ).toThrow(/viewerWindow/)
  })

  it('survives the session-record write the viewer respawn reads back', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hrc-t07118-intent-'))
    try {
      const db = openHrcDatabase(join(dir, 'state.sqlite'))
      const now = '2026-08-08T00:00:00.000Z'
      db.sessions.insert({
        hostSessionId: 'hsid-t07118',
        scopeRef: CLOD,
        laneRef: 'main',
        generation: 1,
        status: 'active',
        createdAt: now,
        updatedAt: now,
        ancestorScopeRefs: [],
      })
      const intent: HrcRuntimeIntent = {
        placement: 'workspace',
        harness: { provider: 'anthropic', id: 'claude-code', interactive: true },
        presentation: { viewerWindow: 'console' },
      }
      db.sessions.updateIntent('hsid-t07118', intent, now)

      const reread = db.sessions.getByHostSessionId('hsid-t07118')
      expect(reread?.lastAppliedIntentJson?.presentation?.viewerWindow).toBe('console')
      db.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
