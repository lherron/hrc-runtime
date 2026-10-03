/**
 * T-09872 — `hrc restartme` (durable record hrc-runtime.self-restart-turn-boundary)
 * against a real isolated HrcServer: real store, real unix socket, real
 * lifecycle credential minted by the store observer, real session rotation.
 * Two seams: the broker controller answers only `seatProbe` (what the live
 * seat reports), and the successor prompt delivery is recorded instead of
 * birthing a harness. Installed acceptance on real claude-code and codex seats
 * is recorded on the task.
 *
 * Failure modes this guards:
 *  - an older turn's delayed terminal (the newerTurnActive path) fires the restart
 *  - a terminal from another invocation/runtime fires the restart
 *  - broker turn.failed/turn.interrupted (folded into turn.completed) lose identity
 *  - arming without a credential, with a foreign credential, or outside a turn
 *  - an external participant rotated out from under its owner
 *  - --cancel does not actually disarm
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'

import {
  HRC_LIFECYCLE_CREDENTIAL_HEADER,
  HRC_LIFECYCLE_RUNTIME_HEADER,
  HRC_LIFECYCLE_SESSION_REF_HEADER,
  type HrcLifecycleEvent,
  type SemanticTurnHandoffRequest,
  lifecycleCredentialPath,
} from 'hrc-core'
import type { HrcDatabase } from 'hrc-store-sqlite'

import { lifecyclePayload } from '../broker/event-mapper/lifecycle-payload.js'
import { appendHrcEvent } from '../hrc-event-helper.js'
import { createHrcServer } from '../index.js'
import type { HrcServer } from '../index.js'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture.js'

const SCOPE = 'agent:clod:project:hrc-runtime:task:T-09872'
const OTHER_SCOPE = 'agent:cody:project:hrc-runtime:task:T-09872'
const NOW = '2026-09-28T12:00:00.000Z'
const INVOCATION = 'inv-t09872-a'
const TURN = 'turn_inv-t09872-a_4'

type Internal = HrcServer & {
  db: HrcDatabase
  notifyEvent(event: HrcLifecycleEvent): void
  getHarnessBrokerController: () => unknown
  persistAndDeliverSemanticTurnHandoff: (body: SemanticTurnHandoffRequest) => Promise<unknown>
}

type Node = {
  fixture: HrcServerTestFixture
  server: Internal
  seat: { state: string; turnId?: string }
  deliveries: SemanticTurnHandoffRequest[]
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
    seat: { state: 'turn-active', turnId: TURN },
    deliveries: [],
  }
  server.getHarnessBrokerController = () => ({
    seatProbe: async () => ({
      ok: true,
      response: {
        invocationId: INVOCATION,
        seat:
          node.seat.state === 'turn-active'
            ? { state: 'turn-active', turnId: node.seat.turnId, policy: 'steer' }
            : { state: node.seat.state },
        brokerHeldDepth: 0,
      },
    }),
  })
  server.persistAndDeliverSemanticTurnHandoff = async (body) => {
    node.deliveries.push(body)
    return { messageId: 'msg-t09872', runId: 'run-t09872-successor', runtimeId: 'rt-successor' }
  }
  started.push(node)
  return node
}

function launchSeat(
  node: Node,
  scopeRef = SCOPE,
  options: { external?: boolean } = {}
): { runtimeId: string; hostSessionId: string } {
  const suffix = Math.random().toString(36).slice(2, 10)
  const hostSessionId = `hsid-t09872-${suffix}`
  const runtimeId = `rt-t09872-${suffix}`
  node.server.db.sessions.insert({
    hostSessionId,
    scopeRef,
    laneRef: 'main',
    generation: 3,
    status: 'active',
    createdAt: NOW,
    updatedAt: NOW,
    continuation: { provider: 'anthropic', key: 'claude-session-prior' },
  })
  node.server.db.continuities.upsert({
    scopeRef,
    laneRef: 'main',
    activeHostSessionId: hostSessionId,
    updatedAt: NOW,
  })
  node.server.db.runtimes.insert({
    runtimeId,
    hostSessionId,
    scopeRef,
    laneRef: 'main',
    generation: 3,
    transport: 'tmux',
    harness: 'claude-code',
    provider: 'anthropic',
    status: 'busy',
    controllerKind: 'harness-broker',
    activeInvocationId: INVOCATION,
    ...(options.external ? { runtimeStateJson: { lifecycleOwner: 'external' } } : {}),
    supportsInflightInput: true,
    createdAt: NOW,
    updatedAt: NOW,
  })
  return { runtimeId, hostSessionId }
}

function seatHeaders(node: Node, runtimeId: string, scopeRef = SCOPE): Record<string, string> {
  return {
    [HRC_LIFECYCLE_RUNTIME_HEADER]: runtimeId,
    [HRC_LIFECYCLE_CREDENTIAL_HEADER]: readFileSync(
      lifecycleCredentialPath(node.fixture.runtimeRoot, runtimeId),
      'utf8'
    ).trim(),
    [HRC_LIFECYCLE_SESSION_REF_HEADER]: `${scopeRef}/lane:main`,
  }
}

async function restartSelf(
  node: Node,
  body: Record<string, unknown>,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await node.fixture.fetchSocket('/v1/runtimes/restart-self', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

function refusalOf(result: { body: Record<string, unknown> }): string | undefined {
  const error = result.body['error'] as { detail?: { refusal?: string; reason?: string } }
  return error?.detail?.refusal ?? error?.detail?.reason
}

/** A committed broker terminal as the mapper projects it (identity on the payload). */
function terminal(
  node: Node,
  seat: { runtimeId: string; hostSessionId: string },
  identity: { invocationId?: string; turnId?: string; runtimeId?: string },
  kind = 'turn.completed'
): void {
  const event = appendHrcEvent(node.server.db, kind, {
    ts: new Date().toISOString(),
    hostSessionId: seat.hostSessionId,
    scopeRef: SCOPE,
    laneRef: 'main',
    generation: 3,
    runtimeId: identity.runtimeId ?? seat.runtimeId,
    transport: 'tmux',
    payload: {
      success: true,
      transport: 'tmux',
      source: 'broker',
      ...(identity.invocationId !== undefined ? { invocationId: identity.invocationId } : {}),
      ...(identity.turnId !== undefined ? { turnId: identity.turnId } : {}),
    },
  })
  node.server.notifyEvent(event)
}

