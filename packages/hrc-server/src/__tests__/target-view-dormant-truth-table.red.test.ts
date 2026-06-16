/**
 * RED tests (T-04831 / parent T-04827 GROUP 1) — toTargetState dormant truth table.
 *
 * Architecture: daedalus-cleared (T-04827).  `archived` is a VIEW FILTER, not a
 * resumability gate.  The new target state `dormant` represents an archived
 * session whose continuation artifact is present (or unknown) and can be resumed
 * via successor-from-continuation.  `broken` is RESERVED for corrupt/missing/
 * non-resumable continuity — NOT for archive status.
 *
 * Required signature change (caller resolves the async probe, keeps toTargetState
 * sync):
 *   toTargetState(
 *     session: HrcSessionRecord,
 *     runtime: HrcTargetRuntimeView | undefined,
 *     artifact?: 'present' | 'missing' | 'unknown'
 *   ): HrcTargetState
 *
 * Truth table:
 *   archived + continuation present + artifact 'present'  ⇒ 'dormant'   [RED]
 *   archived + continuation present + artifact 'unknown'  ⇒ 'dormant'   [RED]
 *   archived + continuation present + artifact 'missing'  ⇒ 'broken'    [GREEN guard]
 *   archived + NO continuation ref at all                 ⇒ 'broken'    [GREEN guard]
 *   active   + no runtime + no continuation               ⇒ 'summoned'  [GREEN guard]
 *   active   + live runtime (bound)                       ⇒ 'bound'     [GREEN guard]
 *   active   + live runtime with activeRunId              ⇒ 'busy'      [GREEN guard]
 *
 * RED at HEAD: toTargetState has no third parameter and maps EVERY archived
 * session to 'broken', so the dormant cases fail:
 *   - toTargetState(archivedWithContinuation, undefined, 'present') returns 'broken' not 'dormant'
 *   - toTargetState(archivedWithContinuation, undefined, 'unknown') returns 'broken' not 'dormant'
 */
import { describe, expect, it } from 'bun:test'

import type { HrcSessionRecord, HrcTargetRuntimeView, HrcTargetState } from 'hrc-core'

import { toTargetState } from '../target-view'

// Cast to the expected post-fix signature so we can drive the artifact param
// without a compile error.  The BEHAVIORAL assertion is what makes these red.
type ToTargetStateWithArtifact = (
  session: HrcSessionRecord,
  runtime: HrcTargetRuntimeView | undefined,
  artifact?: 'present' | 'missing' | 'unknown'
) => HrcTargetState

const toTargetStateFn = toTargetState as unknown as ToTargetStateWithArtifact

// ── Fixture builders ──────────────────────────────────────────────────────────

const NOW = '2026-06-16T00:00:00.000Z'

function makeArchivedSession(withContinuation: boolean): HrcSessionRecord {
  return {
    hostSessionId: 'hsid-archived-01',
    scopeRef: 'agent:test:project:t04831-group1',
    laneRef: 'main',
    generation: 2,
    status: 'archived',
    priorHostSessionId: 'hsid-prior-01',
    createdAt: NOW,
    updatedAt: NOW,
    ancestorScopeRefs: [],
    ...(withContinuation
      ? { continuation: { provider: 'anthropic', key: 'sess-key-abc123' } }
      : {}),
  }
}

function makeActiveSession(): HrcSessionRecord {
  return {
    hostSessionId: 'hsid-active-01',
    scopeRef: 'agent:test:project:t04831-group1',
    laneRef: 'main',
    generation: 3,
    status: 'active',
    createdAt: NOW,
    updatedAt: NOW,
    ancestorScopeRefs: [],
  }
}

function makeBoundRuntime(activeRunId?: string): HrcTargetRuntimeView {
  return {
    runtimeId: 'rt-bound-01',
    transport: 'tmux',
    status: 'ready',
    supportsLiteralSend: true,
    supportsCapture: true,
    ...(activeRunId ? { activeRunId } : {}),
  }
}

// ── GROUP 1 RED: archived + artifact 'present' ⇒ 'dormant' ───────────────────
// These fail because toTargetState currently returns 'broken' for any archived
// session, ignoring the continuation artifact result.

