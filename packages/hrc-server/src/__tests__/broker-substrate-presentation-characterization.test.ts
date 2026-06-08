/**
 * T-01873 (T-01868 Ph2) — substrate + presentation characterization tests and one genuine red.
 *
 * TWO categories (clearly labeled in each describe block):
 *
 * A) CHARACTERIZATION (GREEN NOW, must stay green after curly's Ph2 refactor):
 *    These pin the CURRENT interactive broker-tmux allocation behavior so the
 *    refactor cannot accidentally change observable behavior.
 *
 *    A1. Flat T-01801 interactive allocation parsed through runtime-hosting.ts:
 *        broker window in substrate; TUI window in presentation; attachCommand present;
 *        substrate and presentation have distinct window identities.
 *        Fixture source: controller.ts buildRuntimeStateJson broker block (~1419-1442)
 *        + createBrokerDurableTmuxAllocator in broker-interactive-handlers.ts.
 *
 *    A2. Socket path-length invariants (T-01776): both the btmux socket path (tmux
 *        server socket) and the broker IPC unix socket path from the real allocation
 *        shape fit the platform sockaddr_un budget (104 macOS / 108 Linux).
 *
 *    A3. substrate/presentation parsing round-trips for BOTH presentation kinds
 *        (none + tmux-tui) through parseBrokerRuntimeHostingState.
 *
 *    A4. Absent tuiWindow → presentation:none (valid, the "correct half" of C-03285).
 *
 * B) ONE GENUINE RED (FAILS NOW, passes after curly extends parseFlatPresentation — C-03285):
 *    B1. Present-but-MALFORMED tuiWindow (key present in the flat broker block, value is
 *        an object missing the required sessionId/windowId/paneId identity fields) must
 *        cause parseBrokerRuntimeHostingState to return undefined (REJECT parse), not
 *        silently downgrade to presentation:none.
 *
 *        THE BUG: parseFlatPresentation does not distinguish "tuiWindow key absent"
 *        (→ none, valid) from "tuiWindow key present but extractTmuxWindowIdentity fails"
 *        (→ reject). Both currently return { kind: 'none' }.
 *
 *        CORRECT BEHAVIOR after fix: if broker['tuiWindow'] !== undefined AND
 *        extractTmuxWindowIdentity returns undefined, parseFlatPresentation returns
 *        undefined, causing parseBrokerRuntimeHostingState to return undefined.
 *
 *        REASON THE FIX MATTERS: Ph4 must verify both substrate and presentation identity
 *        on restart. If a corrupted interactive lease (present-but-malformed tuiWindow)
 *        silently downgrades to presentation:none, Ph4 skips TUI window verification,
 *        enabling a stale lease to survive a restart gate.
 */

import { describe, expect, it } from 'bun:test'
import type { HrcRuntimeSnapshot } from 'hrc-core'

import {
  assertSocketPathWithinBudget,
  socketPathByteBudget,
  socketPathByteLength,
} from 'spaces-harness-broker-client'

import {
  canOperatorAttach,
  canUseDirectPaneFallback,
  hasBrokerPresentation,
  hasDurableBrokerEndpoint,
  hasLeasedBrokerSubstrate,
  parseBrokerRuntimeHostingState,
  requireBrokerRuntimeHostingState,
} from '../broker/runtime-hosting'

// ── minimal runtime fixture builder (mirrors Ph1 test pattern) ────────────────