function kinds(node: Node, hostSessionId: string): string[] {
  return node.server.db.hrcEvents
    .listFromHrcSeq(1, { hostSessionId })
    .map((event) => event.eventKind)
    .filter(
      (kind) =>
        kind.startsWith('session.restart') || kind === 'context.cleared' || kind.startsWith('turn.')
    )
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 5))
}

describe('T-09872 terminal identity threading', () => {
  it('broker turn.completed / turn.failed / turn.interrupted payloads carry invocationId and turnId', () => {
    for (const type of ['turn.completed', 'turn.failed', 'turn.interrupted'] as const) {
      const payload = lifecyclePayload(
        {
          invocationId: INVOCATION,
          seq: 9,
          time: NOW,
          type,
          turnId: TURN,
          payload: type === 'turn.failed' ? { message: 'boom' } : {},
        } as never,
        'tmux'
      )
      expect(payload).toMatchObject({ invocationId: INVOCATION, turnId: TURN, source: 'broker' })
    }
  })
})

describe('T-09872 arm refusals', () => {
  it('refuses a caller with no lifecycle credential and arms nothing', async () => {
    const node = await startNode('hrc-t09872-nocred-')
    const seat = launchSeat(node)
    const result = await restartSelf(
      node,
      { handoffId: 'H-1' },
      { [HRC_LIFECYCLE_SESSION_REF_HEADER]: `${SCOPE}/lane:main` }
    )
    expect(result.status).toBe(403)
    expect(refusalOf(result)).toBe('credential_missing')
    terminal(node, seat, { invocationId: INVOCATION, turnId: TURN })
    await settle()
    expect(kinds(node, seat.hostSessionId)).toEqual(['turn.completed'])
  })

  it('refuses a credential attributed to another seat', async () => {
    const node = await startNode('hrc-t09872-mismatch-')
    const seat = launchSeat(node)
    const headers = {
      ...seatHeaders(node, seat.runtimeId),
      [HRC_LIFECYCLE_SESSION_REF_HEADER]: `${OTHER_SCOPE}/lane:main`,
    }
    const result = await restartSelf(node, { handoffId: 'H-1' }, headers)
    expect(refusalOf(result)).toBe('credential_mismatch')
  })

  it('refuses with no_active_turn when the seat is idle', async () => {
    const node = await startNode('hrc-t09872-idle-')
    const seat = launchSeat(node)
    node.seat = { state: 'idle' }
    const result = await restartSelf(node, { handoffId: 'H-1' }, seatHeaders(node, seat.runtimeId))
    expect(result.status).toBe(403)
    expect(refusalOf(result)).toBe('no_active_turn')
  })

  it('refuses an external-lifecycle participant with the fresh-context participant refusal', async () => {
    const node = await startNode('hrc-t09872-participant-')
    const seat = launchSeat(node, SCOPE, { external: true })
    const result = await restartSelf(node, { handoffId: 'H-1' }, seatHeaders(node, seat.runtimeId))
    expect(refusalOf(result)).toBe('participant_rotation_unsupported')
  })

  it('rejects a body that is neither {handoffId} nor {cancel:true}', async () => {
    const node = await startNode('hrc-t09872-body-')
    const seat = launchSeat(node)
    const result = await restartSelf(node, {}, seatHeaders(node, seat.runtimeId))
    expect(result.status).toBe(400)
  })
})

