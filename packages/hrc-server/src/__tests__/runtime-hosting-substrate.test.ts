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

import { hasLeasedBrokerSubstrate } from '../broker/runtime-hosting'

// ── minimal runtime fixture builder ──────────────────────────────────────────

import {
  flatHeadlessRuntime,
  flatInteractiveRuntime,
  makeRuntime,
  noBrokerBlockRuntime,
  normalizedHeadlessRuntime,
  normalizedInteractiveRuntime,
} from './broker-runtime-hosting.fixture.js'
describe('hasLeasedBrokerSubstrate', () => {
  it('returns true for leased-tmux substrate (normalized interactive)', () => {
    expect(hasLeasedBrokerSubstrate(normalizedInteractiveRuntime)).toBe(true)
  })

  it('returns true for flat T-01801 shape — substrate inferred from brokerWindow', () => {
    expect(hasLeasedBrokerSubstrate(flatInteractiveRuntime)).toBe(true)
  })

  it('IGNORES runtime.transport: headless transport + leased-tmux substrate = true', () => {
    expect(hasLeasedBrokerSubstrate(normalizedHeadlessRuntime)).toBe(true)
  })

  it('returns false for daemon-child substrate', () => {
    const runtime = makeRuntime({
      runtimeStateJson: {
        broker: {
          endpoint: { kind: 'stdio-jsonrpc-ndjson' },
          substrate: { kind: 'daemon-child' },
          presentation: { kind: 'none' },
        },
      },
    })
    expect(hasLeasedBrokerSubstrate(runtime)).toBe(false)
  })

  it('returns false for old stdio headless runtime (no brokerWindow in flat shape)', () => {
    // flatHeadlessRuntime has no brokerWindow → no leased substrate
    expect(hasLeasedBrokerSubstrate(flatHeadlessRuntime)).toBe(false)
  })

  it('returns false when broker block is absent', () => {
    expect(hasLeasedBrokerSubstrate(noBrokerBlockRuntime)).toBe(false)
  })

  it('transport=tmux with daemon-child substrate is NOT leased (transport is irrelevant)', () => {
    const tmuxTransportDaemonChild = makeRuntime({
      transport: 'tmux',
      runtimeStateJson: {
        broker: {
          endpoint: { kind: 'stdio-jsonrpc-ndjson' },
          substrate: { kind: 'daemon-child' },
          presentation: { kind: 'none' },
        },
      },
    })
    expect(hasLeasedBrokerSubstrate(tmuxTransportDaemonChild)).toBe(false)
  })
})

// ── 6. hasBrokerPresentation ──────────────────────────────────────────────────
