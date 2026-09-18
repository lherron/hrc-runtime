import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, expect, test } from 'bun:test'

import { createControlledParticipantAdapter } from 'agent-spaces/testing'
import {
  type ParticipantAttempt,
  type ParticipantRegistration,
  openHrcDatabase,
} from 'hrc-store-sqlite'
import type { BrokerExecutionProfile } from 'spaces-runtime-contracts'

import { HarnessBrokerController } from '../broker/controller.js'
import {
  assertPriorParticipantRecoveryDisposition,
  ensureAndStageParticipantAttach,
  recoverParticipantEstablishmentWork,
  scheduleParticipantEstablishment,
} from '../participant-establishment.js'
import { createParticipantHostingIntent } from '../participant-hosting-intent.js'
import { realizeAndFreezeParticipantDispatch } from '../participant-realization.js'
import type { HrcServerInstanceForHandlers } from '../server-instance-context.js'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})

type Window = {
  socketPath: string
  sessionName: string
  windowName: string
  sessionId: string
  windowId: string
  paneId: string
}

function fakeTmux() {
  const windows = new Map<string, Window>()
  const processes = new Map<
    string,
    { command: string; pid: number; dead: boolean; commandLine?: string }
  >()
  const createCommands: string[] = []
  let nextBrokerCommandLine: string | undefined
  let next = 1
  const key = (sessionName: string, windowName: string) => `${sessionName}:${windowName}`
  const makeWindow = (socketPath: string, sessionName: string, windowName: string): Window => {
    const created: Window = {
      socketPath,
      sessionName,
      windowName,
      sessionId: `$${next}`,
      windowId: `@${next}`,
      paneId: `%${next}`,
    }
    next += 1
    windows.set(key(sessionName, windowName), created)
    return created
  }
  return {
    createCommands,
    setNextBrokerCommandLine: (commandLine: string) => {
      nextBrokerCommandLine = commandLine
    },
    seedWindow: (
      socketPath: string,
      sessionName: string,
      windowName: string,
      process: { command: string; pid: number; dead: boolean; commandLine?: string }
    ) => {
      const window = makeWindow(socketPath, sessionName, windowName)
      processes.set(window.paneId, process)
      return window
    },
    manager: (opts: { socketPath: string }) => ({
      initialize: async () => undefined,
      inspectWindow: async (input: { sessionName: string; windowName: string }) =>
        windows.get(key(input.sessionName, input.windowName)) ?? null,
      createWindowWithCommand: async (input: {
        sessionName: string
        windowName: string
        command: string
      }) => {
        createCommands.push(input.command)
        const window = makeWindow(opts.socketPath, input.sessionName, input.windowName)
        processes.set(window.paneId, {
          command: 'bun',
          pid: 83_349,
          dead: false,
          commandLine: nextBrokerCommandLine,
        })
        return window
      },
      createOrInspectWindow: async (input: { sessionName: string; windowName: string }) => {
        const existing = windows.get(key(input.sessionName, input.windowName))
        return existing ?? makeWindow(opts.socketPath, input.sessionName, input.windowName)
      },
      inspectPaneProcess: async (paneId: string) => processes.get(paneId) ?? null,
    }),
  }
}

function registration(): ParticipantRegistration {
  return {
    registrationId: 'registration-participant-served',
    registrationMode: 'legacy',
    classId: 'class-participant-served',
    adapterId: 'controlled-participant',
    join: 'participant-served',
    participantKey: 'key-participant-served',
    scopeRef: 'agent:larry:project:hrc-runtime:task:participant-realization-served',
    laneRef: 'main',
    hostSessionId: 'hsid-participant-realization',
    generation: 1,
    workspaceCwd: '/tmp/participant-workspace',
    socketPath: '/tmp/served.sock',
    preparationJson: '{}',
    createdAt: '2026-09-09T22:30:00.000Z',
    updatedAt: '2026-09-09T22:30:00.000Z',
  }
}

