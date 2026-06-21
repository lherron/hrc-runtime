/**
 * T-04439 — headless-viewer status-bar projection.
 *
 * Pure render + state-mapping, plus the projector's last-state-wins / debounce /
 * sticky-exited behavior with injected timers (no real wall-clock).
 */

import { describe, expect, it } from 'bun:test'

import { agentTheme } from '../agent-theme.js'
import type { GhostmuxStatusBarSpec } from '../ghostmux.js'
import {
  HeadlessViewerStatusProjector,
  renderStatusBar,
  viewerStateForEventKind,
  viewerTerminalBg,
} from '../headless-viewer-status.js'

describe('viewerStateForEventKind', () => {
  it('maps lifecycle event kinds to viewer states', () => {
    expect(viewerStateForEventKind('turn.started')).toBe('running')
    expect(viewerStateForEventKind('turn.input_resumed')).toBe('running')
    expect(viewerStateForEventKind('turn.awaiting_input')).toBe('awaiting')
    expect(viewerStateForEventKind('turn.completed')).toBe('idle')
    expect(viewerStateForEventKind('runtime.terminated')).toBe('exited')
    expect(viewerStateForEventKind('runtime.dead')).toBe('exited')
    expect(viewerStateForEventKind('runtime.stale')).toBe('exited')
  })

  it('returns null for events with no state meaning', () => {
    expect(viewerStateForEventKind('turn.tool_call')).toBeNull()
    expect(viewerStateForEventKind('surface.bound')).toBeNull()
  })
})

describe('renderStatusBar', () => {
  it('renders the full triplet from a scope ref', () => {
    const spec = renderStatusBar('agent:clod:project:hrc-runtime:task:T-04297', 'running')
    expect(spec.left).toBe('◆ CLOD')
    expect(spec.center).toBe('hrc-runtime · T-04297')
    expect(spec.right).toBe('▶ running')
    expect(spec.bg).toBe('#6B4FB0')
    expect(spec.fg).toBe('#F2EEE6')
  })

  it('drops the primary task from the center field', () => {
    const spec = renderStatusBar('agent:daedalus:project:agent-spaces:task:primary', 'idle')
    expect(spec.center).toBe('agent-spaces')
    expect(spec.right).toBe('✓ idle')
  })

  it('always emits all three fields (never blanks left/center)', () => {
    const spec = renderStatusBar('agent:smokey:project:wrkq:task:T-1', 'exited')
    expect(spec.left).toBe('◆ SMOKEY')
    expect(spec.center).toBe('wrkq · T-1')
    expect(spec.right).toBe('■ exited')
  })

  it('degrades gracefully on an unparseable scope ref', () => {
    const spec = renderStatusBar('not-a-scope', 'running')
    expect(spec.left).toBe('◆ UNKNOWN')
    expect(spec.right).toBe('▶ running')
  })

  it('appends the wrkq slug to the center field when provided (T-04977)', () => {
    const spec = renderStatusBar(
      'agent:clod:project:hrc-runtime:task:T-04977',
      'running',
      'add-task-slug-to-ghostmux-status-bar'
    )
    expect(spec.center).toBe('hrc-runtime · T-04977 · add-task-slug-to-ghostmux-status-bar')
  })

  it('falls back to project · T-id when no slug is provided', () => {
    expect(renderStatusBar('agent:clod:project:hrc-runtime:task:T-04977', 'running').center).toBe(
      'hrc-runtime · T-04977'
    )
    expect(
      renderStatusBar('agent:clod:project:hrc-runtime:task:T-04977', 'running', null).center
    ).toBe('hrc-runtime · T-04977')
    expect(
      renderStatusBar('agent:clod:project:hrc-runtime:task:T-04977', 'running', '   ').center
    ).toBe('hrc-runtime · T-04977')
  })

  it('never appends a slug to a primary (taskless) scope', () => {
    const spec = renderStatusBar(
      'agent:daedalus:project:agent-spaces:task:primary',
      'idle',
      'should-not-appear'
    )
    expect(spec.center).toBe('agent-spaces')
  })
})

describe('viewerTerminalBg', () => {
  it('resolves the agent dark tint from a scope ref', () => {
    expect(viewerTerminalBg('agent:clod:project:hrc-runtime:task:T-1')).toBe(
      agentTheme('clod').terminalBg
    )
  })

  it('falls back to the unknown-agent tint on a bad scope ref', () => {
    expect(viewerTerminalBg('garbage')).toBe(agentTheme('unknown').terminalBg)
  })
})

type Applied = { surfaceId: string; spec: GhostmuxStatusBarSpec }

function makeHarness(
  resolveSurfaceId: (runtimeId: string) => string | null = () => 'surf-1',
  resolveSlug?: (scopeRef: string) => Promise<string | null>
) {
  const applied: Applied[] = []
  const scheduled: Array<() => void> = []
  const errors: unknown[] = []
  const projector = new HeadlessViewerStatusProjector({
    resolveSurfaceId,
    applyStatusBar: async (surfaceId, spec) => {
      applied.push({ surfaceId, spec })
    },
    resolveSlug,
    onError: (error) => errors.push(error),
    schedule: (fn) => {
      scheduled.push(fn)
      return scheduled.length as unknown as ReturnType<typeof setTimeout>
    },
    clearScheduled: () => {},
  })
  const flushAll = async () => {
    const pending = scheduled.splice(0)
    for (const fn of pending) fn()
    // let the async flush() resolve
    await Promise.resolve()
    await Promise.resolve()
  }
  return { projector, applied, errors, flushAll }
}