function makeRuntime(
  overrides: Partial<HrcRuntimeSnapshot> & { runtimeStateJson?: Record<string, unknown> }
): HrcRuntimeSnapshot {
  return {
    runtimeId: 'rt-ph2-test',
    hostSessionId: 'hsid-ph2-test',
    scopeRef: 'agent:smokey:project:hrc-runtime:task:T-01873',
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

// ── flat T-01801/T-01812 interactive durable broker block ─────────────────────
//
// This is the REAL shape the live controller.ts buildRuntimeStateJson persists for
// an interactive durable broker runtime today. The allocator (createBrokerDurableTmuxAllocator
// in broker-interactive-handlers.ts) produces two windows and the controller
// packs them into the flat broker blob under runtimeStateJson.broker.
//
// Key structural invariants locked by these tests:
//   - brokerWindow = SUBSTRATE identity (the exec-form broker PROCESS pane)
//   - tuiWindow    = PRESENTATION identity (the operator TUI pane)
//   - Both windows share the SAME btmux server socket + session (one tmux server
//     per runtime hosts both windows)
//   - endpoint.socketPath = BROKER IPC unix socket (separate from btmux socket)
//   - tuiWindow.socketPath === brokerWindow.socketPath (same btmux server)
//   - brokerWindow.windowId ≠ tuiWindow.windowId (distinct windows in same session)
//
// Socket path classes (two SEPARATE sockets per runtime):
//   BTMUX_SOCKET:      /…/btmux/<driver>-<runtimeId>.sock — the tmux server for hosting
//   BROKER_IPC_SOCKET: /…/bipc/<hash>/b.sock              — broker → HRC IPC endpoint

const BTMUX_SOCKET = '/tmp/hrc-ph2/btmux/claude-code-tmux-rt-0192aa3c.sock'
const SESSION_NAME = 'hrc-claude-code-tmux-rt-0192aa3c'
const BROKER_IPC_SOCKET = '/tmp/hrc-ph2/bipc/a4f1b3c2/b.sock'
const ATTACH_TOKEN_PATH = '/tmp/hrc-ph2/bipc/a4f1b3c2/attach.token'

/**
 * The broker block the current interactive path persists (flat T-01801 shape).
 * NO substrate/presentation keys — those are the new normalized fields from Ph3+.
 * brokerWindow + tuiWindow live at the broker root, not inside a substrate/presentation
 * envelope.
 */
const flatInteractiveBrokerBlock: Record<string, unknown> = {
  // hello.protocolVersion stored at broker root (controller.ts ~1464)
  protocolVersion: 'harness-broker/0.2',
  multiInvocation: true,
  startedAt: '2026-06-04T10:00:00Z',
  ownerServerInstanceId: 'srv-ph2-001',
  // T-01812: unix endpoint, NO protocolVersion inside endpoint (flat-shape marker)
  endpoint: {
    kind: 'unix-jsonrpc-ndjson',
    socketPath: BROKER_IPC_SOCKET,
    attachTokenRef: { kind: 'file', path: ATTACH_TOKEN_PATH, redacted: true },
  },
  generation: 3,
  brokerCommand: `exec harness-broker run --transport unix --socket ${BROKER_IPC_SOCKET} --event-ledger /tmp/hrc-ph2/bipc/a4f1b3c2/events.ndjson --runtime-id rt-0192aa3c --host-session-id hsid-ph2 --generation 3 --attach-token-file ${ATTACH_TOKEN_PATH}`,
  brokerPid: 5432,
  // brokerWindow: the BROKER PROCESS pane — substrate identity, NOT the operator pane
  brokerWindow: {
    socketPath: BTMUX_SOCKET,
    sessionName: SESSION_NAME,
    windowName: 'broker',
    sessionId: '$4',
    windowId: '@10',
    paneId: '%18',
  },
  // tuiWindow: the OPERATOR TUI pane — presentation identity, NOT the broker process pane
  tuiWindow: {
    socketPath: BTMUX_SOCKET,
    sessionName: SESSION_NAME,
    windowName: 'tui',
    sessionId: '$4',
    windowId: '@11',
    paneId: '%19',
  },
}

/** Full runtime snapshot with the flat interactive broker block. */
const interactiveRuntime = makeRuntime({
  runtimeId: 'rt-0192aa3c',
  generation: 3,
  transport: 'tmux',
  runtimeStateJson: {
    schemaVersion: 'runtime-state/v1',
    kind: 'harness-broker',
    runtimeId: 'rt-0192aa3c',
    broker: flatInteractiveBrokerBlock,
    control: { mode: 'broker-ipc', brokerAttached: true },
  },
})

// ── normalized shape fixtures ─────────────────────────────────────────────────
// These represent the NEW persisted shape (Ph3+). Characterization tests verify
// the round-trip parser handles both presentation kinds correctly.

const NORM_BTMUX_SOCKET = '/tmp/hrc-ph2/btmux/claude-code-tmux-rt-norm.sock'
const NORM_SESSION = 'hrc-claude-code-tmux-rt-norm'
const NORM_BROKER_IPC = '/tmp/hrc-ph2/bipc/b5e2d1f0/b.sock'
const NORM_TOKEN_PATH = '/tmp/hrc-ph2/bipc/b5e2d1f0/attach.token'
const NORM_LEDGER = '/tmp/hrc-ph2/bipc/b5e2d1f0/events.ndjson'

const normalizedInteractiveBrokerBlock: Record<string, unknown> = {
  endpoint: {
    kind: 'unix-jsonrpc-ndjson',
    socketPath: NORM_BROKER_IPC,
    attachTokenRef: { kind: 'file', path: NORM_TOKEN_PATH, redacted: true },
    protocolVersion: 'harness-broker/0.2', // present in endpoint in normalized shape
  },
  substrate: {
    kind: 'leased-tmux',
    tmuxSocketPath: NORM_BTMUX_SOCKET,
    sessionName: NORM_SESSION,
    brokerWindow: { sessionId: '$5', windowId: '@12', paneId: '%20' },
    generation: 2,
    eventLedgerPath: NORM_LEDGER,
  },
  presentation: {
    kind: 'tmux-tui',
    tuiWindow: { sessionId: '$5', windowId: '@13', paneId: '%21' },
    operatorAttachTarget: true,
    attachCommand: `tmux -S ${NORM_BTMUX_SOCKET} attach -t ${NORM_SESSION}:tui`,
  },
}

const normalizedInteractiveRuntime = makeRuntime({
  runtimeId: 'rt-norm-interactive',
  generation: 2,
  transport: 'tmux',
  runtimeStateJson: {
    schemaVersion: 'runtime-state/v1',
    kind: 'harness-broker',
    runtimeId: 'rt-norm-interactive',
    broker: normalizedInteractiveBrokerBlock,
    control: { mode: 'broker-ipc', brokerAttached: true },
  },
})

const NORM_HL_BTMUX = '/tmp/hrc-ph2/btmux/claude-code-tmux-rt-headless.sock'
const NORM_HL_IPC = '/tmp/hrc-ph2/bipc/c6d3e2a1/b.sock'

const normalizedHeadlessBrokerBlock: Record<string, unknown> = {
  endpoint: {
    kind: 'unix-jsonrpc-ndjson',
    socketPath: NORM_HL_IPC,
    attachTokenRef: {
      kind: 'file',
      path: '/tmp/hrc-ph2/bipc/c6d3e2a1/attach.token',
      redacted: true,
    },
    protocolVersion: 'harness-broker/0.2',
  },
  substrate: {
    kind: 'leased-tmux',
    tmuxSocketPath: NORM_HL_BTMUX,
    sessionName: 'hrc-claude-code-tmux-rt-headless',
    brokerWindow: { sessionId: '$6', windowId: '@14', paneId: '%22' },
    generation: 1,
    eventLedgerPath: '/tmp/hrc-ph2/bipc/c6d3e2a1/events.ndjson',
  },
  presentation: { kind: 'none' },
}

const normalizedHeadlessRuntime = makeRuntime({
  runtimeId: 'rt-norm-headless',
  generation: 1,
  transport: 'headless',
  runtimeStateJson: {
    schemaVersion: 'runtime-state/v1',
    kind: 'harness-broker',
    runtimeId: 'rt-norm-headless',
    broker: normalizedHeadlessBrokerBlock,
  },
})

// =============================================================================
// A) CHARACTERIZATION TESTS — GREEN NOW, must stay green after Ph2 refactor
// =============================================================================

// ── A1: Flat T-01801 interactive allocation — substrate/presentation split ────
//
// Pins: the current allocation produces a broker window in SUBSTRATE and a TUI window
// in PRESENTATION; these are two distinct windows in the same session; the btmux socket
// and broker IPC socket are separate paths; attach is possible; canOperatorAttach is true.

describe('[CHARACTERIZATION A1] flat T-01801 interactive allocation — substrate/presentation split', () => {
  it('parseBrokerRuntimeHostingState succeeds for the flat interactive broker shape', () => {
    expect(parseBrokerRuntimeHostingState(interactiveRuntime)).toBeDefined()
  })

  it('substrate.kind = leased-tmux (broker process lives in a leased tmux session)', () => {
    const result = parseBrokerRuntimeHostingState(interactiveRuntime)
    expect(result?.substrate.kind).toBe('leased-tmux')
  })

  it('presentation.kind = tmux-tui (TUI window present for interactive allocation)', () => {
    const result = parseBrokerRuntimeHostingState(interactiveRuntime)
    expect(result?.presentation.kind).toBe('tmux-tui')
  })

  it('substrate.brokerWindow carries the BROKER PROCESS pane identity (NOT the TUI pane)', () => {
    const result = parseBrokerRuntimeHostingState(interactiveRuntime)
    if (result?.substrate.kind !== 'leased-tmux') throw new Error('expected leased-tmux')
    expect(result.substrate.brokerWindow.sessionId).toBe('$4')
    expect(result.substrate.brokerWindow.windowId).toBe('@10')
    expect(result.substrate.brokerWindow.paneId).toBe('%18')
  })

  it('presentation.tuiWindow carries the TUI (operator) pane identity (NOT the broker pane)', () => {
    const result = parseBrokerRuntimeHostingState(interactiveRuntime)
    if (result?.presentation.kind !== 'tmux-tui') throw new Error('expected tmux-tui')
    expect(result.presentation.tuiWindow.sessionId).toBe('$4')
    expect(result.presentation.tuiWindow.windowId).toBe('@11')
    expect(result.presentation.tuiWindow.paneId).toBe('%19')
  })

  it('substrate.brokerWindow and presentation.tuiWindow have DISTINCT windowId (two separate windows)', () => {
    const result = parseBrokerRuntimeHostingState(interactiveRuntime)
    if (result?.substrate.kind !== 'leased-tmux') throw new Error('expected leased-tmux')
    if (result?.presentation.kind !== 'tmux-tui') throw new Error('expected tmux-tui')
    expect(result.substrate.brokerWindow.windowId).not.toBe(result.presentation.tuiWindow.windowId)
  })

  it('substrate.brokerWindow and presentation.tuiWindow have DISTINCT paneId', () => {
    const result = parseBrokerRuntimeHostingState(interactiveRuntime)
    if (result?.substrate.kind !== 'leased-tmux') throw new Error('expected leased-tmux')
    if (result?.presentation.kind !== 'tmux-tui') throw new Error('expected tmux-tui')
    expect(result.substrate.brokerWindow.paneId).not.toBe(result.presentation.tuiWindow.paneId)
  })

  it('presentation.operatorAttachTarget = true for interactive allocation', () => {
    const result = parseBrokerRuntimeHostingState(interactiveRuntime)
    if (result?.presentation.kind !== 'tmux-tui') throw new Error('expected tmux-tui')
    expect(result.presentation.operatorAttachTarget).toBe(true)
  })

  it('presentation.attachCommand is present (operator can attach)', () => {
    const result = parseBrokerRuntimeHostingState(interactiveRuntime)
    if (result?.presentation.kind !== 'tmux-tui') throw new Error('expected tmux-tui')
    expect(typeof result.presentation.attachCommand).toBe('string')
    expect((result.presentation.attachCommand?.length ?? 0) > 0).toBe(true)
  })

  it('presentation.attachCommand references the btmux socket path', () => {
    const result = parseBrokerRuntimeHostingState(interactiveRuntime)
    if (result?.presentation.kind !== 'tmux-tui') throw new Error('expected tmux-tui')
    expect(result.presentation.attachCommand).toContain(BTMUX_SOCKET)
  })

  it('presentation.attachCommand references the session name', () => {
    const result = parseBrokerRuntimeHostingState(interactiveRuntime)
    if (result?.presentation.kind !== 'tmux-tui') throw new Error('expected tmux-tui')
    expect(result.presentation.attachCommand).toContain(SESSION_NAME)
  })

  it('endpoint.kind = unix-jsonrpc-ndjson (durable endpoint for interactive allocation)', () => {
    const result = parseBrokerRuntimeHostingState(interactiveRuntime)
    expect(result?.endpoint.kind).toBe('unix-jsonrpc-ndjson')
  })

  it('endpoint.socketPath = broker IPC socket path (separate from btmux socket)', () => {
    const result = parseBrokerRuntimeHostingState(interactiveRuntime)
    expect((result?.endpoint as { socketPath?: string }).socketPath).toBe(BROKER_IPC_SOCKET)
    // The broker IPC socket is NOT the btmux socket (two separate paths per runtime)
    expect((result?.endpoint as { socketPath?: string }).socketPath).not.toBe(BTMUX_SOCKET)
  })

  it('substrate.tmuxSocketPath = btmux socket (separate from broker IPC socket)', () => {
    const result = parseBrokerRuntimeHostingState(interactiveRuntime)
    if (result?.substrate.kind !== 'leased-tmux') throw new Error('expected leased-tmux')
    expect(result.substrate.tmuxSocketPath).toBe(BTMUX_SOCKET)
    // The btmux socket is NOT the broker IPC socket
    expect(result.substrate.tmuxSocketPath).not.toBe(BROKER_IPC_SOCKET)
  })

  it('substrate.sessionName from brokerWindow.sessionName', () => {
    const result = parseBrokerRuntimeHostingState(interactiveRuntime)
    if (result?.substrate.kind !== 'leased-tmux') throw new Error('expected leased-tmux')
    expect(result.substrate.sessionName).toBe(SESSION_NAME)
  })

  it('substrate.generation = 3 (from broker.generation)', () => {
    const result = parseBrokerRuntimeHostingState(interactiveRuntime)
    if (result?.substrate.kind !== 'leased-tmux') throw new Error('expected leased-tmux')
    expect(result.substrate.generation).toBe(3)
  })

  it('canOperatorAttach = true for interactive flat allocation', () => {
    expect(canOperatorAttach(interactiveRuntime)).toBe(true)
  })

  it('canUseDirectPaneFallback = true for interactive flat allocation', () => {
    expect(canUseDirectPaneFallback(interactiveRuntime)).toBe(true)
  })

  it('hasDurableBrokerEndpoint = true for interactive flat allocation', () => {
    expect(hasDurableBrokerEndpoint(interactiveRuntime)).toBe(true)
  })

  it('hasLeasedBrokerSubstrate = true for interactive flat allocation', () => {
    expect(hasLeasedBrokerSubstrate(interactiveRuntime)).toBe(true)
  })

  it('hasBrokerPresentation(runtime, "tmux-tui") = true for interactive allocation', () => {
    expect(hasBrokerPresentation(interactiveRuntime, 'tmux-tui')).toBe(true)
  })

  it('hasBrokerPresentation(runtime, "none") = false for interactive allocation', () => {
    expect(hasBrokerPresentation(interactiveRuntime, 'none')).toBe(false)
  })
})

// ── A2: Socket path-length invariants (T-01776) ───────────────────────────────
//
// Pins: the btmux socket path and broker IPC socket path from the real allocation
// fit the platform sockaddr_un budget (104 macOS / 108 Linux). These stay true
// after the refactor (the allocator path computation is unchanged in Ph2).

describe('[CHARACTERIZATION A2] socket path-length invariants (T-01776)', () => {
  it('btmux socket path from flat interactive allocation fits the platform sockaddr_un budget', () => {
    expect(socketPathByteLength(BTMUX_SOCKET)).toBeLessThanOrEqual(socketPathByteBudget())
  })

  it('broker IPC socket path from flat interactive allocation fits the platform sockaddr_un budget', () => {
    expect(socketPathByteLength(BROKER_IPC_SOCKET)).toBeLessThanOrEqual(socketPathByteBudget())
  })

  it('assertSocketPathWithinBudget does not throw for the btmux socket path', () => {
    expect(() => assertSocketPathWithinBudget(BTMUX_SOCKET)).not.toThrow()
  })

  it('assertSocketPathWithinBudget does not throw for the broker IPC socket path', () => {
    expect(() => assertSocketPathWithinBudget(BROKER_IPC_SOCKET)).not.toThrow()
  })

  it('normalized interactive btmux socket path fits the sockaddr_un budget', () => {
    expect(socketPathByteLength(NORM_BTMUX_SOCKET)).toBeLessThanOrEqual(socketPathByteBudget())
  })

  it('normalized interactive broker IPC socket path fits the sockaddr_un budget', () => {
    expect(socketPathByteLength(NORM_BROKER_IPC)).toBeLessThanOrEqual(socketPathByteBudget())
  })

  it('normalized headless btmux socket path fits the sockaddr_un budget', () => {
    expect(socketPathByteLength(NORM_HL_BTMUX)).toBeLessThanOrEqual(socketPathByteBudget())
  })

  it('normalized headless broker IPC socket path fits the sockaddr_un budget', () => {
    expect(socketPathByteLength(NORM_HL_IPC)).toBeLessThanOrEqual(socketPathByteBudget())
  })

  it('btmux socket path and broker IPC socket path are DISTINCT paths for the same runtime', () => {
    // Each runtime has two separate sockets: one for tmux hosting, one for broker IPC.
    expect(BTMUX_SOCKET).not.toBe(BROKER_IPC_SOCKET)
  })
})

// ── A3: Round-trips for both presentation kinds ───────────────────────────────
//
// Pins: parseBrokerRuntimeHostingState handles BOTH presentation kinds (none + tmux-tui)
// across BOTH serialization shapes (flat T-01801 + new normalized), and the choke point
// returns the correct logical BrokerRuntimeHostingState for each.

describe('[CHARACTERIZATION A3] substrate/presentation round-trips for both presentation kinds', () => {
  // Flat shape: tmux-tui
  it('flat shape with tuiWindow → presentation.kind = tmux-tui (round-trip)', () => {
    expect(parseBrokerRuntimeHostingState(interactiveRuntime)?.presentation.kind).toBe('tmux-tui')
  })

  it('flat shape with tuiWindow → substrate.kind = leased-tmux (round-trip)', () => {
    expect(parseBrokerRuntimeHostingState(interactiveRuntime)?.substrate.kind).toBe('leased-tmux')
  })

  it('flat shape with tuiWindow → endpoint.kind = unix-jsonrpc-ndjson (round-trip)', () => {
    expect(parseBrokerRuntimeHostingState(interactiveRuntime)?.endpoint.kind).toBe(
      'unix-jsonrpc-ndjson'
    )
  })

  // Normalized shape: tmux-tui
  it('normalized shape with presentation.tmux-tui → presentation.kind = tmux-tui (round-trip)', () => {
    expect(parseBrokerRuntimeHostingState(normalizedInteractiveRuntime)?.presentation.kind).toBe(
      'tmux-tui'
    )
  })

  it('normalized shape with presentation.tmux-tui → operatorAttachTarget = true (round-trip)', () => {
    const result = parseBrokerRuntimeHostingState(normalizedInteractiveRuntime)
    if (result?.presentation.kind !== 'tmux-tui') throw new Error('expected tmux-tui')
    expect(result.presentation.operatorAttachTarget).toBe(true)
  })

  it('normalized shape with presentation.tmux-tui → substrate.kind = leased-tmux (round-trip)', () => {
    expect(parseBrokerRuntimeHostingState(normalizedInteractiveRuntime)?.substrate.kind).toBe(
      'leased-tmux'
    )
  })

  it('normalized shape with presentation.tmux-tui → tuiWindow identity preserved (round-trip)', () => {
    const result = parseBrokerRuntimeHostingState(normalizedInteractiveRuntime)
    if (result?.presentation.kind !== 'tmux-tui') throw new Error('expected tmux-tui')
    expect(result.presentation.tuiWindow.sessionId).toBe('$5')
    expect(result.presentation.tuiWindow.windowId).toBe('@13')
    expect(result.presentation.tuiWindow.paneId).toBe('%21')
  })

  // Normalized shape: none
  it('normalized headless shape with presentation.none → presentation.kind = none (round-trip)', () => {
    expect(parseBrokerRuntimeHostingState(normalizedHeadlessRuntime)?.presentation.kind).toBe(
      'none'
    )
  })

  it('normalized headless shape with presentation.none → substrate.kind = leased-tmux (round-trip)', () => {
    expect(parseBrokerRuntimeHostingState(normalizedHeadlessRuntime)?.substrate.kind).toBe(
      'leased-tmux'
    )
  })

  it('normalized headless shape → endpoint.kind = unix-jsonrpc-ndjson (durable even without TUI)', () => {
    expect(parseBrokerRuntimeHostingState(normalizedHeadlessRuntime)?.endpoint.kind).toBe(
      'unix-jsonrpc-ndjson'
    )
  })

  it('hasBrokerPresentation("none") = true for normalized headless', () => {
    expect(hasBrokerPresentation(normalizedHeadlessRuntime, 'none')).toBe(true)
  })

  it('hasBrokerPresentation("tmux-tui") = false for normalized headless (no TUI window)', () => {
    expect(hasBrokerPresentation(normalizedHeadlessRuntime, 'tmux-tui')).toBe(false)
  })

  it('canOperatorAttach = false for normalized headless (presentation.none)', () => {
    expect(canOperatorAttach(normalizedHeadlessRuntime)).toBe(false)
  })

  it('canOperatorAttach = true for normalized interactive (presentation.tmux-tui)', () => {
    expect(canOperatorAttach(normalizedInteractiveRuntime)).toBe(true)
  })
})

// ── A4: Absent tuiWindow → presentation:none (C-03285 VALID case) ─────────────
//
// Pins: when tuiWindow is absent from the flat broker block, the parse succeeds
// and returns presentation:none. This is the VALID half of the C-03285 distinction.
// The refactor must not break this case.

describe('[CHARACTERIZATION A4] absent tuiWindow → presentation:none valid (C-03285)', () => {
  // tuiWindow: undefined means the key is absent (or explicitly set to undefined).
  // Both are treated the same: broker['tuiWindow'] === undefined → absent → none.
  const flatNoTuiRuntime = makeRuntime({
    runtimeId: 'rt-no-tui',
    generation: 3,
    runtimeStateJson: {
      broker: {
        ...flatInteractiveBrokerBlock,
        tuiWindow: undefined, // absent — presentation:none is the correct result
      },
    },
  })

  it('flat broker block with absent tuiWindow: parseBrokerRuntimeHostingState succeeds (not undefined)', () => {
    expect(parseBrokerRuntimeHostingState(flatNoTuiRuntime)).toBeDefined()
  })

  it('flat broker block with absent tuiWindow: presentation.kind = none', () => {
    const result = parseBrokerRuntimeHostingState(flatNoTuiRuntime)
    expect(result?.presentation.kind).toBe('none')
  })

  it('flat broker block with absent tuiWindow: substrate.kind still = leased-tmux (brokerWindow present)', () => {
    const result = parseBrokerRuntimeHostingState(flatNoTuiRuntime)
    expect(result?.substrate.kind).toBe('leased-tmux')
  })

  it('flat broker block with absent tuiWindow: endpoint.kind = unix-jsonrpc-ndjson', () => {
    const result = parseBrokerRuntimeHostingState(flatNoTuiRuntime)
    expect(result?.endpoint.kind).toBe('unix-jsonrpc-ndjson')
  })

  it('flat broker block with absent tuiWindow: canOperatorAttach = false', () => {
    expect(canOperatorAttach(flatNoTuiRuntime)).toBe(false)
  })

  it('flat broker block with absent tuiWindow: hasBrokerPresentation("none") = true', () => {
    expect(hasBrokerPresentation(flatNoTuiRuntime, 'none')).toBe(true)
  })

  it('flat broker block with absent tuiWindow: hasLeasedBrokerSubstrate = true (substrate unaffected)', () => {
    expect(hasLeasedBrokerSubstrate(flatNoTuiRuntime)).toBe(true)
  })
})

// =============================================================================
// B) ONE GENUINE RED — FAILS NOW, passes after curly fixes parseFlatPresentation
// =============================================================================

describe('[RED — FAILS NOW] present-but-malformed tuiWindow → parse REJECTS (C-03285)', () => {
  // THE BUG (current behavior, wrong):
  //   parseFlatPresentation does not distinguish "tuiWindow key absent" from
  //   "tuiWindow key present but extractTmuxWindowIdentity fails". Both currently
  //   return { kind: 'none' }, making parseBrokerRuntimeHostingState return a
  //   defined result when it should return undefined.
  //
  // CORRECT behavior after fix:
  //   If broker['tuiWindow'] !== undefined AND extractTmuxWindowIdentity returns
  //   undefined (malformed), parseFlatPresentation returns undefined, causing
  //   parseBrokerRuntimeHostingState to return undefined (parse rejected).
  //
  // WHY THIS MATTERS:
  //   Ph4 verifies substrate AND presentation identity on restart. A corrupted
  //   interactive lease (present-but-malformed tuiWindow) must NOT silently
  //   downgrade to presentation:none — that would cause Ph4 to skip TUI window
  //   verification and allow a stale lease to pass the restart gate.
  //
  // EXPECTED FAILURE MODE (current):
  //   parseBrokerRuntimeHostingState returns a defined result with
  //   presentation.kind === 'none' instead of undefined.
  //
  // VERIFY RED IS FOR THE RIGHT REASON (current behavior):
  //   The tests below expect `undefined` but get a defined result — not an error
  //   thrown by an unexpected code path.

  // Malformed case 1: tuiWindow present as an object but missing all identity fields
  // (no sessionId, windowId, paneId — only the flat-shape non-identity fields)
  const flatMalformedTuiRuntime = makeRuntime({
    runtimeId: 'rt-malformed-tui',
    generation: 3,
    runtimeStateJson: {
      broker: {
        ...flatInteractiveBrokerBlock,
        // tuiWindow is PRESENT (key exists, value is a non-null record) but
        // missing the required identity triple: sessionId, windowId, paneId.
        // This represents a corrupted lease where the TUI window entry was
        // written but the identity fields were lost.
        tuiWindow: {
          socketPath: BTMUX_SOCKET,
          sessionName: SESSION_NAME,
          windowName: 'tui',
          // sessionId, windowId, paneId deliberately ABSENT — malformed
        },
      },
    },
  })

  it('present tuiWindow missing sessionId/windowId/paneId → parseBrokerRuntimeHostingState returns undefined', () => {
    // TODAY this FAILS: current code returns a defined result with presentation:none.
    // AFTER curly's fix, returns undefined (parse rejected).
    expect(parseBrokerRuntimeHostingState(flatMalformedTuiRuntime)).toBeUndefined()
  })

  it('present tuiWindow missing identity → requireBrokerRuntimeHostingState throws', () => {
    // TODAY this FAILS: current code does not throw.
    // AFTER curly's fix, throws because parseBrokerRuntimeHostingState returns undefined.
    expect(() => requireBrokerRuntimeHostingState(flatMalformedTuiRuntime)).toThrow()
  })

  // Malformed case 2: tuiWindow present as a non-object (wrong type entirely)
  const flatStringTuiRuntime = makeRuntime({
    runtimeId: 'rt-string-tui',
    generation: 3,
    runtimeStateJson: {
      broker: {
        ...flatInteractiveBrokerBlock,
        tuiWindow: 'tui-pane-id-as-string', // present but wrong type
      },
    },
  })

  it('present tuiWindow as a non-object (string) → parseBrokerRuntimeHostingState returns undefined', () => {
    // TODAY this FAILS: current code silently downgrades to presentation:none.
    // AFTER curly's fix, returns undefined (parse rejected).
    expect(parseBrokerRuntimeHostingState(flatStringTuiRuntime)).toBeUndefined()
  })

  // Malformed case 3: tuiWindow present as an empty object (no fields at all)
  const flatEmptyTuiRuntime = makeRuntime({
    runtimeId: 'rt-empty-tui',
    generation: 3,
    runtimeStateJson: {
      broker: {
        ...flatInteractiveBrokerBlock,
        tuiWindow: {}, // present but entirely empty
      },
    },
  })

  it('present tuiWindow as an empty object → parseBrokerRuntimeHostingState returns undefined', () => {
    // TODAY this FAILS: current code silently downgrades to presentation:none.
    // AFTER curly's fix, returns undefined (parse rejected).
    expect(parseBrokerRuntimeHostingState(flatEmptyTuiRuntime)).toBeUndefined()
  })

  // ── Paired characterization: absent tuiWindow → none (the VALID contrast) ──
  // This paired test re-confirms A4 in proximity to the red tests so the
  // before/after distinction is immediately visible when reviewing test output.

  it('[paired characterization] absent tuiWindow (undefined) → parse succeeds with presentation:none', () => {
    // This test is GREEN NOW and must stay green after curly's fix.
    // It proves the fix distinguishes "absent" from "present-but-malformed".
    const flatAbsentTuiRuntime = makeRuntime({
      runtimeId: 'rt-absent-tui-paired',
      generation: 3,
      runtimeStateJson: {
        broker: {
          ...flatInteractiveBrokerBlock,
          tuiWindow: undefined, // ABSENT — presentation:none, valid
        },
      },
    })
    const result = parseBrokerRuntimeHostingState(flatAbsentTuiRuntime)
    expect(result).toBeDefined()
    expect(result?.presentation.kind).toBe('none')
  })
})
