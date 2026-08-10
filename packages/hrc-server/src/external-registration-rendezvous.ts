import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { dirname, join } from 'node:path'

import { parseScopeRef } from 'agent-scope'
import type { HrcHarness, HrcProvider } from 'hrc-core'
import type { ExternalRegistrationGrant, HrcDatabase } from 'hrc-store-sqlite'
import {
  type InvocationEventEnvelope,
  type InvocationSnapshot,
  validateEventEnvelope,
} from 'spaces-harness-broker-protocol'

import { runtimeStatusFromInvocationState } from './broker/runtime-state.js'
import { scheduleExternalRegistrationCollectiveEstablishment } from './external-registration-establishment.js'
import { appendHrcEvent } from './hrc-event-helper.js'
import { runtimeActivityPatch } from './runtime-activity.js'
import type { HrcServerInstanceForHandlers } from './server-instance-context.js'
import { writeServerLog } from './server-log.js'
import { createHostSessionId, isRuntimeUnavailableStatus, timestamp } from './server-util.js'
import { getBrokerIpcSocketPath } from './tmux-socket.js'

export const EPR_PROTOCOL_VERSION = 'epr/1'
export const EPR_HELLO_ERROR_CODE = {
  unknown_registration: -32050,
  credential_mismatch: -32051,
  grant_expired: -32052,
  protocol_unsupported: -32053,
  malformed_hello: -32054,
  registration_completed: -32058,
  registration_established: -32059,
} as const

export const EPR_REPLAY_UNAVAILABLE_CODE = -32013
export const EPR_CONTROLLER_FENCED_CODE = -32015
export const EPR_ATTACH_TOKEN_INVALID_CODE = -32055

export type EprHelloErrorName = keyof typeof EPR_HELLO_ERROR_CODE

export class EprHelloError extends Error {
  readonly code: number
  readonly eprError: EprHelloErrorName

  constructor(eprError: EprHelloErrorName, message: string) {
    super(message)
    this.name = 'EprHelloError'
    this.eprError = eprError
    this.code = EPR_HELLO_ERROR_CODE[eprError]
  }
}

export type ExternalParticipantCapabilities = {
  events: boolean
  turns: boolean
  continuations: boolean
}

export type ExternalParticipantInfo = {
  name: string
  version?: string | undefined
}

export type EprHelloResponse = {
  protocolVersion: typeof EPR_PROTOCOL_VERSION
  registrationId: string
  credential: string
  capabilities: ExternalParticipantCapabilities
  participantInfo: ExternalParticipantInfo
}

export type EprEstablishedDelivery = {
  invocationId: string
  runtimeId: string
  derivedScope: string
  attachToken: string
  controllerInstanceId: string
  ackedThroughSeq: number
  lingerMs: number
  probe: {
    intervalMs: number
    deadlineMs: number
    failureThreshold: number
  }
}

export type ExternalParticipantRpcClient = {
  request(method: string, params: Record<string, unknown>): Promise<unknown>
  notify(method: string, params: Record<string, unknown>): Promise<void>
  streamNotifications?(): AsyncIterable<ExternalParticipantNotification>
  waitForClose?(): Promise<void>
  close(): Promise<void>
}

export type ExternalParticipantNotification = {
  method: string
  params: unknown
}

export type ExternalParticipantClientFactory = (input: {
  socketPath: string
  timeoutMs?: number | undefined
}) => Promise<ExternalParticipantRpcClient>

const DEFAULT_CONNECT_TIMEOUT_MS = 2_000
const DEFAULT_RENDEZVOUS_RETRY_MS = 100
const DEFAULT_RENDEZVOUS_RETRY_MAX_MS = 2_000
const DEFAULT_RENDEZVOUS_RETRY_BUDGET = 5
export const DEFAULT_EXTERNAL_PARTICIPANT_LINGER_MS = 10 * 60 * 1_000
const DEFAULT_PROBE_INTERVAL_MS = 30_000
const DEFAULT_PROBE_DEADLINE_MS = 2_000
const DEFAULT_PROBE_FAILURE_THRESHOLD = 3

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = new Set(keys)
  return Object.keys(value).every((key) => expected.delete(key)) && expected.size === 0
}

function malformed(message: string): never {
  throw new EprHelloError('malformed_hello', message)
}

