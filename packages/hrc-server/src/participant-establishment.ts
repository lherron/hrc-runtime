import { readFile } from 'node:fs/promises'

import type { HrcProvider, HrcRuntimeSnapshot } from 'hrc-core'
import type { ParticipantAttempt, ParticipantRegistration } from 'hrc-store-sqlite'
import type { BrokerClient } from 'spaces-harness-broker-client'
import type {
  BrokerEnsureInvocationResponse,
  BrokerHelloResponse,
  BrokerInstallIdentityResponse,
  BrokerRuntimeIdentity,
  InvocationId,
} from 'spaces-harness-broker-protocol'
import { canonicalLifecyclePolicyJson } from 'spaces-harness-broker-protocol'
import type { BrokerExecutionProfile } from 'spaces-runtime-contracts'

import { connectObservedBrokerUnixClient } from './broker/client-observability.js'
import { runtimeHarness } from './broker/runtime-state.js'
import { appendHrcEvent } from './hrc-event-helper.js'
import type { ParticipantHostingIntent } from './participant-hosting-intent.js'
import {
  type ParticipantRealizedHosting,
  realizeAndFreezeParticipantDispatch,
} from './participant-realization.js'
import type { HrcServerInstanceForHandlers } from './server-instance-context.js'
import { writeServerLog } from './server-log.js'
import { timestamp } from './server-util.js'

type ParticipantBootstrapClient = Pick<
  BrokerClient,
  'close' | 'ensureInvocation' | 'hello' | 'installIdentity'
>

type ParticipantInstallResult = {
  attempt: ParticipantAttempt
  acknowledgement: BrokerInstallIdentityResponse
  hello: BrokerHelloResponse
}

function parseJson<T>(json: string | undefined, label: string): T {
  if (json === undefined) throw new Error(`participant attempt is missing ${label}`)
  try {
    return JSON.parse(json) as T
  } catch {
    throw new Error(`participant attempt has invalid ${label}`)
  }
}

function expectedIdentity(
  registration: ParticipantRegistration,
  attempt: ParticipantAttempt,
  profile: BrokerExecutionProfile,
  attachToken: string
): BrokerRuntimeIdentity {
  return {
    runtimeId: attempt.runtimeId,
    hostSessionId: registration.hostSessionId,
    generation: registration.generation,
    attachEpoch: attempt.attachEpoch,
    invocationId: attempt.invocationId as InvocationId,
    startRequestHash: profile.harnessInvocation.startRequestHash,
    selectedProfileHash: profile.profileHash,
    attachToken,
  }
}

function assertInstallResponse(
  response: BrokerInstallIdentityResponse,
  expected: BrokerRuntimeIdentity
): void {
  if (
    response.installed !== true ||
    response.brokerInstanceId.trim().length === 0 ||
    response.runtimeId !== expected.runtimeId ||
    response.hostSessionId !== expected.hostSessionId ||
    response.generation !== expected.generation ||
    response.attachEpoch !== expected.attachEpoch ||
    response.invocationId !== expected.invocationId ||
    response.installedAt.trim().length === 0
  ) {
    throw new Error(
      'participant broker install acknowledgement conflicts with the committed attempt'
    )
  }
}

/** The stored broker response is a write-once incarnation/epoch fence. */
function sameInstallResponse(
  existing: BrokerInstallIdentityResponse,
  observed: BrokerInstallIdentityResponse
): boolean {
  return (
    existing.installed === observed.installed &&
    existing.brokerInstanceId === observed.brokerInstanceId &&
    existing.runtimeId === observed.runtimeId &&
    existing.hostSessionId === observed.hostSessionId &&
    existing.generation === observed.generation &&
    existing.attachEpoch === observed.attachEpoch &&
    existing.invocationId === observed.invocationId &&
    existing.installedAt === observed.installedAt
  )
}

function requireBootstrapClient(value: unknown): ParticipantBootstrapClient {
  if (
    typeof value !== 'object' ||
    value === null ||
    typeof (value as Partial<ParticipantBootstrapClient>).installIdentity !== 'function' ||
    typeof (value as Partial<ParticipantBootstrapClient>).hello !== 'function' ||
    typeof (value as Partial<ParticipantBootstrapClient>).close !== 'function'
  ) {
    throw new Error('participant broker client does not expose installIdentity and hello')
  }
  return value as ParticipantBootstrapClient
}