function attempt(registrationId: string, runtimeId: string): ParticipantAttempt {
  return {
    attemptId: `attempt-${runtimeId}`,
    registrationId,
    attachEpoch: 1,
    requestId: `req-${runtimeId}`,
    operationId: `op-${runtimeId}`,
    invocationId: `inv-${runtimeId}`,
    runtimeId,
    state: 'HOSTING_INTENT_PERSISTED',
    recoveryDisposition: 'unresolved',
    establishmentWorkState: 'pending',
    establishmentAttemptCount: 0,
    createdAt: '2026-09-09T22:30:00.000Z',
    updatedAt: '2026-09-09T22:30:00.000Z',
  }
}

async function profileFor(input: ParticipantAttempt): Promise<BrokerExecutionProfile> {
  const adapter = createControlledParticipantAdapter({
    adapterId: 'controlled-participant',
    workspaceCwd: '/tmp/participant-workspace',
    driver: 'noop-driver',
  })
  const prepared = await adapter.prepare({
    classId: 'class-participant-served',
    join: 'participant-served',
    participantKey: 'key-participant-served',
    workspaceCwd: '/tmp/participant-workspace',
    preparation: {},
    identity: {
      requestId: input.requestId,
      operationId: input.operationId,
      hostSessionId: 'hsid-participant-realization',
      generation: 1,
      runtimeId: input.runtimeId,
      invocationId: input.invocationId,
    },
    scopeRef: 'agent:larry:project:hrc-runtime:task:participant-realization',
    laneRef: 'main',
    attachEpoch: 1,
  })
  if (prepared.status !== 'prepared') throw new Error('controlled profile was not prepared')
  return prepared.profile
}

test('persists actual HRC leases then freezes the unchanged start request before any ensure', async () => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), 't08349-realization-'))
  temporaryRoots.push(runtimeRoot)
  const db = openHrcDatabase(':memory:')
  const tmux = fakeTmux()
  const installedIdentities: unknown[] = []
  const helloRequests: unknown[] = []
  const brokerInstanceId = 'broker-instance-1'
  const server = {
    options: { runtimeRoot },
    db,
    generateBrokerAttachToken: () => 'realization-token',
    brokerTmuxManagerFactory: tmux.manager,
    brokerUnixClientFactory: async () =>
      ({
        installIdentity: async (identity: {
          runtimeId: string
          hostSessionId: string
          generation: number
          attachEpoch: number
          invocationId: string
        }) => {
          installedIdentities.push(identity)
          return {
            installed: true as const,
            brokerInstanceId,
            runtimeId: identity.runtimeId,
            hostSessionId: identity.hostSessionId,
            generation: identity.generation,
            attachEpoch: identity.attachEpoch,
            invocationId: identity.invocationId,
            installedAt: '2026-09-09T23:30:00.000Z',
          }
        },
        hello: async (request: unknown) => {
          helloRequests.push(request)
          return {}
        },
        ensureInvocation: async (request: {
          startAttemptId: string
          invocationId: string
          attachEpoch: number
        }) => ({
          receipt: {
            startAttemptId: request.startAttemptId,
            invocationId: request.invocationId,
            attachEpoch: request.attachEpoch,
            state: 'started' as const,
            requestDigest: 'ensure-digest',
            brokerInstanceId,
            updatedAt: '2026-09-09T23:30:01.000Z',
          },
        }),
        close: async () => undefined,
      }) as never,
  } as unknown as HrcServerInstanceForHandlers
  try {
    const servedRegistration = registration()
    const servedAttempt = attempt(servedRegistration.registrationId, 'rt-served')
    const preparedServed = await profileFor(servedAttempt)
    const servedProfile: BrokerExecutionProfile = {
      ...preparedServed,
      interactionMode: 'interactive',
      brokerTerminal: {
        host: 'tmux',
        startupMethod: 'create-terminal',
        turnDelivery: 'terminal-literal-input',
        operatorAttach: true,
        exposurePolicy: { mode: 'broker-reports-target', targetKind: 'tmux-session' },
      },
    }
    const servedIntent = await createParticipantHostingIntent(
      server,
      servedRegistration,
      servedAttempt,
      servedProfile
    )
    db.participantRegistrations.insertRegistration(servedRegistration)
    db.participantRegistrations.insertAttempt({
      ...servedAttempt,
      preparedProfileJson: JSON.stringify(servedProfile),
      adapterDispatchEnvJson: 'null',
      hostingIntentJson: JSON.stringify(servedIntent),
    })
    const frozenServed = await realizeAndFreezeParticipantDispatch(
      server,
      servedRegistration,
      servedAttempt
    )
    const dispatchServed = JSON.parse(frozenServed.dispatchJson ?? '{}')
    expect(frozenServed).toMatchObject({ state: 'DISPATCH_FROZEN' })
    expect(dispatchServed.runtime).toMatchObject({
      terminalSurface: { kind: 'tmux-pane', ownership: 'hrc', paneId: expect.any(String) },
      terminalSurfaceRequired: true,
    })
    expect(tmux.createCommands).toHaveLength(0)
  } finally {
    db.close()
  }
})

