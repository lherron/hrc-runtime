/**
 * RED tests — T-04925 / T-04905 Phase E: presentation-aware tmux socket/session/attach resolvers.
 *
 * Defect (confirmed live T-04905 Phase D e2e):
 *   spawnBrokerHeadlessViewer bails early at `broker_headless_viewer.skipped_no_socket` for
 *   the codex-app-server headless+tmux-tui viewer runtime. Root cause: the three resolver
 *   functions in broker-decisions.ts only read runtime.tmuxJson and runtimeStateJson.tmux —
 *   BOTH EMPTY for a headless+tmux-tui viewer. The viewer's socket/session/window live in
 *   runtimeStateJson.broker.tuiWindow (flat shape). parseBrokerRuntimeHostingState /
 *   parseFlatPresentation already infer presentation.kind='tmux-tui' + tuiWindow from this
 *   shape; the resolvers just don't consult it.
 *
 * Tests (ALL RED except test 3 behavior-preserving GREEN):
 *
 *   1. (RED) getBrokerRuntimeTmuxSocketPath: for the flat headless+tmux-tui viewer shape
 *      (runtimeStateJson.broker.tuiWindow.socketPath set, brokerWindow set, NO
 *      substrate/presentation keys, transport='headless'), must return tuiWindow.socketPath.
 *      TODAY returns undefined (only reads tmuxJson + runtimeStateJson.tmux). RED.
 *
 *   2a. (RED) getBrokerRuntimeTmuxSessionName: must return tuiWindow.sessionName for the
 *      viewer shape. TODAY returns 'hrc-<hostSessionId.slice(0,12)>' (default). RED.
 *
 *   2b. (RED) getBrokerRuntimeTmuxAttachTarget: must return '<sessionName>:tui' for the
 *      viewer shape. TODAY returns the wrong default session name (no :tui window). RED.
 *
 *   3. (GREEN — behavior-preserving) Transport='tmux' runtimes (tmuxJson populated) keep
 *      their existing socket/session/attach resolution. Assert here so any fix cannot
 *      silently regress the existing path.
 *
 *   4. (RED — integration) spawnBrokerHeadlessViewer for a headless+tmux-tui viewer runtime
 *      must NOT return at the skipped_no_socket guard — it must reach
 *      ghostmux.ensureHeadlessViewer. TODAY returns early (getBrokerRuntimeTmuxSocketPath
 *      returns undefined → socketPath guard fires). RED.
 *
 * Fixture shape (from the REAL codex-app-server runtime from T-04905 Phase D):
 *   runtimeStateJson.broker = {
 *     endpoint: { kind:'unix-jsonrpc-ndjson', socketPath, attachTokenRef },
 *     brokerWindow: { socketPath: BTMUX_SOCKET, sessionName: SESSION_NAME, windowName: 'broker',
 *                     sessionId: '$0', windowId: '@0', paneId: '%0' },
 *     tuiWindow:    { socketPath: BTMUX_SOCKET, sessionName: SESSION_NAME, windowName: 'tui',
 *                     sessionId: '$0', windowId: '@1', paneId: '%1' },
 *   }
 *   transport = 'headless'   (NOT 'tmux')
 *   tmuxJson = undefined      (NOT set for headless transport)
 *
 * After fix: getBrokerRuntimeTmuxSocketPath / SessionName / AttachTarget must consult
 * parseBrokerRuntimeHostingState(runtime).presentation (already the authority for
 * presentation.kind + tuiWindow) instead of relying on the empty tmuxJson / tmux paths.
 *
 * Architecture: daedalus DM #8645 (presentation-aware everywhere; attach target = TUI window,
 * never broker window). Phase B prereq: T-04922. Governing task: T-04925 (Phase E of T-04905).
 */

import { describe, expect, it } from 'bun:test'

import type { HrcRuntimeSnapshot } from 'hrc-core'

import {
  getBrokerRuntimeTmuxAttachTarget,
  getBrokerRuntimeTmuxSessionName,
  getBrokerRuntimeTmuxSocketPath,
} from '../broker-decisions'
import { spawnBrokerHeadlessViewer } from '../broker-interactive-handlers'

// ── Fixture constants (matching REAL codex-app-server runtime shape) ───────────