async function connectParticipantBroker(
  server: HrcServerInstanceForHandlers,
  socketPath: string
): Promise<ParticipantBootstrapClient> {
  const client = server.brokerUnixClientFactory
    ? await server.brokerUnixClientFactory({ socketPath })
    : await connectObservedBrokerUnixClient({ socketPath })
  return requireBootstrapClient(client)
}

function persistInstallAcknowledgement(
  server: HrcServerInstanceForHandlers,
  attempt: ParticipantAttempt,
  acknowledgement: BrokerInstallIdentityResponse
): ParticipantAttempt {
  const now = timestamp()
  server.db.sqlite.transaction(() => {
    const current = server.db.participantRegistrations.getAttempt(attempt.attemptId)
    if (current === null)
      throw new Error('participant attempt disappeared before install acknowledgement')
    if (current.brokerIdentityJson !== undefined) {
      const existing = parseJson<BrokerInstallIdentityResponse>(
        current.brokerIdentityJson,
        'broker install acknowledgement'
      )
      if (!sameInstallResponse(existing, acknowledgement)) {
        throw new Error(
          'participant broker instance or epoch conflicts with durable acknowledgement'
        )
      }
      return
    }
    if (current.state !== 'DISPATCH_FROZEN') {
      throw new Error(`participant attempt cannot confirm install from ${current.state}`)
    }
    const persisted = server.db.participantRegistrations.setSnapshotIfAbsent(
      current.attemptId,
      'brokerIdentityJson',
      JSON.stringify(acknowledgement),
      now
    )
    if (!persisted) throw new Error('participant broker acknowledgement persistence raced')
    const transitioned = server.db.participantRegistrations.transitionAttempt(
      current.attemptId,
      ['DISPATCH_FROZEN'],
      'INSTALL_CONFIRMED',
      now
    )
    if (!transitioned)
      throw new Error('participant broker install acknowledgement transition raced')
  })()
  const persisted = server.db.participantRegistrations.getAttempt(attempt.attemptId)
  if (persisted === null)
    throw new Error('participant attempt disappeared after install acknowledgement')
  return persisted
}

/**
 * Establishes only the broker-owned installation boundary. Resource rediscovery
 * is still required on a frozen retry; successful process continuity is merely
 * a candidate, while `installIdentity` fences runtime/session/generation/token
 * and the persisted acknowledgement fences instance plus epoch. ENSURE remains
 * deliberately out of this function until the complete frozen dispatch is used.
 */
async function installAndHelloParticipantBrokerDetails(
  server: HrcServerInstanceForHandlers,
  registration: ParticipantRegistration,
  initialAttempt: ParticipantAttempt
): Promise<ParticipantInstallResult> {
  const attempt = await realizeAndFreezeParticipantDispatch(server, registration, initialAttempt)
  if (
    ![
      'DISPATCH_FROZEN',
      'INSTALL_CONFIRMED',
      'INVOCATION_READY',
      'ATTACH_CONFIRMED',
      'ACTIVE',
      'DETACHED',
    ].includes(attempt.state)
  ) {
    throw new Error(`participant attempt cannot install broker identity from ${attempt.state}`)
  }
  const intent = parseJson<ParticipantHostingIntent>(attempt.hostingIntentJson, 'hosting intent')
  const profile = parseJson<BrokerExecutionProfile>(attempt.preparedProfileJson, 'prepared profile')
  const attachToken = (await readFile(intent.endpoint.attachTokenRef.path, 'utf8')).trim()
  if (attachToken.length === 0) throw new Error('participant attach token is empty')
  const identity = expectedIdentity(registration, attempt, profile, attachToken)
  const client = await connectParticipantBroker(server, intent.endpoint.socketPath)
  let acknowledgement: BrokerInstallIdentityResponse
  let hello: BrokerHelloResponse
  try {
    acknowledgement = await client.installIdentity(identity)
    assertInstallResponse(acknowledgement, identity)
    hello = await client.hello({
      clientInfo: { name: 'hrc-server' },
      protocolVersions: [intent.endpoint.protocolVersion],
      capabilities: { permissionRequests: true },
    })
  } finally {
    await client.close()
  }
  return {
    attempt: persistInstallAcknowledgement(server, attempt, acknowledgement),
    acknowledgement,
    hello,
  }
}

