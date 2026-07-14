import { describe, expect, it } from 'bun:test'

import {
  HEADLESS_PANE_ROLE,
  type PaneStatus,
  classifyReapExec,
  isAlreadyTerminatedError,
  isLeftoverViewer,
  isQuitEligible,
  selectHeadlessPanes,
  skipReasons,
} from './reap-headless-ghostmux'

// Operator idle-viewer reap predicate (T-04423). Eligible iff the surface
// resolves to exactly one broker-tmux runtime that is idle-and-complete with NO
// active run. Each guard is exercised below.
function eligibleStatus(overrides: Partial<PaneStatus> = {}): PaneStatus {
  return {
    id: 'PANE0001',
    title: 'hrc headless agent:clod:project:hrc-runtime:task:reap-probe',
    agent: 'clod',
    scopeRef: 'agent:clod:project:hrc-runtime:task:reap-probe',
    runtimeId: 'rt-eligible',
    runtimeStatus: 'ready',
    transport: 'tmux',
    controllerKind: 'harness-broker',
    activeRunId: '',
    turnStatus: 'completed',
    runId: 'run-done',
    lastEventUtc: '2026-06-14T15:50:38.000Z',
    lastEventLocal: '2026-06-14 10:50:38',
    lastEventKind: 'turn.completed',
    ...overrides,
  }
}

describe('isQuitEligible (operator reap predicate)', () => {
  it('is eligible for an idle, complete broker-tmux runtime with no active run', () => {
    expect(isQuitEligible(eligibleStatus())).toBe(true)
  })

  it('skips when the surface did not resolve to a runtime', () => {
    expect(isQuitEligible(eligibleStatus({ runtimeId: '' }))).toBe(false)
  })

  it('skips a true headless/sdk runtime (only broker-tmux is reapable here)', () => {
    expect(isQuitEligible(eligibleStatus({ transport: 'headless' }))).toBe(false)
    expect(isQuitEligible(eligibleStatus({ transport: 'sdk' }))).toBe(false)
  })

  it('skips a non-broker tmux pane', () => {
    expect(isQuitEligible(eligibleStatus({ controllerKind: '' }))).toBe(false)
    expect(isQuitEligible(eligibleStatus({ controllerKind: 'none' }))).toBe(false)
  })

  it('skips a runtime that is not ready (busy/terminated/etc.)', () => {
    expect(isQuitEligible(eligibleStatus({ runtimeStatus: 'busy' }))).toBe(false)
    expect(isQuitEligible(eligibleStatus({ runtimeStatus: 'terminated' }))).toBe(false)
  })

  it('skips a runtime with an active run (HIGH-severity guard)', () => {
    expect(isQuitEligible(eligibleStatus({ activeRunId: 'run-live' }))).toBe(false)
    // ready + active run is exactly the corrupt state that would otherwise have
    // its live run failed by finalizeRuntimeTermination.
    expect(
      isQuitEligible(eligibleStatus({ runtimeStatus: 'ready', activeRunId: 'run-live' }))
    ).toBe(false)
  })

  it('skips when the latest turn is not completed', () => {
    expect(isQuitEligible(eligibleStatus({ turnStatus: 'running' }))).toBe(false)
    expect(isQuitEligible(eligibleStatus({ turnStatus: 'failed' }))).toBe(false)
    expect(isQuitEligible(eligibleStatus({ turnStatus: 'none' }))).toBe(false)
  })

  it('requires the latest activity to be strictly more than 30 minutes old', () => {
    const realDateNow = Date.now
    const now = Date.parse('2026-07-14T15:00:00.000Z')
    Date.now = () => now
    try {
      expect(
        isQuitEligible(
          eligibleStatus({
            lastEventUtc: new Date(now - 29 * 60 * 1000).toISOString(),
          })
        )
      ).toBe(false)
      expect(
        isQuitEligible(
          eligibleStatus({
            lastEventUtc: new Date(now - 30 * 60 * 1000).toISOString(),
          })
        )
      ).toBe(false)
      expect(
        isQuitEligible(
          eligibleStatus({
            lastEventUtc: new Date(now - 30 * 60 * 1000 - 1).toISOString(),
          })
        )
      ).toBe(true)
    } finally {
      Date.now = realDateNow
    }
  })

  it('skips when latest activity time is missing or invalid', () => {
    expect(isQuitEligible(eligibleStatus({ lastEventUtc: '' }))).toBe(false)
    expect(isQuitEligible(eligibleStatus({ lastEventUtc: 'not-a-timestamp' }))).toBe(false)
  })
})

