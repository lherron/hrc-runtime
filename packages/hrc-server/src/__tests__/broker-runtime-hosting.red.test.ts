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
import type { HrcRuntimeSnapshot } from 'hrc-core'

import {
  parseBrokerRuntimeHostingState,
  requireBrokerRuntimeHostingState,
  isHarnessBroker,
  hasDurableBrokerEndpoint,
  hasLeasedBrokerSubstrate,
  hasBrokerPresentation,
  canOperatorAttach,
  canUseDirectPaneFallback,
  brokerLeaseIdentityMatches,
} from '../broker/runtime-hosting'
import type { BrokerLeaseProbe } from '../broker/runtime-hosting'

// ── minimal runtime fixture builder ──────────────────────────────────────────

function makeRuntime(
  overrides: Partial<HrcRuntimeSnapshot> & { runtimeStateJson?: Record<string, unknown> }
): HrcRuntimeSnapshot {
  return {
    runtimeId: 'rt-test',
    hostSessionId: 'hsid-test',
    scopeRef: 'agent:smokey:project:hrc-runtime:task:T-01872',
    laneRef: 'main',
    generation: 1,
    transport: 'tmux',
    harness: 'claude-code',
    provider: 'anthropic',
    status: 'ready',
    supportsInflightInput: true,
    adopted: false,
    controllerKind: 'harness-broker',
    createdAt: '2026-06-04T00:00:00Z',
    updatedAt: '2026-06-04T00:00:00Z',
    ...overrides,
  }
}

// ── flat T-01801 interactive durable shape ────────────────────────────────────
// Fixture source: controller.ts buildRuntimeStateJson (~1419-1442) +
// runtime-state.ts extractFullRuntimeControlState / getPersistedBrokerWindows.
// The live interactive durable path (T-01801/T-01812) writes this today.
//
// Structure: runtimeStateJson.broker = {
//   protocolVersion  (at broker root, NOT inside endpoint)
//   endpoint: { kind:'unix-jsonrpc-ndjson', socketPath, attachTokenRef }
//             NOTE: no protocolVersion inside endpoint — that's the new shape
//   generation       (at broker root)
//   brokerWindow: BrokerWindowView { socketPath, sessionName, windowName,
//                                    sessionId, windowId, paneId }
//   tuiWindow:    BrokerWindowView (same shape, optional)
//   // NO substrate key, NO presentation key
// }

const FLAT_TMUX_SOCKET = '/tmp/hrc-test/btmux/rt-123.sock'
const FLAT_SESSION = 'hrc-rt-123-g2'
const FLAT_BROKER_IPC = '/tmp/hrc-test/broker-ipc/rt-123.g2.sock'
const FLAT_TOKEN_PATH = '/tmp/hrc-test/tokens/rt-123.g2.token'

/** Exact flat broker blob the live interactive durable path persists today. */
const flatInteractiveBrokerBlock: Record<string, unknown> = {
  // hello.protocolVersion stored at broker root (controller.ts ~1464)
  protocolVersion: 'harness-broker/0.2',
  multiInvocation: true,
  startedAt: '2026-06-04T10:00:00Z',
  ownerServerInstanceId: 'srv-001',
  // T-01812 durable identity block (controller.ts ~1421-1443)
  endpoint: {
    kind: 'unix-jsonrpc-ndjson',
    socketPath: FLAT_BROKER_IPC,
    attachTokenRef: { kind: 'file', path: FLAT_TOKEN_PATH, redacted: true },
    // NOTE: NO protocolVersion inside endpoint — this is the critical flat-shape marker
  },
  generation: 2,
  brokerWindow: {
    socketPath: FLAT_TMUX_SOCKET,
    sessionName: FLAT_SESSION,
    windowName: 'broker',
    sessionId: '$3',
    windowId: '@7',
    paneId: '%12',
  },
  tuiWindow: {
    socketPath: FLAT_TMUX_SOCKET,
    sessionName: FLAT_SESSION,
    windowName: 'tui',
    sessionId: '$3',
    windowId: '@8',
    paneId: '%13',
  },
}