export async function installAndHelloParticipantBroker(
  server: HrcServerInstanceForHandlers,
  registration: ParticipantRegistration,
  initialAttempt: ParticipantAttempt
): Promise<ParticipantAttempt> {
  return (await installAndHelloParticipantBrokerDetails(server, registration, initialAttempt))
    .attempt
}

function assertEnsureReceipt(
  response: BrokerEnsureInvocationResponse,
  attempt: ParticipantAttempt,
  acknowledgement: BrokerInstallIdentityResponse
): void {
  const receipt = response.receipt
  if (
    receipt.startAttemptId !== attempt.attemptId ||
    receipt.invocationId !== attempt.invocationId ||
    receipt.attachEpoch !== attempt.attachEpoch ||
    receipt.brokerInstanceId !== acknowledgement.brokerInstanceId
  ) {
    throw new Error('participant broker ensure receipt conflicts with durable identity')
  }
}

/**
 * Uses the already-frozen complete dispatch tuple for the broker's one
 * at-most-once start attempt. Only a `started` receipt advances HRC; failed or
 * indeterminate receipts retain the immutable attempt and assert no recovery.
 */
export async function ensureParticipantInvocation(
  server: HrcServerInstanceForHandlers,
  registration: ParticipantRegistration,
  initialAttempt: ParticipantAttempt
): Promise<{
  attempt: ParticipantAttempt
  receipt: BrokerEnsureInvocationResponse['receipt']
  hello: BrokerHelloResponse
}> {
  const installed = await installAndHelloParticipantBrokerDetails(
    server,
    registration,
    initialAttempt
  )
  const attempt = installed.attempt
  if (attempt.dispatchJson === undefined || attempt.brokerIdentityJson === undefined) {
    throw new Error('participant attempt is missing immutable dispatch or broker identity')
  }
  const acknowledgement = parseJson<BrokerInstallIdentityResponse>(
    attempt.brokerIdentityJson,
    'broker install acknowledgement'
  )
  const dispatch = parseJson<{
    startRequest: Parameters<BrokerClient['ensureInvocation']>[0]['startRequest']
    dispatchEnv?: Parameters<BrokerClient['ensureInvocation']>[0]['dispatchEnv']
    runtime?: Parameters<BrokerClient['ensureInvocation']>[0]['runtime']
    lifecyclePolicy?: Parameters<BrokerClient['ensureInvocation']>[0]['lifecyclePolicy']
  }>(attempt.dispatchJson, 'frozen dispatch')
  const intent = parseJson<ParticipantHostingIntent>(attempt.hostingIntentJson, 'hosting intent')
  const client = await connectParticipantBroker(server, intent.endpoint.socketPath)
  let response: BrokerEnsureInvocationResponse
  try {
    if (typeof client.ensureInvocation !== 'function') {
      throw new Error('participant broker client does not expose ensureInvocation')
    }
    response = await client.ensureInvocation({
      startAttemptId: attempt.attemptId,
      invocationId: attempt.invocationId as InvocationId,
      attachEpoch: attempt.attachEpoch,
      ...dispatch,
    })
    assertEnsureReceipt(response, attempt, acknowledgement)
  } finally {
    await client.close()
  }
  if (response.receipt.state === 'started' && attempt.state === 'INSTALL_CONFIRMED') {
    const transitioned = server.db.participantRegistrations.transitionAttempt(
      attempt.attemptId,
      ['INSTALL_CONFIRMED'],
      'INVOCATION_READY',
      timestamp()
    )
    if (!transitioned) throw new Error('participant invocation-ready transition raced')
  }
  const persisted = server.db.participantRegistrations.getAttempt(attempt.attemptId)
  if (persisted === null) throw new Error('participant attempt disappeared after ensure receipt')
  return { attempt: persisted, receipt: response.receipt, hello: installed.hello }
}