// The btmux server socket — shared by brokerWindow and tuiWindow.
const BTMUX_SOCKET = '/tmp/hrc-t4925/btmux/codex-app-se-rt-4925.sock'
// The broker IPC unix socket (separate from btmux).
const BROKER_IPC_SOCKET = '/tmp/hrc-t4925/bipc/a1b2c3d4e5f6/b.sock'
const ATTACH_TOKEN_PATH = '/tmp/hrc-t4925/bipc/a1b2c3d4e5f6/attach.token'
// The session name as the real runtime writes it.
const SESSION_NAME = 'hrc-codex-app-server-rt-4925'
// The host session id (used by the current default fallback in getBrokerRuntimeTmuxSessionName).
const HOST_SESSION_ID = 'hsid-4925-viewer-test'

// ── Viewer runtime builder (flat headless+tmux-tui shape) ────────────────────
//
// This is the FLAT T-01801 shape: broker.brokerWindow + broker.tuiWindow at the
// broker root, NO substrate/presentation keys. transport='headless', tmuxJson unset.
// parseBrokerRuntimeHostingState / parseFlatPresentation already parse this into
// presentation.kind='tmux-tui'; the resolvers must consult that authority.

function makeViewerRuntime(overrides: Partial<HrcRuntimeSnapshot> = {}): HrcRuntimeSnapshot {
  return {
    runtimeId: 'rt-4925-viewer',
    hostSessionId: HOST_SESSION_ID,
    scopeRef: 'agent:smokey:project:hrc-runtime:task:T-04925:tui',
    laneRef: 'main',
    generation: 1,
    transport: 'headless', // NOT 'tmux' — this is the headless+tmux-tui viewer shape
    harness: 'claude-code',
    provider: 'anthropic',
    status: 'ready',
    supportsInflightInput: false,
    adopted: false,
    controllerKind: 'harness-broker',
    // tmuxJson is NOT set — the viewer runtime stores its lease in runtimeStateJson.broker
    tmuxJson: undefined,
    runtimeStateJson: {
      schemaVersion: 'runtime-state/v1',
      kind: 'harness-broker',
      runtimeId: 'rt-4925-viewer',
      broker: {
        // Endpoint: durable unix socket (broker IPC, separate from btmux).
        endpoint: {
          kind: 'unix-jsonrpc-ndjson',
          socketPath: BROKER_IPC_SOCKET,
          attachTokenRef: { kind: 'file', path: ATTACH_TOKEN_PATH, redacted: true },
        },
        // brokerWindow = SUBSTRATE identity (the headless broker process pane).
        // Flat shape: socketPath + sessionName + window identity at root.
        brokerWindow: {
          socketPath: BTMUX_SOCKET,
          sessionName: SESSION_NAME,
          windowName: 'broker',
          sessionId: '$0',
          windowId: '@0',
          paneId: '%0',
        },
        // tuiWindow = PRESENTATION identity (the operator-attachable TUI pane).
        // Same btmux socket + session, different window (windowId '@1').
        tuiWindow: {
          socketPath: BTMUX_SOCKET,
          sessionName: SESSION_NAME,
          windowName: 'tui',
          sessionId: '$0',
          windowId: '@1',
          paneId: '%1',
        },
        // NO substrate / presentation keys (flat shape, NOT normalized).
      },
    },
    createdAt: '2026-06-18T21:00:00Z',
    updatedAt: '2026-06-18T21:00:00Z',
    ...overrides,
  }
}

// ── Transport='tmux' runtime builder (existing path, behavior-preserving) ─────

const TMUX_BTMUX_SOCKET = '/tmp/hrc-t4925/btmux/claude-code-tmux-rt-4925.sock'
const TMUX_SESSION_NAME = 'hrc-claude-code-tmux-rt-4925'
const TMUX_WINDOW_NAME = 'main'

function makeTmuxRuntime(overrides: Partial<HrcRuntimeSnapshot> = {}): HrcRuntimeSnapshot {
  return {
    runtimeId: 'rt-4925-tmux',
    hostSessionId: 'hsid-4925-tmux',
    scopeRef: 'agent:smokey:project:hrc-runtime:task:T-04925',
    laneRef: 'main',
    generation: 1,
    transport: 'tmux',
    harness: 'claude-code',
    provider: 'anthropic',
    status: 'ready',
    supportsInflightInput: true,
    adopted: false,
    controllerKind: 'harness-broker',
    // tmuxJson IS set for the transport='tmux' path (the existing interactive broker).
    tmuxJson: {
      socketPath: TMUX_BTMUX_SOCKET,
      sessionName: TMUX_SESSION_NAME,
      windowName: TMUX_WINDOW_NAME,
    },
    createdAt: '2026-06-18T21:00:00Z',
    updatedAt: '2026-06-18T21:00:00Z',
    ...overrides,
  }
}

