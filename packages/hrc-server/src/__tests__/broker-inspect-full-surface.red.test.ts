/**
 * RED test (T-01814 / T-01801 Phase 5) — the FULL operator-facing control
 * surface for a durable broker IPC runtime via `hrc runtime inspect`.
 *
 * Phases 0/4 already added the MINIMAL `control = { mode, brokerAttached }`
 * field (see broker-degraded-inspect-surface.red.test.ts — DO NOT modify that
 * test; this is the full surface layered on top). Phase 5 completes the polished
 * surface and REDACTION so an operator can, from a single inspect call:
 *
 *   1. read the broker CONTROL channel (Unix IPC socket + REDACTED attach-token
 *      ref, event high-water seq, replay status, degraded fallback reason),
 *   2. read the OPERATOR TUI attach descriptor (the `tui` pane an operator
 *      attaches to — NEVER the broker pane), and
 *   3. read the broker PROCESS diagnostics (the broker child pane/command/pid),
 *
 * with these THREE concerns kept in DISTINCT sections (not conflated), and with
 * the raw attach token NEVER present anywhere in the output.
 *
 * ── Expected NEW InspectRuntimeResponse.control shape (implementer matches) ──
 *   control: {
 *     mode: string                       // controlMode (e.g. 'broker-ipc')
 *     brokerAttached: boolean
 *
 *     // (1) Broker control over Unix IPC — the durable control channel.
 *     brokerIpc?: {
 *       socketPath: string
 *       attachTokenRef: { kind: 'file'; path: string; redacted: true }
 *       eventHighWaterSeq: number | null   // last projected broker seq
 *       replayStatus: string | null        // e.g. 'replayed' | 'attached' | 'pending'
 *       degradedReason: string | null      // null when broker-attached
 *       lastAttachError: { code: string; message: string } | null
 *     }
 *
 *     // (2) Operator TUI attach — where a human attaches (the `tui` window).
 *     operatorAttach?: {
 *       socketPath: string
 *       sessionName: string
 *       windowName: string                 // 'tui'
 *       sessionId: string
 *       windowId: string
 *       paneId: string
 *       attachCommand: string              // tmux -S <sock> attach -t <session>:tui
 *     }
 *
 *     // (3) Broker PROCESS diagnostics — the broker child (the `broker` window).
 *     brokerProcess?: {
 *       command: string
 *       pid: number | null
 *       generation: number | null
 *       socketPath: string
 *       sessionName: string
 *       windowName: string                 // 'broker'
 *       sessionId: string
 *       windowId: string
 *       paneId: string
 *     }
 *   }
 *
 * At HEAD the inspect handler emits ONLY `control = { mode, brokerAttached }`
 * (extractRuntimeControlState), so the three sub-sections + high-water + replay
 * status + redaction-ref are all absent → this test FAILS until Phase 5 lands.
 *
 * Exercises the REAL server over its unix socket; state is read straight from
 * persisted runtime_state_json + the broker_invocations high-water row. NO live
 * broker / tmux is needed.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { openHrcDatabase } from 'hrc-store-sqlite'

import { createHrcServer } from '../index'
import type { HrcServer } from '../index'
import { createHrcTestFixture } from './fixtures/hrc-test-fixture'
import type { HrcServerTestFixture } from './fixtures/hrc-test-fixture'

let fixture: HrcServerTestFixture
let server: HrcServer

// A raw attach-token secret that MUST never appear anywhere in inspect output.
// It is deliberately persisted into runtime_state_json.broker (simulating a
// careless persist) to prove the inspect path redacts rather than echoes it.
const RAW_ATTACH_TOKEN_SECRET = 'SUPER_SECRET_RAW_ATTACH_TOKEN_zzz999'

beforeEach(async () => {
  fixture = await createHrcTestFixture('hrc-broker-inspect-full-surface-')
  server = await createHrcServer(fixture.serverOpts())
})

afterEach(async () => {
  if (server) await server.stop()
  await fixture.cleanup()
})

type FullControl = {
  mode?: unknown
  brokerAttached?: unknown
  brokerIpc?: {
    socketPath?: unknown
    attachTokenRef?: { kind?: unknown; path?: unknown; redacted?: unknown } | undefined
    eventHighWaterSeq?: unknown
    replayStatus?: unknown
    degradedReason?: unknown
    lastAttachError?: unknown
  } | undefined
  operatorAttach?: {
    socketPath?: unknown
    sessionName?: unknown
    windowName?: unknown
    sessionId?: unknown
    windowId?: unknown
    paneId?: unknown
    attachCommand?: unknown
  } | undefined
  brokerProcess?: {
    command?: unknown
    pid?: unknown
    generation?: unknown
    socketPath?: unknown
    sessionName?: unknown
    windowName?: unknown
    sessionId?: unknown
    windowId?: unknown
    paneId?: unknown
  } | undefined
}

const BTMUX_SOCKET = '/tmp/hrc-fixture/btmux/claude-code-rt_full.sock'
const IPC_SOCKET = '/tmp/hrc-fixture/bipc/abcd1234/b.sock'
const ATTACH_TOKEN_PATH = '/tmp/hrc-fixture/bipc/abcd1234/attach.token'
const SESSION_NAME = 'hrc-claude-code-rt_full'

function brokerWindow(): Record<string, unknown> {
  return {
    socketPath: BTMUX_SOCKET,
    sessionName: SESSION_NAME,
    windowName: 'broker',
    sessionId: '$7',
    windowId: '@7',
    paneId: '%7',
  }
}

function tuiWindow(): Record<string, unknown> {
  return {
    socketPath: BTMUX_SOCKET,
    sessionName: SESSION_NAME,
    windowName: 'tui',
    sessionId: '$7',
    windowId: '@8',
    paneId: '%8',
  }
}

type SeedOptions = {
  runtimeId: string
  hostSessionId: string
  scopeRef: string
  control: Record<string, unknown>
  activeInvocationId?: string | undefined
  lastEventSeq?: number | undefined
}

function seedDurableBrokerRuntime(options: SeedOptions): void {
  const now = fixture.now()
  const db = openHrcDatabase(fixture.dbPath)
  try {
    db.sessions.insert({
      hostSessionId: options.hostSessionId,
      scopeRef: options.scopeRef,
      laneRef: 'main',
      generation: 1,
      status: 'active',
      createdAt: now,
      updatedAt: now,
      ancestorScopeRefs: [],
    })
    db.runtimes.insert({
      runtimeId: options.runtimeId,
      hostSessionId: options.hostSessionId,
      scopeRef: options.scopeRef,
      laneRef: 'main',
      generation: 1,
      transport: 'tmux',
      harness: 'claude-code',
      provider: 'anthropic',
      status: 'busy',
      supportsInflightInput: true,
      adopted: false,
      controllerKind: 'harness-broker',
      ...(options.activeInvocationId ? { activeInvocationId: options.activeInvocationId } : {}),
      tmuxJson: {
        socketPath: BTMUX_SOCKET,
        sessionName: SESSION_NAME,
        windowName: 'tui',
        sessionId: '$7',
        windowId: '@8',
        paneId: '%8',
      },
      runtimeStateJson: {
        schemaVersion: 'runtime-state/v1',
        kind: 'harness-broker',
        broker: {
          protocolVersion: 'harness-broker/0.2',
          ownerServerInstanceId: 'srv-test',
          endpoint: {
            kind: 'unix-jsonrpc-ndjson',
            socketPath: IPC_SOCKET,
            attachTokenRef: { kind: 'file', path: ATTACH_TOKEN_PATH, redacted: true },
          },
          generation: 1,
          brokerCommand: `exec harness-broker run --transport unix --socket ${IPC_SOCKET}`,
          brokerPid: 54321,
          brokerWindow: brokerWindow(),
          tuiWindow: tuiWindow(),
          // Simulated careless persist of the RAW secret — inspect MUST NOT echo it.
          attachToken: RAW_ATTACH_TOKEN_SECRET,
        },
        control: options.control,
      },
      createdAt: now,
      updatedAt: now,
      lastActivityAt: now,
    })
    if (options.activeInvocationId) {
      db.brokerInvocations.insert({
        invocationId: options.activeInvocationId,
        operationId: `op-${options.runtimeId}`,
        runtimeId: options.runtimeId,
        runId: `run-${options.runtimeId}`,
        brokerProtocol: 'harness-broker/0.2',
        brokerDriver: 'claude-code',
        invocationState: 'turn_active',
        capabilitiesJson: '{}',
        specHash: 'spec-hash',
        startRequestHash: 'start-hash',
        selectedProfileHash: 'profile-hash',
        ...(options.lastEventSeq !== undefined ? { lastEventSeq: options.lastEventSeq } : {}),
        ownerServerInstanceId: 'srv-test',
        createdAt: now,
        updatedAt: now,
      })
    }
  } finally {
    db.close()
  }
}

describe('RED: inspect surfaces the FULL durable-broker control surface (T-01814)', () => {
  it('surfaces broker IPC control, operator TUI attach, and broker-process diagnostics as DISTINCT sections', async () => {
    const runtimeId = 'rt_full'
    seedDurableBrokerRuntime({
      runtimeId,
      hostSessionId: 'hsid_full',
      scopeRef: 'agent:smokey:project:hrc-runtime:task:T-01814:full',
      activeInvocationId: 'inv_full',
      lastEventSeq: 42,
      control: {
        mode: 'broker-ipc',
        brokerAttached: true,
        replayStatus: 'replayed',
        degradedReason: null,
        lastAttachError: null,
      },
    })

    const res = await fixture.postJson('/v1/runtimes/inspect', { runtimeId })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { control?: FullControl | undefined }
    const control = body.control
    expect(control).toBeDefined()

    // Minimal (Phase 0/4) fields stay.
    expect(control?.mode).toBe('broker-ipc')
    expect(control?.brokerAttached).toBe(true)

    // (1) Broker control over Unix IPC.
    expect(control?.brokerIpc).toBeDefined()
    expect(control?.brokerIpc?.socketPath).toBe(IPC_SOCKET)
    expect(control?.brokerIpc?.attachTokenRef?.kind).toBe('file')
    expect(control?.brokerIpc?.attachTokenRef?.path).toBe(ATTACH_TOKEN_PATH)
    expect(control?.brokerIpc?.attachTokenRef?.redacted).toBe(true)
    expect(control?.brokerIpc?.eventHighWaterSeq).toBe(42)
    expect(control?.brokerIpc?.replayStatus).toBe('replayed')
    expect(control?.brokerIpc?.degradedReason).toBeNull()
    expect(control?.brokerIpc?.lastAttachError).toBeNull()

    // (2) Operator TUI attach — the `tui` window, NEVER the broker window.
    expect(control?.operatorAttach).toBeDefined()
    expect(control?.operatorAttach?.windowName).toBe('tui')
    expect(control?.operatorAttach?.paneId).toBe('%8')
    expect(control?.operatorAttach?.sessionName).toBe(SESSION_NAME)
    expect(control?.operatorAttach?.socketPath).toBe(BTMUX_SOCKET)
    expect(typeof control?.operatorAttach?.attachCommand).toBe('string')
    expect(control?.operatorAttach?.attachCommand as string).toContain(BTMUX_SOCKET)
    expect(control?.operatorAttach?.attachCommand as string).toContain('tui')

    // (3) Broker PROCESS diagnostics — the `broker` window child.
    expect(control?.brokerProcess).toBeDefined()
    expect(control?.brokerProcess?.windowName).toBe('broker')
    expect(control?.brokerProcess?.paneId).toBe('%7')
    expect(control?.brokerProcess?.pid).toBe(54321)
    expect(control?.brokerProcess?.generation).toBe(1)
    expect(control?.brokerProcess?.command as string).toContain('harness-broker')

    // The three concerns must be DISTINCT — the operator-attach pane is the TUI
    // pane and the broker-process pane is the broker pane, never conflated.
    expect(control?.operatorAttach?.paneId).not.toBe(control?.brokerProcess?.paneId)
    expect(control?.operatorAttach?.windowName).not.toBe(control?.brokerProcess?.windowName)
  })

  it('REDACTION: the raw attach token never appears; only the redacted ref does', async () => {
    const runtimeId = 'rt_redact'
    seedDurableBrokerRuntime({
      runtimeId,
      hostSessionId: 'hsid_redact',
      scopeRef: 'agent:smokey:project:hrc-runtime:task:T-01814:redact',
      activeInvocationId: 'inv_redact',
      lastEventSeq: 7,
      control: {
        mode: 'broker-ipc',
        brokerAttached: true,
        replayStatus: 'attached',
        degradedReason: null,
        lastAttachError: null,
      },
    })

    const res = await fixture.postJson('/v1/runtimes/inspect', { runtimeId })
    expect(res.status).toBe(200)
    const raw = await res.text()

    // The raw secret must be absent from the ENTIRE serialized response.
    expect(raw).not.toContain(RAW_ATTACH_TOKEN_SECRET)

    const body = JSON.parse(raw) as { control?: FullControl | undefined }
    // Only the redacted reference is exposed.
    expect(body.control?.brokerIpc?.attachTokenRef?.path).toBe(ATTACH_TOKEN_PATH)
    expect(body.control?.brokerIpc?.attachTokenRef?.redacted).toBe(true)
    // No raw-token-bearing field leaks into the IPC section.
    expect((body.control?.brokerIpc as Record<string, unknown> | undefined)?.['attachToken']).toBeUndefined()
  })

  it('degraded fallback surfaces a degradedReason distinct from broker-attached state', async () => {
    const runtimeId = 'rt_degraded_full'
    seedDurableBrokerRuntime({
      runtimeId,
      hostSessionId: 'hsid_degraded_full',
      scopeRef: 'agent:smokey:project:hrc-runtime:task:T-01814:degraded',
      control: {
        mode: 'direct-tmux-degraded',
        brokerAttached: false,
        replayStatus: null,
        degradedReason: 'broker_socket_unavailable_tui_live',
        lastAttachError: { code: 'broker_attach_replay_failed', message: 'connect ECONNREFUSED' },
      },
    })

    const res = await fixture.postJson('/v1/runtimes/inspect', { runtimeId })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { control?: FullControl | undefined }
    const control = body.control

    expect(control?.mode).toBe('direct-tmux-degraded')
    expect(control?.brokerAttached).toBe(false)
    // Degraded reason + last attach error are surfaced for operator diagnosis.
    expect(control?.brokerIpc?.degradedReason).toBe('broker_socket_unavailable_tui_live')
    expect(
      (control?.brokerIpc?.lastAttachError as { code?: unknown } | null | undefined)?.code
    ).toBe('broker_attach_replay_failed')
    // The operator can still locate the TUI pane even while degraded.
    expect(control?.operatorAttach?.windowName).toBe('tui')
  })
})
