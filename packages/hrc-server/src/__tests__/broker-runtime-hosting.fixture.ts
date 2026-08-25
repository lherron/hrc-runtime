import type { HrcRuntimeSnapshot } from 'hrc-core'

// ── minimal runtime fixture builder ──────────────────────────────────────────

export function makeRuntime(
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

export const FLAT_TMUX_SOCKET = '/tmp/hrc-test/btmux/rt-123.sock'
export const FLAT_SESSION = 'hrc-rt-123-g2'
export const FLAT_BROKER_IPC = '/tmp/hrc-test/broker-ipc/rt-123.g2.sock'
export const FLAT_TOKEN_PATH = '/tmp/hrc-test/tokens/rt-123.g2.token'

/** Exact flat broker blob the live interactive durable path persists today. */
export const flatInteractiveBrokerBlock: Record<string, unknown> = {
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

export const flatInteractiveRuntime = makeRuntime({
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
export const flatHeadlessBrokerBlock: Record<string, unknown> = {
  protocolVersion: 'harness-broker/0.1',
  multiInvocation: false,
  startedAt: '2026-06-04T09:00:00Z',
  ownerServerInstanceId: 'srv-001',
  endpoint: { kind: 'stdio-jsonrpc-ndjson' },
  // No generation, no brokerWindow, no tuiWindow
}

export const flatHeadlessRuntime = makeRuntime({
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

export const NORM_TMUX_SOCKET = '/tmp/hrc-test/btmux/rt-456.sock'
export const NORM_SESSION = 'hrc-rt-456-g4'
export const NORM_BROKER_IPC = '/tmp/hrc-test/broker-ipc/rt-456.g4.sock'
export const NORM_TOKEN_PATH = '/tmp/hrc-test/tokens/rt-456.g4.token'
export const NORM_LEDGER_PATH = '/tmp/hrc-test/broker-ledger/rt-456.g4.ndjson'

export const normalizedInteractiveBrokerBlock: Record<string, unknown> = {
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

export const normalizedInteractiveRuntime = makeRuntime({
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
export const normalizedHeadlessBrokerBlock: Record<string, unknown> = {
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

export const normalizedHeadlessRuntime = makeRuntime({
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

export const EQ_TMUX_SOCKET = '/tmp/hrc-test/btmux/rt-eq.sock'
export const EQ_SESSION = 'hrc-rt-eq-g1'
export const EQ_BROKER_IPC = '/tmp/hrc-test/broker-ipc/rt-eq.g1.sock'
export const EQ_TOKEN_PATH = '/tmp/hrc-test/tokens/rt-eq.g1.token'

export const eqFlatBrokerBlock: Record<string, unknown> = {
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

export const eqNormalizedBrokerBlock: Record<string, unknown> = {
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

export const eqFlatRuntime = makeRuntime({
  runtimeId: 'rt-eq',
  transport: 'tmux',
  runtimeStateJson: { broker: eqFlatBrokerBlock },
})

export const eqNormalizedRuntime = makeRuntime({
  runtimeId: 'rt-eq',
  transport: 'tmux',
  runtimeStateJson: { broker: eqNormalizedBrokerBlock },
})

// ── non-broker / malformed runtimes ───────────────────────────────────────────

export const nonBrokerRuntime = makeRuntime({
  controllerKind: 'terminal',
  runtimeStateJson: undefined,
})

export const noBrokerBlockRuntime = makeRuntime({
  controllerKind: 'harness-broker',
  runtimeStateJson: { schemaVersion: 'runtime-state/v1', kind: 'harness-broker' },
})

export const unparseableRuntime = makeRuntime({
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