describe('[RED 1a] archived + continuation + artifact present ⇒ dormant (not broken)', () => {
  it('returns dormant when session is archived and continuation artifact is present', () => {
    const session = makeArchivedSession(true)
    // RED: currently returns 'broken' (status !== 'active' branch fires unconditionally)
    expect(toTargetStateFn(session, undefined, 'present')).toBe<HrcTargetState>('dormant')
  })

  it('dormant regardless of whether a (stale/dead) runtime view is passed', () => {
    const session = makeArchivedSession(true)
    const staleRuntime: HrcTargetRuntimeView = {
      runtimeId: 'rt-stale-01',
      transport: 'headless',
      status: 'dead',
      supportsLiteralSend: false,
      supportsCapture: false,
    }
    // RED: currently returns 'broken'
    expect(toTargetStateFn(session, staleRuntime, 'present')).toBe<HrcTargetState>('dormant')
  })
})

// ── GROUP 1 RED: archived + artifact 'unknown' ⇒ 'dormant' ───────────────────
// 'unknown' is NOT false.  An inability to stat the artifact must NOT coerce the
// state to 'broken' — the session may still be resumable.

describe('[RED 1b] archived + continuation + artifact unknown ⇒ dormant (unknown ≠ missing)', () => {
  it('returns dormant when artifact probe result is unknown', () => {
    const session = makeArchivedSession(true)
    // RED: currently returns 'broken'
    expect(toTargetStateFn(session, undefined, 'unknown')).toBe<HrcTargetState>('dormant')
  })

  it('returns dormant when artifact param is omitted entirely (caller did not probe)', () => {
    // When no probe was run at all (e.g. cheap list path), archived + continuation
    // should default to dormant — unknown is the implicit state.
    const session = makeArchivedSession(true)
    // RED: currently returns 'broken'
    expect(toTargetStateFn(session, undefined)).toBe<HrcTargetState>('dormant')
  })
})

// ── GROUP 1 GREEN guards: cases that must stay broken ────────────────────────
// These currently PASS and must continue to pass after the fix.

describe('[GREEN guard] archived + artifact missing ⇒ broken (non-resumable)', () => {
  it('returns broken when artifact is explicitly missing', () => {
    const session = makeArchivedSession(true)
    expect(toTargetStateFn(session, undefined, 'missing')).toBe<HrcTargetState>('broken')
  })
})

describe('[GREEN guard] archived + no continuation ref ⇒ broken', () => {
  it('returns broken when archived session has no continuation at all', () => {
    const session = makeArchivedSession(false) // no continuation field
    // No continuation key to probe → non-resumable
    expect(toTargetStateFn(session, undefined, 'present')).toBe<HrcTargetState>('broken')
    expect(toTargetStateFn(session, undefined, 'unknown')).toBe<HrcTargetState>('broken')
    expect(toTargetStateFn(session, undefined, 'missing')).toBe<HrcTargetState>('broken')
    expect(toTargetStateFn(session, undefined)).toBe<HrcTargetState>('broken')
  })
})

describe('[GREEN guard] active session states are UNCHANGED (regression fence)', () => {
  it('active + no runtime ⇒ summoned (fresh-start, unchanged)', () => {
    const session = makeActiveSession()
    expect(toTargetStateFn(session, undefined)).toBe<HrcTargetState>('summoned')
  })

  it('active + live bound runtime ⇒ bound (unchanged)', () => {
    const session = makeActiveSession()
    expect(toTargetStateFn(session, makeBoundRuntime())).toBe<HrcTargetState>('bound')
  })

  it('active + live runtime with activeRunId ⇒ busy (unchanged)', () => {
    const session = makeActiveSession()
    expect(toTargetStateFn(session, makeBoundRuntime('run-xyz'))).toBe<HrcTargetState>('busy')
  })

  it('active + headless runtime (no activeRunId) ⇒ summoned (unchanged)', () => {
    const session = makeActiveSession()
    const headlessRuntime: HrcTargetRuntimeView = {
      runtimeId: 'rt-headless-01',
      transport: 'headless',
      status: 'ready',
      supportsLiteralSend: false,
      supportsCapture: false,
    }
    expect(toTargetStateFn(session, headlessRuntime)).toBe<HrcTargetState>('summoned')
  })
})
