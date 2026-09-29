import type { HrcServerInstanceForHandlers } from './server-instance-context.js'

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

export const DEFAULT_CONNECT_TIMEOUT_MS = 2_000
export const DEFAULT_RENDEZVOUS_RETRY_MS = 100
export const DEFAULT_RENDEZVOUS_RETRY_MAX_MS = 2_000
export const DEFAULT_RENDEZVOUS_RETRY_BUDGET = 5
export const DEFAULT_EXTERNAL_PARTICIPANT_LINGER_MS = 10 * 60 * 1_000
export const DEFAULT_PROBE_INTERVAL_MS = 30_000
const DEFAULT_PROBE_DEADLINE_MS = 2_000
export const DEFAULT_PROBE_FAILURE_THRESHOLD = 3
// The socket is untrusted. Retain at most one reasonably large JSON-RPC frame
// and a finite burst of event hints for a consumer that is temporarily busy.
export const MAX_EXTERNAL_PARTICIPANT_NDJSON_LINE_BYTES = 1024 * 1024
export const MAX_EXTERNAL_PARTICIPANT_BUFFERED_NOTIFICATIONS = 1024

export function externalParticipantRpcDeadlineMs(
  options: HrcServerInstanceForHandlers['options']
): number {
  return options.externalParticipantProbeDeadlineMs ?? DEFAULT_PROBE_DEADLINE_MS
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = new Set(keys)
  return Object.keys(value).every((key) => expected.delete(key)) && expected.size === 0
}

export function malformed(message: string): never {
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
