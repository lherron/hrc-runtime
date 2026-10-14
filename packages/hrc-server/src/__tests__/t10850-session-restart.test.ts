/**
 * T-10850 — operator session restart (`POST /v1/sessions/restart`, ADR
 * hrc-ios architecture/adr/2026-10-14-semantic-session-restart.md) against a
 * real isolated HrcServer: real store, real unix socket, real rotation. Two
 * seams: the broker controller answers `seatProbe`/`dispose` (what the live
 * seat reports), and the successor launch is recorded instead of birthing a
 * harness. The installed acceptance on a real claude-code seat is on the task.
 *
 * Failure modes this guards:
 *  - a human-typed turn (broker turnId, no HRC run) is destroyed as "idle" (F1)
 *  - an unattributed observed turn or an unobservable seat counts as idle (F1)
 *  - a refusal mutates anything: generation, runtime, events (F2)
 *  - a stale leaf restarts whatever generation is current now
 *  - a participant or intent-less session is rotated, then cannot relaunch (F4)
 *  - a failed launch after commit loses the successor's identity (F4)
 *  - the successor resumes the old conversation (continuation kept)
 */
import { afterEach, describe, expect, it } from 'bun:test'

import type { HrcRuntimeIntent, HrcSessionRecord } from 'hrc-core'
import type { HrcDatabase } from 'hrc-store-sqlite'

import { createHrcServer } from '../index.js'
import type { HrcServer } from '../index.js'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture.js'

const SCOPE = 'agent:clod:project:hrc-ios:task:T-10850'
const NOW = '2026-10-14T12:00:00.000Z'
const INTENT = { placement: { agentRoot: '/tmp/agent' }, harness: { provider: 'anthropic' } }

type Internal = HrcServer & {
  db: HrcDatabase
  getHarnessBrokerController: () => unknown
  startRuntimeForSession: (
    session: HrcSessionRecord,
    intent: HrcRuntimeIntent,
    restartStyle: string
  ) => Promise<unknown>
}

type Probe = { ok: true; state: string; turnId?: string } | { ok: false; message: string }

type Node = {
  fixture: HrcServerTestFixture
  server: Internal
  probe: Probe
  launches: { hostSessionId: string; restartStyle: string; intent: unknown }[]
  launchFails: boolean
}

const started: Node[] = []

afterEach(async () => {
  for (const node of started.splice(0)) {
    await node.server.stop().catch(() => undefined)
    await node.fixture.cleanup()
  }
})

async function startNode(prefix: string): Promise<Node> {
  const fixture = await createHrcTestFixture(prefix)
  const server = (await createHrcServer(fixture.serverOpts())) as Internal
  const node: Node = {
    fixture,
    server,
    probe: { ok: true, state: 'idle' },
    launches: [],
    launchFails: false,
  }
  server.getHarnessBrokerController = () => ({
    seatProbe: async () =>
      node.probe.ok
        ? {
            ok: true,
            response: {
              invocationId: 'inv-t10850',
              seat:
                node.probe.turnId !== undefined
                  ? { state: node.probe.state, turnId: node.probe.turnId, policy: 'steer' }
                  : { state: node.probe.state },
              brokerHeldDepth: 0,
            },
          }
        : { ok: false, error: { message: node.probe.message } },
    dispose: async () => ({ ok: true, response: {} }),
  })
  server.startRuntimeForSession = async (session, intent, restartStyle) => {
    node.launches.push({ hostSessionId: session.hostSessionId, restartStyle, intent })
    if (node.launchFails) throw new Error('harness failed to boot')
    return { runtimeId: `rt-successor-${session.generation}` }
  }
  started.push(node)
  return node
}

