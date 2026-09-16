import type { ParticipantAttempt, ParticipantRegistration } from 'hrc-store-sqlite'
import type { BrokerHelloRequest, BrokerHelloResponse } from 'spaces-harness-broker-protocol'
import type { WriterEvidence, WriterSubject } from 'spaces-runtime-contracts'

import { connectObservedBrokerUnixClient } from './broker/client-observability.js'
import { BROKER_PROTOCOL_VERSION } from './broker/constants.js'
import type { DurableBrokerClientLike } from './broker/controller.js'
import type { HrcServerInstanceForHandlers } from './server-instance-context.js'
import { timestamp } from './server-util.js'

export const PARTICIPANT_TRANSPORT_PROBE_TIMEOUT_MS = 2_000

type ParticipantTransportProbeOutcome = 'dead' | 'live' | 'indeterminate'

export type ParticipantTransportEvidenceObservation = {
  outcome: ParticipantTransportProbeOutcome
  evidence: WriterEvidence
}

const DEAD_TRANSPORT_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ENOENT', 'EPIPE'])

function errorRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

function isDeadTransportError(error: unknown): boolean {
  let current: unknown = error
  const visited = new Set<unknown>()
  while (current !== undefined && current !== null && !visited.has(current)) {
    visited.add(current)
    const record = errorRecord(current)
    const code = record?.['code']
    if (typeof code === 'string' && DEAD_TRANSPORT_CODES.has(code)) return true
    const message = current instanceof Error ? current.message : String(current)
    if (
      /\b(?:ECONNREFUSED|ECONNRESET|ENOENT|EPIPE)\b/.test(message) ||
      /broker (?:socket|transport) closed(?: unexpectedly)?/i.test(message)
    ) {
      return true
    }
    current = record?.['cause'] ?? record?.['causeError']
  }
  return false
}

function brokerInstanceId(attempt: ParticipantAttempt): string | undefined {
  if (attempt.brokerIdentityJson === undefined) return undefined
  try {
    const value = JSON.parse(attempt.brokerIdentityJson) as { brokerInstanceId?: unknown }
    return typeof value.brokerInstanceId === 'string' && value.brokerInstanceId.length > 0
      ? value.brokerInstanceId
      : undefined
  } catch {
    return undefined
  }
}

function transportEvidence(
  registration: ParticipantRegistration,
  attempt: ParticipantAttempt,
  subject: WriterSubject,
  endpoint: string | undefined,
  outcome: ParticipantTransportProbeOutcome,
  detail: string
): WriterEvidence {
  const observedAt = timestamp()
  const observationDetail = {
    basis: 'transport',
    probedEndpoint: endpoint ?? null,
    detail,
  }
  const instanceId = brokerInstanceId(attempt)
  return {
    schemaVersion: 'writer-evidence/v1',
    writerRef: {
      subject,
      classId: registration.classId ?? 'hrc-direct-registration',
      participantKey: registration.participantKey ?? registration.registrationId,
      attemptId: attempt.attemptId,
      invocationId: attempt.invocationId as WriterEvidence['writerRef']['invocationId'],
      attachEpoch: attempt.attachEpoch,
      ...(subject === 'bridge' && instanceId !== undefined ? { brokerInstanceId: instanceId } : {}),
      ...(subject === 'host' && registration.hostIncarnationId !== undefined
        ? { hostIncarnationId: registration.hostIncarnationId }
        : {}),
    },
    observedAt,
    writePath:
      outcome === 'live'
        ? { state: 'writable', reason: 'transport_live', detail: observationDetail }
        : {
            state: 'unknown',
            reason: outcome === 'dead' ? 'transport_dead' : 'transport_indeterminate',
            detail: observationDetail,
          },
    liveness: {
      state: outcome === 'dead' ? 'dead' : outcome === 'live' ? 'live' : 'unknown',
      reason:
        outcome === 'dead'
          ? 'transport_dead'
          : outcome === 'live'
            ? 'transport_live'
            : 'transport_indeterminate',
      detail: observationDetail,
    },
    priorRecovery: {
      state: 'unknown',
      reason: 'transport probe does not observe predecessor recovery',
      detail: observationDetail,
    },
  }
}

function withDeadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('participant_transport_probe_timeout')),
      timeoutMs
    )
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

/**
 * Probe the predecessor through a fresh Unix connection. The controller's
 * cached client is deliberately not consulted: only a new connection followed
 * by the published broker hello can establish current transport liveness.
 */
export async function observeParticipantTransportEvidence(
  server: HrcServerInstanceForHandlers,
  registration: ParticipantRegistration,
  attempt: ParticipantAttempt,
  subject: WriterSubject
): Promise<ParticipantTransportEvidenceObservation> {
  const endpoint = attempt.attachSocketPath
  if (endpoint === undefined) {
    return {
      outcome: 'indeterminate',
      evidence: transportEvidence(
        registration,
        attempt,
        subject,
        endpoint,
        'indeterminate',
        'predecessor has no durable attach socket path'
      ),
    }
  }

  const startedAt = Date.now()
  const factory =
    server.brokerUnixClientFactory ??
    ((options: { socketPath: string; timeoutMs?: number | undefined }) =>
      connectObservedBrokerUnixClient(options) as Promise<DurableBrokerClientLike>)
  let client: DurableBrokerClientLike | undefined
  try {
    client = await factory({
      socketPath: endpoint,
      timeoutMs: PARTICIPANT_TRANSPORT_PROBE_TIMEOUT_MS,
    })
    const remainingMs = Math.max(
      1,
      PARTICIPANT_TRANSPORT_PROBE_TIMEOUT_MS - (Date.now() - startedAt)
    )
    const request: BrokerHelloRequest = {
      clientInfo: { name: 'hrc-server' },
      protocolVersions: [BROKER_PROTOCOL_VERSION],
      capabilities: { permissionRequests: true },
    }
    await withDeadline<BrokerHelloResponse>(client.hello(request), remainingMs)
    return {
      outcome: 'live',
      evidence: transportEvidence(
        registration,
        attempt,
        subject,
        endpoint,
        'live',
        'fresh connection completed broker hello'
      ),
    }
  } catch (error) {
    const outcome = isDeadTransportError(error) ? 'dead' : 'indeterminate'
    return {
      outcome,
      evidence: transportEvidence(
        registration,
        attempt,
        subject,
        endpoint,
        outcome,
        error instanceof Error ? error.message : String(error)
      ),
    }
  } finally {
    await client?.close().catch(() => undefined)
  }
}
