/**
 * Envelope predicates and shared projection types for the BrokerEventMapper.
 *
 * Extracted verbatim from event-mapper.ts as a pure mechanical move.
 */
import type { HrcProviderTranscriptReportedPayload } from 'hrc-core'
import {
  HRC_ARTIFACT_REPORTED_EVENT,
  HRC_PROVIDER_TRANSCRIPT_ARTIFACT_KIND,
  HRC_PROVIDER_TRANSCRIPT_REPORTED_EVENT,
} from 'hrc-core'
import type { InvocationEventEnvelope } from 'spaces-harness-broker-protocol'

import { isRecord } from '../json'

export function providerTranscriptPayload(
  envelope: InvocationEventEnvelope
): HrcProviderTranscriptReportedPayload | undefined {
  if (!isRecord(envelope.payload)) return undefined
  const type = String(envelope.type)
  if (type === HRC_PROVIDER_TRANSCRIPT_REPORTED_EVENT)
    return normalizeTranscriptPayload(envelope.payload)
  if (
    type === HRC_ARTIFACT_REPORTED_EVENT &&
    String(envelope.payload['kind']) === HRC_PROVIDER_TRANSCRIPT_ARTIFACT_KIND
  ) {
    return normalizeTranscriptPayload(envelope.payload)
  }
  return undefined
}

function normalizeTranscriptPayload(
  payload: Record<string, unknown>
): HrcProviderTranscriptReportedPayload {
  return {
    ...(typeof payload['kind'] === 'string' ? { kind: payload['kind'] } : {}),
    ...(typeof payload['path'] === 'string' ? { path: payload['path'] } : {}),
    ...(typeof payload['artifactPath'] === 'string'
      ? { artifactPath: payload['artifactPath'] }
      : {}),
    ...(typeof payload['provider'] === 'string' ? { provider: payload['provider'] } : {}),
    ...(typeof payload['harnessGeneration'] === 'number'
      ? { harnessGeneration: payload['harnessGeneration'] }
      : {}),
  }
}

export function isIgnoredBrokerDelta(envelope: InvocationEventEnvelope): boolean {
  return envelope.type.endsWith('.delta')
}

export function shouldPersistBrokerEvent(envelope: InvocationEventEnvelope): boolean {
  return !isIgnoredBrokerDelta(envelope)
}

export function requestsCaptureStateRefresh(envelope: InvocationEventEnvelope): boolean {
  if (envelope.type === 'capture.released') return true
  return (
    envelope.type === 'capture.warning' &&
    isRecord(envelope.payload) &&
    envelope.payload['kind'] === 'blocked_unknown'
  )
}

export type Format2TurnStart = {
  runId: string
  turnId: string
  initiatingInputId?: string | undefined
  joinedInputIds: string[]
  minted: boolean
}