function participantLifecycleOwner(registration: ParticipantRegistration): 'external' | undefined {
  return registration.join === 'participant-served' ? 'external' : undefined
}

function participantTransport(realized: ParticipantRealizedHosting): 'headless' | 'tmux' {
  return realized.presentation.kind === 'tmux-tui' ? 'tmux' : 'headless'
}

function assertExistingParticipantRuntime(
  runtime: HrcRuntimeSnapshot,
  registration: ParticipantRegistration,
  attempt: ParticipantAttempt,
  profile: BrokerExecutionProfile
): void {
  if (
    runtime.hostSessionId !== registration.hostSessionId ||
    runtime.scopeRef !== registration.scopeRef ||
    runtime.laneRef !== registration.laneRef ||
    runtime.generation !== registration.generation ||
    runtime.activeOperationId !== attempt.operationId ||
    runtime.activeInvocationId !== attempt.invocationId ||
    runtime.selectedProfileHash !== profile.profileHash
  ) {
    throw new Error('participant runtime bookkeeping conflicts with the committed attempt')
  }
}

/**
 * Persist the ordinary HRC runtime/invocation graph for an already-resident
 * participant invocation. This deliberately does not call ordinary start: all
 * identity, request, profile, hosting, and ensure facts are durable inputs.
 */