// ── Test 1: getBrokerRuntimeTmuxSocketPath ─────────────────────────────────────

describe('getBrokerRuntimeTmuxSocketPath', () => {
  it('(RED) viewer (headless+tmux-tui, flat shape) returns tuiWindow.socketPath — ' +
    'today returns undefined because resolver only reads tmuxJson + runtimeStateJson.tmux', () => {
    const runtime = makeViewerRuntime()
    const socketPath = getBrokerRuntimeTmuxSocketPath(runtime)
    // MUST be the btmux socket from tuiWindow (NOT undefined).
    // Today: tmuxJson is undefined → tmuxJson?.socketPath = undefined; runtimeStateJson.tmux
    // is undefined → falls through → returns undefined. RED.
    expect(socketPath).toBe(BTMUX_SOCKET)
  })
})

// ── Test 2a: getBrokerRuntimeTmuxSessionName ──────────────────────────────────

describe('getBrokerRuntimeTmuxSessionName', () => {
  it('(RED) viewer (headless+tmux-tui, flat shape) returns tuiWindow.sessionName — ' +
    'today returns the hrc-<hostSessionId> default because tmuxJson.sessionName is absent', () => {
    const runtime = makeViewerRuntime()
    const sessionName = getBrokerRuntimeTmuxSessionName(runtime)
    // MUST be the session name from tuiWindow.sessionName.
    // Today: tmuxJson is undefined → tmuxJson?.sessionName = undefined;
    // falls through to default: `hrc-${runtime.hostSessionId.slice(0, 12)}`
    // = `hrc-${HOST_SESSION_ID.slice(0, 12)}` = 'hrc-hsid-4925-vi'. RED.
    expect(sessionName).toBe(SESSION_NAME)
    // Ensure it is NOT the default fallback (belt-and-suspenders assertion).
    expect(sessionName).not.toBe(`hrc-${HOST_SESSION_ID.slice(0, 12)}`)
  })
})

// ── Test 2b: getBrokerRuntimeTmuxAttachTarget ─────────────────────────────────

describe('getBrokerRuntimeTmuxAttachTarget', () => {
  it("(RED) viewer (headless+tmux-tui, flat shape) returns '<sessionName>:tui' — " +
    'today returns the wrong default session name with no :tui window qualifier', () => {
    const runtime = makeViewerRuntime()
    const attachTarget = getBrokerRuntimeTmuxAttachTarget(runtime)
    // MUST be '<SESSION_NAME>:tui' — the TUI window (7530bd4 invariant).
    // Today: getBrokerRuntimeTmuxSessionName returns the hrc-<hostSessionId> default;
    // tmuxJson?.windowName is undefined → falls back to bare sessionName.
    // So result = 'hrc-hsid-4925-vi' (no session name, no :tui). RED.
    expect(attachTarget).toBe(`${SESSION_NAME}:tui`)
  })

  it("(RED) viewer attach target ends with ':tui' window — must NEVER be the broker window", () => {
    const runtime = makeViewerRuntime()
    const attachTarget = getBrokerRuntimeTmuxAttachTarget(runtime)
    // daedalus DM #8645 hard constraint: attach target for viewer is always the TUI
    // window, never the broker (headless exec) window.
    expect(attachTarget.endsWith(':tui')).toBe(true)
  })
})

// ── Test 3: behavior-preserving — transport='tmux' runtimes unchanged ─────────