function seat(
  node: Node,
  options: { intent?: boolean; runtime?: boolean; external?: boolean } = {}
): { hostSessionId: string; runtimeId: string } {
  const suffix = Math.random().toString(36).slice(2, 10)
  const hostSessionId = `hsid-t10850-${suffix}`
  const runtimeId = `rt-t10850-${suffix}`
  node.server.db.sessions.insert({
    hostSessionId,
    scopeRef: SCOPE,
    laneRef: 'main',
    generation: 3,
    status: 'active',
    createdAt: NOW,
    updatedAt: NOW,
    continuation: { provider: 'anthropic', key: 'claude-session-prior' },
  })
  // Preserve the incomplete persisted intent this restart fixture exercises;
  // it is JSON in the store, not a valid intent for a real harness launch.
  if (options.intent !== false) {
    node.server.db.sqlite.run(
      'UPDATE sessions SET last_applied_intent_json = ? WHERE host_session_id = ?',
      [JSON.stringify(INTENT), hostSessionId]
    )
  }
  node.server.db.continuities.upsert({
    scopeRef: SCOPE,
    laneRef: 'main',
    activeHostSessionId: hostSessionId,
    updatedAt: NOW,
  })
  if (options.runtime !== false) {
    node.server.db.runtimes.insert({
      runtimeId,
      hostSessionId,
      scopeRef: SCOPE,
      laneRef: 'main',
      generation: 3,
      transport: 'tmux',
      harness: 'claude-code',
      provider: 'anthropic',
      status: 'ready',
      controllerKind: 'harness-broker',
      ...(options.external ? { runtimeStateJson: { lifecycleOwner: 'external' } } : {}),
      supportsInflightInput: true,
      createdAt: NOW,
      updatedAt: NOW,
    })
  }
  return { hostSessionId, runtimeId }
}

