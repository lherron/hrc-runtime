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

import { installAndHelloParticipantBroker } from '../participant-establishment.js'
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

function registration(joinDirection: ParticipantRegistration['join']): ParticipantRegistration {
  return {
    registrationId: `registration-${joinDirection}`,
    classId: `class-${joinDirection}`,
    adapterId: 'controlled-participant',
    join: joinDirection,
    participantKey: `key-${joinDirection}`,
    scopeRef: `agent:larry:project:hrc-runtime:task:participant-realization-${joinDirection}`,
    laneRef: 'main',
    hostSessionId: 'hsid-participant-realization',
    generation: 1,
    workspaceCwd: '/tmp/participant-workspace',
    ...(joinDirection === 'participant-served' ? { socketPath: '/tmp/served.sock' } : {}),
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
    createdAt: '2026-09-09T22:30:00.000Z',
    updatedAt: '2026-09-09T22:30:00.000Z',
  }
}

async function profileFor(
  joinDirection: ParticipantRegistration['join'],
  input: ParticipantAttempt
): Promise<BrokerExecutionProfile> {
  const adapter = createControlledParticipantAdapter({
    adapterId: 'controlled-participant',
    workspaceCwd: '/tmp/participant-workspace',
    driver: 'noop-driver',
  })
  const prepared = await adapter.prepare({
    classId: `class-${joinDirection}`,
    join: joinDirection,
    participantKey: `key-${joinDirection}`,
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
  let brokerInstanceId = 'broker-instance-1'
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
        close: async () => undefined,
      }) as never,
  } as unknown as HrcServerInstanceForHandlers
  try {
    const hostedRegistration = registration('hrc-hosted')
    const hostedAttempt = attempt(hostedRegistration.registrationId, 'rt-hosted')
    const hostedProfile = await profileFor('hrc-hosted', hostedAttempt)
    const hostedIntent = await createParticipantHostingIntent(
      server,
      hostedRegistration,
      hostedAttempt,
      hostedProfile
    )
    if (hostedIntent.hrcHosted === undefined) throw new Error('expected hosted intent')
    // The isolated hosted-broker probe records macOS's post-shebang `ps`
    // representation: the shipped executable appears as `bun <script argv>`.
    tmux.setNextBrokerCommandLine(`bun ${hostedIntent.hrcHosted.brokerArgv.join(' ')}`)
    db.participantRegistrations.insertRegistration(hostedRegistration)
    db.participantRegistrations.insertAttempt({
      ...hostedAttempt,
      preparedProfileJson: JSON.stringify(hostedProfile),
      adapterDispatchEnvJson: JSON.stringify({ ADAPTER_ONLY: 'kept' }),
      hostingIntentJson: JSON.stringify(hostedIntent),
    })

    const frozenHosted = await realizeAndFreezeParticipantDispatch(
      server,
      hostedRegistration,
      hostedAttempt
    )
    expect(frozenHosted).toMatchObject({ state: 'DISPATCH_FROZEN' })
    const realizedHosted = JSON.parse(frozenHosted.realizedHostingJson ?? '{}')
    const dispatchHosted = JSON.parse(frozenHosted.dispatchJson ?? '{}')
    expect(realizedHosted).toMatchObject({
      substrate: { kind: 'leased-tmux', brokerWindow: { paneId: '%1' }, pid: 83_349 },
      presentation: { kind: 'none' },
    })
    expect(dispatchHosted).toMatchObject({
      startRequest: hostedProfile.harnessInvocation.startRequest,
      dispatchEnv: { ADAPTER_ONLY: 'kept' },
      lifecyclePolicy: hostedIntent.lifecyclePolicy,
    })
    expect(dispatchHosted.runtime).toBeUndefined()
    expect(tmux.createCommands).toEqual([hostedIntent.hrcHosted?.brokerCommand])
    expect(
      await realizeAndFreezeParticipantDispatch(server, hostedRegistration, frozenHosted)
    ).toEqual(frozenHosted)
    expect(tmux.createCommands).toHaveLength(1)

    // Exact lease/process equality only admits a candidate. The broker still
    // receives the launch identity, then HELLO, and its instance/epoch
    // acknowledgement is frozen before any ensure can be considered.
    const installedHosted = await installAndHelloParticipantBroker(
      server,
      hostedRegistration,
      frozenHosted
    )
    expect(installedHosted).toMatchObject({ state: 'INSTALL_CONFIRMED' })
    expect(JSON.parse(installedHosted.brokerIdentityJson ?? '{}')).toMatchObject({
      brokerInstanceId: 'broker-instance-1',
      runtimeId: hostedAttempt.runtimeId,
      attachEpoch: hostedAttempt.attachEpoch,
      invocationId: hostedAttempt.invocationId,
    })
    expect(installedIdentities).toHaveLength(1)
    expect(helloRequests).toEqual([
      {
        clientInfo: { name: 'hrc-server' },
        protocolVersions: [hostedIntent.endpoint.protocolVersion],
        capabilities: { permissionRequests: true },
      },
    ])
    expect(
      await installAndHelloParticipantBroker(server, hostedRegistration, installedHosted)
    ).toMatchObject({
      state: 'INSTALL_CONFIRMED',
      brokerIdentityJson: installedHosted.brokerIdentityJson,
    })
    brokerInstanceId = 'broker-instance-conflict'
    await expect(
      installAndHelloParticipantBroker(server, hostedRegistration, installedHosted)
    ).rejects.toThrow('participant broker instance or epoch conflicts with durable acknowledgement')
    expect(db.participantRegistrations.getAttempt(hostedAttempt.attemptId)).toMatchObject({
      state: 'INSTALL_CONFIRMED',
      dispatchJson: installedHosted.dispatchJson,
      realizedHostingJson: installedHosted.realizedHostingJson,
      brokerIdentityJson: installedHosted.brokerIdentityJson,
    })

    const unavailableServer = {
      ...server,
      brokerTmuxManagerFactory: () => {
        throw new Error('writer unavailable')
      },
    } as unknown as HrcServerInstanceForHandlers
    await expect(
      realizeAndFreezeParticipantDispatch(unavailableServer, hostedRegistration, frozenHosted)
    ).rejects.toThrow('writer unavailable')
    expect(db.participantRegistrations.getAttempt(hostedAttempt.attemptId)).toMatchObject({
      state: 'INSTALL_CONFIRMED',
      dispatchJson: installedHosted.dispatchJson,
      realizedHostingJson: installedHosted.realizedHostingJson,
      brokerIdentityJson: installedHosted.brokerIdentityJson,
    })

    const servedRegistration = registration('participant-served')
    const servedAttempt = attempt(servedRegistration.registrationId, 'rt-served')
    const preparedServed = await profileFor('participant-served', servedAttempt)
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
    expect(tmux.createCommands).toHaveLength(1)
  } finally {
    db.close()
  }
})