function materializeParticipantBrokerBookkeeping(
  server: HrcServerInstanceForHandlers,
  registration: ParticipantRegistration,
  attempt: ParticipantAttempt,
  hello: BrokerHelloResponse
): void {
  if (
    attempt.preparedProfileJson === undefined ||
    attempt.hostingIntentJson === undefined ||
    attempt.realizedHostingJson === undefined ||
    attempt.dispatchJson === undefined
  ) {
    throw new Error('participant attempt is missing a committed establishment boundary')
  }
  const profile = parseJson<BrokerExecutionProfile>(attempt.preparedProfileJson, 'prepared profile')
  const intent = parseJson<ParticipantHostingIntent>(attempt.hostingIntentJson, 'hosting intent')
  const realized = parseJson<ParticipantRealizedHosting>(
    attempt.realizedHostingJson,
    'realized hosting'
  )
  const dispatch = parseJson<{
    startRequest: BrokerExecutionProfile['harnessInvocation']['startRequest']
    lifecyclePolicy?: ParticipantHostingIntent['lifecyclePolicy']
  }>(attempt.dispatchJson, 'frozen dispatch')
  const protocol = hello.protocolVersion
  if (typeof protocol !== 'string' || protocol.length === 0) {
    throw new Error('participant broker hello did not report its negotiated protocol')
  }
  // `runtimes.provider` is a legacy non-null compatibility column, while the
  // participant adapter contract intentionally supplies no provider identity.
  // Keep that absence honest and inert: routing uses the broker profile/driver,
  // never this projection sentinel.
  const provider =
    dispatch.startRequest.spec.harness.provider === 'openai' ||
    dispatch.startRequest.spec.harness.provider === 'anthropic'
      ? dispatch.startRequest.spec.harness.provider
      : ('participant-adapter' as HrcProvider)
  const now = timestamp()
  const lifecycleOwner = participantLifecycleOwner(registration)
  server.db.sqlite.transaction(() => {
    const existingRuntime = server.db.runtimes.getByRuntimeId(attempt.runtimeId)
    if (existingRuntime !== null) {
      assertExistingParticipantRuntime(existingRuntime, registration, attempt, profile)
    } else {
      server.db.runtimes.insert({
        runtimeId: attempt.runtimeId,
        runtimeKind: 'harness',
        hostSessionId: registration.hostSessionId,
        scopeRef: registration.scopeRef,
        laneRef: registration.laneRef,
        generation: registration.generation,
        transport: participantTransport(realized),
        harness: runtimeHarness(dispatch.startRequest.spec.harness.frontend, profile.brokerDriver),
        provider,
        status: 'starting',
        statusChangedAt: now,
        supportsInflightInput: true,
        adopted: false,
        controllerKind: 'harness-broker',
        activeOperationId: attempt.operationId,
        activeInvocationId: attempt.invocationId,
        selectedProfileHash: profile.profileHash,
        lifecyclePolicyHash: intent.lifecyclePolicy.policyHash,
        runtimeStateJson: {
          schemaVersion: 'runtime-state/v1',
          kind: 'harness-broker',
          runtimeId: attempt.runtimeId,
          hostSessionId: registration.hostSessionId,
          generation: registration.generation,
          status: 'starting',
          ...(lifecycleOwner === undefined ? {} : { lifecycleOwner }),
          participantRegistration: {
            registrationId: registration.registrationId,
            attemptId: attempt.attemptId,
            attachEpoch: attempt.attachEpoch,
            join: registration.join,
          },
          broker: {
            protocolVersion: protocol,
            endpoint: realized.endpoint,
            substrate: realized.substrate,
            presentation: realized.presentation,
          },
          invocation: {
            invocationId: attempt.invocationId,
            state: 'ready',
            driver: profile.brokerDriver,
          },
          control: { mode: 'broker-ipc', brokerAttached: false },
        },
        createdAt: now,
        updatedAt: now,
      })
    }

    if (server.db.runtimeOperations.getByOperationId(attempt.operationId) === null) {
      server.db.runtimeOperations.insert({
        operationId: attempt.operationId,
        runtimeId: attempt.runtimeId,
        hostSessionId: registration.hostSessionId,
        generation: registration.generation,
        operationKind: 'broker_invocation',
        controller: 'harness-broker',
        selectedProfileId: profile.profileId,
        selectedProfileHash: profile.profileHash,
        startupMethod: 'broker.ensureInvocation',
        turnDelivery: 'invocation.input',
        status: 'starting',
        routeDecisionJson: JSON.stringify({
          origin: 'participant-registration',
          join: registration.join,
        }),
        capabilityResolutionJson: JSON.stringify({ brokerHello: hello.capabilities ?? {} }),
        createdAt: now,
        startedAt: now,
        updatedAt: now,
      })
    }

    const existingInvocation = server.db.brokerInvocations.getByInvocationId(attempt.invocationId)
    if (existingInvocation !== null) {
      if (
        existingInvocation.operationId !== attempt.operationId ||
        existingInvocation.runtimeId !== attempt.runtimeId ||
        existingInvocation.startRequestHash !== profile.harnessInvocation.startRequestHash ||
        existingInvocation.selectedProfileHash !== profile.profileHash
      ) {
        throw new Error(
          'participant broker invocation bookkeeping conflicts with the committed attempt'
        )
      }
    } else {
      server.db.lifecyclePolicies.insert({
        policyId: intent.lifecyclePolicy.policyId,
        lifecyclePolicyHash: intent.lifecyclePolicy.policyHash,
        canonicalPolicyJson: canonicalLifecyclePolicyJson(intent.lifecyclePolicy),
        schemaVersion: intent.lifecyclePolicy.schemaVersion,
        createdAt: now,
      })
      server.db.brokerInvocations.insert({
        invocationId: attempt.invocationId,
        operationId: attempt.operationId,
        runtimeId: attempt.runtimeId,
        brokerProtocol: protocol,
        brokerDriver: profile.brokerDriver,
        invocationState: 'ready',
        capabilitiesJson: JSON.stringify(hello.capabilities ?? {}),
        specHash: profile.harnessInvocation.specHash,
        startRequestHash: profile.harnessInvocation.startRequestHash,
        selectedProfileHash: profile.profileHash,
        specProjectionJson: JSON.stringify(dispatch.startRequest.spec),
        startRequestProjectionJson: JSON.stringify(dispatch.startRequest),
        lifecyclePolicyHash: intent.lifecyclePolicy.policyHash,
        createdAt: now,
        updatedAt: now,
      })
    }
  })()
}

function requireCurrentInvocationReady(
  server: HrcServerInstanceForHandlers,
  attempt: ParticipantAttempt
): ParticipantAttempt {
  const current = server.db.participantRegistrations.getAttempt(attempt.attemptId)
  if (
    current === null ||
    current.attachEpoch !== attempt.attachEpoch ||
    current.runtimeId !== attempt.runtimeId ||
    current.invocationId !== attempt.invocationId ||
    current.state !== 'INVOCATION_READY'
  ) {
    throw new Error('participant attach work is stale or no longer invocation-ready')
  }
  return current
}