export function parseEprHelloResponse(
  input: unknown,
  expectedRegistrationId: string
): EprHelloResponse {
  if (!isRecord(input)) malformed('epr.hello response must be an object')
  if (
    !exactKeys(input, [
      'protocolVersion',
      'registrationId',
      'credential',
      'capabilities',
      'participantInfo',
    ])
  ) {
    malformed('epr.hello response has missing or unsupported fields')
  }
  if (input['protocolVersion'] !== EPR_PROTOCOL_VERSION) {
    throw new EprHelloError(
      'protocol_unsupported',
      `participant selected unsupported protocol ${String(input['protocolVersion'])}`
    )
  }
  if (input['registrationId'] !== expectedRegistrationId) {
    malformed('epr.hello registrationId does not match the requested registration')
  }
  if (typeof input['credential'] !== 'string' || input['credential'].length === 0) {
    malformed('epr.hello credential must be a non-empty string')
  }
  const capabilities = input['capabilities']
  if (
    !isRecord(capabilities) ||
    !exactKeys(capabilities, ['events', 'turns', 'continuations']) ||
    typeof capabilities['events'] !== 'boolean' ||
    typeof capabilities['turns'] !== 'boolean' ||
    typeof capabilities['continuations'] !== 'boolean'
  ) {
    malformed('epr.hello capabilities must contain exactly events, turns, and continuations')
  }
  const participantInfo = input['participantInfo']
  if (
    !isRecord(participantInfo) ||
    !Object.keys(participantInfo).every((key) => key === 'name' || key === 'version') ||
    typeof participantInfo['name'] !== 'string' ||
    participantInfo['name'].trim().length === 0 ||
    (participantInfo['version'] !== undefined && typeof participantInfo['version'] !== 'string')
  ) {
    malformed('epr.hello participantInfo must contain a name and optional version')
  }

  return {
    protocolVersion: EPR_PROTOCOL_VERSION,
    registrationId: expectedRegistrationId,
    credential: input['credential'],
    capabilities: {
      events: capabilities['events'],
      turns: capabilities['turns'],
      continuations: capabilities['continuations'],
    },
    participantInfo: {
      name: participantInfo['name'].trim(),
      ...(participantInfo['version'] === undefined ? {} : { version: participantInfo['version'] }),
    },
  }
}

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