const ev = (
  eventKind: string,
  runtimeId = 'rt-1',
  scopeRef = 'agent:clod:project:hrc-runtime:task:T-1'
) => ({
  eventKind,
  runtimeId,
  scopeRef,
})

describe('HeadlessViewerStatusProjector', () => {
  it('writes a full bar for a single event', async () => {
    const { projector, applied, flushAll } = makeHarness()
    projector.observe(ev('turn.started'))
    await flushAll()
    expect(applied).toHaveLength(1)
    expect(applied[0]?.spec.right).toBe('▶ running')
    expect(applied[0]?.spec.left).toBe('◆ CLOD')
  })

  it('coalesces rapid transitions within the debounce window (last-state-wins)', async () => {
    const { projector, applied, flushAll } = makeHarness()
    projector.observe(ev('turn.started')) // running
    projector.observe(ev('turn.awaiting_input')) // awaiting
    projector.observe(ev('turn.input_resumed')) // running
    await flushAll()
    expect(applied).toHaveLength(1)
    expect(applied[0]?.spec.right).toBe('▶ running')
  })

  it('exited dominates a pending lower-priority update', async () => {
    const { projector, applied, flushAll } = makeHarness()
    projector.observe(ev('turn.completed')) // idle pending
    projector.observe(ev('runtime.terminated')) // exited
    await flushAll()
    expect(applied).toHaveLength(1)
    expect(applied[0]?.spec.right).toBe('■ exited')
  })

  it('ignores a non-exited update that arrives after exited within the window (sticky)', async () => {
    const { projector, applied, flushAll } = makeHarness()
    projector.observe(ev('runtime.terminated')) // exited
    projector.observe(ev('turn.started')) // out-of-order, must be ignored
    await flushAll()
    expect(applied).toHaveLength(1)
    expect(applied[0]?.spec.right).toBe('■ exited')
  })

  it('tracks distinct runtimes independently', async () => {
    const { projector, applied, flushAll } = makeHarness((runtimeId) => `surf-${runtimeId}`)
    projector.observe(ev('turn.started', 'rt-a'))
    projector.observe(ev('runtime.terminated', 'rt-b'))
    await flushAll()
    const bySurface = Object.fromEntries(applied.map((a) => [a.surfaceId, a.spec.right]))
    expect(bySurface['surf-rt-a']).toBe('▶ running')
    expect(bySurface['surf-rt-b']).toBe('■ exited')
  })

  it('skips the write when no viewer surface is bound', async () => {
    const { projector, applied, flushAll } = makeHarness(() => null)
    projector.observe(ev('turn.started'))
    await flushAll()
    expect(applied).toHaveLength(0)
  })

  it('ignores events without a runtime id or with no state meaning', async () => {
    const { projector, applied, flushAll } = makeHarness()
    projector.observe({ eventKind: 'turn.started', scopeRef: 'agent:clod' })
    projector.observe(ev('turn.tool_call'))
    await flushAll()
    expect(applied).toHaveLength(0)
  })

  it('enriches the center field with a resolved slug (T-04977)', async () => {
    const { projector, applied, flushAll } = makeHarness(
      () => 'surf-1',
      async () => 'add-task-slug-to-ghostmux-status-bar'
    )
    projector.observe(ev('turn.started', 'rt-1', 'agent:clod:project:hrc-runtime:task:T-04977'))
    await flushAll()
    expect(applied).toHaveLength(1)
    expect(applied[0]?.spec.center).toBe(
      'hrc-runtime · T-04977 · add-task-slug-to-ghostmux-status-bar'
    )
  })

  it('falls back to project · T-id when the slug resolver returns null', async () => {
    const { projector, applied, flushAll } = makeHarness(
      () => 'surf-1',
      async () => null
    )
    projector.observe(ev('turn.started', 'rt-1', 'agent:clod:project:hrc-runtime:task:T-04977'))
    await flushAll()
    expect(applied[0]?.spec.center).toBe('hrc-runtime · T-04977')
  })

  it('still writes the bar when the slug resolver throws (best-effort)', async () => {
    const { projector, applied, errors, flushAll } = makeHarness(
      () => 'surf-1',
      async () => {
        throw new Error('wrkq exploded')
      }
    )
    projector.observe(ev('turn.started', 'rt-1', 'agent:clod:project:hrc-runtime:task:T-04977'))
    await flushAll()
    expect(applied).toHaveLength(1)
    expect(applied[0]?.spec.center).toBe('hrc-runtime · T-04977')
    expect(errors).toHaveLength(1)
  })

  it('writes the bar normally when no slug resolver is configured', async () => {
    const { projector, applied, flushAll } = makeHarness()
    projector.observe(ev('turn.started', 'rt-1', 'agent:clod:project:hrc-runtime:task:T-04977'))
    await flushAll()
    expect(applied[0]?.spec.center).toBe('hrc-runtime · T-04977')
  })

  it('never repaints terminal color — the projector only writes the status bar', async () => {
    // The projector is constructed with NO terminal-background dependency; color
    // is identity, applied once at spawn/reuse, never per lifecycle event.
    const { projector } = makeHarness()
    expect('setTerminalBackground' in (projector as unknown as Record<string, unknown>)).toBe(false)
    expect(Object.keys(projector as unknown as Record<string, unknown>)).not.toContain(
      'applyTerminalBackground'
    )
  })
})