test('refuses an incumbent broker whose attach-token path differs from the committed argv', async () => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), 't08349-incumbent-'))
  temporaryRoots.push(runtimeRoot)
  const db = openHrcDatabase(':memory:')
  const tmux = fakeTmux()
  const server = {
    options: { runtimeRoot },
    db,
    generateBrokerAttachToken: () => 'incumbent-token',
    brokerTmuxManagerFactory: tmux.manager,
  } as unknown as HrcServerInstanceForHandlers
  try {
    const hostedRegistration = registration('hrc-hosted')
    const hostedAttempt = attempt(hostedRegistration.registrationId, 'rt-incumbent')
    const hostedProfile = await profileFor('hrc-hosted', hostedAttempt)
    const hostedIntent = await createParticipantHostingIntent(
      server,
      hostedRegistration,
      hostedAttempt,
      hostedProfile
    )
    const hosted = hostedIntent.hrcHosted
    if (hosted === undefined) throw new Error('expected hosted intent')
    tmux.seedWindow(hosted.tmuxSocketPath, hosted.sessionName, 'broker', {
      command: 'bun',
      pid: 91_234,
      dead: false,
      commandLine: `bun ${hosted.brokerArgv.join(' ')}-different`,
    })
    db.participantRegistrations.insertRegistration(hostedRegistration)
    db.participantRegistrations.insertAttempt({
      ...hostedAttempt,
      preparedProfileJson: JSON.stringify(hostedProfile),
      adapterDispatchEnvJson: 'null',
      hostingIntentJson: JSON.stringify(hostedIntent),
    })

    await expect(
      realizeAndFreezeParticipantDispatch(server, hostedRegistration, hostedAttempt)
    ).rejects.toThrow('participant broker writer does not match the committed launch identity')
    expect(tmux.createCommands).toEqual([])
    const persisted = db.participantRegistrations.getAttempt(hostedAttempt.attemptId)
    expect(persisted).toMatchObject({ state: 'HOSTING_INTENT_PERSISTED' })
    expect(persisted?.realizedHostingJson).toBeUndefined()
    expect(persisted?.dispatchJson).toBeUndefined()
  } finally {
    db.close()
  }
})