test('retries replay failure after activation CAS without reclassification or destructive lifecycle', async () => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), 't08349-stage-'))
  temporaryRoots.push(runtimeRoot)
  const db = openHrcDatabase(':memory:')
  const tmux = fakeTmux()
  let attachCalls = 0
  let replayCalls = 0
  let ackCalls = 0
  let failReplayAfterActivationOnce = true
  const brokerUnixClientFactory = async () =>
    ({
      installIdentity: async (identity: {
        runtimeId: string
        hostSessionId: string
        generation: number
        attachEpoch: number
        invocationId: string
      }) => ({
        installed: true as const,
        brokerInstanceId: 'broker-stage-1',
        runtimeId: identity.runtimeId,
        hostSessionId: identity.hostSessionId,
        generation: identity.generation,
        attachEpoch: identity.attachEpoch,
        invocationId: identity.invocationId,
        installedAt: '2026-09-09T23:40:00.000Z',
      }),
      hello: async () => ({
        protocolVersion: 'harness-broker/0.2' as const,
        capabilities: {},
        drivers: [],
      }),
      ensureInvocation: async (request: {
        startAttemptId: string
        invocationId: string
        attachEpoch: number
      }) => ({
        receipt: {
          startAttemptId: request.startAttemptId,
          invocationId: request.invocationId,
          attachEpoch: request.attachEpoch,
          state: 'started' as const,
          requestDigest: 'ensure-stage-digest',
          brokerInstanceId: 'broker-stage-1',
          updatedAt: '2026-09-09T23:40:01.000Z',
        },
      }),
      attach: async (request: { runtimeId: string; generation: number; invocationId: string }) => {
        attachCalls += 1
        return {
          attached: true as const,
          brokerInstanceId: 'broker-stage-1',
          runtimeId: request.runtimeId,
          generation: request.generation,
          invocationId: request.invocationId,
          activeControllerInstanceId: 'participant-stage-controller',
          currentSeq: 3,
          retentionFloorSeq: 1,
          snapshot: {
            invocationId: request.invocationId,
            state: 'ready',
            capabilities: {},
            pendingInputIds: [],
            inputDispositions: {},
            pendingPermissionRequests: [],
            seat: { state: 'available' },
            brokerQueue: [],
            turnManifests: [],
            currentSeq: 3,
            retentionFloorSeq: 1,
          },
        }
      },
      snapshot: async (request: { invocationId: string }) => ({
        invocationId: request.invocationId,
        state: 'ready',
        capabilities: {},
        pendingInputIds: [],
        inputDispositions: {},
        pendingPermissionRequests: [],
        seat: { state: 'available' },
        brokerQueue: [],
        turnManifests: [],
        currentSeq: 3,
        retentionFloorSeq: 1,
      }),
      health: async () => ({ status: 'ok' as const }),
      status: async (request: { invocationId: string }) => ({
        invocationId: request.invocationId,
        state: 'ready',
      }),
      eventsSince: async () => {
        replayCalls += 1
        if (failReplayAfterActivationOnce) {
          failReplayAfterActivationOnce = false
          throw new Error('injected replay failure after activation CAS')
        }
        return { events: [], currentSeq: 3, retentionFloorSeq: 1 }
      },
      ackEvents: async () => {
        ackCalls += 1
        throw new Error('staging must not ACK')
      },
      permissionRespond: async () => ({ status: 'unknown' as const, permissionRequestId: 'none' }),
      onClose: () => undefined,
      close: async () => undefined,
    }) as never
  const controller = new HarnessBrokerController({
    db,
    brokerUnixClientFactory,
    serverInstanceId: 'participant-stage-controller',
  })
  const server = {
    options: { runtimeRoot },
    db,
    generateBrokerAttachToken: () => 'stage-token',
    brokerTmuxManagerFactory: tmux.manager,
    brokerUnixClientFactory,
    harnessBrokerController: controller,
    ctx: { notifyEvent: () => undefined },
    participantEstablishmentOperations: new Map<string, Promise<void>>(),
    stopping: false,
  } as unknown as HrcServerInstanceForHandlers
  try {
    const stagedRegistration = registration()
    const stagedAttempt = {
      ...attempt(stagedRegistration.registrationId, 'rt-stage'),
      activationClassification: 'resume' as const,
    }
    const stagedProfile = await profileFor(stagedAttempt)
    const stagedIntent = await createParticipantHostingIntent(
      server,
      stagedRegistration,
      stagedAttempt,
      stagedProfile
    )
    db.sessions.insert({
      hostSessionId: stagedRegistration.hostSessionId,
      scopeRef: stagedRegistration.scopeRef,
      laneRef: stagedRegistration.laneRef,
      generation: stagedRegistration.generation,
      status: 'active',
      createdAt: stagedRegistration.createdAt,
      updatedAt: stagedRegistration.updatedAt,
      parsedScopeJson: {},
      ancestorScopeRefs: [],
    })
    db.participantRegistrations.insertRegistration(stagedRegistration)
    db.participantRegistrations.insertAttempt({
      ...stagedAttempt,
      preparedProfileJson: JSON.stringify(stagedProfile),
      adapterDispatchEnvJson: 'null',
      hostingIntentJson: JSON.stringify(stagedIntent),
    })

    const staged = await ensureAndStageParticipantAttach(server, stagedRegistration, stagedAttempt)

    expect(staged).toMatchObject({ state: 'ATTACH_CONFIRMED' })
    expect(attachCalls).toBe(1)
    expect(replayCalls).toBe(0)
    expect(ackCalls).toBe(0)
    expect(db.runtimes.getByRuntimeId(stagedAttempt.runtimeId)).toMatchObject({
      activeOperationId: stagedAttempt.operationId,
      activeInvocationId: stagedAttempt.invocationId,
      status: 'starting',
      runtimeStateJson: {
        lifecycleOwner: 'external',
        control: { brokerAttached: false },
      },
    })
    expect(db.runtimeOperations.getByOperationId(stagedAttempt.operationId)).toMatchObject({
      startupMethod: 'broker.ensureInvocation',
      selectedProfileHash: stagedProfile.profileHash,
    })
    expect(db.brokerInvocations.getByInvocationId(stagedAttempt.invocationId)).toMatchObject({
      invocationState: 'ready',
      lastProjectedSeq: 0,
      startRequestHash: stagedProfile.harnessInvocation.startRequestHash,
    })

    // Losing an unactivated candidate leaves the durable attempt staged. Its
    // next callback must reconnect that same attempt instead of rerunning
    // ensure or trying to release a missing candidate.
    const legacyRuntime = db.runtimes.getByRuntimeId(stagedAttempt.runtimeId)
    if (legacyRuntime === null) throw new Error('expected participant runtime bookkeeping')
    const legacyRuntimeState = Object.fromEntries(
      Object.entries(legacyRuntime.runtimeStateJson ?? {}).filter(
        ([key]) => key !== 'lifecycleOwner'
      )
    )
    db.runtimes.update(stagedAttempt.runtimeId, {
      runtimeStateJson: legacyRuntimeState,
      updatedAt: '2026-09-15T14:30:00.000Z',
    })
    await controller.discardStagedParticipantAttach(stagedAttempt.attemptId)
    scheduleParticipantEstablishment(server, stagedRegistration, staged)
    const failedActivation = server.participantEstablishmentOperations.get(stagedAttempt.attemptId)
    await failedActivation
    const retrying = db.participantRegistrations.getAttempt(stagedAttempt.attemptId)
    expect(retrying).toMatchObject({
      state: 'ACTIVE',
      initialActivationConfirmedAt: expect.any(String),
      establishmentWorkState: 'retry_wait',
      establishmentAttemptCount: 1,
    })
    expect(db.participantRegistrations.listEstablishmentWork()).toContainEqual(retrying)
    expect(db.runtimes.getByRuntimeId(stagedAttempt.runtimeId)).toMatchObject({
      status: expect.not.stringMatching(/^(stale|terminated)$/),
      runtimeStateJson: {
        lifecycleOwner: 'external',
        control: { brokerAttached: false },
      },
    })

    const retry = server.participantEstablishmentOperations.get(stagedAttempt.attemptId)
    expect(retry).toBeDefined()
    await retry
    expect(db.participantRegistrations.getAttempt(stagedAttempt.attemptId)).toMatchObject({
      state: 'ACTIVE',
      initialActivationConfirmedAt: expect.any(String),
      establishmentWorkState: 'completed',
      establishmentAttemptCount: 1,
    })
    expect(attachCalls).toBe(5)
    expect(replayCalls).toBe(2)
    expect(ackCalls).toBe(0)
    expect(db.runtimes.getByRuntimeId(stagedAttempt.runtimeId)?.runtimeStateJson).toMatchObject({
      participantActivation: {
        attemptId: stagedAttempt.attemptId,
        attachEpoch: stagedAttempt.attachEpoch,
        classification: 'resume',
      },
    })
    expect(
      db.hrcEvents
        .listByKind('runtime.ensured')
        .filter(
          (event) =>
            event.runtimeId === stagedAttempt.runtimeId &&
            event.payload?.['source'] === 'participant-activation'
        )
    ).toHaveLength(1)

    // An ordinary retry in the owning controller is a no-op: no extra attach
    // and, critically, no activation attempt without a staged candidate.
    scheduleParticipantEstablishment(
      server,
      stagedRegistration,
      db.participantRegistrations.getAttempt(stagedAttempt.attemptId) ?? stagedAttempt
    )
    await server.participantEstablishmentOperations.get(stagedAttempt.attemptId)
    expect(attachCalls).toBe(5)
    expect(replayCalls).toBe(2)
  } finally {
    controller.shutdown()
    db.close()
  }
})