describe('transport=tmux runtimes: existing tmuxJson-based resolution (GREEN — must stay green)', () => {
  it('getBrokerRuntimeTmuxSocketPath returns tmuxJson.socketPath for tmux runtime', () => {
    const runtime = makeTmuxRuntime()
    expect(getBrokerRuntimeTmuxSocketPath(runtime)).toBe(TMUX_BTMUX_SOCKET)
  })

  it('getBrokerRuntimeTmuxSessionName returns tmuxJson.sessionName for tmux runtime', () => {
    const runtime = makeTmuxRuntime()
    expect(getBrokerRuntimeTmuxSessionName(runtime)).toBe(TMUX_SESSION_NAME)
  })

  it("getBrokerRuntimeTmuxAttachTarget returns '<sessionName>:<windowName>' for tmux runtime", () => {
    const runtime = makeTmuxRuntime()
    expect(getBrokerRuntimeTmuxAttachTarget(runtime)).toBe(
      `${TMUX_SESSION_NAME}:${TMUX_WINDOW_NAME}`
    )
  })
})

// ── Test 4: integration — spawnBrokerHeadlessViewer reaches ensureHeadlessViewer ──

describe('spawnBrokerHeadlessViewer integration', () => {
  it('(RED) viewer runtime (headless+tmux-tui) does NOT bail at skipped_no_socket — ' +
    'reaches ghostmux.ensureHeadlessViewer instead', async () => {
    const runtime = makeViewerRuntime()

    // Track ensureHeadlessViewer calls. After the resolver fix, this MUST be called.
    // TODAY: getBrokerRuntimeTmuxSocketPath returns undefined → early return → never called.
    const ensureHeadlessViewerCalls: Array<Record<string, unknown>> = []

    const mockThis = {
      ghostmux: {
        ensureHeadlessViewer: async (opts: Record<string, unknown>) => {
          ensureHeadlessViewerCalls.push(opts)
          return { status: 'created', surfaceId: 'surface-t4925-test' }
        },
      },
      db: {
        surfaceBindings: {
          bind: (_opts: unknown) => {},
        },
      },
    }

    // Call with mock `this` context — no live daemon required.
    await spawnBrokerHeadlessViewer.call(
      mockThis as Parameters<typeof spawnBrokerHeadlessViewer.call>[0],
      runtime
    )

    // After fix: ensureHeadlessViewer must have been called exactly once.
    // Today: ensureHeadlessViewerCalls.length === 0 (early return at skipped_no_socket). RED.
    expect(ensureHeadlessViewerCalls.length).toBe(1)
  })

  it('(RED) ensureHeadlessViewer receives correct attachCommand containing <sessionName>:tui', async () => {
    const runtime = makeViewerRuntime()

    const ensureHeadlessViewerCalls: Array<Record<string, unknown>> = []

    const mockThis = {
      ghostmux: {
        ensureHeadlessViewer: async (opts: Record<string, unknown>) => {
          ensureHeadlessViewerCalls.push(opts)
          return { status: 'created', surfaceId: 'surface-t4925-test' }
        },
      },
      db: {
        surfaceBindings: {
          bind: (_opts: unknown) => {},
        },
      },
    }

    await spawnBrokerHeadlessViewer.call(
      mockThis as Parameters<typeof spawnBrokerHeadlessViewer.call>[0],
      runtime
    )

    // After fix: the attachCommand must reference <sessionName>:tui (TUI window, not broker window).
    // Today: never reached — ensureHeadlessViewerCalls is empty. RED.
    expect(ensureHeadlessViewerCalls.length).toBeGreaterThan(0)
    const opts = ensureHeadlessViewerCalls[0]
    const attachCommand = opts?.['attachCommand']
    expect(typeof attachCommand).toBe('string')
    // Must contain the btmux socket path and the :tui window target.
    expect(attachCommand as string).toContain(BTMUX_SOCKET)
    expect(attachCommand as string).toContain(`${SESSION_NAME}:tui`)
  })

  it('skips viewer spawn when an operator attach is already pending', async () => {
    const runtime = makeViewerRuntime()
    const ensureHeadlessViewerCalls: Array<Record<string, unknown>> = []

    const mockThis = {
      ghostmux: {
        ensureHeadlessViewer: async (opts: Record<string, unknown>) => {
          ensureHeadlessViewerCalls.push(opts)
          return { status: 'created', surfaceId: 'surface-t05881-test' }
        },
      },
      db: {
        surfaceBindings: {
          bind: (_opts: unknown) => {},
        },
      },
    }

    await spawnBrokerHeadlessViewer.call(
      mockThis as Parameters<typeof spawnBrokerHeadlessViewer.call>[0],
      runtime,
      { operatorAttachPending: true }
    )

    expect(ensureHeadlessViewerCalls).toEqual([])
  })
})
