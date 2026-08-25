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

import { parseBrokerRuntimeHostingState } from '../broker/runtime-hosting'

// ── minimal runtime fixture builder ──────────────────────────────────────────

import {
  FLAT_BROKER_IPC,
  FLAT_SESSION,
  FLAT_TMUX_SOCKET,
  NORM_BROKER_IPC,
  NORM_LEDGER_PATH,
  NORM_SESSION,
  NORM_TMUX_SOCKET,
  eqFlatRuntime,
  eqNormalizedRuntime,
  flatHeadlessRuntime,
  flatInteractiveBrokerBlock,
  flatInteractiveRuntime,
  makeRuntime,
  noBrokerBlockRuntime,
  normalizedHeadlessRuntime,
  normalizedInteractiveRuntime,
} from './broker-runtime-hosting.fixture.js'
describe('parseBrokerRuntimeHostingState', () => {
  // ── G2: flat T-01801 interactive durable shape ────────────────────────────
  describe('G2 flat T-01801 shape — brokerWindow + tuiWindow at broker root', () => {
    it('flat shape: endpoint.kind = unix-jsonrpc-ndjson', () => {
      const result = parseBrokerRuntimeHostingState(flatInteractiveRuntime)
      expect(result?.endpoint.kind).toBe('unix-jsonrpc-ndjson')
    })

    it('flat shape: endpoint.socketPath from broker.endpoint.socketPath', () => {
      const result = parseBrokerRuntimeHostingState(flatInteractiveRuntime)
      expect((result?.endpoint as { socketPath?: string }).socketPath).toBe(FLAT_BROKER_IPC)
    })

    it('flat shape: substrate.kind = leased-tmux (inferred from brokerWindow at broker root)', () => {
      const result = parseBrokerRuntimeHostingState(flatInteractiveRuntime)
      expect(result?.substrate.kind).toBe('leased-tmux')
    })

    it('flat shape: substrate.tmuxSocketPath from brokerWindow.socketPath', () => {
      const result = parseBrokerRuntimeHostingState(flatInteractiveRuntime)
      if (result?.substrate.kind !== 'leased-tmux') throw new Error('expected leased-tmux')
      expect(result.substrate.tmuxSocketPath).toBe(FLAT_TMUX_SOCKET)
    })

    it('flat shape: substrate.sessionName from brokerWindow.sessionName', () => {
      const result = parseBrokerRuntimeHostingState(flatInteractiveRuntime)
      if (result?.substrate.kind !== 'leased-tmux') throw new Error('expected leased-tmux')
      expect(result.substrate.sessionName).toBe(FLAT_SESSION)
    })

    it('flat shape: substrate.brokerWindow.sessionId/windowId/paneId from brokerWindow', () => {
      const result = parseBrokerRuntimeHostingState(flatInteractiveRuntime)
      if (result?.substrate.kind !== 'leased-tmux') throw new Error('expected leased-tmux')
      expect(result.substrate.brokerWindow.sessionId).toBe('$3')
      expect(result.substrate.brokerWindow.windowId).toBe('@7')
      expect(result.substrate.brokerWindow.paneId).toBe('%12')
    })

    it('flat shape: substrate.generation from broker.generation', () => {
      const result = parseBrokerRuntimeHostingState(flatInteractiveRuntime)
      if (result?.substrate.kind !== 'leased-tmux') throw new Error('expected leased-tmux')
      expect(result.substrate.generation).toBe(2)
    })

    it('flat shape with tuiWindow: presentation.kind = tmux-tui', () => {
      const result = parseBrokerRuntimeHostingState(flatInteractiveRuntime)
      expect(result?.presentation.kind).toBe('tmux-tui')
    })

    it('flat shape: presentation.tuiWindow.sessionId/windowId/paneId from tuiWindow', () => {
      const result = parseBrokerRuntimeHostingState(flatInteractiveRuntime)
      if (result?.presentation.kind !== 'tmux-tui') throw new Error('expected tmux-tui')
      expect(result.presentation.tuiWindow.sessionId).toBe('$3')
      expect(result.presentation.tuiWindow.windowId).toBe('@8')
      expect(result.presentation.tuiWindow.paneId).toBe('%13')
    })

    it('flat shape without tuiWindow: presentation.kind = none', () => {
      const flatNoTui = makeRuntime({
        transport: 'tmux',
        runtimeStateJson: {
          broker: {
            ...flatInteractiveBrokerBlock,
            tuiWindow: undefined,
          },
        },
      })
      const result = parseBrokerRuntimeHostingState(flatNoTui)
      expect(result?.presentation.kind).toBe('none')
    })

    it('flat shape: parses stdio/headless path correctly (endpoint.kind = stdio-jsonrpc-ndjson)', () => {
      const result = parseBrokerRuntimeHostingState(flatHeadlessRuntime)
      expect(result).toBeDefined()
      expect(result?.endpoint.kind).toBe('stdio-jsonrpc-ndjson')
    })
  })

  // ── G2: new normalized endpoint/substrate/presentation shape ─────────────
  describe('G2 normalized endpoint/substrate/presentation shape', () => {
    it('normalized shape: endpoint.kind = unix-jsonrpc-ndjson', () => {
      const result = parseBrokerRuntimeHostingState(normalizedInteractiveRuntime)
      expect(result?.endpoint.kind).toBe('unix-jsonrpc-ndjson')
    })

    it('normalized shape: endpoint.socketPath correct', () => {
      const result = parseBrokerRuntimeHostingState(normalizedInteractiveRuntime)
      expect((result?.endpoint as { socketPath?: string }).socketPath).toBe(NORM_BROKER_IPC)
    })

    it('normalized shape: substrate.kind = leased-tmux', () => {
      const result = parseBrokerRuntimeHostingState(normalizedInteractiveRuntime)
      expect(result?.substrate.kind).toBe('leased-tmux')
    })

    it('normalized shape: substrate fields are parsed correctly', () => {
      const result = parseBrokerRuntimeHostingState(normalizedInteractiveRuntime)
      if (result?.substrate.kind !== 'leased-tmux') throw new Error('expected leased-tmux')
      expect(result.substrate.tmuxSocketPath).toBe(NORM_TMUX_SOCKET)
      expect(result.substrate.sessionName).toBe(NORM_SESSION)
      expect(result.substrate.generation).toBe(4)
      expect(result.substrate.eventLedgerPath).toBe(NORM_LEDGER_PATH)
    })

    it('normalized shape: substrate.brokerWindow parsed correctly', () => {
      const result = parseBrokerRuntimeHostingState(normalizedInteractiveRuntime)
      if (result?.substrate.kind !== 'leased-tmux') throw new Error('expected leased-tmux')
      expect(result.substrate.brokerWindow.sessionId).toBe('$9')
      expect(result.substrate.brokerWindow.windowId).toBe('@22')
      expect(result.substrate.brokerWindow.paneId).toBe('%31')
    })

    it('normalized shape: tmux-tui presentation parsed correctly', () => {
      const result = parseBrokerRuntimeHostingState(normalizedInteractiveRuntime)
      if (result?.presentation.kind !== 'tmux-tui') throw new Error('expected tmux-tui')
      expect(result.presentation.tuiWindow.sessionId).toBe('$9')
      expect(result.presentation.tuiWindow.windowId).toBe('@23')
      expect(result.presentation.tuiWindow.paneId).toBe('%32')
      expect(result.presentation.operatorAttachTarget).toBe(true)
    })

    it('normalized headless shape: presentation.kind = none', () => {
      const result = parseBrokerRuntimeHostingState(normalizedHeadlessRuntime)
      expect(result?.presentation.kind).toBe('none')
    })

    it('normalized headless shape: substrate.kind = leased-tmux', () => {
      const result = parseBrokerRuntimeHostingState(normalizedHeadlessRuntime)
      expect(result?.substrate.kind).toBe('leased-tmux')
    })

    it('normalized headless shape: endpoint.kind = unix-jsonrpc-ndjson', () => {
      const result = parseBrokerRuntimeHostingState(normalizedHeadlessRuntime)
      expect(result?.endpoint.kind).toBe('unix-jsonrpc-ndjson')
    })

    it('parses daemon-child substrate correctly', () => {
      const runtime = makeRuntime({
        runtimeStateJson: {
          broker: {
            endpoint: { kind: 'stdio-jsonrpc-ndjson' },
            substrate: { kind: 'daemon-child' },
            presentation: { kind: 'none' },
          },
        },
      })
      const result = parseBrokerRuntimeHostingState(runtime)
      expect(result?.endpoint.kind).toBe('stdio-jsonrpc-ndjson')
      expect(result?.substrate.kind).toBe('daemon-child')
      expect(result?.presentation.kind).toBe('none')
    })
  })

  // ── G2: flat and normalized shapes resolve to equivalent state ────────────
  describe('G2 equivalence: flat and normalized shapes resolve to the same logical state', () => {
    it('endpoint.kind is the same from both shapes', () => {
      const flat = parseBrokerRuntimeHostingState(eqFlatRuntime)
      const norm = parseBrokerRuntimeHostingState(eqNormalizedRuntime)
      expect(flat?.endpoint.kind).toBe(norm?.endpoint.kind)
    })

    it('endpoint.socketPath is the same from both shapes', () => {
      const flat = parseBrokerRuntimeHostingState(eqFlatRuntime)
      const norm = parseBrokerRuntimeHostingState(eqNormalizedRuntime)
      expect((flat?.endpoint as { socketPath?: string }).socketPath).toBe(
        (norm?.endpoint as { socketPath?: string }).socketPath
      )
    })

    it('substrate.kind is the same from both shapes', () => {
      const flat = parseBrokerRuntimeHostingState(eqFlatRuntime)
      const norm = parseBrokerRuntimeHostingState(eqNormalizedRuntime)
      expect(flat?.substrate.kind).toBe(norm?.substrate.kind)
    })

    it('substrate.tmuxSocketPath is the same from both shapes', () => {
      const flat = parseBrokerRuntimeHostingState(eqFlatRuntime)
      const norm = parseBrokerRuntimeHostingState(eqNormalizedRuntime)
      if (flat?.substrate.kind !== 'leased-tmux' || norm?.substrate.kind !== 'leased-tmux') {
        throw new Error('both should be leased-tmux')
      }
      expect(flat.substrate.tmuxSocketPath).toBe(norm.substrate.tmuxSocketPath)
    })

    it('substrate.sessionName is the same from both shapes', () => {
      const flat = parseBrokerRuntimeHostingState(eqFlatRuntime)
      const norm = parseBrokerRuntimeHostingState(eqNormalizedRuntime)
      if (flat?.substrate.kind !== 'leased-tmux' || norm?.substrate.kind !== 'leased-tmux') {
        throw new Error('both should be leased-tmux')
      }
      expect(flat.substrate.sessionName).toBe(norm.substrate.sessionName)
    })

    it('substrate.generation is the same from both shapes', () => {
      const flat = parseBrokerRuntimeHostingState(eqFlatRuntime)
      const norm = parseBrokerRuntimeHostingState(eqNormalizedRuntime)
      if (flat?.substrate.kind !== 'leased-tmux' || norm?.substrate.kind !== 'leased-tmux') {
        throw new Error('both should be leased-tmux')
      }
      expect(flat.substrate.generation).toBe(norm.substrate.generation)
    })

    it('substrate.brokerWindow identity is the same from both shapes', () => {
      const flat = parseBrokerRuntimeHostingState(eqFlatRuntime)
      const norm = parseBrokerRuntimeHostingState(eqNormalizedRuntime)
      if (flat?.substrate.kind !== 'leased-tmux' || norm?.substrate.kind !== 'leased-tmux') {
        throw new Error('both should be leased-tmux')
      }
      expect(flat.substrate.brokerWindow.sessionId).toBe(norm.substrate.brokerWindow.sessionId)
      expect(flat.substrate.brokerWindow.windowId).toBe(norm.substrate.brokerWindow.windowId)
      expect(flat.substrate.brokerWindow.paneId).toBe(norm.substrate.brokerWindow.paneId)
    })

    it('presentation.kind is the same from both shapes', () => {
      const flat = parseBrokerRuntimeHostingState(eqFlatRuntime)
      const norm = parseBrokerRuntimeHostingState(eqNormalizedRuntime)
      expect(flat?.presentation.kind).toBe(norm?.presentation.kind)
    })

    it('presentation.tuiWindow identity is the same from both shapes', () => {
      const flat = parseBrokerRuntimeHostingState(eqFlatRuntime)
      const norm = parseBrokerRuntimeHostingState(eqNormalizedRuntime)
      if (flat?.presentation.kind !== 'tmux-tui' || norm?.presentation.kind !== 'tmux-tui') {
        throw new Error('both should be tmux-tui')
      }
      expect(flat.presentation.tuiWindow.sessionId).toBe(norm.presentation.tuiWindow.sessionId)
      expect(flat.presentation.tuiWindow.windowId).toBe(norm.presentation.tuiWindow.windowId)
      expect(flat.presentation.tuiWindow.paneId).toBe(norm.presentation.tuiWindow.paneId)
    })
  })

  // ── malformed-combo rejection ─────────────────────────────────────────────
  describe('malformed-combo rejection', () => {
    it('returns undefined when runtimeStateJson is absent', () => {
      expect(
        parseBrokerRuntimeHostingState(makeRuntime({ runtimeStateJson: undefined }))
      ).toBeUndefined()
    })

    it('returns undefined when broker key is missing', () => {
      expect(parseBrokerRuntimeHostingState(noBrokerBlockRuntime)).toBeUndefined()
    })

    it('returns undefined when broker.endpoint.kind is unknown', () => {
      const runtime = makeRuntime({
        runtimeStateJson: {
          broker: {
            endpoint: { kind: 'websocket-unknown' },
            substrate: {
              kind: 'leased-tmux',
              tmuxSocketPath: '/s',
              sessionName: 's',
              brokerWindow: { sessionId: '$1', windowId: '@1', paneId: '%1' },
              generation: 1,
              eventLedgerPath: '/l',
            },
            presentation: { kind: 'none' },
          },
        },
      })
      expect(parseBrokerRuntimeHostingState(runtime)).toBeUndefined()
    })

    it('returns undefined when unix-jsonrpc-ndjson endpoint is missing socketPath', () => {
      const runtime = makeRuntime({
        runtimeStateJson: {
          broker: {
            endpoint: {
              kind: 'unix-jsonrpc-ndjson',
              attachTokenRef: { kind: 'file', path: '/t', redacted: true },
            },
            substrate: {
              kind: 'leased-tmux',
              tmuxSocketPath: '/s',
              sessionName: 's',
              brokerWindow: { sessionId: '$1', windowId: '@1', paneId: '%1' },
              generation: 1,
              eventLedgerPath: '/l',
            },
            presentation: { kind: 'none' },
          },
        },
      })
      expect(parseBrokerRuntimeHostingState(runtime)).toBeUndefined()
    })

    it('returns undefined when unix-jsonrpc-ndjson endpoint is missing attachTokenRef', () => {
      const runtime = makeRuntime({
        runtimeStateJson: {
          broker: {
            endpoint: { kind: 'unix-jsonrpc-ndjson', socketPath: '/s/broker.sock' },
            substrate: {
              kind: 'leased-tmux',
              tmuxSocketPath: '/s',
              sessionName: 's',
              brokerWindow: { sessionId: '$1', windowId: '@1', paneId: '%1' },
              generation: 1,
              eventLedgerPath: '/l',
            },
            presentation: { kind: 'none' },
          },
        },
      })
      expect(parseBrokerRuntimeHostingState(runtime)).toBeUndefined()
    })

    it('returns undefined when substrate kind is unknown', () => {
      const runtime = makeRuntime({
        runtimeStateJson: {
          broker: {
            endpoint: {
              kind: 'unix-jsonrpc-ndjson',
              socketPath: '/s/broker.sock',
              attachTokenRef: { kind: 'file', path: '/t', redacted: true },
              protocolVersion: 'harness-broker/0.2',
            },
            substrate: { kind: 'k8s-pod' },
            presentation: { kind: 'none' },
          },
        },
      })
      expect(parseBrokerRuntimeHostingState(runtime)).toBeUndefined()
    })

    it('returns undefined when leased-tmux substrate is missing brokerWindow (G4 guard)', () => {
      const runtime = makeRuntime({
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
              generation: 1,
              eventLedgerPath: '/l',
              // brokerWindow deliberately absent
            },
            presentation: { kind: 'none' },
          },
        },
      })
      expect(parseBrokerRuntimeHostingState(runtime)).toBeUndefined()
    })

    it('returns undefined when leased-tmux substrate is missing tmuxSocketPath', () => {
      const runtime = makeRuntime({
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
              // tmuxSocketPath absent
              sessionName: 'sess',
              brokerWindow: { sessionId: '$1', windowId: '@1', paneId: '%1' },
              generation: 1,
              eventLedgerPath: '/l',
            },
            presentation: { kind: 'none' },
          },
        },
      })
      expect(parseBrokerRuntimeHostingState(runtime)).toBeUndefined()
    })

    it('returns undefined when presentation kind is unknown', () => {
      const runtime = makeRuntime({
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
            presentation: { kind: 'vnc-display' },
          },
        },
      })
      expect(parseBrokerRuntimeHostingState(runtime)).toBeUndefined()
    })

    it('flat shape: returns undefined when brokerWindow is present but has no socketPath', () => {
      // brokerWindow is malformed — missing socketPath required for tmuxSocketPath inference
      const runtime = makeRuntime({
        runtimeStateJson: {
          broker: {
            endpoint: {
              kind: 'unix-jsonrpc-ndjson',
              socketPath: '/s/broker.sock',
              attachTokenRef: { kind: 'file', path: '/t', redacted: true },
            },
            generation: 1,
            brokerWindow: {
              // socketPath missing
              sessionName: 'sess',
              windowName: 'broker',
              sessionId: '$1',
              windowId: '@1',
              paneId: '%1',
            },
          },
        },
      })
      expect(parseBrokerRuntimeHostingState(runtime)).toBeUndefined()
    })
  })
})

// ── 2. requireBrokerRuntimeHostingState ──────────────────────────────────────
