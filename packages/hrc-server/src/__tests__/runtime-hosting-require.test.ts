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

import { requireBrokerRuntimeHostingState } from '../broker/runtime-hosting'

// ── minimal runtime fixture builder ──────────────────────────────────────────

import {
  flatInteractiveRuntime,
  noBrokerBlockRuntime,
  nonBrokerRuntime,
  normalizedInteractiveRuntime,
  unparseableRuntime,
} from './broker-runtime-hosting.fixture.js'
describe('requireBrokerRuntimeHostingState', () => {
  it('returns the parsed hosting state for a valid normalized runtime', () => {
    const result = requireBrokerRuntimeHostingState(normalizedInteractiveRuntime)
    expect(result.endpoint.kind).toBe('unix-jsonrpc-ndjson')
    expect(result.substrate.kind).toBe('leased-tmux')
  })

  it('returns the parsed hosting state for a valid flat T-01801 runtime', () => {
    const result = requireBrokerRuntimeHostingState(flatInteractiveRuntime)
    expect(result.endpoint.kind).toBe('unix-jsonrpc-ndjson')
  })

  it('throws when broker block is absent', () => {
    expect(() => requireBrokerRuntimeHostingState(noBrokerBlockRuntime)).toThrow()
  })

  it('throws when runtimeStateJson is absent', () => {
    expect(() => requireBrokerRuntimeHostingState(nonBrokerRuntime)).toThrow()
  })

  it('throws for a runtime with an unparseable broker block', () => {
    expect(() => requireBrokerRuntimeHostingState(unparseableRuntime)).toThrow()
  })
})

// ── 3. isHarnessBroker ────────────────────────────────────────────────────────
