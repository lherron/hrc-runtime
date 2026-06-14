/**
 * Headless-viewer status-bar projection (T-04439).
 *
 * The Ghostty status bar on a headless Claude viewer window is an
 * eventually-consistent PRESENTATION PROJECTION. It is never state authority,
 * never mutates run/runtime lifecycle, and never delays or fails dispatch.
 * Canonical HRC lifecycle events project to a last-state-wins bar; `exited`
 * dominates any pending lower-priority update (daedalus, T-04439 invariant).
 *
 * ghostmux `statusbar set` is NOT a partial update — passing text sets all
 * three fields — so we always re-render the whole triplet, preserving
 * left/center and changing only the right (state) field.
 */

import { parseScopeRef } from 'agent-scope'

import { agentTheme } from './agent-theme.js'
import type { GhostmuxStatusBarSpec } from './ghostmux.js'

export type ViewerState = 'running' | 'awaiting' | 'idle' | 'exited'

/** Right-field label per state. Distinct glyphs, no emoji. */
const STATE_RIGHT: Readonly<Record<ViewerState, string>> = {
  running: '▶ running',
  awaiting: '⏸ awaiting input',
  idle: '✓ idle',
  exited: '■ exited',
}

/**
 * Map a canonical HRC lifecycle event kind to the viewer state it implies, or
 * null when the event carries no state meaning. `turn.completed` maps to idle;
 * the projector's sticky-exited rule guarantees we never paint idle over a
 * runtime that has already terminated.
 */
export function viewerStateForEventKind(eventKind: string): ViewerState | null {
  switch (eventKind) {
    case 'turn.started':
    case 'turn.input_resumed':
      return 'running'
    case 'turn.awaiting_input':
      return 'awaiting'
    case 'turn.completed':
      return 'idle'
    case 'runtime.terminated':
    case 'runtime.dead':
    case 'runtime.stale':
      return 'exited'
    default:
      return null
  }
}

/** Build the full status-bar triplet for a scope + state. Pure. */
export function renderStatusBar(scopeRef: string, state: ViewerState): GhostmuxStatusBarSpec {
  const parsed = safeParseScopeRef(scopeRef)
  const agentId = parsed?.agentId ?? 'unknown'
  const theme = agentTheme(agentId)
  return {
    left: `◆ ${agentId.toUpperCase()}`,
    center: renderCenter(parsed),
    right: STATE_RIGHT[state],
    fg: theme.fg,
    bg: theme.bg,
  }
}

/** The agent-color terminal tint (`set-bg`) for a scope's viewer window. */
export function viewerTerminalBg(scopeRef: string): string {
  const parsed = safeParseScopeRef(scopeRef)
  return agentTheme(parsed?.agentId ?? 'unknown').terminalBg
}

function renderCenter(parsed: ReturnType<typeof safeParseScopeRef>): string {
  if (!parsed) return ''
  const project = parsed.projectId ?? ''
  // `primary` is the default task scope and carries no information — drop it.
  const task = parsed.taskId && parsed.taskId !== 'primary' ? parsed.taskId : ''
  if (project && task) return `${project} · ${task}`
  return project || task || ''
}

function safeParseScopeRef(scopeRef: string): ReturnType<typeof parseScopeRef> | null {
  try {
    return parseScopeRef(scopeRef)
  } catch {
    return null
  }
}

export type HeadlessViewerStatusProjectorDeps = {
  /** Resolve the viewer surface bound to a runtime (DB first, metadata fallback). */
  resolveSurfaceId: (runtimeId: string) => Promise<string | null> | string | null
  /** Apply a full status-bar triplet. Best-effort — must never throw. */
  applyStatusBar: (surfaceId: string, spec: GhostmuxStatusBarSpec) => Promise<void>
  /** Coalescing window per runtime. Defaults to 150ms. */
  debounceMs?: number
  /** Injectable timer for tests. Defaults to setTimeout/clearTimeout. */
  schedule?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearScheduled?: (handle: ReturnType<typeof setTimeout>) => void
  /** Optional error sink; the projector itself never throws regardless. */
  onError?: (error: unknown) => void
}

type ProjectorEntry = {
  scopeRef: string
  pending: ViewerState
  /** True once any terminal event has been observed — exited is sticky. */
  exited: boolean
  timer: ReturnType<typeof setTimeout> | undefined
}

type LifecycleLike = {
  eventKind: string
  runtimeId?: string | undefined
  scopeRef?: string | undefined
}

/**
 * Single observer hung off the `notifyEvent` lifecycle seam. Coalesces rapid
 * transitions per runtime (last-state-wins) and writes the bar best-effort.
 */
export class HeadlessViewerStatusProjector {
  private readonly entries = new Map<string, ProjectorEntry>()
  private readonly debounceMs: number
  private readonly schedule: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  private readonly clearScheduled: (handle: ReturnType<typeof setTimeout>) => void

  constructor(private readonly deps: HeadlessViewerStatusProjectorDeps) {
    this.debounceMs = deps.debounceMs ?? 150
    this.schedule = deps.schedule ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearScheduled = deps.clearScheduled ?? ((handle) => clearTimeout(handle))
  }

  /** Observe one lifecycle event. Never throws; returns immediately. */
  observe(event: LifecycleLike): void {
    try {
      const state = viewerStateForEventKind(event.eventKind)
      if (!state) return
      const runtimeId = event.runtimeId
      const scopeRef = event.scopeRef
      if (!runtimeId || !scopeRef) return

      const entry = this.entries.get(runtimeId) ?? {
        scopeRef,
        pending: state,
        exited: false,
        timer: undefined,
      }
      // Once a terminal event is seen, the bar is exited forever — ignore any
      // later running/awaiting/idle, even if it arrives out of order.
      if (entry.exited) return
      entry.scopeRef = scopeRef
      if (state === 'exited') entry.exited = true
      entry.pending = state
      this.entries.set(runtimeId, entry)

      if (entry.timer === undefined) {
        entry.timer = this.schedule(() => {
          void this.flush(runtimeId)
        }, this.debounceMs)
      }
    } catch (error) {
      this.deps.onError?.(error)
    }
  }

  private async flush(runtimeId: string): Promise<void> {
    const entry = this.entries.get(runtimeId)
    if (!entry) return
    entry.timer = undefined
    const { pending: state, scopeRef, exited } = entry
    try {
      const surfaceId = await this.deps.resolveSurfaceId(runtimeId)
      if (surfaceId) {
        await this.deps.applyStatusBar(surfaceId, renderStatusBar(scopeRef, state))
      }
    } catch (error) {
      this.deps.onError?.(error)
    } finally {
      // After the final exited write, drop the entry so a reused window for a
      // future runtime starts clean.
      if (exited) this.entries.delete(runtimeId)
    }
  }

  /** Cancel pending timers (server shutdown). */
  dispose(): void {
    for (const entry of this.entries.values()) {
      if (entry.timer !== undefined) this.clearScheduled(entry.timer)
    }
    this.entries.clear()
  }
}