const flatInteractiveRuntime = makeRuntime({
  runtimeId: 'rt-123',
  generation: 2,
  transport: 'tmux',
  runtimeStateJson: {
    schemaVersion: 'runtime-state/v1',
    kind: 'harness-broker',
    runtimeId: 'rt-123',
    broker: flatInteractiveBrokerBlock,
    control: { mode: 'broker-ipc', brokerAttached: true },
  },
})

// Flat headless shape — stdio endpoint, no tmux windows; the old headless path
const flatHeadlessBrokerBlock: Record<string, unknown> = {
  protocolVersion: 'harness-broker/0.1',
  multiInvocation: false,
  startedAt: '2026-06-04T09:00:00Z',
  ownerServerInstanceId: 'srv-001',
  endpoint: { kind: 'stdio-jsonrpc-ndjson' },
  // No generation, no brokerWindow, no tuiWindow
}

const flatHeadlessRuntime = makeRuntime({
  runtimeId: 'rt-headless-old',
  transport: 'headless',
  runtimeStateJson: {
    schemaVersion: 'runtime-state/v1',
    kind: 'harness-broker',
    runtimeId: 'rt-headless-old',
    broker: flatHeadlessBrokerBlock,
  },
})

// ── new normalized endpoint/substrate/presentation shape ──────────────────────
// Per spec §9.1. The new headless durable path (Ph3) will write this shape.

const NORM_TMUX_SOCKET = '/tmp/hrc-test/btmux/rt-456.sock'
const NORM_SESSION = 'hrc-rt-456-g4'
const NORM_BROKER_IPC = '/tmp/hrc-test/broker-ipc/rt-456.g4.sock'
const NORM_TOKEN_PATH = '/tmp/hrc-test/tokens/rt-456.g4.token'
const NORM_LEDGER_PATH = '/tmp/hrc-test/broker-ledger/rt-456.g4.ndjson'

const normalizedInteractiveBrokerBlock: Record<string, unknown> = {
  endpoint: {
    kind: 'unix-jsonrpc-ndjson',
    socketPath: NORM_BROKER_IPC,
    attachTokenRef: { kind: 'file', path: NORM_TOKEN_PATH, redacted: true },
    protocolVersion: 'harness-broker/0.2', // present in endpoint for new shape
  },
  substrate: {
    kind: 'leased-tmux',
    tmuxSocketPath: NORM_TMUX_SOCKET,
    sessionName: NORM_SESSION,
    brokerWindow: { sessionId: '$9', windowId: '@22', paneId: '%31' },
    generation: 4,
    eventLedgerPath: NORM_LEDGER_PATH,
  },
  presentation: {
    kind: 'tmux-tui',
    tuiWindow: { sessionId: '$9', windowId: '@23', paneId: '%32' },
    operatorAttachTarget: true,
    attachCommand: `tmux -S ${NORM_TMUX_SOCKET} attach -t ${NORM_SESSION}:tui`,
  },
}

const normalizedInteractiveRuntime = makeRuntime({
  runtimeId: 'rt-456',
  generation: 4,
  transport: 'tmux',
  runtimeStateJson: {
    schemaVersion: 'runtime-state/v1',
    kind: 'harness-broker',
    runtimeId: 'rt-456',
    broker: normalizedInteractiveBrokerBlock,
    control: { mode: 'broker-ipc', brokerAttached: true },
  },
})

// Normalized headless shape — unix endpoint + leased-tmux substrate + presentation.none
// This is what Ph3 headless durable path will persist.
const normalizedHeadlessBrokerBlock: Record<string, unknown> = {
  endpoint: {
    kind: 'unix-jsonrpc-ndjson',
    socketPath: '/tmp/hrc-test/broker-ipc/rt-789.g3.sock',
    attachTokenRef: { kind: 'file', path: '/tmp/hrc-test/tokens/rt-789.g3.token', redacted: true },
    protocolVersion: 'harness-broker/0.2',
  },
  substrate: {
    kind: 'leased-tmux',
    tmuxSocketPath: '/tmp/hrc-test/btmux/rt-789.sock',
    sessionName: 'hrc-rt-789-g3',
    brokerWindow: { sessionId: '$7', windowId: '@15', paneId: '%28' },
    generation: 3,
    eventLedgerPath: '/tmp/hrc-test/broker-ledger/rt-789.g3.ndjson',
  },
  presentation: { kind: 'none' },
}

