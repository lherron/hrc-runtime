/**
 * Regression: terminating a codex-app-server dual-tmux VIEWER runtime must
 * dispose the broker AND tear down its leased tmux session — not just finalize
 * HRC state.
 *
 * The viewer's HRC transport is `headless` (the broker channel is a Unix IPC
 * socket, not a tmux pane), but it still owns a LEASED tmux session hosting the
 * broker + renderer windows (broker hosting state: presentation.kind ===
 * 'tmux-tui' over a leased-tmux substrate). Before the fix, `terminateRuntime`
 * routed it to `terminateHeadlessRuntime`, which only called
 * `finalizeRuntimeTermination` + emitted `runtime.terminated` — leaving the live
 * broker + renderer process and the operator Ghostty viewer pane orphaned (the
 * reaper marked the runtime `terminated` but the window never exited).
 *
 * These tests pin: (a) a leased-tmux viewer disposes the broker on terminate and
 * stamps reason/source on the `headless` audit event; (b) a TRUE daemon-child
 * headless runtime (no leased tmux) does NOT dispose a broker — behavior
 * unchanged.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { HrcRuntimeSnapshot } from 'hrc-core'
import { openHrcDatabase } from 'hrc-store-sqlite'
import type { HrcDatabase } from 'hrc-store-sqlite'

import {
  terminateHeadlessRuntime,
  terminateRuntime,
} from '../runtime-control-handlers/interrupt-terminate'

const HOST_SESSION_ID = 'hsid_viewer'
const SCOPE_REF = 'agent:cody:project:hrc-runtime:task:codex-viewer'
const LANE_REF = 'main'
const GENERATION = 1

// A lease socket that never had a tmux server — inspectSession/killServer both
// tolerate an absent server, so the teardown is a benign no-op in the unit test
// while still proving the path is REACHED (the broker dispose is the observable).
const LEASE_SOCKET = join(tmpdir(), 'hrc-viewer-teardown', 'btmux', 'codex-app-se.sock')
const SESSION_NAME = 'hrc-codex-app-server-rt-viewer'

let dir: string
let db: HrcDatabase

function nowTs(): string {
  return '2026-06-19T00:00:00.000Z'
}

function seedSession(): void {
  const now = nowTs()
  db.sessions.insert({
    hostSessionId: HOST_SESSION_ID,
    scopeRef: SCOPE_REF,
    laneRef: LANE_REF,
    generation: GENERATION,
    status: 'active',
    createdAt: now,
    updatedAt: now,
    ancestorScopeRefs: [],
  })
}

/** A headless-transport broker runtime that owns a leased tmux viewer session. */
function seedViewerRuntime(runtimeId: string): HrcRuntimeSnapshot {
  const now = nowTs()
  const window = {
    socketPath: LEASE_SOCKET,
    sessionName: SESSION_NAME,
    sessionId: '$0',
  }
  db.runtimes.insert({
    runtimeId,
    hostSessionId: HOST_SESSION_ID,
    scopeRef: SCOPE_REF,
    laneRef: LANE_REF,
    generation: GENERATION,
    transport: 'headless',
    harness: 'codex',
    provider: 'codex',
    status: 'ready',
    supportsInflightInput: false,
    adopted: false,
    controllerKind: 'harness-broker',
    runtimeStateJson: {
      schemaVersion: 'runtime-state/v1',
      kind: 'harness-broker',
      runtimeId,
      hostSessionId: HOST_SESSION_ID,
      generation: GENERATION,
      status: 'ready',
      broker: {
        protocolVersion: 'harness-broker/0.2',
        endpoint: {
          kind: 'unix-jsonrpc-ndjson',
          socketPath: join(dir, 'bipc', 'b.sock'),
          attachTokenRef: { kind: 'file', path: join(dir, 'bipc', 't.token'), redacted: true },
        },
        generation: GENERATION,
        brokerWindow: { ...window, windowName: 'broker', windowId: '@0', paneId: '%0' },
        tuiWindow: { ...window, windowName: 'tui', windowId: '@1', paneId: '%1' },
      },
    },
    createdAt: now,
    updatedAt: now,
    lastActivityAt: now,
  })
  const runtime = db.runtimes.getByRuntimeId(runtimeId)
  if (!runtime) throw new Error('seed failed')
  return runtime
}

