/**
 * RED tests — T-01876 / T-01862 Ph5: status/inspect projection exposes
 * endpoint, substrate, and presentation as SEPARATE top-level fields on the
 * full inspect response; public status adds coarse brokerEndpoint + presentation
 * alongside the existing brokerSubstrate; all derived from
 * parseBrokerRuntimeHostingState (not runtime.transport).
 *
 * FAILS AT HEAD because:
 *  - InspectRuntimeResponse has no top-level `broker`, `substrate`, or
 *    `presentation` fields — only `control.brokerIpc` (different concern).
 *  - HrcTargetRuntimeView has no `brokerEndpoint` or `presentation` fields.
 *
 * Curly adds the projection; smokey verifies green.
 *
 * Schema shape after Ph5 (spec §10.9):
 *
 *  InspectRuntimeResponse (new top-level fields):
 *    broker:       { protocolVersion, endpoint: { kind, socketPath } }
 *    substrate:    { kind:'leased-tmux', tmuxSocketPath, sessionName,
 *                    brokerWindow:{sessionId,windowId,paneId}, generation }
 *    presentation: { kind:'none' } | { kind:'tmux-tui', tuiWindow, operatorAttachTarget:true, attachCommand }
 *
 *  HrcTargetRuntimeView (additive coarse fields):
 *    brokerEndpoint:  'unix-jsonrpc-ndjson' | 'stdio-jsonrpc-ndjson'  (NEW)
 *    presentation:    'none' | 'tmux-tui'                              (NEW)
 *    brokerSubstrate: 'leased-tmux' | 'daemon-child'                   (EXISTING, Ph3)
 *
 * Architecture note (spec §10.9):
 *  Projection MUST derive these from parseBrokerRuntimeHostingState, never from
 *  runtime.transport. A headless runtime with leased-tmux substrate must expose
 *  substrate.kind='leased-tmux' even though transport='headless'.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import type { HrcRuntimeSnapshot } from 'hrc-core'
import { openHrcDatabase } from 'hrc-store-sqlite'

import { createHrcServer } from '../index'
import type { HrcServer } from '../index'
import { toTargetRuntimeView } from '../target-view'
import { createHrcTestFixture } from './fixtures/hrc-test-fixture'
import type { HrcServerTestFixture } from './fixtures/hrc-test-fixture'

let fixture: HrcServerTestFixture
let server: HrcServer

const BTMUX_SOCKET = '/tmp/hrc-fixture/btmux/proj-ph5.sock'
const IPC_SOCKET = '/tmp/hrc-fixture/bipc/ph5abcd/b.sock'
const ATTACH_TOKEN_PATH = '/tmp/hrc-fixture/bipc/ph5abcd/attach.token'
const SESSION_NAME = 'hrc-claude-code-rt_ph5'

beforeEach(async () => {
  fixture = await createHrcTestFixture('hrc-broker-inspect-projection-')
  server = await createHrcServer(fixture.serverOpts())
})

afterEach(async () => {
  if (server) await server.stop()
  await fixture.cleanup()
})

// ── Seed helpers ──────────────────────────────────────────────────────────────

function brokerEndpointJson(): Record<string, unknown> {
  return {
    kind: 'unix-jsonrpc-ndjson',
    socketPath: IPC_SOCKET,
    attachTokenRef: { kind: 'file', path: ATTACH_TOKEN_PATH, redacted: true },
  }
}

function brokerWindowJson(): Record<string, unknown> {
  return {
    socketPath: BTMUX_SOCKET,
    sessionName: SESSION_NAME,
    windowName: 'broker',
    sessionId: '$9',
    windowId: '@9',
    paneId: '%9',
  }
}

function tuiWindowJson(): Record<string, unknown> {
  return {
    socketPath: BTMUX_SOCKET,
    sessionName: SESSION_NAME,
    windowName: 'tui',
    sessionId: '$9',
    windowId: '@10',
    paneId: '%10',
  }
}

type SeedOptions = {
  runtimeId: string
  hostSessionId: string
  scopeRef: string
  interactive: boolean
}

function seedDurableBrokerRuntime(opts: SeedOptions): void {
  const now = fixture.now()
  const db = openHrcDatabase(fixture.dbPath)
  try {
    db.sessions.insert({
      hostSessionId: opts.hostSessionId,
      scopeRef: opts.scopeRef,
      laneRef: 'main',
      generation: 1,
      status: 'active',
      createdAt: now,
      updatedAt: now,
      ancestorScopeRefs: [],
    })
    // Headless: transport='headless'; interactive: transport='tmux'.
    // Both use controllerKind='harness-broker'.
    const transport = opts.interactive ? 'tmux' : 'headless'
    // tmuxJson for interactive carries the tui pane; for headless it is omitted.
    const tmuxJson = opts.interactive ? tuiWindowJson() : undefined
    // Flat broker state shape (T-01801): endpoint + brokerWindow + optional tuiWindow.
    const brokerBlock: Record<string, unknown> = {
      protocolVersion: 'harness-broker/0.2',
      ownerServerInstanceId: 'srv-test',
      endpoint: brokerEndpointJson(),
      generation: 3,
      brokerWindow: brokerWindowJson(),
      ...(opts.interactive ? { tuiWindow: tuiWindowJson() } : {}),
    }
    db.runtimes.insert({
      runtimeId: opts.runtimeId,
      hostSessionId: opts.hostSessionId,
      scopeRef: opts.scopeRef,
      laneRef: 'main',
      generation: 1,
      transport,
      harness: 'claude-code',
      provider: 'anthropic',
      status: 'ready',
      supportsInflightInput: true,
      adopted: false,
      controllerKind: 'harness-broker',
      ...(tmuxJson ? { tmuxJson } : {}),
      runtimeStateJson: {
        schemaVersion: 'runtime-state/v1',
        kind: 'harness-broker',
        broker: brokerBlock,
        control: {
          mode: 'broker-ipc',
          brokerAttached: false,
        },
      },
      createdAt: now,
      updatedAt: now,
      lastActivityAt: now,
    })
  } finally {
    db.close()
  }
}

// Helper to build a minimal HrcRuntimeSnapshot directly for unit-level projection tests.
function makeRawRuntime(opts: {
  transport: 'headless' | 'tmux'
  interactive: boolean
}): HrcRuntimeSnapshot {
  const brokerBlock: Record<string, unknown> = {
    protocolVersion: 'harness-broker/0.2',
    ownerServerInstanceId: 'srv-unit',
    endpoint: brokerEndpointJson(),
    generation: 2,
    brokerWindow: brokerWindowJson(),
    ...(opts.interactive ? { tuiWindow: tuiWindowJson() } : {}),
  }
  return {
    runtimeId: 'rt-unit',
    hostSessionId: 'hsid-unit',
    scopeRef: 'agent:unit:project:test',
    laneRef: 'main',
    generation: 1,
    transport: opts.transport,
    harness: 'claude-code',
    provider: 'anthropic',
    status: 'ready',
    supportsInflightInput: false,
    adopted: false,
    controllerKind: 'harness-broker',
    runtimeStateJson: {
      schemaVersion: 'runtime-state/v1',
      kind: 'harness-broker',
      broker: brokerBlock,
      control: { mode: 'broker-ipc', brokerAttached: false },
    },
    createdAt: fixture.now(),
    updatedAt: fixture.now(),
    lastActivityAt: fixture.now(),
  } as unknown as HrcRuntimeSnapshot
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('RED: Ph5 — inspect projection exposes endpoint/substrate/presentation as SEPARATE fields (T-01876)', () => {
  it('RED 1 — full inspect for durable HEADLESS row surfaces broker/substrate/presentation as distinct top-level fields', async () => {
    seedDurableBrokerRuntime({
      runtimeId: 'rt_ph5_headless',
      hostSessionId: 'hsid_ph5_headless',
      scopeRef: 'agent:smokey:project:hrc-runtime:task:T-01876:headless',
      interactive: false,
    })

    const res = await fixture.postJson('/v1/runtimes/inspect', { runtimeId: 'rt_ph5_headless' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>

    // Legacy transport alias MUST be preserved.
    expect(body['transport']).toBe('headless')

    // Broker axis — protocolVersion + redacted endpoint.
    // RED: `broker` top-level field does not exist today.
    expect(body['broker']).toBeDefined()
    const broker = body['broker'] as Record<string, unknown>
    expect(broker['protocolVersion']).toBe('harness-broker/0.2')
    const endpoint = broker['endpoint'] as Record<string, unknown>
    expect(endpoint['kind']).toBe('unix-jsonrpc-ndjson')
    expect(endpoint['socketPath']).toBe(IPC_SOCKET)

    // Substrate axis — WHERE the broker lives.
    // RED: `substrate` top-level field does not exist today.
    expect(body['substrate']).toBeDefined()
    const substrate = body['substrate'] as Record<string, unknown>
    expect(substrate['kind']).toBe('leased-tmux')
    expect(substrate['tmuxSocketPath']).toBe(BTMUX_SOCKET)
    expect(substrate['sessionName']).toBe(SESSION_NAME)
    expect(substrate['generation']).toBe(3)
    const brokerWindow = substrate['brokerWindow'] as Record<string, unknown>
    expect(brokerWindow['sessionId']).toBe('$9')
    expect(brokerWindow['windowId']).toBe('@9')
    expect(brokerWindow['paneId']).toBe('%9')

    // Presentation axis — headless = none.
    // RED: `presentation` top-level field does not exist today.
    expect(body['presentation']).toBeDefined()
    const presentation = body['presentation'] as Record<string, unknown>
    expect(presentation['kind']).toBe('none')

    // The three axes are distinct top-level keys, not nested under `control`.
    // (control.brokerIpc is a SEPARATE concern from the hosting-state projection.)
    expect(body['broker']).not.toBe(body['control'])
    expect(body['substrate']).not.toBe(body['control'])
    expect(body['presentation']).not.toBe(body['control'])
  })

  it('RED 2 — full inspect for durable INTERACTIVE row surfaces presentation{kind:tmux-tui} with attach fields', async () => {
    seedDurableBrokerRuntime({
      runtimeId: 'rt_ph5_interactive',
      hostSessionId: 'hsid_ph5_interactive',
      scopeRef: 'agent:smokey:project:hrc-runtime:task:T-01876:interactive',
      interactive: true,
    })

    const res = await fixture.postJson('/v1/runtimes/inspect', { runtimeId: 'rt_ph5_interactive' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>

    // Legacy transport preserved.
    expect(body['transport']).toBe('tmux')

    // Substrate axis — same leased-tmux shape.
    expect(body['substrate']).toBeDefined()
    const substrate = body['substrate'] as Record<string, unknown>
    expect(substrate['kind']).toBe('leased-tmux')

    // Presentation axis — interactive = tmux-tui.
    // RED: `presentation` field absent AND no tmux-tui shape today.
    expect(body['presentation']).toBeDefined()
    const presentation = body['presentation'] as Record<string, unknown>
    expect(presentation['kind']).toBe('tmux-tui')

    // tuiWindow identity must be the TUI window, NOT the broker window.
    const tuiWindow = presentation['tuiWindow'] as Record<string, unknown>
    expect(tuiWindow['paneId']).toBe('%10')
    expect(tuiWindow['windowId']).toBe('@10')
    expect(tuiWindow['sessionId']).toBe('$9')

    // operatorAttachTarget must be true (operator can attach here).
    expect(presentation['operatorAttachTarget']).toBe(true)

    // attachCommand must reference the tmux socket + session + tui.
    const attachCommand = presentation['attachCommand'] as string
    expect(typeof attachCommand).toBe('string')
    expect(attachCommand).toContain(BTMUX_SOCKET)
    expect(attachCommand).toContain('tui')

    // TUI pane ≠ broker pane — axes must not be conflated.
    const broker = body['broker'] as Record<string, unknown> | undefined
    if (broker) {
      const brokerEndpoint = broker['endpoint'] as Record<string, unknown> | undefined
      // Broker endpoint is unix, not tmux. The substrate is where broker lives.
      expect(brokerEndpoint?.['kind']).toBe('unix-jsonrpc-ndjson')
    }
    expect(tuiWindow['paneId']).not.toBe('%9') // broker pane
  })

  it('RED 3 — non-broker runtime has no broker/substrate/presentation in inspect response', async () => {
    // A vanilla headless (non-broker) runtime should NOT grow the new fields —
    // the projection must guard on controllerKind==='harness-broker'.
    const now = fixture.now()
    const db = openHrcDatabase(fixture.dbPath)
    try {
      db.sessions.insert({
        hostSessionId: 'hsid_ph5_plain',
        scopeRef: 'agent:smokey:project:hrc-runtime:task:T-01876:plain',
        laneRef: 'main',
        generation: 1,
        status: 'active',
        createdAt: now,
        updatedAt: now,
        ancestorScopeRefs: [],
      })
      db.runtimes.insert({
        runtimeId: 'rt_ph5_plain',
        hostSessionId: 'hsid_ph5_plain',
        scopeRef: 'agent:smokey:project:hrc-runtime:task:T-01876:plain',
        laneRef: 'main',
        generation: 1,
        transport: 'headless',
        harness: 'agent-sdk',
        provider: 'anthropic',
        status: 'ready',
        supportsInflightInput: false,
        adopted: false,
        createdAt: now,
        updatedAt: now,
        lastActivityAt: now,
      })
    } finally {
      db.close()
    }

    const res = await fixture.postJson('/v1/runtimes/inspect', { runtimeId: 'rt_ph5_plain' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>

    // Plain non-broker runtime must NOT have hosting-state fields.
    expect(body['broker']).toBeUndefined()
    expect(body['substrate']).toBeUndefined()
    expect(body['presentation']).toBeUndefined()
    expect(body['transport']).toBe('headless')
  })
})

describe('RED: Ph5 — public status (HrcTargetRuntimeView) adds brokerEndpoint + presentation (T-01876)', () => {
  it('RED 4 — toTargetRuntimeView for headless durable runtime adds brokerEndpoint + presentation coarse fields', () => {
    // Unit-level test of the projection function directly (no HTTP round-trip needed).
    const runtime = makeRawRuntime({ transport: 'headless', interactive: false })

    const view = toTargetRuntimeView(runtime)
    expect(view).toBeDefined()

    const rawView = view as unknown as Record<string, unknown>

    // Legacy transport alias preserved.
    expect(rawView['transport']).toBe('headless')

    // Existing Ph3 field must still be present.
    expect(rawView['brokerSubstrate']).toBe('leased-tmux')

    // RED: `brokerEndpoint` coarse field absent today.
    expect(rawView['brokerEndpoint']).toBe('unix-jsonrpc-ndjson')

    // RED: `presentation` coarse field absent today.
    expect(rawView['presentation']).toBe('none')
  })

  it('RED 5 — toTargetRuntimeView for interactive durable runtime adds presentation=tmux-tui', () => {
    const runtime = makeRawRuntime({ transport: 'tmux', interactive: true })

    const view = toTargetRuntimeView(runtime)
    expect(view).toBeDefined()

    const rawView = view as unknown as Record<string, unknown>

    // Legacy transport alias preserved.
    expect(rawView['transport']).toBe('tmux')

    // RED: `brokerEndpoint` coarse field absent today.
    expect(rawView['brokerEndpoint']).toBe('unix-jsonrpc-ndjson')

    // RED: `presentation` coarse field absent today — interactive = tmux-tui.
    expect(rawView['presentation']).toBe('tmux-tui')
  })

  it('RED 6 — non-broker runtime has no brokerEndpoint or presentation coarse fields', () => {
    // A non-broker tmux runtime must NOT grow broker projection fields.
    const runtime = {
      runtimeId: 'rt-unit-plain',
      hostSessionId: 'hsid-unit-plain',
      scopeRef: 'agent:unit:project:test:plain',
      laneRef: 'main',
      generation: 1,
      transport: 'tmux',
      harness: 'claude-code',
      provider: 'anthropic',
      status: 'ready',
      supportsInflightInput: false,
      adopted: false,
      controllerKind: undefined,
      runtimeStateJson: null,
      createdAt: fixture.now(),
      updatedAt: fixture.now(),
      lastActivityAt: fixture.now(),
    } as unknown as HrcRuntimeSnapshot

    const view = toTargetRuntimeView(runtime)
    expect(view).toBeDefined()
    const rawView = view as unknown as Record<string, unknown>

    expect(rawView['brokerSubstrate']).toBeUndefined()
    expect(rawView['brokerEndpoint']).toBeUndefined()
    expect(rawView['presentation']).toBeUndefined()
  })
})