test('holds successor replay until prior recovery has an independent durable disposition', () => {
  const db = openHrcDatabase(':memory:')
  try {
    const durableRegistration = registration()
    db.participantRegistrations.insertRegistration(durableRegistration)
    const prior = {
      ...attempt(durableRegistration.registrationId, 'rt-prior-recovery'),
      state: 'TERMINAL' as const,
      dispositionReason: 'producer-authored-terminal-projected',
    }
    const successor = {
      ...attempt(durableRegistration.registrationId, 'rt-successor-recovery'),
      attemptId: 'attempt-successor-recovery',
      attachEpoch: 2,
      state: 'ATTACH_CONFIRMED' as const,
    }
    db.participantRegistrations.insertAttempt(prior)
    db.participantRegistrations.insertAttempt(successor)
    const server = { db } as unknown as HrcServerInstanceForHandlers

    expect(() => assertPriorParticipantRecoveryDisposition(server, successor)).toThrow(
      'participant prior-invocation recovery disposition is unresolved'
    )
    expect(
      db.participantRegistrations.recordRecoveryDisposition(
        prior.attemptId,
        'reconciled',
        'validated immutable prior ledger snapshot',
        '2026-09-15T14:00:00.000Z'
      )
    ).toBe(true)
    expect(() => assertPriorParticipantRecoveryDisposition(server, successor)).not.toThrow()
  } finally {
    db.close()
  }
})