/**
 * One scheduling call performs the current ensure then its attach. A persisted
 * INVOCATION_READY from an earlier call is intentionally insufficient: a later
 * failed/indeterminate ensure must not authorize attach.
 */
export async function ensureAndStageParticipantAttach(
  server: HrcServerInstanceForHandlers,
  registration: ParticipantRegistration,
  initialAttempt: ParticipantAttempt
): Promise<ParticipantAttempt> {
  const ensured = await ensureParticipantInvocation(server, registration, initialAttempt)
  if (ensured.receipt.state !== 'started') {
    throw new Error('participant ensure did not return a started receipt for this attach call')
  }
  const attempt = requireCurrentInvocationReady(server, ensured.attempt)
  materializeParticipantBrokerBookkeeping(server, registration, attempt, ensured.hello)
  if (attempt.brokerIdentityJson === undefined || attempt.hostingIntentJson === undefined) {
    throw new Error('participant attempt is missing broker identity or hosting intent for attach')
  }
  const acknowledgement = parseJson<BrokerInstallIdentityResponse>(
    attempt.brokerIdentityJson,
    'broker install acknowledgement'
  )
  const intent = parseJson<ParticipantHostingIntent>(attempt.hostingIntentJson, 'hosting intent')
  const attachToken = (await readFile(intent.endpoint.attachTokenRef.path, 'utf8')).trim()
  if (attachToken.length === 0) throw new Error('participant attach token is empty')
  const controller = server.harnessBrokerController
  if (controller === undefined)
    throw new Error('participant attach requires the HRC broker controller')
  try {
    await controller.stageParticipantAttach({
      attemptId: attempt.attemptId,
      attachEpoch: attempt.attachEpoch,
      runtimeId: attempt.runtimeId,
      invocationId: attempt.invocationId,
      socketPath: intent.endpoint.socketPath,
      attachToken,
      brokerInstanceId: acknowledgement.brokerInstanceId,
    })
    const now = timestamp()
    const confirmed = server.db.participantRegistrations.transitionAttempt(
      attempt.attemptId,
      ['INVOCATION_READY'],
      'ATTACH_CONFIRMED',
      now
    )
    if (!confirmed)
      throw new Error('participant attach confirmation lost its current attempt fence')
  } catch (error) {
    await controller.discardStagedParticipantAttach(attempt.attemptId)
    throw error
  }
  const confirmed = server.db.participantRegistrations.getAttempt(attempt.attemptId)
  if (confirmed === null)
    throw new Error('participant attempt disappeared after attach confirmation')
  return confirmed
}

