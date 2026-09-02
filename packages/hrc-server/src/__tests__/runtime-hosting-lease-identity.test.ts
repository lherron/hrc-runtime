/**
 * RED tests (T-01872 / Ph1) — broker runtime-hosting state model and predicates.
 *
 * Target module: packages/hrc-server/src/broker/runtime-hosting.ts (does NOT
 * exist yet). These tests FAIL at HEAD because the module is missing.
 *
 * Coverage:
 *  1. G2 (daedalus) dual-shape parse: parseBrokerRuntimeHostingState accepts
 *     BOTH the current flat T-01801 persisted shape (endpoint + brokerWindow +
 *     tuiWindow at broker root, NO substrate/presentation keys) AND the new
 *     normalized endpoint/substrate/presentation shape. Both resolve to the
 *     same logical BrokerRuntimeHostingState.
 *
 *     Fixtures derived from actual runtime-state.ts output shapes:
 *       - extractFullRuntimeControlState / getPersistedBrokerWindows (startup-reconcile.ts)
 *       - controller.ts buildRuntimeStateJson broker block (~1419-1442)
 *     Flat broker block has: endpoint (unix, NO protocolVersion inside it),
 *     generation, brokerWindow (BrokerWindowView: socketPath+sessionName+
 *     windowName+sessionId+windowId+paneId), optional tuiWindow (same shape).
 *     NO substrate or presentation keys — these are the new normalized fields.
 *
 *  2. Predicate truth table:
 *     - hasDurableBrokerEndpoint / hasLeasedBrokerSubstrate IGNORE runtime.transport
 *     - canOperatorAttach / canUseDirectPaneFallback require presentation.kind==='tmux-tui'
 *
 *  3. G4 (daedalus): brokerLeaseIdentityMatches requires brokerWindow for EVERY
 *     leased substrate; requires tuiWindow ONLY when presentation.kind==='tmux-tui'.
 *     presentation.none succeeds with no tuiWindow in probe.
 *
 *  4. Malformed-combo rejection: parser returns undefined for unknown kinds and
 *     missing required fields.
 *
 *  5. No-second-parser guard: predicates derive answers exclusively via
 *     parseBrokerRuntimeHostingState. Unparseable broker blocks → all predicates
 *     return false; requireBrokerRuntimeHostingState throws.
 */

import { describe, expect, it } from 'bun:test'

import { brokerLeaseIdentityMatches, compareBrokerLeaseIdentity } from '../broker/runtime-hosting'
import type { BrokerLeaseProbe } from '../broker/runtime-hosting'

// ── minimal runtime fixture builder ──────────────────────────────────────────