test('startup recovery discovers durable work without another participant callback', async () => {
  const db = openHrcDatabase(':memory:')
  try {
    const durableRegistration = registration()
    const activeAttempt = {
      ...attempt(durableRegistration.registrationId, 'rt-boot-recovery'),
      state: 'ACTIVE' as const,
      initialActivationConfirmedAt: '2026-09-15T14:10:00.000Z',
    }
    db.participantRegistrations.insertRegistration(durableRegistration)
    db.participantRegistrations.insertAttempt(activeAttempt)
    const server = {
      db,
      stopping: false,
      participantEstablishmentOperations: new Map<string, Promise<void>>(),
      harnessBrokerController: {
        activeClientInvocationId: () => activeAttempt.invocationId,
      },
    } as unknown as HrcServerInstanceForHandlers

    recoverParticipantEstablishmentWork(server)
    await server.participantEstablishmentOperations.get(activeAttempt.attemptId)
    expect(db.participantRegistrations.getAttempt(activeAttempt.attemptId)).toMatchObject({
      state: 'ACTIVE',
      establishmentWorkState: 'completed',
      establishmentAttemptCount: 0,
    })
  } finally {
    db.close()
  }
})

test('startup recovery fences durable work from an older attempt epoch', async () => {
  const db = openHrcDatabase(':memory:')
  try {
    const durableRegistration = registration()
    const stale = {
      ...attempt(durableRegistration.registrationId, 'rt-stale-work'),
      state: 'DETACHED' as const,
    }
    const current = {
      ...attempt(durableRegistration.registrationId, 'rt-current-work'),
      attemptId: 'attempt-current-work',
      attachEpoch: 2,
      state: 'ACTIVE' as const,
      initialActivationConfirmedAt: '2026-09-15T14:15:00.000Z',
    }
    db.participantRegistrations.insertRegistration(durableRegistration)
    db.participantRegistrations.insertAttempt(stale)
    db.participantRegistrations.insertAttempt(current)
    const server = {
      db,
      stopping: false,
      participantEstablishmentOperations: new Map<string, Promise<void>>(),
      harnessBrokerController: { activeClientInvocationId: () => current.invocationId },
    } as unknown as HrcServerInstanceForHandlers

    recoverParticipantEstablishmentWork(server)
    await Promise.all([...server.participantEstablishmentOperations.values()])
    expect(db.participantRegistrations.getAttempt(stale.attemptId)).toMatchObject({
      state: 'DETACHED',
      establishmentWorkState: 'completed',
      establishmentAttemptCount: 0,
    })
    expect(db.participantRegistrations.getAttempt(current.attemptId)).toMatchObject({
      state: 'ACTIVE',
      establishmentWorkState: 'completed',
    })
  } finally {
    db.close()
  }
})