const normalizedHeadlessRuntime = makeRuntime({
  runtimeId: 'rt-789',
  generation: 3,
  transport: 'headless',
  runtimeStateJson: {
    schemaVersion: 'runtime-state/v1',
    kind: 'harness-broker',
    runtimeId: 'rt-789',
    broker: normalizedHeadlessBrokerBlock,
    control: { mode: 'broker-ipc', brokerAttached: true },
  },
})

// ── G2 equivalence pair — same logical state in both serialization shapes ─────
// Flat and normalized versions of rt-eq encode the SAME runtime so parsed
// outputs can be compared field-by-field.

const EQ_TMUX_SOCKET = '/tmp/hrc-test/btmux/rt-eq.sock'
const EQ_SESSION = 'hrc-rt-eq-g1'
const EQ_BROKER_IPC = '/tmp/hrc-test/broker-ipc/rt-eq.g1.sock'
const EQ_TOKEN_PATH = '/tmp/hrc-test/tokens/rt-eq.g1.token'

const eqFlatBrokerBlock: Record<string, unknown> = {
  protocolVersion: 'harness-broker/0.2',
  endpoint: {
    kind: 'unix-jsonrpc-ndjson',
    socketPath: EQ_BROKER_IPC,
    attachTokenRef: { kind: 'file', path: EQ_TOKEN_PATH, redacted: true },
    // No protocolVersion inside endpoint — flat shape
  },
  generation: 1,
  brokerWindow: {
    socketPath: EQ_TMUX_SOCKET,
    sessionName: EQ_SESSION,
    windowName: 'broker',
    sessionId: '$5',
    windowId: '@10',
    paneId: '%20',
  },
  tuiWindow: {
    socketPath: EQ_TMUX_SOCKET,
    sessionName: EQ_SESSION,
    windowName: 'tui',
    sessionId: '$5',
    windowId: '@11',
    paneId: '%21',
  },
}

const eqNormalizedBrokerBlock: Record<string, unknown> = {
  endpoint: {
    kind: 'unix-jsonrpc-ndjson',
    socketPath: EQ_BROKER_IPC,
    attachTokenRef: { kind: 'file', path: EQ_TOKEN_PATH, redacted: true },
    protocolVersion: 'harness-broker/0.2',
  },
  substrate: {
    kind: 'leased-tmux',
    tmuxSocketPath: EQ_TMUX_SOCKET,
    sessionName: EQ_SESSION,
    brokerWindow: { sessionId: '$5', windowId: '@10', paneId: '%20' },
    generation: 1,
    eventLedgerPath: '/tmp/hrc-test/broker-ledger/rt-eq.g1.ndjson',
  },
  presentation: {
    kind: 'tmux-tui',
    tuiWindow: { sessionId: '$5', windowId: '@11', paneId: '%21' },
    operatorAttachTarget: true as const,
    attachCommand: `tmux -S ${EQ_TMUX_SOCKET} attach -t ${EQ_SESSION}:tui`,
  },
}

const eqFlatRuntime = makeRuntime({
  runtimeId: 'rt-eq',
  transport: 'tmux',
  runtimeStateJson: { broker: eqFlatBrokerBlock },
})

const eqNormalizedRuntime = makeRuntime({
  runtimeId: 'rt-eq',
  transport: 'tmux',
  runtimeStateJson: { broker: eqNormalizedBrokerBlock },
})

// ── non-broker / malformed runtimes ───────────────────────────────────────────

const nonBrokerRuntime = makeRuntime({
  controllerKind: 'terminal',
  runtimeStateJson: undefined,
})

const noBrokerBlockRuntime = makeRuntime({
  controllerKind: 'harness-broker',
  runtimeStateJson: { schemaVersion: 'runtime-state/v1', kind: 'harness-broker' },
})

const unparseableRuntime = makeRuntime({
  controllerKind: 'harness-broker',
  runtimeStateJson: {
    broker: {
      endpoint: { kind: 'GARBAGE_KIND' },
      substrate: { kind: 'UNKNOWN' },
      presentation: { kind: 'UNKNOWN' },
    },
  },
})

