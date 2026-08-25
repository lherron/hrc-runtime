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

import { canUseDirectPaneFallback } from '../broker/runtime-hosting'

// ── minimal runtime fixture builder ──────────────────────────────────────────

import {
  flatInteractiveRuntime,
  makeRuntime,
  noBrokerBlockRuntime,
  normalizedHeadlessRuntime,
  normalizedInteractiveRuntime,
} from './broker-runtime-hosting.fixture.js'
describe('canUseDirectPaneFallback', () => {
  it('returns true for normalized interactive (presentation.kind = tmux-tui)', () => {
    expect(canUseDirectPaneFallback(normalizedInteractiveRuntime)).toBe(true)
  })

  it('returns true for flat T-01801 shape with tuiWindow', () => {
    expect(canUseDirectPaneFallback(flatInteractiveRuntime)).toBe(true)
  })

  it('returns false for normalized headless (presentation.none)', () => {
    expect(canUseDirectPaneFallback(normalizedHeadlessRuntime)).toBe(false)
  })

  it('returns false when broker block absent', () => {
    expect(canUseDirectPaneFallback(noBrokerBlockRuntime)).toBe(false)
  })

  it('presentation.kind = tmux-tui is sufficient regardless of transport', () => {
    // Unusual runtime with transport=headless but tmux-tui presentation — fallback still allowed
    const headlessTransportTuiPresentation = makeRuntime({
      transport: 'headless',
      runtimeStateJson: {
        broker: {
          endpoint: {
            kind: 'unix-jsonrpc-ndjson',
            socketPath: '/s/broker.sock',
            attachTokenRef: { kind: 'file', path: '/t', redacted: true },
            protocolVersion: 'harness-broker/0.2',
          },
          substrate: {
            kind: 'leased-tmux',
            tmuxSocketPath: '/s',
            sessionName: 'sess',
            brokerWindow: { sessionId: '$1', windowId: '@1', paneId: '%1' },
            generation: 1,
            eventLedgerPath: '/l',
          },
          presentation: {
            kind: 'tmux-tui',
            tuiWindow: { sessionId: '$1', windowId: '@2', paneId: '%2' },
            operatorAttachTarget: true,
          },
        },
      },
    })
    expect(canUseDirectPaneFallback(headlessTransportTuiPresentation)).toBe(true)
  })
})

// ── 9. brokerLeaseIdentityMatches (G4) ───────────────────────────────────────
