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

import { canOperatorAttach } from '../broker/runtime-hosting'

// ── minimal runtime fixture builder ──────────────────────────────────────────

import {
  flatInteractiveBrokerBlock,
  flatInteractiveRuntime,
  makeRuntime,
  noBrokerBlockRuntime,
  normalizedHeadlessRuntime,
  normalizedInteractiveRuntime,
} from './broker-runtime-hosting.fixture.js'
describe('canOperatorAttach', () => {
  it('returns true for normalized interactive (presentation.kind = tmux-tui)', () => {
    expect(canOperatorAttach(normalizedInteractiveRuntime)).toBe(true)
  })

  it('returns true for flat T-01801 interactive shape (has tuiWindow)', () => {
    expect(canOperatorAttach(flatInteractiveRuntime)).toBe(true)
  })

  it('returns false for normalized headless (presentation.kind = none)', () => {
    expect(canOperatorAttach(normalizedHeadlessRuntime)).toBe(false)
  })

  it('returns false when broker block absent', () => {
    expect(canOperatorAttach(noBrokerBlockRuntime)).toBe(false)
  })

  it('transport=tmux + presentation.none = NOT attachable (transport is not the gate)', () => {
    const tmuxTransportNonePresentation = makeRuntime({
      transport: 'tmux',
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
          presentation: { kind: 'none' },
        },
      },
    })
    expect(canOperatorAttach(tmuxTransportNonePresentation)).toBe(false)
  })

  it('flat T-01801 shape without tuiWindow = NOT attachable', () => {
    const flatNoTui = makeRuntime({
      transport: 'tmux',
      runtimeStateJson: {
        broker: {
          ...flatInteractiveBrokerBlock,
          tuiWindow: undefined,
        },
      },
    })
    expect(canOperatorAttach(flatNoTui)).toBe(false)
  })
})

// ── 8. canUseDirectPaneFallback ───────────────────────────────────────────────