describe('skipReasons (per-pane skip explanations)', () => {
  it('returns no reasons for an eligible pane', () => {
    expect(skipReasons(eligibleStatus())).toEqual([])
  })

  it('reports a single root reason when the surface resolves to no runtime', () => {
    const reasons = skipReasons(eligibleStatus({ runtimeId: '' }))
    expect(reasons).toHaveLength(1)
    expect(reasons[0]).toMatch(/no HRC runtime resolved/i)
  })

  it('reports a single root reason when the runtime is absent from the DB', () => {
    const reasons = skipReasons(
      eligibleStatus({ runtimeStatus: 'unknown', runtimeId: 'rt-ghost123' })
    )
    expect(reasons).toHaveLength(1)
    expect(reasons[0]).toMatch(/not found in the HRC DB/i)
    expect(reasons[0]).toContain('rt-ghost123')
  })

  it('explains an already-terminated runtime (the leftover-viewer case)', () => {
    const reasons = skipReasons(eligibleStatus({ runtimeStatus: 'terminated' }))
    expect(reasons).toHaveLength(1)
    expect(reasons[0]).toMatch(/already terminated/i)
    expect(reasons[0]).toMatch(/ghostmux/i)
  })

  it('explains a busy runtime as a wait-and-retry case', () => {
    expect(skipReasons(eligibleStatus({ runtimeStatus: 'busy' }))[0]).toMatch(/wait until/i)
  })

  it('explains a failed/dead runtime as do-not-reap', () => {
    expect(skipReasons(eligibleStatus({ runtimeStatus: 'failed' }))[0]).toMatch(/do not reap/i)
  })

  it('explains a non-broker / non-tmux runtime', () => {
    expect(skipReasons(eligibleStatus({ controllerKind: 'sdk' }))[0]).toMatch(/not harness-broker/i)
    expect(skipReasons(eligibleStatus({ transport: 'headless' }))[0]).toMatch(/not tmux/i)
  })

  it('flags the HIGH-severity active-run case with the run id', () => {
    const reasons = skipReasons(eligibleStatus({ activeRunId: 'run-live9999' }))
    expect(reasons[0]).toMatch(/active run/i)
    expect(reasons[0]).toMatch(/would fail the live run/i)
    expect(reasons[0]).toContain('run-live9')
  })

  it('explains an incomplete latest turn', () => {
    expect(skipReasons(eligibleStatus({ turnStatus: 'started' }))[0]).toMatch(/in progress/i)
    expect(skipReasons(eligibleStatus({ turnStatus: 'failed' }))[0]).toMatch(/not completed/i)
    expect(skipReasons(eligibleStatus({ turnStatus: 'none' }))[0]).toMatch(/nothing has run/i)
  })

  it('explains when the latest activity is not more than 30 minutes old', () => {
    const reasons = skipReasons(
      eligibleStatus({
        lastEventUtc: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      })
    )
    expect(reasons.some((reason) => /more than 30 minutes idle/i.test(reason))).toBe(true)
  })

  it('lists every failed guard when several are wrong at once', () => {
    const reasons = skipReasons(
      eligibleStatus({ transport: 'sdk', activeRunId: 'run-x', turnStatus: 'none' })
    )
    expect(reasons.length).toBeGreaterThanOrEqual(3)
    expect(reasons.some((r) => /not tmux/i.test(r))).toBe(true)
    expect(reasons.some((r) => /active run/i.test(r))).toBe(true)
    expect(reasons.some((r) => /nothing has run/i.test(r))).toBe(true)
  })
})