test('bounded retries become durably inert without abandoning a possibly-live writer', async () => {
  const db = openHrcDatabase(':memory:')
  try {
    const durableRegistration = registration()
    const activeAttempt = {
      ...attempt(durableRegistration.registrationId, 'rt-retry-exhaustion'),
      state: 'ACTIVE' as const,
      initialActivationConfirmedAt: '2026-09-15T14:20:00.000Z',
    }
    db.participantRegistrations.insertRegistration(durableRegistration)
    db.participantRegistrations.insertAttempt(activeAttempt)
    const server = {
      db,
      stopping: false,
      participantEstablishmentOperations: new Map<string, Promise<void>>(),
      harnessBrokerController: { activeClientInvocationId: () => undefined },
    } as unknown as HrcServerInstanceForHandlers

    scheduleParticipantEstablishment(server, durableRegistration, activeAttempt)
    const deadline = Date.now() + 5_000
    while (
      db.participantRegistrations.getAttempt(activeAttempt.attemptId)?.establishmentWorkState !==
        'exhausted' &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    const exhausted = db.participantRegistrations.getAttempt(activeAttempt.attemptId)
    expect(exhausted).toMatchObject({
      state: 'DETACHED',
      establishmentWorkState: 'exhausted',
      establishmentAttemptCount: 5,
      recoveryDisposition: 'unresolved',
    })
    const attemptsBefore = exhausted?.establishmentAttemptCount
    scheduleParticipantEstablishment(server, durableRegistration, exhausted ?? activeAttempt)
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(
      db.participantRegistrations.getAttempt(activeAttempt.attemptId)?.establishmentAttemptCount
    ).toBe(attemptsBefore)
  } finally {
    db.close()
  }
})