// =============================================================================
// TEST SUITES
// =============================================================================

// ── 1. parseBrokerRuntimeHostingState ─────────────────────────────────────────

describe('parseBrokerRuntimeHostingState', () => {
  // ── G2: flat T-01801 interactive durable shape ────────────────────────────
  describe('G2 flat T-01801 shape — brokerWindow + tuiWindow at broker root', () => {
    it('parses flat interactive shape and returns a defined result', () => {
      const result = parseBrokerRuntimeHostingState(flatInteractiveRuntime)
      expect(result).toBeDefined()
    })

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
    it('parses new normalized interactive shape', () => {
      expect(parseBrokerRuntimeHostingState(normalizedInteractiveRuntime)).toBeDefined()
    })

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
    it('both shapes parse without error', () => {
      expect(parseBrokerRuntimeHostingState(eqFlatRuntime)).toBeDefined()
      expect(parseBrokerRuntimeHostingState(eqNormalizedRuntime)).toBeDefined()
    })

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
      expect(parseBrokerRuntimeHostingState(makeRuntime({ runtimeStateJson: undefined }))).toBeUndefined()
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
            endpoint: { kind: 'unix-jsonrpc-ndjson', attachTokenRef: { kind: 'file', path: '/t', redacted: true } },
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

describe('isHarnessBroker', () => {
  it('returns true when controllerKind = harness-broker (normalized)', () => {
    expect(isHarnessBroker(normalizedInteractiveRuntime)).toBe(true)
  })

  it('returns true when controllerKind = harness-broker (flat T-01801)', () => {
    expect(isHarnessBroker(flatInteractiveRuntime)).toBe(true)
  })

  it('returns false when controllerKind = terminal', () => {
    expect(isHarnessBroker(nonBrokerRuntime)).toBe(false)
  })

  it('returns false when controllerKind is absent', () => {
    const runtime = makeRuntime({ controllerKind: undefined })
    expect(isHarnessBroker(runtime)).toBe(false)
  })
})

// ── 4. hasDurableBrokerEndpoint ───────────────────────────────────────────────

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

describe('hasLeasedBrokerSubstrate', () => {
  it('returns true for leased-tmux substrate (normalized interactive)', () => {
    expect(hasLeasedBrokerSubstrate(normalizedInteractiveRuntime)).toBe(true)
  })

  it('returns true for leased-tmux substrate (normalized headless)', () => {
    expect(hasLeasedBrokerSubstrate(normalizedHeadlessRuntime)).toBe(true)
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

describe('hasBrokerPresentation', () => {
  it('hasBrokerPresentation(runtime, "tmux-tui") = true for normalized interactive', () => {
    expect(hasBrokerPresentation(normalizedInteractiveRuntime, 'tmux-tui')).toBe(true)
  })

  it('hasBrokerPresentation(runtime, "tmux-tui") = true for flat T-01801 shape with tuiWindow', () => {
    expect(hasBrokerPresentation(flatInteractiveRuntime, 'tmux-tui')).toBe(true)
  })

  it('hasBrokerPresentation(runtime, "none") = true for normalized headless', () => {
    expect(hasBrokerPresentation(normalizedHeadlessRuntime, 'none')).toBe(true)
  })

  it('hasBrokerPresentation(runtime, "tmux-tui") = false for normalized headless', () => {
    expect(hasBrokerPresentation(normalizedHeadlessRuntime, 'tmux-tui')).toBe(false)
  })

  it('hasBrokerPresentation(runtime, "none") = false for normalized interactive', () => {
    expect(hasBrokerPresentation(normalizedInteractiveRuntime, 'none')).toBe(false)
  })

  it('hasBrokerPresentation = false when broker block absent', () => {
    expect(hasBrokerPresentation(noBrokerBlockRuntime, 'tmux-tui')).toBe(false)
  })
})

// ── 7. canOperatorAttach ──────────────────────────────────────────────────────

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
    expect(brokerLeaseIdentityMatches(normalizedInteractiveRuntime, probeNoBrokerWindow)).toBe(false)
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

  it('requireBrokerRuntimeHostingState throws for unparseable runtime', () => {
    expect(() => requireBrokerRuntimeHostingState(unparseableRuntime)).toThrow()
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
