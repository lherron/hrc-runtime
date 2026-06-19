/**
 * Regression — T-04928 / T-04905: presentation-aware leased-pane resolution for
 * the broker-tmux liveness reconcile.
 *
 * Defect (confirmed live): reconcileBrokerTmuxRuntimeLiveness (runtime-io-handlers.ts)
 * read the leased pane id directly via `runtime.tmuxJson?.['paneId']`. The
 * codex-app-server viewer FLAT shape records NO tmuxJson (its lease lives in
 * runtimeStateJson.broker.{brokerWindow,tuiWindow}), so the read returned undefined,
 * `inspected` became null, the reconcile declared the live session "missing", and
 * called killServer() — which delivered SIGHUP to the running broker pane and
 * crashed the viewer broker ~40ms into every turn ("Broker socket closed
 * unexpectedly", empty stderr). The fix routes the read through the
 * presentation-aware getBrokerRuntimeTmuxLeasedPaneId, which falls back to the
 * broker window pane for the flat viewer shape.
 *
 * Fixture shape mirrors t4925-viewer-socket-resolvers (the REAL Phase D runtime).
 */

import { describe, expect, it } from 'bun:test'

import type { HrcRuntimeSnapshot } from 'hrc-core'

import { getBrokerRuntimeTmuxLeasedPaneId } from '../broker-decisions'

const BTMUX_SOCKET = '/tmp/hrc-t4928/btmux/codex-app-se-rt-4928.sock'
const BROKER_IPC_SOCKET = '/tmp/hrc-t4928/bipc/a1b2c3d4e5f6/b.sock'
const ATTACH_TOKEN_PATH = '/tmp/hrc-t4928/bipc/a1b2c3d4e5f6/attach.token'
const SESSION_NAME = 'hrc-codex-app-server-rt-4928'
const BROKER_PANE_ID = '%0'
const TUI_PANE_ID = '%1'

// Flat headless+tmux-tui viewer shape: broker.brokerWindow + broker.tuiWindow at
// the broker root, NO substrate/presentation keys, transport='headless',
// tmuxJson unset.
function makeViewerRuntime(overrides: Partial<HrcRuntimeSnapshot> = {}): HrcRuntimeSnapshot {
  return {
    runtimeId: 'rt-4928-viewer',
    hostSessionId: 'hsid-4928-viewer',
    scopeRef: 'agent:cody:project:hrc-runtime:task:T-04928:tui',
    laneRef: 'main',
    generation: 1,
    transport: 'headless',
    harness: 'claude-code',
    provider: 'anthropic',
    status: 'ready',
    supportsInflightInput: false,
    adopted: false,
    controllerKind: 'harness-broker',
    tmuxJson: undefined,
    runtimeStateJson: {
      schemaVersion: 'runtime-state/v1',
      kind: 'harness-broker',
      runtimeId: 'rt-4928-viewer',
      broker: {
        endpoint: {
          kind: 'unix-jsonrpc-ndjson',
          socketPath: BROKER_IPC_SOCKET,
          attachTokenRef: { kind: 'file', path: ATTACH_TOKEN_PATH, redacted: true },
        },
        brokerWindow: {
          socketPath: BTMUX_SOCKET,
          sessionName: SESSION_NAME,
          windowName: 'broker',
          sessionId: '$0',
          windowId: '@0',
          paneId: BROKER_PANE_ID,
        },
        tuiWindow: {
          socketPath: BTMUX_SOCKET,
          sessionName: SESSION_NAME,
          windowName: 'tui',
          sessionId: '$0',
          windowId: '@1',
          paneId: TUI_PANE_ID,
        },
      },
    },
    createdAt: '2026-06-18T21:00:00Z',
    updatedAt: '2026-06-18T21:00:00Z',
    ...overrides,
  }
}

describe('getBrokerRuntimeTmuxLeasedPaneId (T-04928)', () => {
  it('returns the broker pane for the viewer flat shape (NOT undefined) so the liveness reconcile never false-reaps it', () => {
    const runtime = makeViewerRuntime()
    // The bug: returned undefined → reconcile killServer'd the live broker (SIGHUP).
    // The broker window pane is the durable harness-broker process — the robust
    // liveness signal, immune to the renderer-startup race the tui pane would have.
    expect(getBrokerRuntimeTmuxLeasedPaneId(runtime)).toBe(BROKER_PANE_ID)
  })

  it('returns tmuxJson.paneId for legacy/normal durable runtimes (behavior-preserving)', () => {
    const runtime = makeViewerRuntime({
      transport: 'tmux',
      tmuxJson: {
        socketPath: '/tmp/hrc-t4928/btmux/claude-code-tmux-rt-4928.sock',
        sessionName: 'hrc-claude-code-tmux-rt-4928',
        windowName: 'main',
        paneId: '%7',
      },
    })
    expect(getBrokerRuntimeTmuxLeasedPaneId(runtime)).toBe('%7')
  })

  it('returns undefined when there is no leased tmux substrate at all', () => {
    const runtime = makeViewerRuntime({
      tmuxJson: undefined,
      runtimeStateJson: {
        schemaVersion: 'runtime-state/v1',
        kind: 'harness-broker',
        runtimeId: 'rt-4928-headless',
        broker: {
          endpoint: {
            kind: 'unix-jsonrpc-ndjson',
            socketPath: BROKER_IPC_SOCKET,
            attachTokenRef: { kind: 'file', path: ATTACH_TOKEN_PATH, redacted: true },
          },
          // No brokerWindow → daemon-child substrate, no lease pane.
        },
      },
    })
    expect(getBrokerRuntimeTmuxLeasedPaneId(runtime)).toBeUndefined()
  })
})