async function stageExistingParticipantAttachment(
  server: HrcServerInstanceForHandlers,
  registration: ParticipantRegistration,
  initialAttempt: ParticipantAttempt
): Promise<ParticipantAttempt> {
  const controller = server.harnessBrokerController
  if (controller === undefined)
    throw new Error('participant attach requires the HRC broker controller')
  let attempt = server.db.participantRegistrations.getAttempt(initialAttempt.attemptId)
  if (attempt === null) throw new Error('participant attempt disappeared before reattachment')
  if (attempt.state === 'ACTIVE') {
    if (controller.activeClientInvocationId(attempt.runtimeId) === attempt.invocationId)
      return attempt
    const detached = server.db.participantRegistrations.transitionAttempt(
      attempt.attemptId,
      ['ACTIVE'],
      'DETACHED',
      timestamp()
    )
    if (!detached)
      throw new Error('participant active attachment could not enter detached recovery')
    attempt = server.db.participantRegistrations.getAttempt(attempt.attemptId)
    if (attempt === null) throw new Error('participant attempt disappeared after detachment')
  }
  if (attempt.state !== 'DETACHED') {
    throw new Error('participant reattachment requires a detached durable attempt')
  }
  const installed = await installAndHelloParticipantBrokerDetails(server, registration, attempt)
  attempt = installed.attempt
  materializeParticipantBrokerBookkeeping(server, registration, attempt, installed.hello)
  if (attempt.brokerIdentityJson === undefined || attempt.hostingIntentJson === undefined) {
    throw new Error('participant reattachment is missing broker identity or hosting intent')
  }
  const acknowledgement = parseJson<BrokerInstallIdentityResponse>(
    attempt.brokerIdentityJson,
    'broker install acknowledgement'
  )
  const intent = parseJson<ParticipantHostingIntent>(attempt.hostingIntentJson, 'hosting intent')
  const attachToken = (await readFile(intent.endpoint.attachTokenRef.path, 'utf8')).trim()
  if (attachToken.length === 0) throw new Error('participant attach token is empty')
  try {
    await controller.stageParticipantAttach({
      attemptId: attempt.attemptId,
      attachEpoch: attempt.attachEpoch,
      runtimeId: attempt.runtimeId,
      invocationId: attempt.invocationId,
      socketPath: intent.endpoint.socketPath,
      attachToken,
      brokerInstanceId: acknowledgement.brokerInstanceId,
    })
    const confirmed = server.db.participantRegistrations.transitionAttempt(
      attempt.attemptId,
      ['DETACHED'],
      'ATTACH_CONFIRMED',
      timestamp()
    )
    if (!confirmed)
      throw new Error('participant reattach confirmation lost its current attempt fence')
  } catch (error) {
    await controller.discardStagedParticipantAttach(attempt.attemptId)
    throw error
  }
  const confirmed = server.db.participantRegistrations.getAttempt(attempt.attemptId)
  if (confirmed === null)
    throw new Error('participant attempt disappeared after reattach confirmation')
  return confirmed
}

function participantActivationClassification(
  registration: ParticipantRegistration
): 'attached' | 'attached_unknown' {
  return registration.continuityEvidenceJson === undefined ? 'attached_unknown' : 'attached'
}

function assertPriorParticipantRecoveryDisposition(
  server: HrcServerInstanceForHandlers,
  attempt: ParticipantAttempt
): void {
  for (const prior of server.db.participantRegistrations.listAttemptsByRegistrationId(
    attempt.registrationId
  )) {
    if (prior.attachEpoch >= attempt.attachEpoch) continue
    if (!['ABANDONED', 'SUPERSEDED', 'TERMINAL'].includes(prior.state)) {
      throw new Error('participant prior-invocation recovery disposition is unresolved')
    }
  }
}

/**
 * Commits the one initial activation before the controller may project or ACK.
 * The registration's opaque evidence is only classified as present/absent here;
 * HRC does not interpret or replace adapter-owned evidence.
 */
