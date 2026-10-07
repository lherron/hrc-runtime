import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { HrcHarness, HrcProvider } from 'hrc-core'
import type { ExternalRegistrationGrant, HrcDatabase } from 'hrc-store-sqlite'
import { scheduleExternalRegistrationCollectiveEstablishment } from './external-registration-establishment.js'
import {
  DEFAULT_EXTERNAL_PARTICIPANT_LINGER_MS,
  DEFAULT_PROBE_FAILURE_THRESHOLD,
  DEFAULT_PROBE_INTERVAL_MS,
  EPR_PROTOCOL_VERSION,
  type EprEstablishedDelivery,
  EprHelloError,
  type EprHelloResponse,
  type ExternalParticipantRpcClient,
  exactKeys,
  externalParticipantRpcDeadlineMs,
  isRecord,
  malformed,
  parseEprHelloResponse,
} from './external-registration-protocol.js'
import { annotateRpcError, requestExternalParticipantRpc } from './external-registration-rpc.js'
import { appendHrcEvent } from './hrc-event-helper.js'
import type { HrcServerInstanceForHandlers } from './server-instance-context.js'
import { createHostSessionId, isRuntimeUnavailableStatus, timestamp } from './server-util.js'
import { getBrokerIpcSocketPath } from './tmux-socket.js'

function credentialMatches(credential: string, expectedHash: string): boolean {
  const actual = Buffer.from(createHash('sha256').update(credential, 'utf8').digest('hex'), 'hex')
  const expected = Buffer.from(expectedHash, 'hex')
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

function validateCredentialAndClass(
  grant: ExternalRegistrationGrant,
  hello: EprHelloResponse,
  now: string
): void {
  if (!credentialMatches(hello.credential, grant.credentialHash)) {
    throw new EprHelloError('credential_mismatch', 'registration credential does not match')
  }
  if (!grant.consumed && grant.expiresAt <= now) {
    throw new EprHelloError('grant_expired', 'registration grant has expired')
  }
  if (hello.capabilities.turns && !grant.turnsAllowed) {
    malformed('registration class does not allow turns capability')
  }
}

export function assertMintLinkage(
  grant: ExternalRegistrationGrant
): asserts grant is ExternalRegistrationGrant & {
  hostSessionId: string
  runtimeId: string
  operationId: string
  invocationId: string
  attachTokenRef: string
  controllerInstanceId: string
  establishmentState: 'DELIVERY_PENDING' | 'ESTABLISHED'
} {
  if (
    grant.hostSessionId === undefined ||
    grant.runtimeId === undefined ||
    grant.operationId === undefined ||
    grant.invocationId === undefined ||
    grant.attachTokenRef === undefined ||
    grant.controllerInstanceId === undefined ||
    grant.establishmentState === undefined
  ) {
    throw new Error(`consumed registration ${grant.registrationId} has incomplete mint linkage`)
  }
}

export function registrationIsFinalized(
  db: HrcDatabase,
  grant: ExternalRegistrationGrant
): boolean {
  if (grant.runtimeId === undefined || grant.invocationId === undefined) return false
  const runtime = db.runtimes.getByRuntimeId(grant.runtimeId)
  if (
    runtime !== null &&
    ((isRuntimeUnavailableStatus(runtime.status) && runtime.status !== 'detached') ||
      runtime.status === 'failed')
  ) {
    return true
  }
  const invocation = db.brokerInvocations.getByInvocationId(grant.invocationId)
  return (
    invocation?.invocationState === 'exited' ||
    invocation?.invocationState === 'failed' ||
    invocation?.invocationState === 'disposed'
  )
}

function stableHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')
}

type MintedExternalRegistration = {
  grant: ExternalRegistrationGrant & {
    hostSessionId: string
    runtimeId: string
    operationId: string
    invocationId: string
    attachTokenRef: string
    controllerInstanceId: string
    establishmentState: 'DELIVERY_PENDING'
  }
  attachToken: string
}

async function allocateAttachToken(
  server: HrcServerInstanceForHandlers,
  runtimeId: string
): Promise<{ attachToken: string; attachTokenRef: string; tokenDir: string }> {
  const tokenDir = dirname(
    getBrokerIpcSocketPath(server.options, 'external-participant', runtimeId)
  )
  await mkdir(tokenDir, { recursive: true, mode: 0o700 })
  await chmod(tokenDir, 0o700)
  const attachToken =
    server.generateBrokerAttachToken?.() ?? `epr_attach_${randomBytes(32).toString('base64url')}`
  const attachTokenRef = join(tokenDir, 'attach.token')
  await writeFile(attachTokenRef, attachToken, { mode: 0o600 })
  return { attachToken, attachTokenRef, tokenDir }
}