async function restart(
  node: Node,
  body: Record<string, unknown>
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await node.fixture.fetchSocket('/v1/sessions/restart', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

function errorOf(result: { body: Record<string, unknown> }): {
  code?: string
  detail?: Record<string, unknown>
} {
  return (result.body['error'] ?? {}) as { code?: string; detail?: Record<string, unknown> }
}

/** Nothing moved: same active head, same generation, runtime untouched, no rotation events. */
function expectUnchanged(node: Node, s: { hostSessionId: string; runtimeId: string }): void {
  const continuity = node.server.db.continuities.getByKey(SCOPE, 'main')
  expect(continuity?.activeHostSessionId).toBe(s.hostSessionId)
  expect(node.server.db.sessions.getByHostSessionId(s.hostSessionId)?.status).toBe('active')
  expect(node.server.db.runtimes.getByRuntimeId(s.runtimeId)?.status).toBe('ready')
  const kinds = node.server.db.hrcEvents
    .listFromHrcSeq(1, { hostSessionId: s.hostSessionId })
    .map((event) => event.eventKind)
  expect(kinds).not.toContain('context.cleared')
  expect(node.launches).toHaveLength(0)
}

describe('POST /v1/sessions/restart', () => {
  it('rotates an idle seat to a fresh generation and relaunches it', async () => {
    const node = await startNode('t10850-idle')
    const s = seat(node)

    const result = await restart(node, { hostSessionId: s.hostSessionId, expectedGeneration: 3 })

    expect(result.status).toBe(200)
    expect(result.body['priorHostSessionId']).toBe(s.hostSessionId)
    expect(result.body['generation']).toBe(4)
    const successorId = result.body['hostSessionId'] as string
    expect(successorId).not.toBe(s.hostSessionId)
    expect(result.body['launch']).toEqual({ status: 'started', runtimeId: 'rt-successor-4' })

    const successor = node.server.db.sessions.getByHostSessionId(successorId)
    expect(successor?.continuation).toBeUndefined()
    expect(node.server.db.sessions.getByHostSessionId(s.hostSessionId)?.status).toBe('archived')
    expect(node.server.db.runtimes.getByRuntimeId(s.runtimeId)?.status).toBe('terminated')
    expect(node.server.db.continuities.getByKey(SCOPE, 'main')?.activeHostSessionId).toBe(
      successorId
    )
    expect(node.launches).toEqual([
      { hostSessionId: successorId, restartStyle: 'fresh_pty', intent: INTENT },
    ])
    const cleared = node.server.db.hrcEvents
      .listFromHrcSeq(1, { hostSessionId: s.hostSessionId })
      .find((event) => event.eventKind === 'context.cleared')
    expect((cleared?.payload as Record<string, unknown>)['reason']).toBe('operator-restart')
  })

  it('refuses a human-typed turn (broker turnId, no HRC run) and changes nothing', async () => {
    const node = await startNode('t10850-busy')
    const s = seat(node)
    node.probe = { ok: true, state: 'turn-active', turnId: 'turn-native-1' }

    const result = await restart(node, { hostSessionId: s.hostSessionId, expectedGeneration: 3 })

    expect(result.status).toBe(409)
    expect(errorOf(result).code).toBe('runtime_busy')
    expect(errorOf(result).detail?.['seatState']).toBe('turn-active')
    expect(errorOf(result).detail?.['turnId']).toBe('turn-native-1')
    expectUnchanged(node, s)
  })

  it('refuses every non-idle seat state as busy', async () => {
    const node = await startNode('t10850-states')
    const s = seat(node)
    for (const state of ['turn-observed', 'starting', 'stopping']) {
      node.probe = { ok: true, state }
      const result = await restart(node, { hostSessionId: s.hostSessionId, expectedGeneration: 3 })
      expect(result.status).toBe(409)
      expect(errorOf(result).code).toBe('runtime_busy')
    }
    expectUnchanged(node, s)
  })

  it('fails closed when the seat cannot be observed', async () => {
    const node = await startNode('t10850-unobservable')
    const s = seat(node)
    node.probe = { ok: false, message: 'broker socket gone' }

    const result = await restart(node, { hostSessionId: s.hostSessionId, expectedGeneration: 3 })

    expect(result.status).toBe(409)
    expect(errorOf(result).code).toBe('seat_unobservable')
    expectUnchanged(node, s)
  })

  it('force restarts a busy seat', async () => {
    const node = await startNode('t10850-force')
    const s = seat(node)
    node.probe = { ok: true, state: 'turn-active', turnId: 'turn-native-2' }

    const result = await restart(node, {
      hostSessionId: s.hostSessionId,
      expectedGeneration: 3,
      force: true,
    })

    expect(result.status).toBe(200)
    expect(result.body['generation']).toBe(4)
  })

  it('refuses a stale generation and names the active one', async () => {
    const node = await startNode('t10850-stale')
    const s = seat(node)

    const result = await restart(node, { hostSessionId: s.hostSessionId, expectedGeneration: 2 })

    expect(result.status).toBe(409)
    expect(errorOf(result).code).toBe('stale_context')
    expect(errorOf(result).detail?.['activeHostSessionId']).toBe(s.hostSessionId)
    expect(errorOf(result).detail?.['activeGeneration']).toBe(3)
    expectUnchanged(node, s)
  })

  it('refuses an archived host session and names the successor', async () => {
    const node = await startNode('t10850-archived')
    const s = seat(node)
    const first = await restart(node, { hostSessionId: s.hostSessionId, expectedGeneration: 3 })
    expect(first.status).toBe(200)

    const again = await restart(node, { hostSessionId: s.hostSessionId, expectedGeneration: 3 })

    expect(again.status).toBe(409)
    expect(errorOf(again).code).toBe('stale_context')
    expect(errorOf(again).detail?.['activeHostSessionId']).toBe(first.body['hostSessionId'])
    expect(node.launches).toHaveLength(1)
  })

  it('refuses a session with no runtime intent before any mutation', async () => {
    const node = await startNode('t10850-intent')
    const s = seat(node, { intent: false })

    const result = await restart(node, { hostSessionId: s.hostSessionId, expectedGeneration: 3 })

    expect(result.status).toBe(422)
    expect(errorOf(result).code).toBe('missing_runtime_intent')
    expectUnchanged(node, s)
  })

  it('refuses an externally owned participant before any mutation', async () => {
    const node = await startNode('t10850-participant')
    const s = seat(node, { external: true })

    const result = await restart(node, { hostSessionId: s.hostSessionId, expectedGeneration: 3 })

    expect(result.status).toBeGreaterThanOrEqual(400)
    expect(errorOf(result).detail?.['reason']).toBe('participant_rotation_unsupported')
    expectUnchanged(node, s)
  })

  it('treats a seat with no live runtime as idle', async () => {
    const node = await startNode('t10850-dormant')
    const s = seat(node, { runtime: false })
    node.probe = { ok: false, message: 'never probed' }

    const result = await restart(node, { hostSessionId: s.hostSessionId, expectedGeneration: 3 })

    expect(result.status).toBe(200)
    expect(result.body['generation']).toBe(4)
  })

  it('returns the successor identity when the launch fails after commit', async () => {
    const node = await startNode('t10850-launch-fail')
    const s = seat(node)
    node.launchFails = true

    const result = await restart(node, { hostSessionId: s.hostSessionId, expectedGeneration: 3 })

    expect(result.status).toBe(200)
    expect(result.body['generation']).toBe(4)
    const successorId = result.body['hostSessionId'] as string
    expect(node.server.db.continuities.getByKey(SCOPE, 'main')?.activeHostSessionId).toBe(
      successorId
    )
    const launch = result.body['launch'] as Record<string, unknown>
    expect(launch['status']).toBe('failed')
    expect(launch['message']).toContain('harness failed to boot')
  })

  it('rejects a body without expectedGeneration', async () => {
    const node = await startNode('t10850-malformed')
    const s = seat(node)

    const result = await restart(node, { hostSessionId: s.hostSessionId })

    expect(result.status).toBe(400)
    expectUnchanged(node, s)
  })
})