export async function activateStagedParticipant(
  server: HrcServerInstanceForHandlers,
  registration: ParticipantRegistration,
  initialAttempt: ParticipantAttempt
): Promise<ParticipantAttempt> {
  const attempt = server.db.participantRegistrations.getAttempt(initialAttempt.attemptId)
  if (attempt === null) throw new Error('participant attempt disappeared before activation')
  if (attempt.attachEpoch !== initialAttempt.attachEpoch) {
    throw new Error('participant activation lost its current attach epoch')
  }
  if (attempt.hostingIntentJson === undefined) {
    throw new Error('participant attempt is missing hosting intent for activation')
  }
  const intent = parseJson<ParticipantHostingIntent>(attempt.hostingIntentJson, 'hosting intent')
  const attachToken = (await readFile(intent.endpoint.attachTokenRef.path, 'utf8')).trim()
  if (attachToken.length === 0) throw new Error('participant attach token is empty')

  let activationEvent: ReturnType<typeof appendHrcEvent> | undefined
  server.db.sqlite.transaction(() => {
    const current = server.db.participantRegistrations.getAttempt(attempt.attemptId)
    if (current === null || current.attachEpoch !== attempt.attachEpoch) {
      throw new Error('participant activation work is stale')
    }
    if (
      current.state === 'ATTACH_CONFIRMED' &&
      current.initialActivationConfirmedAt === undefined
    ) {
      assertPriorParticipantRecoveryDisposition(server, current)
      const now = timestamp()
      if (!server.db.participantRegistrations.confirmInitialActivation(current.attemptId, now)) {
        throw new Error('participant activation compare-and-set lost')
      }
      const runtime = server.db.runtimes.getByRuntimeId(current.runtimeId)
      if (runtime === null)
        throw new Error('participant runtime bookkeeping disappeared before activation')
      const classification = participantActivationClassification(registration)
      server.db.runtimes.update(current.runtimeId, {
        runtimeStateJson: {
          ...(runtime.runtimeStateJson ?? {}),
          participantActivation: {
            attemptId: current.attemptId,
            attachEpoch: current.attachEpoch,
            classification,
            activatedAt: now,
          },
        },
        updatedAt: now,
      })
      activationEvent = appendHrcEvent(server.db, 'runtime.ensured', {
        ts: now,
        hostSessionId: registration.hostSessionId,
        scopeRef: registration.scopeRef,
        laneRef: registration.laneRef,
        generation: registration.generation,
        runtimeId: current.runtimeId,
        transport: participantTransport(
          parseJson<ParticipantRealizedHosting>(current.realizedHostingJson, 'realized hosting')
        ),
        payload: {
          source: 'participant-activation',
          attemptId: current.attemptId,
          attachEpoch: current.attachEpoch,
          classification,
        },
      })
    } else if (
      current.state === 'ATTACH_CONFIRMED' &&
      current.initialActivationConfirmedAt !== undefined
    ) {
      if (!server.db.participantRegistrations.confirmReattachment(current.attemptId, timestamp())) {
        throw new Error('participant reattachment activation compare-and-set lost')
      }
    } else if (
      !(current.state === 'ACTIVE' && current.initialActivationConfirmedAt !== undefined)
    ) {
      throw new Error('participant activation requires current attach confirmation')
    }
  })()
  if (activationEvent !== undefined) server.ctx.notifyEvent(activationEvent)

  const controller = server.harnessBrokerController
  if (controller === undefined)
    throw new Error('participant activation requires the HRC broker controller')
  const replay = await controller.activateStagedParticipant({
    attemptId: attempt.attemptId,
    runtimeId: attempt.runtimeId,
    attachToken,
  })
  if (!replay.ok) throw replay.error
  const active = server.db.participantRegistrations.getAttempt(attempt.attemptId)
  if (active === null || active.state !== 'ACTIVE') {
    throw new Error('participant activation state disappeared before replay release')
  }
  return active
}

/**
 * Registration acknowledgement is not held behind process or broker work.
 * The durable attempt ID serializes this detached effect inside one daemon;
 * every effect re-reads its durable boundary before acting, and a restart can
 * reconnect through the same attempt without reclassifying user continuity.
 */
export function scheduleParticipantEstablishment(
  server: HrcServerInstanceForHandlers,
  registration: ParticipantRegistration,
  attempt: ParticipantAttempt
): void {
  if (server.stopping || server.participantEstablishmentOperations.has(attempt.attemptId)) return
  const operation = new Promise<void>((resolve) => setTimeout(resolve, 0))
    .then(async () => {
      if (server.stopping) return
      const current = server.db.participantRegistrations.getAttempt(attempt.attemptId) ?? attempt
      const staged =
        current.state === 'ACTIVE' || current.state === 'DETACHED'
          ? await stageExistingParticipantAttachment(server, registration, current)
          : await ensureAndStageParticipantAttach(server, registration, current)
      await activateStagedParticipant(server, registration, staged)
    })
    .catch((error: unknown) => {
      // Failed establishment is deliberately non-terminal and leaves the
      // immutable attempt for the next scheduled retry/recovery. In particular,
      // neither an ensure failure nor a dropped candidate is writer-death or
      // retirement evidence.
      writeServerLog('WARN', 'participant.establishment.pending', {
        registrationId: registration.registrationId,
        attemptId: attempt.attemptId,
        error: error instanceof Error ? error.message : String(error),
      })
    })
    .finally(() => server.participantEstablishmentOperations.delete(attempt.attemptId))
  server.participantEstablishmentOperations.set(attempt.attemptId, operation)
}
