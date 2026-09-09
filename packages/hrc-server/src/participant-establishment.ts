import { readFile } from 'node:fs/promises'

import type { ParticipantAttempt, ParticipantRegistration } from 'hrc-store-sqlite'
import type { BrokerClient } from 'spaces-harness-broker-client'
import type {
  BrokerInstallIdentityResponse,
  BrokerRuntimeIdentity,
  InvocationId,
} from 'spaces-harness-broker-protocol'
import type { BrokerExecutionProfile } from 'spaces-runtime-contracts'

import { connectObservedBrokerUnixClient } from './broker/client-observability.js'
import type { ParticipantHostingIntent } from './participant-hosting-intent.js'
import { realizeAndFreezeParticipantDispatch } from './participant-realization.js'
import type { HrcServerInstanceForHandlers } from './server-instance-context.js'
import { timestamp } from './server-util.js'

type ParticipantBootstrapClient = Pick<BrokerClient, 'close' | 'hello' | 'installIdentity'>

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
export async function installAndHelloParticipantBroker(
  server: HrcServerInstanceForHandlers,
  registration: ParticipantRegistration,
  initialAttempt: ParticipantAttempt
): Promise<ParticipantAttempt> {
  const attempt = await realizeAndFreezeParticipantDispatch(server, registration, initialAttempt)
  if (!['DISPATCH_FROZEN', 'INSTALL_CONFIRMED'].includes(attempt.state)) {
    throw new Error(`participant attempt cannot install broker identity from ${attempt.state}`)
  }
  const intent = parseJson<ParticipantHostingIntent>(attempt.hostingIntentJson, 'hosting intent')
  const profile = parseJson<BrokerExecutionProfile>(attempt.preparedProfileJson, 'prepared profile')
  const attachToken = (await readFile(intent.endpoint.attachTokenRef.path, 'utf8')).trim()
  if (attachToken.length === 0) throw new Error('participant attach token is empty')
  const identity = expectedIdentity(registration, attempt, profile, attachToken)
  const client = await connectParticipantBroker(server, intent.endpoint.socketPath)
  let acknowledgement: BrokerInstallIdentityResponse
  try {
    acknowledgement = await client.installIdentity(identity)
    assertInstallResponse(acknowledgement, identity)
    await client.hello({
      clientInfo: { name: 'hrc-server' },
      protocolVersions: [intent.endpoint.protocolVersion],
      capabilities: { permissionRequests: true },
    })
  } finally {
    await client.close()
  }
  return persistInstallAcknowledgement(server, attempt, acknowledgement)
}
