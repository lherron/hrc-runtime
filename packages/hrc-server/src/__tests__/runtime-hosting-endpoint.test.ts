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

import { hasDurableBrokerEndpoint } from '../broker/runtime-hosting'

// ── minimal runtime fixture builder ──────────────────────────────────────────

import {
  flatHeadlessRuntime,
  flatInteractiveRuntime,
  makeRuntime,
  noBrokerBlockRuntime,
  nonBrokerRuntime,
  normalizedHeadlessRuntime,
  normalizedInteractiveRuntime,
} from './broker-runtime-hosting.fixture.js'
describe('hasDurableBrokerEndpoint', () => {
  it('returns true for unix-jsonrpc-ndjson endpoint (normalized interactive)', () => {
    expect(hasDurableBrokerEndpoint(normalizedInteractiveRuntime)).toBe(true)
  })

  it('returns true for unix-jsonrpc-ndjson endpoint (flat T-01801 shape)', () => {
    expect(hasDurableBrokerEndpoint(flatInteractiveRuntime)).toBe(true)
  })

  it('IGNORES runtime.transport: headless transport + unix endpoint = durable', () => {
    // normalizedHeadlessRuntime has transport='headless' but a unix endpoint
    expect(hasDurableBrokerEndpoint(normalizedHeadlessRuntime)).toBe(true)
  })

  it('returns false for stdio-jsonrpc-ndjson endpoint (old flat headless)', () => {
    expect(hasDurableBrokerEndpoint(flatHeadlessRuntime)).toBe(false)
  })

  it('returns false when broker block is absent', () => {
    expect(hasDurableBrokerEndpoint(noBrokerBlockRuntime)).toBe(false)
  })

  it('returns false when runtimeStateJson is absent', () => {
    expect(hasDurableBrokerEndpoint(nonBrokerRuntime)).toBe(false)
  })

  it('transport=tmux with stdio endpoint is NOT durable (transport is not the durability proxy)', () => {
    // Key invariant: transport must not be used as durability predicate
    const tmuxTransportStdioEndpoint = makeRuntime({
      transport: 'tmux',
      runtimeStateJson: {
        broker: {
          endpoint: { kind: 'stdio-jsonrpc-ndjson' },
          substrate: { kind: 'daemon-child' },
          presentation: { kind: 'none' },
        },
      },
    })
    expect(hasDurableBrokerEndpoint(tmuxTransportStdioEndpoint)).toBe(false)
  })
})

// ── 5. hasLeasedBrokerSubstrate ───────────────────────────────────────────────
