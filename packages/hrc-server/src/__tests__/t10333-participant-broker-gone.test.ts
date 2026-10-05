/**
 * T-10333 — a participant-served runtime whose broker is gone leaves `ready`;
 * a desktop observer whose broker is gone does not.
 *
 * Both rows below are `lifecycleOwner: 'external'`, so the controller's crash
 * path treats them identically (records `observerAttachment: detached`). What
 * separates them is the participant registration: only a `participant-served`
 * one, confirmed dead by a fresh dial, may assert that the subject died.
 */

import { describe, expect, test } from 'bun:test'

import type { HrcEventEnvelope, HrcLifecycleEvent } from 'hrc-core'
import { openHrcDatabase } from 'hrc-store-sqlite'
import type { HrcDatabase } from 'hrc-store-sqlite'
import type { BrokerHelloResponse } from 'spaces-harness-broker-protocol'

import { BrokerControllerError } from '../broker/controller/errors'
import { markBrokerCrashTerminal } from '../broker/controller/lifecycle'
import type { LifecycleContext } from '../broker/controller/lifecycle'
import type { DurableBrokerClientLike } from '../broker/controller/types'
import {
  PARTICIPANT_BROKER_GONE_REASON,
  type ParticipantBrokerLossOutcome,
  settleParticipantBrokerLoss,
} from '../participant-broker-gone'
import type { HrcServerInstanceForHandlers } from '../server-instance-context'

const SCOPE = 'agent:arris:project:arris:task:T-10333'
const NOW = '2026-10-05T00:00:00.000Z'
const RUNTIME = 'rt-t10333'
const INVOCATION = 'inv-t10333'
const RUN = 'run-t10333'
const SOCKET = '/tmp/t10333-no-such-dir/broker.sock'

type Dial = 'dead' | 'live'

function seed(options: { participantServed: boolean; status?: 'ready' | 'busy' }): HrcDatabase {
  const db = openHrcDatabase(':memory:')
  db.sessions.insert({
    hostSessionId: 'hsid-t10333',
    scopeRef: SCOPE,
    laneRef: 'main',
    generation: 1,
    status: 'active',
    createdAt: NOW,
    updatedAt: NOW,
  } as never)
  if (options.participantServed) {
    db.participantHostBindings.insertReservation({
      reservationId: 'resv-t10333',
      scopeRef: SCOPE,
      laneRef: 'main',
      homeNodeId: 'local',
      state: 'held',
      createdAt: NOW,
      updatedAt: NOW,
    })
    db.participantRegistrations.insertRegistration({
      registrationId: 'preg-t10333',
      join: 'participant-served',
      scopeRef: SCOPE,
      laneRef: 'main',
      hostSessionId: 'hsid-t10333',
      generation: 1,
      socketPath: SOCKET,
      policy: {
        addressPolicy: 'selected-scope',
        continuityPolicy: 'host-incarnation',
        lifecycleOwner: 'externally-owned',
        replaySemantics: 'full-source-replay',
      },
      hostIncarnationId: 'host-incarnation:t10333',
      createdAt: NOW,
      updatedAt: NOW,
    } as never)
    db.participantHostBindings.insertBinding({
      bindingId: 'bind-t10333',
      reservationId: 'resv-t10333',
      registrationId: 'preg-t10333',
      hostIncarnationId: 'host-incarnation:t10333',
      hostSessionId: 'hsid-t10333',
      generation: 1,
      runtimeId: RUNTIME,
      state: 'BOUND',
      admittedAt: NOW,
      updatedAt: NOW,
    } as never)
    db.participantRegistrations.insertAttempt({
      attemptId: 'patt-t10333',
      registrationId: 'preg-t10333',
      attachEpoch: 1,
      requestId: 'req-t10333',
      operationId: 'op-t10333',
      invocationId: INVOCATION,
      runtimeId: RUNTIME,
      hostBindingId: 'bind-t10333',
      state: 'ACTIVE',
      preparedDescriptorJson: '{"kind":"participant-broker-descriptor/v1"}',
      adapterDispatchEnvJson: '{}',
      attachSocketPath: SOCKET,
      recoveryDisposition: 'unresolved',
      establishmentWorkState: 'completed',
      establishmentAttemptCount: 0,
      createdAt: NOW,
      updatedAt: NOW,
    } as never)
  }
  db.runtimes.insert({
    runtimeId: RUNTIME,
    hostSessionId: 'hsid-t10333',
    scopeRef: SCOPE,
    laneRef: 'main',
    generation: 1,
    transport: 'headless',
    harness: 'codex-cli',
    provider: 'openai',
    controllerKind: 'harness-broker',
    status: options.status ?? 'ready',
    activeInvocationId: INVOCATION,
    runtimeStateJson: { lifecycleOwner: 'external', control: { brokerAttached: true } },
    createdAt: NOW,
    updatedAt: NOW,
  } as never)
  if (options.status === 'busy') {
    db.runs.insert({
      runId: RUN,
      hostSessionId: 'hsid-t10333',
      runtimeId: RUNTIME,
      scopeRef: SCOPE,
      laneRef: 'main',
      generation: 1,
      transport: 'headless',
      status: 'running',
      acceptedAt: NOW,
      startedAt: NOW,
      updatedAt: NOW,
    } as never)
  }
  return db
}