describe('isLeftoverViewer (already-dead pane to close)', () => {
  it('is true for a resolved, already-terminated runtime', () => {
    expect(isLeftoverViewer(eligibleStatus({ runtimeStatus: 'terminated' }))).toBe(true)
  })

  it('is true for a stale runtime (no live broker left)', () => {
    expect(isLeftoverViewer(eligibleStatus({ runtimeStatus: 'stale' }))).toBe(true)
  })

  it('is false for a live, reap-eligible runtime (that path reaps first)', () => {
    expect(isLeftoverViewer(eligibleStatus())).toBe(false)
  })

  it('is false when no runtime resolved (orphaned viewer, not a known dead one)', () => {
    expect(isLeftoverViewer(eligibleStatus({ runtimeStatus: 'terminated', runtimeId: '' }))).toBe(
      false
    )
  })

  it('is false when a run is still active (never key-close an in-flight pane)', () => {
    expect(
      isLeftoverViewer(eligibleStatus({ runtimeStatus: 'terminated', activeRunId: 'run-live' }))
    ).toBe(false)
  })

  it('is false when the leftover pane has not been idle for more than 30 minutes', () => {
    expect(
      isLeftoverViewer(
        eligibleStatus({
          runtimeStatus: 'terminated',
          lastEventUtc: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
        })
      )
    ).toBe(false)
  })

  it('is disjoint from reap-eligibility (a pane is never both)', () => {
    const terminated = eligibleStatus({ runtimeStatus: 'terminated' })
    expect(isLeftoverViewer(terminated) && isQuitEligible(terminated)).toBe(false)
    const ready = eligibleStatus()
    expect(isLeftoverViewer(ready) && isQuitEligible(ready)).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Phase C: presentation-aware eligibility matrix (T-04923, daedalus test 7)
//
// After Phase C green, skipReasons() replaces the raw transport gate (lines 249-254)
// with a presentation-aware check: a runtime is eligible IFF ALL hold:
//   controllerKind=harness-broker  +  substrateKind=leased-tmux
//   +  presentationKind=tmux-tui   +  ready/idle  +  no active run  +  latest turn completed
// This unlocks transport='headless' runtimes that have a real tmux TUI window
// (the codex app-server viewer pane), while rejecting true headless runs
// (presentation.kind=none) and daemon-child substrates.
//
// How the script should source presentationKind / substrateKind:
//   Add two json_extract columns to the WITH latest_runtime AS (...) query in
//   queryStatus() — reading from the runtime_state_json column of the runtimes
//   table.  Two serialisation shapes must be handled (G2 compatibility):
//     presentationKind:
//       COALESCE(
//         json_extract(runtime_state_json, '$.broker.presentation.kind'),   -- normalized
//         CASE WHEN json_extract(runtime_state_json, '$.broker.tuiWindow')
//                   IS NOT NULL THEN 'tmux-tui' ELSE 'none' END,           -- flat fallback
//         ''
//       )
//     substrateKind:
//       COALESCE(
//         json_extract(runtime_state_json, '$.broker.substrate.kind'),      -- normalized
//         CASE WHEN json_extract(runtime_state_json, '$.broker.brokerWindow')
//                   IS NOT NULL THEN 'leased-tmux' ELSE 'daemon-child' END, -- flat fallback
//         ''
//       )
//   Then add both to the SELECT list and to PaneStatus, and wire them into
//   skipReasons() in place of the transport check.
// ─────────────────────────────────────────────────────────────────────────────

describe('Phase C: reap eligibility matrix — presentation-aware predicate (T-04923)', () => {
  // PaneStatus will gain presentationKind + substrateKind in Phase C green.
  // We define a local extension and use an explicit cast so the file compiles
  // today.  Reds fail at RUNTIME (the transport gate at lines 249-254 wrongly
  // rejects headless+tmux-tui), not at compile time.
  type ViewerPaneStatus = PaneStatus & {
    presentationKind: string
    substrateKind: string
  }

  function viewerStatus(overrides: Partial<ViewerPaneStatus> = {}): ViewerPaneStatus {
    return {
      ...eligibleStatus(),
      // Codex app-server viewer pane: the HRC transport is 'headless' (the
      // broker channel to the daemon), but the runtime has a dedicated tmux
      // TUI window visible to the operator.
      transport: 'headless',
      presentationKind: 'tmux-tui',
      substrateKind: 'leased-tmux',
      ...overrides,
    }
  }

  // Explicit cast: current skipReasons/isQuitEligible take PaneStatus.
  // The extra fields (presentationKind, substrateKind) are silently ignored by
  // the current predicate — the tests expose exactly what happens when they
  // are NOT ignored after Phase C green.
  function ps(s: ViewerPaneStatus): PaneStatus {
    return s as unknown as PaneStatus
  }

  // ── ELIGIBLE — core Phase C green target ────────────────────────────────────

  it('is eligible: harness-broker + leased-tmux substrate + tmux-tui presentation + headless transport + ready + no active run + completed turn', () => {
    // RED: transport='headless' is caught at lines 249-254 before presentationKind
    // is consulted, so isQuitEligible returns false today.  Phase C green replaces
    // the transport gate with a presentation-aware check and this becomes GREEN.
    expect(isQuitEligible(ps(viewerStatus()))).toBe(true)
    expect(skipReasons(ps(viewerStatus()))).toEqual([])
  })

  // ── REJECT: presentation is not tmux-tui ─────────────────────────────────────

  it('rejects headless + presentation.kind=none (pure headless runtime, no viewer pane)', () => {
    // A true headless codex runtime — broker lives in a leased tmux session but
    // there is no TUI window for the operator.  Must be rejected and the reason
    // must reference presentation, not just the raw transport value.
    // RED today: skipReasons returns "transport=headless, not tmux" — the
    // /presentation|tmux-tui/ assertion fails because no reason mentions presentation.
    const reasons = skipReasons(ps(viewerStatus({ presentationKind: 'none' })))
    expect(reasons.length).toBeGreaterThan(0)
    expect(reasons.some((r) => /presentation|tmux-tui/i.test(r))).toBe(true)
  })

  it('rejects headless + presentation.kind="" (missing / malformed hosting state)', () => {
    // presentationKind='' means the DB json_extract returned NULL — runtimeStateJson
    // has no parseable broker.presentation block.  Must reject for that reason.
    // RED today: reason says "transport=headless", not "hosting state" / "presentation".
    const reasons = skipReasons(ps(viewerStatus({ presentationKind: '' })))
    expect(reasons.length).toBeGreaterThan(0)
    expect(reasons.some((r) => /presentation|hosting state|malformed/i.test(r))).toBe(true)
  })

  // ── REJECT: substrate not leased-tmux ───────────────────────────────────────

  it('rejects harness-broker + daemon-child substrate (no tmux pane to close)', () => {
    // Even if presentation claims tmux-tui, a daemon-child substrate has no real
    // tmux session — reject and surface the substrate mismatch in the reason.
    // RED today: no substrate check exists; reason says "transport=headless" with
    // no mention of daemon-child/substrate/leased-tmux.
    const reasons = skipReasons(ps(viewerStatus({ substrateKind: 'daemon-child' })))
    expect(reasons.length).toBeGreaterThan(0)
    expect(reasons.some((r) => /daemon-child|substrate|leased-tmux/i.test(r))).toBe(true)
  })

  // ── REJECT: controllerKind not harness-broker (regression guard) ─────────────

  it('rejects a non-broker runtime even with tmux-tui presentation (regression guard)', () => {
    // Already rejects today via the controllerKind check — included to guard
    // against Phase C accidentally removing that gate.
    const reasons = skipReasons(ps(viewerStatus({ controllerKind: 'sdk' })))
    expect(reasons.some((r) => /not harness-broker/i.test(r))).toBe(true)
  })

  // ── REJECT: runtime lifecycle (regression guards) ────────────────────────────

  it('rejects an already-terminated viewer pane — leftover-viewer path handles it (regression guard)', () => {
    expect(isQuitEligible(ps(viewerStatus({ runtimeStatus: 'terminated' })))).toBe(false)
    expect(isLeftoverViewer(ps(viewerStatus({ runtimeStatus: 'terminated' })))).toBe(true)
  })

  it('rejects a stale viewer pane (regression guard)', () => {
    expect(isQuitEligible(ps(viewerStatus({ runtimeStatus: 'stale' })))).toBe(false)
  })

  it('rejects a busy/started viewer pane — wait-and-retry (regression guard)', () => {
    expect(isQuitEligible(ps(viewerStatus({ runtimeStatus: 'busy' })))).toBe(false)
    expect(isQuitEligible(ps(viewerStatus({ runtimeStatus: 'started' })))).toBe(false)
  })

  // ── REJECT: orphaned viewer (regression guard) ───────────────────────────────

  it('handles an orphaned viewer pane safely — no runtime to reap or close (regression guard)', () => {
    expect(isQuitEligible(ps(viewerStatus({ runtimeId: '' })))).toBe(false)
    expect(isLeftoverViewer(ps(viewerStatus({ runtimeId: '' })))).toBe(false)
  })

  // ── REJECT: active run / incomplete turn (regression guards) ─────────────────

  it('rejects a viewer pane with an active run — HIGH-severity guard (regression guard)', () => {
    const reasons = skipReasons(ps(viewerStatus({ activeRunId: 'run-viewer-live' })))
    expect(reasons.some((r) => /active run/i.test(r))).toBe(true)
    expect(reasons.some((r) => /would fail the live run/i.test(r))).toBe(true)
  })

  it('rejects a viewer pane with an incomplete latest turn (regression guard)', () => {
    expect(isQuitEligible(ps(viewerStatus({ turnStatus: 'running' })))).toBe(false)
    expect(isQuitEligible(ps(viewerStatus({ turnStatus: 'failed' })))).toBe(false)
    expect(isQuitEligible(ps(viewerStatus({ turnStatus: 'none' })))).toBe(false)
  })

  // ── FULL MATRIX: multiple simultaneous failures ───────────────────────────────

  it('reports all failed guards when presentation=none + active run + incomplete turn', () => {
    // RED: skipReasons returns "transport=headless", "active run", "in progress" —
    // three reasons exist but none mentions presentation.  The /presentation|tmux-tui/
    // assertion fails.  After Phase C green all three map to their real guards.
    const reasons = skipReasons(
      ps(viewerStatus({ presentationKind: 'none', activeRunId: 'run-x', turnStatus: 'running' }))
    )
    expect(reasons.length).toBeGreaterThanOrEqual(3)
    expect(reasons.some((r) => /presentation|tmux-tui/i.test(r))).toBe(true)
    expect(reasons.some((r) => /active run/i.test(r))).toBe(true)
    expect(reasons.some((r) => /in progress/i.test(r))).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Discovery by durable metadata role, NOT title (T-05237 regression).
//
// The consolidated "Headless Sessions" window renamed pane titles from
// `hrc headless agent:<scope>` to the compact `<proj> · <task> · <agent>` form,
// which silently broke the old `^hrc headless agent:` title regex. Discovery now
// keys off ghostmux metadata `hrc_role === HEADLESS_PANE_ROLE`.
// ─────────────────────────────────────────────────────────────────────────────
describe('selectHeadlessPanes (metadata-role discovery)', () => {
  // Mirrors the live surface set: new-format headless panes, the window anchor,
  // an interactive non-headless surface, and an old-format leftover with no
  // metadata at all (the pre-rename pane that the title regex used to match).
  const terminals = [
    { short_id: '4EF80A10', title: 'hrc · T-05262 · clod' },
    { short_id: '5B01A4E9', title: 'wrkq · T-05272 · clod' },
    { short_id: '618CFC8D', title: 'Headless Sessions' },
    { short_id: 'DD4C6CE6', title: '/Users/lherron/praesidium/hrc-runtime' },
    { short_id: '3851935F', title: 'hrc headless agent:cody:project:acp:task:T-05190' },
  ]
  const metadataById: Record<string, Record<string, unknown>> = {
    '4EF80A10': {
      hrc_role: HEADLESS_PANE_ROLE,
      hrc_runtime_id: 'rt-a',
      hrc_scope_ref: 'agent:clod',
    },
    '5B01A4E9': {
      hrc_role: HEADLESS_PANE_ROLE,
      hrc_runtime_id: 'rt-b',
      hrc_scope_ref: 'agent:clod',
    },
    '618CFC8D': { hrc_role: 'headless-window-anchor' },
    DD4C6CE6: { hrc_role: 'interactive-tui' },
    '3851935F': {}, // leftover: no metadata at all
  }
  const resolve = (id: string) => metadataById[id] ?? {}

  it('selects only panes whose role is headless-agent-pane', () => {
    const panes = selectHeadlessPanes(terminals, resolve, HEADLESS_PANE_ROLE)
    expect(panes.map((p) => p.id)).toEqual(['4EF80A10', '5B01A4E9'])
  })

  it('excludes the window anchor and interactive/leftover surfaces', () => {
    const ids = selectHeadlessPanes(terminals, resolve, HEADLESS_PANE_ROLE).map((p) => p.id)
    expect(ids).not.toContain('618CFC8D') // headless-window-anchor
    expect(ids).not.toContain('DD4C6CE6') // interactive tui
    expect(ids).not.toContain('3851935F') // old-format leftover, no metadata
  })

  it('carries the resolved metadata forward so queryStatus need not re-fetch', () => {
    const [first] = selectHeadlessPanes(terminals, resolve, HEADLESS_PANE_ROLE)
    expect(first.metadata.hrc_runtime_id).toBe('rt-a')
    expect(first.metadata.hrc_scope_ref).toBe('agent:clod')
  })

  it('applies an optional title regex as a secondary filter', () => {
    const ids = selectHeadlessPanes(terminals, resolve, HEADLESS_PANE_ROLE, '^wrkq ').map(
      (p) => p.id
    )
    expect(ids).toEqual(['5B01A4E9'])
  })

  it('matches new-format compact titles (the post-rename shape) by role, not title', () => {
    // The whole point: none of these titles start with the old `hrc headless`
    // prefix, yet both are still discovered.
    const panes = selectHeadlessPanes(terminals, resolve, HEADLESS_PANE_ROLE)
    expect(panes.every((p) => !p.title.startsWith('hrc headless'))).toBe(true)
    expect(panes).toHaveLength(2)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Bounded reap exec (hang regression): `hrc runtime terminate` can hang forever
// when a broker is wedged — neither the SDK fetch nor `hrc` has a timeout — and
// the sequential sweep froze on it. The script now SIGTERMs the child at a
// per-runtime ceiling and treats the timeout as a benign warn so the sweep
// continues. classifyReapExec is the pure decision the spawn feeds into.
// ─────────────────────────────────────────────────────────────────────────────
describe('classifyReapExec (bounded terminate outcome)', () => {
  const argv = ['hrc', 'runtime', 'terminate', 'rt-x', '--no-drop-continuation']

  it('classifies a timeout (wedged broker, SIGTERM at ceiling) as a benign warn, not an abort', () => {
    const r = classifyReapExec(
      { exitedDueToTimeout: true, exitCode: null, stdout: '', stderr: '' },
      argv,
      20_000
    )
    expect(r.kind).toBe('timed-out')
    if (r.kind === 'timed-out') expect(r.seconds).toBe(20)
  })

  it('classifies exit 0 as sent', () => {
    expect(classifyReapExec({ exitCode: 0, stdout: '', stderr: '' }, argv, 20_000).kind).toBe(
      'sent'
    )
  })

  it('classifies a non-zero already-terminated exit as benign', () => {
    const r = classifyReapExec(
      {
        exitCode: 1,
        stdout: '',
        stderr: 'hrc: [runtime_unavailable] runtime "rt-x" is terminated',
      },
      argv,
      20_000
    )
    expect(r.kind).toBe('already-terminated')
  })

  it('classifies a genuine non-zero failure as an error (still non-fatal to the sweep)', () => {
    const r = classifyReapExec(
      { exitCode: 1, stdout: '', stderr: 'connection refused: broker socket unavailable' },
      argv,
      20_000
    )
    expect(r.kind).toBe('error')
  })

  it('prefers the timeout verdict even if an exit code is also present', () => {
    // exitedDueToTimeout wins: a SIGTERM'd child may still report exitCode/signal.
    const r = classifyReapExec(
      { exitedDueToTimeout: true, exitCode: 143, stdout: '', stderr: '' },
      argv,
      15_000
    )
    expect(r.kind).toBe('timed-out')
  })
})

describe('isAlreadyTerminatedError (benign reap-failure classifier)', () => {
  it('classifies an already-terminated runtime as benign', () => {
    // The exact message that aborted the whole sweep before the fix.
    expect(
      isAlreadyTerminatedError(
        'hrc runtime terminate rt-71190f3f --no-drop-continuation failed (1): ' +
          'hrc: [runtime_unavailable] runtime "rt-71190f3f" is terminated'
      )
    ).toBe(true)
  })

  it('classifies a missing/pruned runtime as benign', () => {
    expect(isAlreadyTerminatedError('runtime "rt-ghost" not found')).toBe(true)
  })

  it('does NOT swallow a genuine RPC/transport failure', () => {
    expect(isAlreadyTerminatedError('connection refused: broker socket unavailable')).toBe(false)
  })
})