function assertMintLinkage(
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

function registrationIsFinalized(db: HrcDatabase, grant: ExternalRegistrationGrant): boolean {
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
    const minted = server.db.sqlite
      .transaction((): boolean => {
        if (!server.db.externalRegistrationGrants.consumeIfAvailable(grant.registrationId, now)) {
          return false
        }
        const parsedScopeJson = parseScopeRef(grant.derivedScope) as unknown as Record<
          string,
          unknown
        >
        server.db.sessions.insert({
          hostSessionId,
          scopeRef: grant.derivedScope,
          laneRef: 'main',
          generation: 1,
          status: 'active',
          createdAt: now,
          updatedAt: now,
          parsedScopeJson,
          ancestorScopeRefs: [],
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
          runtimeKind: 'harness',
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
          adopted: false,
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
        return true
      })
      .immediate()

    if (!minted) {
      await rm(token.tokenDir, { recursive: true, force: true })
      return null
    }
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
      deadlineMs: options.externalParticipantProbeDeadlineMs ?? DEFAULT_PROBE_DEADLINE_MS,
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
  const rawHello = await requestExternalParticipantRpc(client, 'epr.hello', {
    protocolVersions: [EPR_PROTOCOL_VERSION],
    controllerInfo: { name: 'hrc-server' },
    registrationId,
  })
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
    delivery as unknown as Record<string, unknown>
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

type EprAttachment = {
  controllerInstanceId: string
  snapshot: InvocationSnapshot
  probe: EprEstablishedDelivery['probe']
  lingerMs: number
  terminal: boolean
}

class EprReplayGapError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EprReplayGapError'
  }
}

function rpcErrorCode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'number' ? code : undefined
}

type EprRpcFailureMetadata = {
  rpcMethod?: string | undefined
  failureCode?: string | undefined
}

function annotateRpcError(
  error: unknown,
  method: string,
  failureCode = 'transport_error'
): Error & EprRpcFailureMetadata {
  const normalized = error instanceof Error ? error : new Error(String(error))
  const annotated = normalized as Error & EprRpcFailureMetadata
  annotated.rpcMethod = method
  annotated.failureCode = failureCode
  return annotated
}

function rpcFailureMethod(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const method = (error as EprRpcFailureMetadata).rpcMethod
  return typeof method === 'string' ? method : undefined
}

function rpcFailureCode(error: unknown): number | string {
  const code = rpcErrorCode(error)
  if (code !== undefined) return code
  if (typeof error === 'object' && error !== null) {
    const failureCode = (error as EprRpcFailureMetadata).failureCode
    if (typeof failureCode === 'string') return failureCode
  }
  return 'internal_error'
}

async function requestExternalParticipantRpc(
  client: ExternalParticipantRpcClient,
  method: string,
  params: Record<string, unknown>
): Promise<unknown> {
  try {
    return await client.request(method, params)
  } catch (error) {
    throw annotateRpcError(error, method)
  }
}

async function requestReplayPlane(
  client: ExternalParticipantRpcClient,
  method: 'epr.reattach' | 'invocation.snapshot' | 'invocation.eventsSince',
  params: Record<string, unknown>
): Promise<unknown> {
  try {
    return await requestExternalParticipantRpc(client, method, params)
  } catch (error) {
    if (rpcErrorCode(error) === EPR_REPLAY_UNAVAILABLE_CODE) {
      throw new EprReplayGapError(`${method} reported that event replay is unavailable`)
    }
    throw error
  }
}

export function externalRegistrationRetryDelayMs(
  consecutiveFailures: number,
  baseMs = DEFAULT_RENDEZVOUS_RETRY_MS,
  maxMs = DEFAULT_RENDEZVOUS_RETRY_MAX_MS
): number {
  const cap = Number.isFinite(maxMs) ? Math.max(1, Math.trunc(maxMs)) : 1
  const base = Number.isFinite(baseMs) ? Math.min(cap, Math.max(1, Math.trunc(baseMs))) : cap
  const failureCount = Number.isFinite(consecutiveFailures) ? Math.trunc(consecutiveFailures) : 1
  const exponent = Math.max(0, Math.min(30, failureCount - 1))
  return Math.min(cap, base * 2 ** exponent)
}

async function withDeadline<T>(
  operation: Promise<T>,
  deadlineMs: number,
  label: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${deadlineMs}ms`)),
      deadlineMs
    )
    timer.unref?.()
  })
  try {
    return await Promise.race([operation, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function integerAtLeast(value: unknown, minimum: number, label: string): number {
  if (!Number.isInteger(value) || (value as number) < minimum) {
    throw new Error(`${label} must be an integer >= ${minimum}`)
  }
  return value as number
}

function parseInvocationSnapshot(value: unknown, invocationId: string): InvocationSnapshot {
  if (!isRecord(value) || value['invocationId'] !== invocationId) {
    throw new Error('invocation.snapshot returned the wrong invocation')
  }
  if (typeof value['state'] !== 'string' || !isRecord(value['capabilities'])) {
    throw new Error('invocation.snapshot has invalid state or capabilities')
  }
  integerAtLeast(value['currentSeq'], 0, 'invocation.snapshot currentSeq')
  integerAtLeast(value['retentionFloorSeq'], 0, 'invocation.snapshot retentionFloorSeq')
  if (
    !Array.isArray(value['pendingInputIds']) ||
    !isRecord(value['inputDispositions']) ||
    !Array.isArray(value['pendingPermissionRequests'])
  ) {
    throw new Error('invocation.snapshot has invalid durable read-model fields')
  }
  return value as unknown as InvocationSnapshot
}

function parseEventsSinceResponse(value: unknown): {
  events: InvocationEventEnvelope[]
  currentSeq: number
  retentionFloorSeq: number
} {
  if (!isRecord(value) || !Array.isArray(value['events'])) {
    throw new Error('invocation.eventsSince response must contain events')
  }
  return {
    events: value['events'].map((event) => validateEventEnvelope(event)),
    currentSeq: integerAtLeast(value['currentSeq'], 0, 'invocation.eventsSince currentSeq'),
    retentionFloorSeq: integerAtLeast(
      value['retentionFloorSeq'],
      0,
      'invocation.eventsSince retentionFloorSeq'
    ),
  }
}

function externalRegistrationState(
  runtimeStateJson: Record<string, unknown> | undefined
): Record<string, unknown> {
  const state = runtimeStateJson?.['externalRegistration']
  return isRecord(state) ? { ...state } : {}
}

function lastAckedExternalSeq(server: HrcServerInstanceForHandlers, runtimeId: string): number {
  const runtime = server.db.runtimes.getByRuntimeId(runtimeId)
  const state = runtime?.runtimeStateJson?.['externalRegistration']
  const value = isRecord(state) ? state['ackedThroughSeq'] : undefined
  return Number.isInteger(value) && (value as number) >= 0 ? (value as number) : 0
}

function writeExternalRegistrationState(
  server: HrcServerInstanceForHandlers,
  runtimeId: string,
  patch: Record<string, unknown>,
  now = timestamp()
): void {
  const runtime = server.db.runtimes.getByRuntimeId(runtimeId)
  if (runtime === null) throw new Error(`external runtime ${runtimeId} is missing`)
  const externalRegistration = externalRegistrationState(runtime.runtimeStateJson)
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete externalRegistration[key]
    else externalRegistration[key] = value
  }
  server.db.runtimes.update(runtimeId, {
    runtimeStateJson: {
      ...(runtime.runtimeStateJson ?? {}),
      externalRegistration,
      updatedAt: now,
    },
    updatedAt: now,
  })
}

export function markExternalParticipantDetached(
  server: HrcServerInstanceForHandlers,
  grant: ExternalRegistrationGrant,
  lingerMs: number,
  detail: Record<string, unknown> = {}
): void {
  assertMintLinkage(grant)
  const runtime = server.db.runtimes.getByRuntimeId(grant.runtimeId)
  if (runtime === null || registrationIsFinalized(server.db, grant)) return
  const current = externalRegistrationState(runtime.runtimeStateJson)
  const now = timestamp()
  const detachedAt =
    runtime.status === 'detached' && typeof current['detachedAt'] === 'string'
      ? current['detachedAt']
      : now
  const lingerDeadlineAt = new Date(Date.parse(detachedAt) + lingerMs).toISOString()
  server.db.runtimes.update(grant.runtimeId, {
    status: 'detached',
    statusChangedAt: runtime.status === 'detached' ? runtime.statusChangedAt : now,
    ...runtimeActivityPatch(server.db, grant.runtimeId, {
      source: 'housekeeping',
      updatedAt: now,
    }),
    runtimeStateJson: {
      ...(runtime.runtimeStateJson ?? {}),
      status: 'detached',
      updatedAt: now,
      control: { mode: 'epr', brokerAttached: false, ...detail },
      externalRegistration: { ...current, detachedAt, lingerDeadlineAt },
    },
  })
}

function finalizeExternalParticipant(
  server: HrcServerInstanceForHandlers,
  grant: ExternalRegistrationGrant,
  reason: 'replay_gap' | 'detached_expired'
): void {
  assertMintLinkage(grant)
  const runtime = server.db.runtimes.getByRuntimeId(grant.runtimeId)
  if (runtime === null || registrationIsFinalized(server.db, grant)) return
  const now = timestamp()
  const externalRegistration = externalRegistrationState(runtime.runtimeStateJson)
  server.db.brokerInvocations.update(grant.invocationId, {
    invocationState: 'failed',
    lifecycleTerminalReason: reason,
    updatedAt: now,
  })
  server.db.runtimes.update(grant.runtimeId, {
    status: 'terminated',
    statusChangedAt: now,
    lifecycleTerminalReason: reason,
    ...runtimeActivityPatch(server.db, grant.runtimeId, {
      source: 'housekeeping',
      updatedAt: now,
    }),
    runtimeStateJson: {
      ...(runtime.runtimeStateJson ?? {}),
      status: 'terminated',
      updatedAt: now,
      terminalReason: reason,
      control: { mode: 'epr', brokerAttached: false },
      externalRegistration: { ...externalRegistration, finalizedAt: now, finalReason: reason },
    },
  })
  const event = appendHrcEvent(server.db, 'runtime.terminated', {
    ts: now,
    hostSessionId: runtime.hostSessionId,
    scopeRef: runtime.scopeRef,
    laneRef: runtime.laneRef,
    generation: runtime.generation,
    runtimeId: runtime.runtimeId,
    transport: 'headless',
    payload: { reason, invocationId: grant.invocationId },
  })
  server.ctx?.notifyEvent(event)
}

function lingerDeadlineMs(
  server: HrcServerInstanceForHandlers,
  grant: ExternalRegistrationGrant,
  lingerMs: number
): number | undefined {
  if (grant.runtimeId === undefined) return undefined
  const runtime = server.db.runtimes.getByRuntimeId(grant.runtimeId)
  const state = runtime?.runtimeStateJson?.['externalRegistration']
  const deadline = isRecord(state) ? state['lingerDeadlineAt'] : undefined
  if (typeof deadline === 'string') return Date.parse(deadline)
  if (runtime?.status === 'detached') return Date.now() + lingerMs
  return undefined
}

async function projectReplayAndAck(
  server: HrcServerInstanceForHandlers,
  grant: ExternalRegistrationGrant,
  client: ExternalParticipantRpcClient,
  controllerInstanceId: string
): Promise<{ throughSeq: number; cleanExit: boolean }> {
  assertMintLinkage(grant)
  const lastAckedSeq = lastAckedExternalSeq(server, grant.runtimeId)
  const rawReplay = await requestReplayPlane(client, 'invocation.eventsSince', {
    invocationId: grant.invocationId,
    afterSeq: lastAckedSeq,
  })
  const replay = parseEventsSinceResponse(rawReplay)
  if (lastAckedSeq < replay.retentionFloorSeq) {
    throw new EprReplayGapError(
      `last ACK ${lastAckedSeq} is below retention floor ${replay.retentionFloorSeq}`
    )
  }

  let throughSeq = lastAckedSeq
  let cleanExit = false
  for (const envelope of replay.events) {
    if (String(envelope.invocationId) !== grant.invocationId) {
      throw new Error('participant replay crossed invocation identity')
    }
    if (envelope.seq <= throughSeq) continue
    if (envelope.seq !== throughSeq + 1) {
      throw new Error(`participant replay is not contiguous at seq ${envelope.seq}`)
    }
    if (throughSeq === 0 && envelope.type !== 'invocation.started') {
      throw new Error('first external participant event must be invocation.started')
    }
    const controller = server.harnessBrokerController ?? server.getHarnessBrokerController()
    await controller.projectExternalParticipantEvent(grant.runtimeId, envelope)
    throughSeq = envelope.seq
    cleanExit ||= envelope.type === 'invocation.exited'
  }
  if (throughSeq !== replay.currentSeq) {
    throw new Error(
      `participant replay ended at ${throughSeq}, behind declared currentSeq ${replay.currentSeq}`
    )
  }
  if (throughSeq > lastAckedSeq) {
    const ack = await requestExternalParticipantRpc(client, 'invocation.ackEvents', {
      invocationId: grant.invocationId,
      throughSeq,
      controllerInstanceId,
    })
    if (!isRecord(ack) || ack['ackedThroughSeq'] !== throughSeq) {
      throw new Error('invocation.ackEvents did not acknowledge the replay high-water')
    }
    writeExternalRegistrationState(server, grant.runtimeId, { ackedThroughSeq: throughSeq })
  }
  return { throughSeq, cleanExit }
}

async function probeAttachedControl(
  client: ExternalParticipantRpcClient,
  invocationId: string,
  deadlineMs: number,
  full: boolean
): Promise<void> {
  if (full) {
    const health = await withDeadline(
      requestExternalParticipantRpc(client, 'broker.health', { probeDrivers: false }),
      deadlineMs,
      'broker.health'
    )
    if (!isRecord(health) || !Number.isInteger(health['activeInvocations'])) {
      throw new Error('broker.health returned a malformed response')
    }
    if (health['status'] === 'shutting_down') throw new Error('participant is shutting down')
    if (health['status'] !== 'ok' && health['status'] !== 'degraded') {
      throw new Error(`participant health status is ${String(health['status'])}`)
    }
  }
  const status = await withDeadline(
    requestExternalParticipantRpc(client, 'invocation.status', { invocationId }),
    deadlineMs,
    'invocation.status'
  )
  if (
    !isRecord(status) ||
    status['invocationId'] !== invocationId ||
    typeof status['state'] !== 'string'
  ) {
    throw new Error('invocation.status returned the wrong invocation')
  }
}

function parseReattachResponse(
  value: unknown,
  invocationId: string
): { snapshot: InvocationSnapshot; currentSeq: number; retentionFloorSeq: number } {
  if (
    !isRecord(value) ||
    value['attached'] !== true ||
    typeof value['participantInstanceId'] !== 'string'
  ) {
    throw new Error('epr.reattach returned a malformed response')
  }
  return {
    snapshot: parseInvocationSnapshot(value['snapshot'], invocationId),
    currentSeq: integerAtLeast(value['currentSeq'], 0, 'epr.reattach currentSeq'),
    retentionFloorSeq: integerAtLeast(
      value['retentionFloorSeq'],
      0,
      'epr.reattach retentionFloorSeq'
    ),
  }
}

export async function performExternalParticipantAttach(
  server: HrcServerInstanceForHandlers,
  registrationId: string,
  client: ExternalParticipantRpcClient,
  mode: 'established' | 'reattach'
): Promise<EprAttachment> {
  const grant = server.db.externalRegistrationGrants.getByRegistrationId(registrationId)
  if (grant === null) throw new Error(`registration ${registrationId} is unknown`)
  assertMintLinkage(grant)
  const probe: EprEstablishedDelivery['probe'] = {
    intervalMs: server.options.externalParticipantProbeIntervalMs ?? DEFAULT_PROBE_INTERVAL_MS,
    deadlineMs: server.options.externalParticipantProbeDeadlineMs ?? DEFAULT_PROBE_DEADLINE_MS,
    failureThreshold:
      server.options.externalParticipantProbeFailureThreshold ?? DEFAULT_PROBE_FAILURE_THRESHOLD,
  }
  const lingerMs =
    server.options.externalParticipantLingerMs ?? DEFAULT_EXTERNAL_PARTICIPANT_LINGER_MS
  let controllerInstanceId = grant.controllerInstanceId
  let snapshot: InvocationSnapshot

  try {
    if (mode === 'reattach') {
      controllerInstanceId = `controller-${randomUUID()}`
      const attachToken = (await readFile(grant.attachTokenRef, 'utf8')).trim()
      const attached = await requestReplayPlane(client, 'epr.reattach', {
        registrationId,
        invocationId: grant.invocationId,
        attachToken,
        controllerInstanceId,
        lastAckedSeq: lastAckedExternalSeq(server, grant.runtimeId),
      })
      const response = parseReattachResponse(attached, grant.invocationId)
      if (lastAckedExternalSeq(server, grant.runtimeId) < response.retentionFloorSeq) {
        throw new EprReplayGapError('reattach retention floor is past HRC ACK high-water')
      }
      snapshot = response.snapshot
      if (
        !server.db.externalRegistrationGrants.updateControllerInstanceId(
          registrationId,
          controllerInstanceId
        )
      ) {
        throw new Error(`registration ${registrationId} lost its established controller fence`)
      }
      writeExternalRegistrationState(server, grant.runtimeId, { controllerInstanceId })
    } else {
      const rawSnapshot = await requestReplayPlane(client, 'invocation.snapshot', {
        invocationId: grant.invocationId,
      })
      snapshot = parseInvocationSnapshot(rawSnapshot, grant.invocationId)
    }

    const replay = await projectReplayAndAck(server, grant, client, controllerInstanceId)
    if (replay.cleanExit) return { controllerInstanceId, snapshot, probe, lingerMs, terminal: true }
  } catch (error) {
    if (error instanceof EprReplayGapError) {
      finalizeExternalParticipant(server, grant, 'replay_gap')
    }
    throw error
  }
  await probeAttachedControl(client, grant.invocationId, probe.deadlineMs, true)

  const runtime = server.db.runtimes.getByRuntimeId(grant.runtimeId)
  if (runtime === null || registrationIsFinalized(server.db, grant)) {
    return { controllerInstanceId, snapshot, probe, lingerMs, terminal: true }
  }
  const now = timestamp()
  const status = runtimeStatusFromInvocationState(snapshot.state)
  const externalRegistration = externalRegistrationState(runtime.runtimeStateJson)
  externalRegistration['detachedAt'] = undefined
  externalRegistration['lingerDeadlineAt'] = undefined
  server.db.brokerInvocations.update(grant.invocationId, {
    invocationState: snapshot.state,
    capabilitiesJson: JSON.stringify(snapshot.capabilities),
    ownerServerInstanceId: controllerInstanceId,
    updatedAt: now,
  })
  server.db.runtimes.update(grant.runtimeId, {
    status,
    statusChangedAt: now,
    runtimeStateJson: {
      ...(runtime.runtimeStateJson ?? {}),
      status,
      updatedAt: now,
      control: { mode: 'epr', brokerAttached: true },
      externalRegistration: {
        ...externalRegistration,
        controllerInstanceId,
        ackedThroughSeq: lastAckedExternalSeq(server, grant.runtimeId),
        attachedAt: now,
      },
    },
    updatedAt: now,
  })
  return { controllerInstanceId, snapshot, probe, lingerMs, terminal: false }
}

class ExternalParticipantNotificationQueue
  implements AsyncIterable<ExternalParticipantNotification>
{
  private readonly buffered: ExternalParticipantNotification[] = []
  private readonly waiters: Array<
    (value: IteratorResult<ExternalParticipantNotification>) => void
  > = []
  private ended = false

  push(notification: ExternalParticipantNotification): void {
    if (this.ended) return
    const waiter = this.waiters.shift()
    if (waiter !== undefined) waiter({ done: false, value: notification })
    else this.buffered.push(notification)
  }

  end(): void {
    if (this.ended) return
    this.ended = true
    for (const waiter of this.waiters.splice(0)) waiter({ done: true, value: undefined })
  }

  [Symbol.asyncIterator](): AsyncIterator<ExternalParticipantNotification> {
    return {
      next: async () => {
        const notification = this.buffered.shift()
        if (notification !== undefined) return { done: false, value: notification }
        if (this.ended) return { done: true, value: undefined }
        return new Promise((resolve) => this.waiters.push(resolve))
      },
    }
  }
}

class NdjsonExternalParticipantClient implements ExternalParticipantRpcClient {
  private readonly pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void }
  >()
  private nextId = 1
  private buffer = ''
  private closed = false
  private readonly notificationQueue = new ExternalParticipantNotificationQueue()
  private readonly closedPromise: Promise<void>
  private resolveClosed!: () => void

  constructor(private readonly socket: import('node:net').Socket) {
    this.closedPromise = new Promise((resolve) => {
      this.resolveClosed = resolve
    })
    socket.setEncoding('utf8')
    socket.on('data', (chunk) => this.onData(String(chunk)))
    socket.on('error', (error) => this.failAll(error))
    socket.on('close', () => this.failAll(new Error('external participant socket closed')))
  }

  request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('external participant socket is closed'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.socket.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`, (error) => {
        if (error === null || error === undefined) return
        this.pending.delete(id)
        reject(error)
      })
    })
  }

  notify(method: string, params: Record<string, unknown>): Promise<void> {
    if (this.closed) return Promise.reject(new Error('external participant socket is closed'))
    return new Promise((resolve, reject) => {
      this.socket.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`, (error) => {
        if (error === null || error === undefined) resolve()
        else reject(error)
      })
    })
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.socket.destroy()
    this.failAll(new Error('external participant client closed'))
  }

  streamNotifications(): AsyncIterable<ExternalParticipantNotification> {
    return this.notificationQueue
  }

  waitForClose(): Promise<void> {
    return this.closedPromise
  }

  private onData(chunk: string): void {
    this.buffer += chunk
    while (true) {
      const newline = this.buffer.indexOf('\n')
      if (newline < 0) return
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (line.length === 0) continue
      let message: unknown
      try {
        message = JSON.parse(line)
      } catch {
        this.failAll(new Error('external participant sent invalid JSON'))
        this.socket.destroy()
        return
      }
      if (!isRecord(message)) continue
      if (!Number.isInteger(message['id'])) {
        if (
          message['jsonrpc'] === '2.0' &&
          typeof message['method'] === 'string' &&
          !Object.hasOwn(message, 'id')
        ) {
          this.notificationQueue.push({
            method: message['method'],
            params: message['params'],
          })
        }
        continue
      }
      const pending = this.pending.get(message['id'] as number)
      if (pending === undefined) continue
      this.pending.delete(message['id'] as number)
      if (isRecord(message['error'])) {
        const code = message['error']['code']
        const detail = message['error']['message']
        const error = new Error(
          `external participant RPC ${String(code)}: ${typeof detail === 'string' ? detail : 'error'}`
        ) as Error & { code?: number }
        if (typeof code === 'number') error.code = code
        pending.reject(error)
      } else if ('result' in message) {
        pending.resolve(message['result'])
      } else {
        pending.reject(new Error('external participant sent malformed JSON-RPC response'))
      }
    }
  }

  private failAll(error: Error): void {
    if (!this.closed) this.closed = true
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
    this.notificationQueue.end()
    this.resolveClosed()
  }
}

export const connectExternalParticipant: ExternalParticipantClientFactory = ({
  socketPath,
  timeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
}) =>
  new Promise((resolve, reject) => {
    const socket = createConnection(socketPath)
    const timeout = setTimeout(() => {
      socket.destroy()
      reject(new Error(`timed out connecting to external participant at ${socketPath}`))
    }, timeoutMs)
    socket.once('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    socket.once('connect', () => {
      clearTimeout(timeout)
      resolve(new NdjsonExternalParticipantClient(socket))
    })
  })

function waitForRetry(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

async function consumeExternalParticipantNotifications(
  server: HrcServerInstanceForHandlers,
  grant: ExternalRegistrationGrant,
  client: ExternalParticipantRpcClient,
  controllerInstanceId: string
): Promise<'clean-exit' | 'stream-ended'> {
  if (client.streamNotifications === undefined) return 'stream-ended'
  for await (const notification of client.streamNotifications()) {
    if (notification.method !== 'invocation.event') {
      throw new Error(`unsupported external participant notification ${notification.method}`)
    }
    const envelope = validateEventEnvelope(notification.params)
    if (String(envelope.invocationId) !== grant.invocationId) {
      throw new Error('external participant notification crossed invocation identity')
    }
    const replay = await projectReplayAndAck(server, grant, client, controllerInstanceId)
    if (replay.cleanExit) return 'clean-exit'
  }
  return 'stream-ended'
}

async function runPeriodicExternalParticipantProbe(
  grant: ExternalRegistrationGrant,
  client: ExternalParticipantRpcClient,
  probe: EprEstablishedDelivery['probe']
): Promise<'probe-failed' | 'transport-closed'> {
  assertMintLinkage(grant)
  let consecutiveFailures = 0
  while (true) {
    if (client.waitForClose !== undefined) {
      const outcome = await Promise.race([
        waitForRetry(probe.intervalMs).then(() => 'interval' as const),
        client.waitForClose().then(() => 'closed' as const),
      ])
      if (outcome === 'closed') return 'transport-closed'
    } else {
      await waitForRetry(probe.intervalMs)
    }
    try {
      await probeAttachedControl(client, grant.invocationId, probe.deadlineMs, false)
      consecutiveFailures = 0
    } catch (error) {
      consecutiveFailures += 1
      writeServerLog('WARN', 'external_registration.probe_failed', {
        registrationId: grant.registrationId,
        runtimeId: grant.runtimeId,
        invocationId: grant.invocationId,
        consecutiveFailures,
        failureThreshold: probe.failureThreshold,
        error: error instanceof Error ? error.message : String(error),
      })
      if (consecutiveFailures >= probe.failureThreshold) {
        await client.close().catch(() => undefined)
        return 'probe-failed'
      }
    }
  }
}

async function maintainExternalParticipantAttachment(
  server: HrcServerInstanceForHandlers,
  grant: ExternalRegistrationGrant,
  client: ExternalParticipantRpcClient,
  attachment: EprAttachment
): Promise<{ terminal: boolean; detail: Record<string, unknown> }> {
  if (client.streamNotifications === undefined || client.waitForClose === undefined) {
    // Structural test doubles used by A2 stop at identity delivery. The real
    // NDJSON client always exposes both long-lived surfaces.
    return { terminal: true, detail: { reason: 'non_streaming_test_client' } }
  }
  const notifications = consumeExternalParticipantNotifications(
    server,
    grant,
    client,
    attachment.controllerInstanceId
  ).then(
    (outcome) => ({ source: 'notifications' as const, outcome }),
    (error: unknown) => ({ source: 'notifications-error' as const, error })
  )
  const closed = client.waitForClose().then(() => ({ source: 'closed' as const }))
  const probes = runPeriodicExternalParticipantProbe(grant, client, attachment.probe).then(
    (outcome) => ({ source: 'probe' as const, outcome })
  )
  let outcome = await Promise.race([notifications, closed, probes])
  if (outcome.source === 'closed') {
    const drained = await notifications
    if (drained.source === 'notifications' && drained.outcome === 'clean-exit') outcome = drained
  }
  if (outcome.source === 'notifications' && outcome.outcome === 'clean-exit') {
    await client.close().catch(() => undefined)
    return { terminal: true, detail: { reason: 'external_participant_exit' } }
  }
  if (outcome.source === 'notifications-error') {
    await client.close().catch(() => undefined)
    return {
      terminal: false,
      detail: {
        reason: 'event_stream_error',
        error: outcome.error instanceof Error ? outcome.error.message : String(outcome.error),
        ...(rpcErrorCode(outcome.error) === EPR_CONTROLLER_FENCED_CODE
          ? { code: EPR_CONTROLLER_FENCED_CODE }
          : {}),
      },
    }
  }
  return {
    terminal: false,
    detail: {
      reason:
        outcome.source === 'probe' && outcome.outcome === 'probe-failed'
          ? 'probe_failure_threshold'
          : 'transport_closed',
    },
  }
}

export async function runExternalRegistrationRendezvous(
  this: HrcServerInstanceForHandlers,
  registrationId: string
): Promise<void> {
  const factory = this.options.externalParticipantClientFactory ?? connectExternalParticipant
  const retryBaseMs =
    this.options.externalParticipantRendezvousRetryMs ?? DEFAULT_RENDEZVOUS_RETRY_MS
  const retryMaxMs =
    this.options.externalParticipantRendezvousRetryMaxMs ?? DEFAULT_RENDEZVOUS_RETRY_MAX_MS
  const retryBudget = Math.max(
    1,
    Math.trunc(
      this.options.externalParticipantRendezvousRetryBudget ?? DEFAULT_RENDEZVOUS_RETRY_BUDGET
    )
  )
  const lingerMs =
    this.options.externalParticipantLingerMs ?? DEFAULT_EXTERNAL_PARTICIPANT_LINGER_MS
  let consecutiveFailures = 0
  while (!this.stopping) {
    const grant = this.db.externalRegistrationGrants.getByRegistrationId(registrationId)
    if (grant === null || (!grant.consumed && grant.expiresAt <= timestamp())) return
    if (registrationIsFinalized(this.db, grant)) return
    if (grant.consumed) {
      assertMintLinkage(grant)
      const runtime = this.db.runtimes.getByRuntimeId(grant.runtimeId)
      if (runtime === null) return
      if (runtime.status === 'detached') {
        const deadline = lingerDeadlineMs(this, grant, lingerMs)
        if (deadline !== undefined && Date.now() >= deadline) {
          finalizeExternalParticipant(this, grant, 'detached_expired')
          return
        }
      } else if (grant.establishmentState === 'ESTABLISHED') {
        return
      }
    }
    const dialMode = grant.establishmentState === 'ESTABLISHED' ? 'reattach' : 'established'

    let client: ExternalParticipantRpcClient | undefined
    let activeMethod = 'connect'
    try {
      client = await factory({
        socketPath: grant.socketPath,
        timeoutMs: DEFAULT_CONNECT_TIMEOUT_MS,
      })
      this.externalParticipantClients.set(registrationId, client)
      const mode = dialMode
      let runtimeId: string
      let invocationId: string
      if (mode === 'established') {
        activeMethod = 'epr.hello'
        const result = await performExternalRegistrationHello(this, registrationId, client)
        runtimeId = result.delivery.runtimeId
        invocationId = result.delivery.invocationId
        writeServerLog('INFO', 'external_registration.established', {
          registrationId,
          branch: result.branch,
          runtimeId,
          invocationId,
        })
      } else {
        activeMethod = 'epr.reattach'
        const current = this.db.externalRegistrationGrants.getByRegistrationId(registrationId)
        if (current === null) throw new Error(`registration ${registrationId} disappeared`)
        assertMintLinkage(current)
        runtimeId = current.runtimeId
        invocationId = current.invocationId
      }
      if (client.streamNotifications === undefined || client.waitForClose === undefined) {
        this.externalParticipantClients.delete(registrationId)
        return
      }
      activeMethod = mode === 'established' ? 'invocation.snapshot' : 'epr.reattach'
      const attachment = await performExternalParticipantAttach(this, registrationId, client, mode)
      if (attachment.terminal) {
        await client.close().catch(() => undefined)
        this.externalParticipantClients.delete(registrationId)
        return
      }
      writeServerLog('INFO', 'external_registration.attached', {
        registrationId,
        runtimeId,
        invocationId,
        mode,
        ackedThroughSeq: lastAckedExternalSeq(this, runtimeId),
      })
      consecutiveFailures = 0
      const attachedGrant = this.db.externalRegistrationGrants.getByRegistrationId(registrationId)
      if (attachedGrant === null) {
        await client.close().catch(() => undefined)
        this.externalParticipantClients.delete(registrationId)
        return
      }
      activeMethod = 'invocation.eventsSince'
      const maintained = await maintainExternalParticipantAttachment(
        this,
        attachedGrant,
        client,
        attachment
      )
      if (maintained.terminal || this.stopping) {
        this.externalParticipantClients.delete(registrationId)
        return
      }
      markExternalParticipantDetached(this, attachedGrant, attachment.lingerMs, maintained.detail)
    } catch (error) {
      consecutiveFailures += 1
      if (client !== undefined && error instanceof EprHelloError) {
        await client
          .notify('epr.rejected', {
            registrationId,
            code: error.code,
            eprError: error.eprError,
            ...(error.eprError === 'registration_established' ? { data: { reattach: true } } : {}),
          })
          .catch(() => undefined)
      }
      await client?.close().catch(() => undefined)
      if (client !== undefined && this.externalParticipantClients.get(registrationId) === client) {
        this.externalParticipantClients.delete(registrationId)
      }
      if (error instanceof EprHelloError) {
        return
      }
      if (error instanceof EprReplayGapError) {
        writeServerLog('WARN', 'external_registration.replay_gap', {
          registrationId,
          error: error.message,
        })
        return
      }
      const latest = this.db.externalRegistrationGrants.getByRegistrationId(registrationId)
      if (
        latest?.consumed === true &&
        !registrationIsFinalized(this.db, latest) &&
        (latest.establishmentState === 'ESTABLISHED' || consecutiveFailures >= retryBudget)
      ) {
        assertMintLinkage(latest)
        markExternalParticipantDetached(this, latest, lingerMs, {
          reason:
            latest.establishmentState === 'DELIVERY_PENDING' ? 'delivery_timeout' : 'attach_failed',
          error: error instanceof Error ? error.message : String(error),
        })
      }
      const retryInMs = externalRegistrationRetryDelayMs(
        consecutiveFailures,
        retryBaseMs,
        retryMaxMs
      )
      writeServerLog('WARN', 'external_registration.rendezvous_retry', {
        registrationId,
        method: rpcFailureMethod(error) ?? activeMethod,
        code: rpcFailureCode(error),
        error: error instanceof Error ? error.message : String(error),
        consecutiveFailures,
        retryBudget,
        retryInMs,
        ...(error instanceof EprHelloError ? { code: error.code, eprError: error.eprError } : {}),
      })
    }
    if (client !== undefined && this.externalParticipantClients.get(registrationId) === client) {
      this.externalParticipantClients.delete(registrationId)
    }
    if (!this.stopping) {
      await waitForRetry(
        externalRegistrationRetryDelayMs(consecutiveFailures, retryBaseMs, retryMaxMs)
      )
    }
  }
}

export function scheduleExternalRegistrationRendezvous(
  this: HrcServerInstanceForHandlers,
  registrationId: string
): void {
  if (this.externalRegistrationOperations.has(registrationId)) return
  const operation = this.runExternalRegistrationRendezvous(registrationId).finally(() => {
    this.externalRegistrationOperations.delete(registrationId)
  })
  this.externalRegistrationOperations.set(registrationId, operation)
}

export const externalRegistrationRendezvousMethods = {
  runExternalRegistrationRendezvous,
  scheduleExternalRegistrationRendezvous,
}

export type ExternalRegistrationRendezvousMethods = typeof externalRegistrationRendezvousMethods
