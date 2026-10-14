import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { HrcServerInstance, createHrcServer } from '../index.js'
import type { HrcServer } from '../index.js'
import {
  PARTICIPANT_BROKER_GONE_REASON,
  settleParticipantBrokerLoss,
} from '../participant-broker-gone.js'
import { resolveParticipantDelivery } from '../participant-delivery.js'
import {
  type DirectJoinResult,
  registerDirectParticipant,
} from '../participant-host-registration.js'
import { createParticipantHostingIntent } from '../participant-hosting-intent.js'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture.js'
import { makeParticipantBrokerDescriptor } from './fixtures/participant-broker-descriptor.fixture.js'
import { type ServerLogCapture, captureServerLog } from './fixtures/server-log.js'

/**
 * T-10794: settling a participant-served broker loss (T-10333) terminated the
 * runtime but left the attempt ACTIVE, so the next boot's
 * `reconnectActivatedParticipants` redialled the dead host and ran a
 * reconnect cycle to exhaustion. The attempt now lands TERMINAL with the
 * runtime, and nothing on the next boot reaches for its socket.
 */
describe('T-10794 a settled participant broker loss settles the attempt too', () => {
  let fixture: HrcServerTestFixture
  let sockDir: string
  let servers: HrcServer[] = []
  let serverLog: ServerLogCapture

  beforeEach(async () => {
    fixture = await createHrcTestFixture('t10794-broker-gone-')
    // Unix socket paths are length-bounded; keep the endpoint short.
    sockDir = mkdtempSync(join(tmpdir(), 't10794-'))
    servers = []
    serverLog = captureServerLog({ passthrough: true })
  })

  afterEach(async () => {
    serverLog.restore()
    for (const server of servers) await server.stop()
    await fixture.cleanup()
    rmSync(sockDir, { recursive: true, force: true })
  })

  const scope = 'agent:foundry:project:hrc-runtime:task:T-10794-stop'
  const endpoint = () => join(sockDir, 'brk.sock')

  async function startServer(): Promise<HrcServerInstance> {
    const server = await createHrcServer(fixture.serverOpts({ otelListenerEnabled: false }))
    servers.push(server)
    if (!(server instanceof HrcServerInstance)) throw new Error('expected a real HRC server')
    return server
  }

  async function stopServer(server: HrcServer): Promise<void> {
    await server.stop()
    servers = servers.filter((s) => s !== server)
  }

  function identityOf(result: DirectJoinResult) {
    if (result.outcome !== 'registered') throw new Error(`refused: ${JSON.stringify(result)}`)
    return result.identity
  }

  /** What establishment leaves behind: prepared ACTIVE attempt, BOUND binding, ready runtime row. */
  async function establish(
    server: HrcServerInstance,
    identity: ReturnType<typeof identityOf>
  ): Promise<void> {
    const db = server.db
    const now = '2026-10-13T08:00:00.000Z'
    const registered = db.participantRegistrations.getAttempt(identity.attemptId)!
    const registration = db.participantRegistrations.getRegistrationById(registered.registrationId)!
    const descriptor = makeParticipantBrokerDescriptor({
      requestId: registered.requestId,
      operationId: registered.operationId,
      hostSessionId: identity.hostSessionId,
      generation: identity.generation,
      runtimeId: identity.runtimeId,
      invocationId: identity.invocationId,
      cwd: sockDir,
    })
    const intent = await createParticipantHostingIntent(
      server,
      registration,
      registered,
      descriptor
    )
    // A headless participant-served host realizes as its own external endpoint.
    const realized = {
      schemaVersion: 'participant-realized-hosting/v1',
      endpoint: intent.endpoint,
      substrate: { kind: 'external' },
      presentation: { kind: 'none' },
    }
    db.sqlite
      .query(
        `UPDATE participant_registration_attempts
            SET state = 'ACTIVE', broker_identity_json = ?, attach_socket_path = ?,
                initial_activation_confirmed_at = ?, establishment_work_state = 'completed',
                prepared_profile_json = ?, adapter_dispatch_env_json = 'null',
                hosting_intent_json = ?, realized_hosting_json = ?
          WHERE attempt_id = ?`
      )
      .run(
        JSON.stringify({ brokerInstanceId: `broker-${identity.attemptId}` }),
        endpoint(),
        now,
        JSON.stringify(descriptor),
        JSON.stringify(intent),
        JSON.stringify(realized),
        identity.attemptId
      )
    const attempt = db.participantRegistrations.getAttempt(identity.attemptId)!
    db.participantHostBindings.transitionBinding({
      bindingId: attempt.hostBindingId!,
      from: ['BINDING', 'DETACHED'],
      to: 'BOUND',
      now,
    })
    db.runtimes.insert({
      runtimeId: identity.runtimeId,
      hostSessionId: identity.hostSessionId,
      scopeRef: scope,
      laneRef: 'main',
      generation: identity.generation,
      transport: 'headless',
      harness: 'codex-cli',
      provider: 'openai',
      controllerKind: 'harness-broker',
      status: 'ready',
      activeOperationId: attempt.operationId,
      activeInvocationId: attempt.invocationId,
      runtimeStateJson: {
        lifecycleOwner: 'external',
        participantRegistration: {
          registrationId: attempt.registrationId,
          attemptId: attempt.attemptId,
          attachEpoch: attempt.attachEpoch,
        },
      },
      createdAt: now,
      updatedAt: now,
    } as never)
  }

  function logLines(event: string, attemptId: string): string[] {
    return serverLog
      .events(event)
      .map((line) => JSON.stringify(line))
      .filter((line) => line.includes(attemptId))
  }

  function deliveryFor(server: HrcServerInstance, hostSessionId: string) {
    const session = server.db.sessions.getByHostSessionId(hostSessionId)
    if (session === null) throw new Error(`no session ${hostSessionId}`)
    return resolveParticipantDelivery(server, session)
  }

  test('clean stop: attempt TERMINAL, next boot never redials, delivery refuses absorbing', async () => {
    const first = await startServer()
    // The host has exited: its broker socket has no listener.
    first.brokerUnixClientFactory = async () => {
      throw Object.assign(new Error('Failed to connect to broker unix socket'), {
        causeError: Object.assign(new Error('connect refused'), { code: 'ECONNREFUSED' }),
      })
    }
    const identity = identityOf(
      await registerDirectParticipant(first, {
        requestedSessionRef: scope,
        laneRef: 'main',
        hostIncarnationId: 'host-a',
        socketPath: endpoint(),
      })
    )
    await establish(first, identity)

    expect(
      await settleParticipantBrokerLoss(first, {
        runtimeId: identity.runtimeId,
        invocationId: identity.invocationId,
        code: 'broker_process_closed',
      })
    ).toBe('terminated')

    // Gate 1a: the attempt reaches the runtime's conclusion in the same write.
    expect(first.db.participantRegistrations.getAttempt(identity.attemptId)).toMatchObject({
      state: 'TERMINAL',
      dispositionReason: PARTICIPANT_BROKER_GONE_REASON,
    })
    expect(first.db.runtimes.getByRuntimeId(identity.runtimeId)).toMatchObject({
      status: 'terminated',
      lifecycleTerminalReason: PARTICIPANT_BROKER_GONE_REASON,
    })
    const terminatedLine = logLines('participant.broker_lost.terminated', identity.attemptId)
    expect(terminatedLine).toHaveLength(1)
    expect(terminatedLine[0]).toContain('"attemptState":"TERMINAL"')

    // Gate 3 on the live server: the dead seat is absorbing, not a reconnect.
    expect(deliveryFor(first, identity.hostSessionId)).toMatchObject({
      outcome: 'refused',
      kind: 'unavailable',
      reason: 'participant_attempt_absorbing',
    })

    await stopServer(first)

    // Something now listens at the dead endpoint and counts every dial, so a
    // redial is observable whichever client the boot path chooses.
    let dials = 0
    const listener = Bun.listen({
      unix: endpoint(),
      socket: {
        open(socket) {
          dials += 1
          socket.terminate()
        },
        data() {},
      },
    })
    try {
      const second = await startServer()
      // Give any establishment cycle boot scheduled time to run (none is
      // expected). Bounded: with the fix reverted, a cycle dialling a socket
      // that accepts never settles, and the assertions below should still
      // report what it did.
      const deadline = Date.now() + 4_000
      while (second.participantEstablishmentOperations.size > 0 && Date.now() < deadline) {
        await Promise.race([
          Promise.all([...second.participantEstablishmentOperations.values()]),
          new Promise((resolve) => setTimeout(resolve, deadline - Date.now())),
        ])
      }

      // Gate 1b: the second boot never selected the attempt or dialled its socket.
      expect(logLines('participant.reconnect.boot', identity.attemptId)).toHaveLength(0)
      expect(logLines('participant.establishment.pending', identity.attemptId)).toHaveLength(0)
      expect(dials).toBe(0)
      expect(second.db.participantRegistrations.getAttempt(identity.attemptId)).toMatchObject({
        state: 'TERMINAL',
        dispositionReason: PARTICIPANT_BROKER_GONE_REASON,
        establishmentWorkState: 'completed',
      })

      // Gate 3 across the restart: still absorbing, never reconnect_exhausted.
      expect(deliveryFor(second, identity.hostSessionId)).toMatchObject({
        outcome: 'refused',
        kind: 'unavailable',
        reason: 'participant_attempt_absorbing',
      })
    } finally {
      listener.stop(true)
    }
  })

  test('a respawn after the settled loss succeeds from the TERMINAL predecessor', async () => {
    const server = await startServer()
    server.brokerUnixClientFactory = async () => {
      throw Object.assign(new Error('Failed to connect to broker unix socket'), {
        causeError: Object.assign(new Error('connect refused'), { code: 'ECONNREFUSED' }),
      })
    }
    const first = identityOf(
      await registerDirectParticipant(server, {
        requestedSessionRef: scope,
        laneRef: 'main',
        hostIncarnationId: 'host-a',
        socketPath: endpoint(),
      })
    )
    await establish(server, first)
    expect(
      await settleParticipantBrokerLoss(server, {
        runtimeId: first.runtimeId,
        invocationId: first.invocationId,
        code: 'broker_process_closed',
      })
    ).toBe('terminated')

    const respawn = identityOf(
      await registerDirectParticipant(server, {
        requestedSessionRef: scope,
        laneRef: 'main',
        hostIncarnationId: 'host-a',
        socketPath: endpoint(),
        expectedPredecessor: {
          hostIncarnationId: 'host-a',
          runtimeId: first.runtimeId,
          generation: first.generation,
        },
      })
    )
    expect(respawn.runtimeId).not.toBe(first.runtimeId)
    expect(respawn.generation).toBe(first.generation + 1)
    // Succession absorbed the TERMINAL predecessor as-is rather than
    // re-disposing it ABANDONED.
    expect(server.db.participantRegistrations.getAttempt(first.attemptId)).toMatchObject({
      state: 'TERMINAL',
      dispositionReason: PARTICIPANT_BROKER_GONE_REASON,
    })
  })
})