async function mintExternalRegistration(
  server: HrcServerInstanceForHandlers,
  grant: ExternalRegistrationGrant,
  hello: EprHelloResponse,
  now: string
): Promise<MintedExternalRegistration | null> {
  const hostSessionId = createHostSessionId()
  const runtimeId = `rt-${randomUUID()}`
  const operationId = `op-${randomUUID()}`
  const invocationId = `inv-${randomUUID()}`
  const controllerInstanceId = `controller-${randomUUID()}`
  const token = await allocateAttachToken(server, runtimeId)
  const capabilities = { ...hello.capabilities }
  const participantInfo = { ...hello.participantInfo }
  const startProjection = {
    origin: 'external-registration',
    registrationId: grant.registrationId,
    protocolVersion: hello.protocolVersion,
    capabilities,
    participantInfo,
  }
  const projectionHash = stableHash(startProjection)

  try {
    const birthEvent = server.db.sqlite
      .transaction(() => {
        if (!server.db.externalRegistrationGrants.consumeIfAvailable(grant.registrationId, now)) {
          return undefined
        }
        server.db.sessions.insert({
          hostSessionId,
          scopeRef: grant.derivedScope,
          laneRef: 'main',
          generation: 1,
          status: 'active',
          createdAt: now,
          updatedAt: now,
        })
        server.db.continuities.upsert({
          scopeRef: grant.derivedScope,
          laneRef: 'main',
          activeHostSessionId: hostSessionId,
          updatedAt: now,
        })
        server.db.runtimeOperations.insert({
          operationId,
          runtimeId,
          hostSessionId,
          generation: 1,
          operationKind: 'broker_invocation',
          controller: 'harness-broker',
          startupMethod: 'epr.hello',
          turnDelivery: 'epr.input',
          status: 'completed',
          routeDecisionJson: JSON.stringify({
            origin: 'external-registration',
            lifecycleOwner: 'external',
          }),
          capabilityResolutionJson: JSON.stringify({
            participant: capabilities,
            turnsAllowed: grant.turnsAllowed,
            result: { status: 'admitted' },
          }),
          createdAt: now,
          startedAt: now,
          completedAt: now,
          updatedAt: now,
        })
        server.db.runtimes.insert({
          runtimeId,
          hostSessionId,
          scopeRef: grant.derivedScope,
          laneRef: 'main',
          generation: 1,
          transport: 'headless',
          // Compatibility columns predate generic external participants. These
          // campaign-canonical sentinel values are deliberately unknown to all
          // driver/provider selectors; lifecycleOwner is the behavior fence.
          harness: 'epr-external' as HrcHarness,
          provider: 'epr-external' as HrcProvider,
          status: 'ready',
          statusChangedAt: now,
          supportsInflightInput: false,
          controllerKind: 'harness-broker',
          activeOperationId: operationId,
          activeInvocationId: invocationId,
          selectedProfileHash: projectionHash,
          runtimeStateJson: {
            schemaVersion: 'runtime-state/v1',
            kind: 'harness-broker',
            runtimeId,
            hostSessionId,
            generation: 1,
            status: 'ready',
            origin: 'external-registration',
            lifecycleOwner: 'external',
            externalRegistration: {
              registrationId: grant.registrationId,
              classId: grant.classId,
              establishmentState: 'DELIVERY_PENDING',
              collectiveEstablishment: {
                state: 'PENDING',
                bindingState: 'UNBOUND',
                retryable: true,
                reason: 'post_mint_reconciliation_scheduled',
                updatedAt: now,
              },
              capabilities,
              participantInfo,
            },
            broker: {
              protocolVersion: EPR_PROTOCOL_VERSION,
              ownerServerInstanceId: `hrc-server:${process.pid}`,
              endpoint: {
                kind: 'unix-jsonrpc-ndjson',
                socketPath: grant.socketPath,
                attachTokenRef: { kind: 'file', path: token.attachTokenRef, redacted: true },
                protocolVersion: EPR_PROTOCOL_VERSION,
              },
              substrate: { kind: 'external' },
              presentation: { kind: 'none' },
            },
            invocation: {
              invocationId,
              state: 'ready',
              driver: 'external-participant',
              capabilities,
            },
          },
          createdAt: now,
          updatedAt: now,
        })
        server.db.brokerInvocations.insert({
          invocationId,
          operationId,
          runtimeId,
          brokerProtocol: EPR_PROTOCOL_VERSION,
          brokerDriver: 'external-participant',
          invocationState: 'ready',
          capabilitiesJson: JSON.stringify(capabilities),
          specHash: projectionHash,
          startRequestHash: projectionHash,
          selectedProfileHash: projectionHash,
          specProjectionJson: JSON.stringify({
            origin: 'external-registration',
            lifecycleOwner: 'external',
            substrate: 'external',
            endpoint: 'unix-jsonrpc-ndjson',
            presentation: 'none',
          }),
          startRequestProjectionJson: JSON.stringify(startProjection),
          ownerServerInstanceId: `hrc-server:${process.pid}`,
          createdAt: now,
          updatedAt: now,
        })
        server.db.externalRegistrationGrants.recordMint(grant.registrationId, {
          hostSessionId,
          runtimeId,
          operationId,
          invocationId,
          attachTokenRef: token.attachTokenRef,
          controllerInstanceId,
          capabilities,
          participantInfo,
        })
        return appendHrcEvent(server.db, 'session.created', {
          ts: now,
          hostSessionId,
          scopeRef: grant.derivedScope,
          laneRef: 'main',
          generation: 1,
          payload: { created: true },
        })
      })
      .immediate()

    if (birthEvent === undefined) {
      await rm(token.tokenDir, { recursive: true, force: true })
      return null
    }
    // EPR establishment can lose a reply and re-deliver, but its mint cannot
    // repeat: consume, session graph, and birth fact committed together.
    server.notifyEvent(birthEvent)
    const linked = server.db.externalRegistrationGrants.getByRegistrationId(grant.registrationId)
    if (linked === null) throw new Error(`minted registration ${grant.registrationId} disappeared`)
    assertMintLinkage(linked)
    if (linked.establishmentState !== 'DELIVERY_PENDING') {
      throw new Error(`new registration ${grant.registrationId} is not delivery pending`)
    }
    return {
      grant: { ...linked, establishmentState: 'DELIVERY_PENDING' },
      attachToken: token.attachToken,
    }
  } catch (error) {
    await rm(token.tokenDir, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
}

async function loadPendingMint(
  db: HrcDatabase,
  grant: ExternalRegistrationGrant
): Promise<MintedExternalRegistration> {
  assertMintLinkage(grant)
  if (grant.establishmentState !== 'DELIVERY_PENDING') {
    throw new Error(`registration ${grant.registrationId} is not delivery pending`)
  }
  const attachToken = (await readFile(grant.attachTokenRef, 'utf8')).trim()
  if (attachToken.length === 0) {
    throw new Error(`registration ${grant.registrationId} attach token is empty`)
  }
  if (db.runtimes.getByRuntimeId(grant.runtimeId) === null) {
    throw new Error(`registration ${grant.registrationId} runtime is missing`)
  }
  return { grant: { ...grant, establishmentState: 'DELIVERY_PENDING' }, attachToken }
}

function establishedDelivery(
  mint: MintedExternalRegistration,
  options: HrcServerInstanceForHandlers['options']
): EprEstablishedDelivery {
  return {
    invocationId: mint.grant.invocationId,
    runtimeId: mint.grant.runtimeId,
    derivedScope: mint.grant.derivedScope,
    attachToken: mint.attachToken,
    controllerInstanceId: mint.grant.controllerInstanceId,
    ackedThroughSeq: 0,
    lingerMs: options.externalParticipantLingerMs ?? DEFAULT_EXTERNAL_PARTICIPANT_LINGER_MS,
    probe: {
      intervalMs: options.externalParticipantProbeIntervalMs ?? DEFAULT_PROBE_INTERVAL_MS,
      deadlineMs: externalParticipantRpcDeadlineMs(options),
      failureThreshold:
        options.externalParticipantProbeFailureThreshold ?? DEFAULT_PROBE_FAILURE_THRESHOLD,
    },
  }
}

function validateEstablishedResponse(value: unknown): number {
  if (
    !isRecord(value) ||
    !exactKeys(value, ['ready', 'currentSeq']) ||
    value['ready'] !== true ||
    !Number.isInteger(value['currentSeq']) ||
    (value['currentSeq'] as number) < 0
  ) {
    // This is a delivery/ACK failure, not a §9.1 hello-validation refusal.
    // Keep the durable row DELIVERY_PENDING so the rendezvous controller
    // redials and re-delivers the same minted authority.
    throw annotateRpcError(
      new Error('epr.established response must be {ready:true,currentSeq:nonnegative integer}'),
      'epr.established',
      'invalid_response'
    )
  }
  return value['currentSeq'] as number
}

export async function performExternalRegistrationHello(
  server: HrcServerInstanceForHandlers,
  registrationId: string,
  client: ExternalParticipantRpcClient
): Promise<{ branch: 'minted' | 'redelivered'; delivery: EprEstablishedDelivery }> {
  const rpcDeadlineMs = externalParticipantRpcDeadlineMs(server.options)
  const rawHello = await requestExternalParticipantRpc(
    client,
    'epr.hello',
    {
      protocolVersions: [EPR_PROTOCOL_VERSION],
      controllerInfo: { name: 'hrc-server' },
      registrationId,
    },
    rpcDeadlineMs
  )
  const hello = parseEprHelloResponse(rawHello, registrationId)
  let grant = server.db.externalRegistrationGrants.getByRegistrationId(registrationId)
  if (grant === null) {
    throw new EprHelloError('unknown_registration', `registration ${registrationId} is unknown`)
  }
  const now = timestamp()
  validateCredentialAndClass(grant, hello, now)

  if (grant.consumed && registrationIsFinalized(server.db, grant)) {
    throw new EprHelloError(
      'registration_completed',
      `registration ${registrationId} has completed`
    )
  }
  if (grant.consumed && grant.establishmentState === 'ESTABLISHED') {
    throw new EprHelloError(
      'registration_established',
      `registration ${registrationId} is already established`
    )
  }

  let branch: 'minted' | 'redelivered'
  let mint: MintedExternalRegistration
  if (!grant.consumed) {
    const attempted = await mintExternalRegistration(server, grant, hello, now)
    if (attempted !== null) {
      branch = 'minted'
      mint = attempted
    } else {
      grant = server.db.externalRegistrationGrants.getByRegistrationId(registrationId)
      if (grant === null) {
        throw new EprHelloError('unknown_registration', `registration ${registrationId} is unknown`)
      }
      if (registrationIsFinalized(server.db, grant)) {
        throw new EprHelloError(
          'registration_completed',
          `registration ${registrationId} has completed`
        )
      }
      if (grant.establishmentState === 'ESTABLISHED') {
        throw new EprHelloError(
          'registration_established',
          `registration ${registrationId} is already established`
        )
      }
      branch = 'redelivered'
      mint = await loadPendingMint(server.db, grant)
    }
  } else {
    branch = 'redelivered'
    mint = await loadPendingMint(server.db, grant)
  }

  // Local presence is already durable. Collective authority is deliberately
  // best-effort and cannot delay or roll back identity delivery.
  scheduleExternalRegistrationCollectiveEstablishment(server, registrationId)

  const delivery = establishedDelivery(mint, server.options)
  const established = await requestExternalParticipantRpc(
    client,
    'epr.established',
    delivery,
    rpcDeadlineMs
  )
  validateEstablishedResponse(established)
  const establishedAt = timestamp()
  server.db.sqlite
    .transaction(() => {
      const changed = server.db.externalRegistrationGrants.markEstablished(
        registrationId,
        establishedAt
      )
      if (!changed) {
        const current = server.db.externalRegistrationGrants.getByRegistrationId(registrationId)
        if (current?.establishmentState !== 'ESTABLISHED') {
          throw new Error(`registration ${registrationId} lost its delivery-pending ACK fence`)
        }
      }
      const currentRuntime = server.db.runtimes.getByRuntimeId(delivery.runtimeId)
      if (currentRuntime?.runtimeStateJson !== undefined) {
        const state = structuredClone(currentRuntime.runtimeStateJson)
        const externalRegistration = state['externalRegistration']
        if (isRecord(externalRegistration)) {
          externalRegistration['establishmentState'] = 'ESTABLISHED'
          externalRegistration['establishedAt'] = establishedAt
          server.db.runtimes.update(delivery.runtimeId, {
            runtimeStateJson: state,
            updatedAt: establishedAt,
          })
        }
      }
    })
    .immediate()
  return { branch, delivery }
}
