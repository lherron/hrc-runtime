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

import {
  brokerLeaseIdentityMatches,
  canOperatorAttach,
  canUseDirectPaneFallback,
  hasBrokerPresentation,
  hasDurableBrokerEndpoint,
  hasLeasedBrokerSubstrate,
  isHarnessBroker,
  parseBrokerRuntimeHostingState,
} from '../broker/runtime-hosting'
import type { BrokerLeaseProbe } from '../broker/runtime-hosting'

// ── minimal runtime fixture builder ──────────────────────────────────────────

import { unparseableRuntime } from './broker-runtime-hosting.fixture.js'
describe('no-second-parser guard', () => {
  it('parseBrokerRuntimeHostingState returns undefined for unparseable broker block', () => {
    expect(parseBrokerRuntimeHostingState(unparseableRuntime)).toBeUndefined()
  })

  it('hasDurableBrokerEndpoint returns false for unparseable runtime', () => {
    expect(hasDurableBrokerEndpoint(unparseableRuntime)).toBe(false)
  })

  it('hasLeasedBrokerSubstrate returns false for unparseable runtime', () => {
    expect(hasLeasedBrokerSubstrate(unparseableRuntime)).toBe(false)
  })

  it('hasBrokerPresentation returns false for unparseable runtime', () => {
    expect(hasBrokerPresentation(unparseableRuntime, 'tmux-tui')).toBe(false)
    expect(hasBrokerPresentation(unparseableRuntime, 'none')).toBe(false)
  })

  it('canOperatorAttach returns false for unparseable runtime', () => {
    expect(canOperatorAttach(unparseableRuntime)).toBe(false)
  })

  it('canUseDirectPaneFallback returns false for unparseable runtime', () => {
    expect(canUseDirectPaneFallback(unparseableRuntime)).toBe(false)
  })

  it('brokerLeaseIdentityMatches returns false for unparseable runtime', () => {
    const probe: BrokerLeaseProbe = {
      tmuxSocketPath: '/s',
      sessionName: 'sess',
      brokerWindow: { sessionId: '$1', windowId: '@1', paneId: '%1' },
    }
    expect(brokerLeaseIdentityMatches(unparseableRuntime, probe)).toBe(false)
  })

  it('isHarnessBroker is unaffected by parse failure (uses controllerKind only)', () => {
    // isHarnessBroker is pure controllerKind check — no parse needed, so it CAN still return true
    // but no predicate that requires hosting state should be true for unparseable
    expect(isHarnessBroker(unparseableRuntime)).toBe(true) // controllerKind IS harness-broker
    expect(hasDurableBrokerEndpoint(unparseableRuntime)).toBe(false) // but hosting state unparseable
  })
})