describe('T-09872 turn binding and execution', () => {
  it('fires only on the arming turn: older turn, other invocation, other runtime and identity-less terminals are ignored', async () => {
    const node = await startNode('hrc-t09872-bind-')
    const seat = launchSeat(node)
    const armed = await restartSelf(
      node,
      { handoffId: 'H-00777' },
      seatHeaders(node, seat.runtimeId)
    )
    expect(armed.status).toBe(200)
    expect(armed.body).toMatchObject({
      outcome: 'armed',
      handoffId: 'H-00777',
      invocationId: INVOCATION,
      turnId: TURN,
      generation: 3,
    })

    // The newerTurnActive path: an older turn's delayed terminal lands after arming.
    terminal(node, seat, { invocationId: INVOCATION, turnId: 'turn_inv-t09872-a_3' })
    terminal(node, seat, { invocationId: 'inv-t09872-older', turnId: TURN })
    terminal(node, seat, { invocationId: INVOCATION, turnId: TURN, runtimeId: 'rt-other' })
    terminal(node, seat, {})
    await settle()
    expect(node.deliveries).toEqual([])
    expect(node.server.db.sessions.getByHostSessionId(seat.hostSessionId)?.status).toBe('active')

    // The bound turn's terminal claims it.
    terminal(node, seat, { invocationId: INVOCATION, turnId: TURN })
    await settle()
    expect(kinds(node, seat.hostSessionId)).toEqual([
      'session.restart_armed',
      'turn.completed',
      'turn.completed',
      'turn.completed',
      'turn.completed',
      'turn.completed',
      'context.cleared',
      'session.restart_executed',
    ])
    const cleared = node.server.db.hrcEvents.listByKind('context.cleared', {
      hostSessionId: seat.hostSessionId,
    })[0]
    expect(cleared?.payload).toMatchObject({ reason: 'self-restart', dropContinuation: true })

    const executed = node.server.db.hrcEvents.listByKind('session.restart_executed', {
      hostSessionId: seat.hostSessionId,
    })[0]
    const nextHostSessionId = (executed?.payload as { nextHostSessionId: string }).nextHostSessionId
    expect(executed?.payload).toMatchObject({
      handoffId: 'H-00777',
      priorHostSessionId: seat.hostSessionId,
      priorGeneration: 3,
      nextGeneration: 4,
      delivery: { runId: 'run-t09872-successor' },
    })
    const successor = node.server.db.sessions.getByHostSessionId(nextHostSessionId)
    expect(successor?.generation).toBe(4)
    expect(successor?.continuation).toBeUndefined()
    expect(node.deliveries).toHaveLength(1)
    expect(node.deliveries[0]?.to).toEqual({
      kind: 'session',
      sessionRef: `${SCOPE}/lane:main`,
    })
    expect(node.deliveries[0]?.body).toBe(
      'Fresh context after self-restart (generation 3 → 4). Run `wrkq handoff get H-00777 --json`, absorb it, acknowledge it with `wrkq handoff acknowledge`, then continue the work it describes.'
    )

    // Claimed once: a duplicate projection of the same terminal does nothing.
    terminal(node, seat, { invocationId: INVOCATION, turnId: TURN })
    await settle()
    expect(node.deliveries).toHaveLength(1)
  })

  it('re-arming in the same turn replaces the handoff and keeps the binding', async () => {
    const node = await startNode('hrc-t09872-rearm-')
    const seat = launchSeat(node)
    await restartSelf(node, { handoffId: 'H-1' }, seatHeaders(node, seat.runtimeId))
    const second = await restartSelf(node, { handoffId: 'H-2' }, seatHeaders(node, seat.runtimeId))
    expect(second.body).toMatchObject({ handoffId: 'H-2', turnId: TURN, replaced: true })
    terminal(node, seat, { invocationId: INVOCATION, turnId: TURN })
    await settle()
    expect(node.deliveries[0]?.body).toContain('H-2')
  })

  it('--cancel disarms: the turn ends and nothing restarts', async () => {
    const node = await startNode('hrc-t09872-cancel-')
    const seat = launchSeat(node)
    await restartSelf(node, { handoffId: 'H-9' }, seatHeaders(node, seat.runtimeId))
    const cancelled = await restartSelf(node, { cancel: true }, seatHeaders(node, seat.runtimeId))
    expect(cancelled.body).toMatchObject({
      outcome: 'cancelled',
      cancelled: true,
      handoffId: 'H-9',
    })
    terminal(node, seat, { invocationId: INVOCATION, turnId: TURN })
    await settle()
    expect(kinds(node, seat.hostSessionId)).toEqual([
      'session.restart_armed',
      'session.restart_cancelled',
      'turn.completed',
    ])
    expect(node.deliveries).toEqual([])
  })
})