/** A TRUE daemon-child headless broker runtime: no leased tmux, no viewer pane. */
function seedDaemonChildHeadlessRuntime(runtimeId: string): HrcRuntimeSnapshot {
  const now = nowTs()
  db.runtimes.insert({
    runtimeId,
    hostSessionId: HOST_SESSION_ID,
    scopeRef: SCOPE_REF,
    laneRef: LANE_REF,
    generation: GENERATION,
    transport: 'headless',
    harness: 'codex',
    provider: 'codex',
    status: 'ready',
    supportsInflightInput: false,
    adopted: false,
    controllerKind: 'harness-broker',
    runtimeStateJson: {
      schemaVersion: 'runtime-state/v1',
      kind: 'harness-broker',
      runtimeId,
      hostSessionId: HOST_SESSION_ID,
      generation: GENERATION,
      status: 'ready',
      broker: {
        protocolVersion: 'harness-broker/0.2',
        endpoint: {
          kind: 'unix-jsonrpc-ndjson',
          socketPath: join(dir, 'bipc', 'b.sock'),
          attachTokenRef: { kind: 'file', path: join(dir, 'bipc', 't.token'), redacted: true },
        },
        generation: GENERATION,
        // No brokerWindow/tuiWindow => daemon-child substrate, presentation:none.
      },
    },
    createdAt: now,
    updatedAt: now,
    lastActivityAt: now,
  })
  const runtime = db.runtimes.getByRuntimeId(runtimeId)
  if (!runtime) throw new Error('seed failed')
  return runtime
}

function makeFakeThis(disposeCalls: Array<{ runtimeId: string; reason?: string }>): unknown {
  return {
    db,
    notifyEvent() {},
    terminateHeadlessRuntime,
    getHarnessBrokerController() {
      return {
        async dispose(runtimeId: string, opts?: { reason?: string }) {
          disposeCalls.push({ runtimeId, ...(opts?.reason ? { reason: opts.reason } : {}) })
          return { ok: true as const, response: { disposed: true as const } }
        },
      }
    },
  }
}

function lastTerminatedEvent(runtimeId: string): { payload: Record<string, unknown> } | undefined {
  const events = db.hrcEvents
    .listFromHrcSeq(1)
    .filter((e) => e.eventKind === 'runtime.terminated' && e.runtimeId === runtimeId)
  const last = events[events.length - 1]
  return last ? { payload: last.payload as Record<string, unknown> } : undefined
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'hrc-viewer-teardown-'))
  db = openHrcDatabase(join(dir, 'test.sqlite'))
  seedSession()
})

afterEach(async () => {
  db.close()
  await rm(dir, { recursive: true, force: true })
})

describe('terminateRuntime: codex-app-server leased-tmux viewer', () => {
  it('disposes the broker and stamps reason/source on the headless audit event', async () => {
    seedViewerRuntime('rt-viewer')
    const runtime = db.runtimes.getByRuntimeId('rt-viewer')
    if (!runtime) throw new Error('missing runtime')

    const disposeCalls: Array<{ runtimeId: string; reason?: string }> = []
    const res = await (
      terminateRuntime as unknown as (
        this: unknown,
        runtime: HrcRuntimeSnapshot,
        opts: Record<string, unknown>
      ) => Promise<Response>
    ).call(makeFakeThis(disposeCalls), runtime, {
      dropContinuation: false,
      reason: 'operator_reap',
      source: 'close-headless-ghostmux',
    })

    expect(res.status).toBe(200)
    // The broker was disposed over the RPC channel (the observable proxy for the
    // leased-tmux teardown path being reached).
    expect(disposeCalls).toEqual([{ runtimeId: 'rt-viewer', reason: 'operator_reap' }])
    expect(db.runtimes.getByRuntimeId('rt-viewer')?.status).toBe('terminated')

    const event = lastTerminatedEvent('rt-viewer')
    expect(event?.payload).toMatchObject({
      transport: 'headless',
      droppedContinuation: false,
      reason: 'operator_reap',
      source: 'close-headless-ghostmux',
    })
  })

  it('does NOT dispose a broker for a true daemon-child headless runtime', async () => {
    seedDaemonChildHeadlessRuntime('rt-daemon')
    const runtime = db.runtimes.getByRuntimeId('rt-daemon')
    if (!runtime) throw new Error('missing runtime')

    const disposeCalls: Array<{ runtimeId: string; reason?: string }> = []
    const res = await (
      terminateRuntime as unknown as (
        this: unknown,
        runtime: HrcRuntimeSnapshot,
        opts: Record<string, unknown>
      ) => Promise<Response>
    ).call(makeFakeThis(disposeCalls), runtime, { dropContinuation: false })

    expect(res.status).toBe(200)
    // No leased tmux viewer => no broker dispose, no tmux teardown.
    expect(disposeCalls).toEqual([])
    expect(db.runtimes.getByRuntimeId('rt-daemon')?.status).toBe('terminated')
    expect(lastTerminatedEvent('rt-daemon')?.payload).toMatchObject({ transport: 'headless' })
  })
})