function fakeServer(
  db: HrcDatabase,
  dial: Dial,
  onDial: () => void = () => {}
): { server: HrcServerInstanceForHandlers; notified: HrcLifecycleEvent[] } {
  const notified: HrcLifecycleEvent[] = []
  // The probe opens a connection, says hello and closes: those two calls are
  // the whole surface it reaches on the client.
  const liveClient = {
    hello: async (): Promise<BrokerHelloResponse> => ({
      brokerInfo: { name: 'harness-broker', version: '0.0.0-t10333' },
      protocolVersion: 'harness-broker/0.2',
      capabilities: {
        multiInvocation: false,
        transports: ['unix-jsonrpc-ndjson'],
        eventNotifications: true,
        brokerToClientRequests: true,
      },
      drivers: [],
    }),
    close: async () => {},
  } satisfies Pick<DurableBrokerClientLike, 'hello' | 'close'>
  // Exactly the server seams settleParticipantBrokerLoss and the transport
  // probe read, each checked against the production instance type.
  const seams = {
    db,
    stopping: false,
    notifyEvent: (event: HrcEventEnvelope | HrcLifecycleEvent) => {
      notified.push(event as HrcLifecycleEvent)
    },
    brokerUnixClientFactory: async () => {
      onDial()
      if (dial === 'dead') {
        // The shape the real unix transport rejects with when nothing listens.
        const error = new Error('Failed to connect to broker unix socket') as Error & {
          causeError: unknown
        }
        error.causeError = Object.assign(new Error('connect ECONNREFUSED'), {
          code: 'ECONNREFUSED',
        })
        throw error
      }
      return liveClient as unknown as DurableBrokerClientLike
    },
  } satisfies Pick<
    HrcServerInstanceForHandlers,
    'db' | 'stopping' | 'notifyEvent' | 'brokerUnixClientFactory'
  >
  return { server: seams as unknown as HrcServerInstanceForHandlers, notified }
}

/**
 * Drive the REAL crash path with the server's hook attached, exactly as
 * production wires it, and wait for the asynchronous settle.
 */
async function crash(
  db: HrcDatabase,
  server: HrcServerInstanceForHandlers
): Promise<ParticipantBrokerLossOutcome | undefined> {
  let settled: Promise<ParticipantBrokerLossOutcome> | undefined
  const ctx: LifecycleContext = {
    db,
    now: () => NOW,
    serverInstanceId: 'srv-t10333',
    logger: {},
    getActiveInvocationId: () => undefined,
    getActiveClient: () => undefined,
    deleteActive: () => {},
    markBrokerClosing: () => {},
    intentionalCloseReason: () => undefined,
    fireBrokerTmuxLeaseReap: () => {},
    onExternalBrokerLost: (input) => {
      settled = settleParticipantBrokerLoss(server, input)
    },
  }
  markBrokerCrashTerminal(
    ctx,
    RUNTIME,
    new BrokerControllerError('broker_process_closed', 'Broker socket closed unexpectedly', {})
  )
  return settled === undefined ? undefined : await settled
}

describe('T-10333 participant-served broker loss', () => {
  test('desktop observer (no participant registration) keeps its status after a broker crash', async () => {
    const db = seed({ participantServed: false })
    let dialed = 0
    const { server, notified } = fakeServer(db, 'dead', () => dialed++)

    expect(await crash(db, server)).toBe('observer_only')

    const row = db.runtimes.getByRuntimeId(RUNTIME)!
    expect(row.status).toBe('ready')
    expect(row.activeInvocationId).toBe(INVOCATION)
    expect(row.lifecycleTerminalReason).toBeUndefined()
    expect(row.runtimeStateJson?.['observerAttachment']).toMatchObject({
      state: 'detached',
      reason: 'broker_crash',
    })
    // An observer's subject is never dialed: there is nothing of HRC's to ask.
    expect(dialed).toBe(0)
    expect(notified).toHaveLength(0)
  })

  test('participant-served host whose serving socket has no listener leaves ready', async () => {
    const db = seed({ participantServed: true })
    const { server, notified } = fakeServer(db, 'dead')

    expect(await crash(db, server)).toBe('terminated')

    const row = db.runtimes.getByRuntimeId(RUNTIME)!
    expect(row.status).toBe('terminated')
    expect(row.lifecycleTerminalReason).toBe(PARTICIPANT_BROKER_GONE_REASON)
    expect(row.activeInvocationId).toBeUndefined()
    expect(row.runtimeStateJson?.['terminalReason']).toBe(PARTICIPANT_BROKER_GONE_REASON)
    expect(notified).toHaveLength(1)
    expect(notified[0]).toMatchObject({
      eventKind: 'runtime.terminated',
      runtimeId: RUNTIME,
    })
  })

  test('a mid-turn participant-served loss fails the open run too', async () => {
    const db = seed({ participantServed: true, status: 'busy' })
    const { server } = fakeServer(db, 'dead')

    expect(await crash(db, server)).toBe('terminated')

    expect(db.runtimes.getByRuntimeId(RUNTIME)!.status).toBe('terminated')
    const run = db.runs.getByRunId(RUN)!
    expect(run.status).toBe('failed')
    expect(run.completedAt).toBeDefined()
  })

  test('participant-served host whose socket still answers hello stays ready', async () => {
    const db = seed({ participantServed: true })
    const { server, notified } = fakeServer(db, 'live')

    expect(await crash(db, server)).toBe('live')

    const row = db.runtimes.getByRuntimeId(RUNTIME)!
    expect(row.status).toBe('ready')
    expect(row.activeInvocationId).toBe(INVOCATION)
    expect(notified).toHaveLength(0)
  })

  test('a row moved on while the dial was in flight is left alone', async () => {
    const db = seed({ participantServed: true })
    const { server, notified } = fakeServer(db, 'dead', () => {
      db.runtimes.update(RUNTIME, { activeInvocationId: 'inv-successor', updatedAt: NOW })
    })

    expect(await crash(db, server)).toBe('superseded')

    const row = db.runtimes.getByRuntimeId(RUNTIME)!
    expect(row.status).toBe('ready')
    expect(row.activeInvocationId).toBe('inv-successor')
    expect(notified).toHaveLength(0)
  })
})