import {
  FLAT_SESSION,
  FLAT_TMUX_SOCKET,
  NORM_SESSION,
  NORM_TMUX_SOCKET,
  flatInteractiveRuntime,
  makeRuntime,
  noBrokerBlockRuntime,
  normalizedHeadlessRuntime,
  normalizedInteractiveRuntime,
} from './broker-runtime-hosting.fixture.js'
describe('brokerLeaseIdentityMatches (G4)', () => {
  // Probes for normalizedInteractiveRuntime (rt-456, tmux-tui)
  const interactiveProbe: BrokerLeaseProbe = {
    tmuxSocketPath: NORM_TMUX_SOCKET,
    sessionName: NORM_SESSION,
    brokerWindow: { sessionId: '$9', windowId: '@22', paneId: '%31' },
    tuiWindow: { sessionId: '$9', windowId: '@23', paneId: '%32' },
  }

  // Probe for normalizedHeadlessRuntime (rt-789, none presentation)
  const headlessProbe: BrokerLeaseProbe = {
    tmuxSocketPath: '/tmp/hrc-test/btmux/rt-789.sock',
    sessionName: 'hrc-rt-789-g3',
    brokerWindow: { sessionId: '$7', windowId: '@15', paneId: '%28' },
    // No tuiWindow — not required for presentation.none
  }

  // ── G4 basic matches ──────────────────────────────────────────────────────

  it('returns true when brokerWindow matches and presentation.none (no tuiWindow required)', () => {
    expect(brokerLeaseIdentityMatches(normalizedHeadlessRuntime, headlessProbe)).toBe(true)
  })

  it('returns true when both brokerWindow and tuiWindow match for tmux-tui', () => {
    expect(brokerLeaseIdentityMatches(normalizedInteractiveRuntime, interactiveProbe)).toBe(true)
  })

  it('works with flat T-01801 shape — brokerWindow/tuiWindow inferred from flat broker', () => {
    const flatProbe: BrokerLeaseProbe = {
      tmuxSocketPath: FLAT_TMUX_SOCKET,
      sessionName: FLAT_SESSION,
      brokerWindow: { sessionId: '$3', windowId: '@7', paneId: '%12' },
      tuiWindow: { sessionId: '$3', windowId: '@8', paneId: '%13' },
    }
    expect(brokerLeaseIdentityMatches(flatInteractiveRuntime, flatProbe)).toBe(true)
  })

  // ── G4 brokerWindow mismatch ──────────────────────────────────────────────

  it('returns false when brokerWindow.sessionId mismatches', () => {
    const probe: BrokerLeaseProbe = {
      ...interactiveProbe,
      brokerWindow: { sessionId: '$WRONG', windowId: '@22', paneId: '%31' },
    }
    expect(brokerLeaseIdentityMatches(normalizedInteractiveRuntime, probe)).toBe(false)
  })

  it('returns false when brokerWindow.windowId mismatches', () => {
    const probe: BrokerLeaseProbe = {
      ...interactiveProbe,
      brokerWindow: { sessionId: '$9', windowId: '@WRONG', paneId: '%31' },
    }
    expect(brokerLeaseIdentityMatches(normalizedInteractiveRuntime, probe)).toBe(false)
  })

  it('returns false when brokerWindow.paneId mismatches', () => {
    const probe: BrokerLeaseProbe = {
      ...interactiveProbe,
      brokerWindow: { sessionId: '$9', windowId: '@22', paneId: '%WRONG' },
    }
    expect(brokerLeaseIdentityMatches(normalizedInteractiveRuntime, probe)).toBe(false)
  })

  // ── G4 tuiWindow required for tmux-tui ───────────────────────────────────

  it('G4: returns false when presentation=tmux-tui and tuiWindow is absent from probe', () => {
    const probeNoTui: BrokerLeaseProbe = {
      tmuxSocketPath: NORM_TMUX_SOCKET,
      sessionName: NORM_SESSION,
      brokerWindow: { sessionId: '$9', windowId: '@22', paneId: '%31' },
      // tuiWindow absent — required for tmux-tui
    }
    expect(brokerLeaseIdentityMatches(normalizedInteractiveRuntime, probeNoTui)).toBe(false)
    expect(compareBrokerLeaseIdentity(normalizedInteractiveRuntime, probeNoTui).mismatches).toEqual(
      [
        {
          field: 'tuiWindow',
          recorded: { sessionId: '$9', windowId: '@23', paneId: '%32' },
          observed: null,
        },
      ]
    )
  })

  it('reports a renamed broker window separately from stable tmux ids', () => {
    const renamedProbe: BrokerLeaseProbe = {
      ...interactiveProbe,
      brokerWindowName: 'worker',
    }

    expect(brokerLeaseIdentityMatches(normalizedInteractiveRuntime, renamedProbe)).toBe(false)
    expect(
      compareBrokerLeaseIdentity(normalizedInteractiveRuntime, renamedProbe).mismatches
    ).toEqual([{ field: 'brokerWindowName', recorded: 'broker', observed: 'worker' }])
  })

  it('reports broker pane-id drift while retaining the matching socket and session evidence', () => {
    const driftedProbe: BrokerLeaseProbe = {
      ...interactiveProbe,
      brokerWindow: { sessionId: '$9', windowId: '@22', paneId: '%99' },
    }

    expect(brokerLeaseIdentityMatches(normalizedInteractiveRuntime, driftedProbe)).toBe(false)
    expect(
      compareBrokerLeaseIdentity(normalizedInteractiveRuntime, driftedProbe).mismatches
    ).toEqual([
      {
        field: 'brokerWindow',
        recorded: { sessionId: '$9', windowId: '@22', paneId: '%31' },
        observed: { sessionId: '$9', windowId: '@22', paneId: '%99' },
      },
    ])
  })

  it('G4: returns false when presentation=tmux-tui and tuiWindow.windowId mismatches', () => {
    const probe: BrokerLeaseProbe = {
      ...interactiveProbe,
      tuiWindow: { sessionId: '$9', windowId: '@WRONG', paneId: '%32' },
    }
    expect(brokerLeaseIdentityMatches(normalizedInteractiveRuntime, probe)).toBe(false)
  })

  it('G4: returns false when presentation=tmux-tui and tuiWindow.paneId mismatches', () => {
    const probe: BrokerLeaseProbe = {
      ...interactiveProbe,
      tuiWindow: { sessionId: '$9', windowId: '@23', paneId: '%WRONG' },
    }
    expect(brokerLeaseIdentityMatches(normalizedInteractiveRuntime, probe)).toBe(false)
  })

  // ── G4 tuiWindow NOT required for presentation.none ───────────────────────

  it('G4: presentation.none matches with no tuiWindow in probe', () => {
    const probeNoTui: BrokerLeaseProbe = {
      tmuxSocketPath: '/tmp/hrc-test/btmux/rt-789.sock',
      sessionName: 'hrc-rt-789-g3',
      brokerWindow: { sessionId: '$7', windowId: '@15', paneId: '%28' },
    }
    expect(brokerLeaseIdentityMatches(normalizedHeadlessRuntime, probeNoTui)).toBe(true)
  })

  it('G4: presentation.none matches even if tuiWindow is provided but irrelevant', () => {
    const probeWithExtraTui: BrokerLeaseProbe = {
      ...headlessProbe,
      tuiWindow: { sessionId: '$EXTRA', windowId: '@EXTRA', paneId: '%EXTRA' },
    }
    // tuiWindow is extra but should not cause a failure for none presentation
    expect(brokerLeaseIdentityMatches(normalizedHeadlessRuntime, probeWithExtraTui)).toBe(true)
  })

  // ── G4 substrate requirements ─────────────────────────────────────────────

  it('returns false when substrate is daemon-child (not leased)', () => {
    const daemonChildRuntime = makeRuntime({
      runtimeStateJson: {
        broker: {
          endpoint: { kind: 'stdio-jsonrpc-ndjson' },
          substrate: { kind: 'daemon-child' },
          presentation: { kind: 'none' },
        },
      },
    })
    const probe: BrokerLeaseProbe = {
      tmuxSocketPath: '/s',
      sessionName: 'sess',
      brokerWindow: { sessionId: '$1', windowId: '@1', paneId: '%1' },
    }
    expect(brokerLeaseIdentityMatches(daemonChildRuntime, probe)).toBe(false)
  })

  it('returns false when no hosting state can be parsed', () => {
    const probe: BrokerLeaseProbe = {
      tmuxSocketPath: '/s',
      sessionName: 'sess',
      brokerWindow: { sessionId: '$1', windowId: '@1', paneId: '%1' },
    }
    expect(brokerLeaseIdentityMatches(noBrokerBlockRuntime, probe)).toBe(false)
  })

  it('returns false when brokerWindow is missing from probe entirely', () => {
    // A probe with no brokerWindow is always a mismatch for leased substrate
    const probeNoBrokerWindow = {
      tmuxSocketPath: NORM_TMUX_SOCKET,
      sessionName: NORM_SESSION,
    } as BrokerLeaseProbe
    expect(brokerLeaseIdentityMatches(normalizedInteractiveRuntime, probeNoBrokerWindow)).toBe(
      false
    )
  })
})

// ── 10. No-second-parser guard ────────────────────────────────────────────────
//
// Each predicate must derive its answer via parseBrokerRuntimeHostingState.
// For a runtime where the broker block cannot be parsed:
//   - parseBrokerRuntimeHostingState → undefined
//   - all predicates → false (no hidden fallback parsing logic)
//   - requireBrokerRuntimeHostingState → throws
//   - brokerLeaseIdentityMatches → false
//
// This proves no predicate has its own independent runtimeStateJson reading path.
