import {
  type BrokerCaptureEvent,
  CAPTURE_VERIFIER_SCHEMA,
  type CaptureObservation,
  type CaptureVerificationFinding,
  type ProviderObservationMatch,
} from './types.js'
import {
  type ComparableBrokerEvent,
  payloadsCompatible,
  toComparableBrokerEvent,
} from './verifier-normalize.js'

export function compareTranscript(
  observations: CaptureObservation[],
  brokerRows: BrokerCaptureEvent[],
  strictText: boolean,
  findings: CaptureVerificationFinding[]
): ProviderObservationMatch[] {
  const broker = brokerRows.map(toComparableBrokerEvent)
  const used = new Set<number>()
  const matches: ProviderObservationMatch[] = []

  for (const observed of observations) {
    const match = findBrokerMatch(
      observed.type,
      observed.correlationKey,
      observed.payloadHash,
      broker,
      used
    )
    if (match === undefined) {
      matches.push({
        line: observed.line,
        type: observed.type,
        ...(observed.correlationKey !== undefined
          ? { correlationKey: observed.correlationKey }
          : {}),
        status: 'missing',
        detail:
          'no broker_invocation_events row matched event class, correlation key, and normalized payload',
      })
      findings.push({
        schema: CAPTURE_VERIFIER_SCHEMA,
        severity: 'error',
        layer: 'provider',
        code: 'provider_event_missing_in_broker',
        message: `provider JSONL line ${observed.line} ${observed.type} missing from broker ledger`,
        line: observed.line,
        brokerSeq: undefined,
        type: observed.type,
      })
      continue
    }

    used.add(match.row.seq)
    if (
      match.payloadHash !== observed.payloadHash &&
      payloadsCompatible(observed.normalizedPayload, match.normalizedPayload)
    ) {
      matches.push({
        line: observed.line,
        type: observed.type,
        ...(observed.correlationKey !== undefined
          ? { correlationKey: observed.correlationKey }
          : {}),
        brokerSeq: match.row.seq,
        status: 'matched',
        detail: 'normalized payloads are compatible after provider truncation normalization',
      })
      continue
    }

    if (
      observed.type === 'assistant.message.completed' &&
      match.payloadHash !== observed.payloadHash &&
      !strictText
    ) {
      matches.push({
        line: observed.line,
        type: observed.type,
        ...(observed.correlationKey !== undefined
          ? { correlationKey: observed.correlationKey }
          : {}),
        brokerSeq: match.row.seq,
        status: 'text-mismatch-tolerated',
        detail: 'assistant text differs; pass --strict-text to fail this',
      })
      findings.push({
        schema: CAPTURE_VERIFIER_SCHEMA,
        severity: 'warning',
        layer: 'provider',
        code: 'assistant_text_mismatch_tolerated',
        message: `provider JSONL line ${observed.line} assistant text differs from broker seq ${match.row.seq}`,
        line: observed.line,
        brokerSeq: match.row.seq,
        type: observed.type,
      })
      continue
    }

    if (match.payloadHash !== observed.payloadHash) {
      matches.push({
        line: observed.line,
        type: observed.type,
        ...(observed.correlationKey !== undefined
          ? { correlationKey: observed.correlationKey }
          : {}),
        brokerSeq: match.row.seq,
        status: 'divergent',
        detail: 'normalized payload hash differs',
      })
      findings.push({
        schema: CAPTURE_VERIFIER_SCHEMA,
        severity: 'error',
        layer: 'provider',
        code: 'provider_event_payload_divergent',
        message: `provider JSONL line ${observed.line} payload differs from broker seq ${match.row.seq}`,
        line: observed.line,
        brokerSeq: match.row.seq,
        type: observed.type,
      })
      continue
    }

    matches.push({
      line: observed.line,
      type: observed.type,
      ...(observed.correlationKey !== undefined ? { correlationKey: observed.correlationKey } : {}),
      brokerSeq: match.row.seq,
      status: 'matched',
    })
  }

  return matches
}

export function findBrokerMatch(
  type: string,
  correlationKey: string | undefined,
  payloadHash: string,
  broker: ComparableBrokerEvent[],
  used: Set<number>
): ComparableBrokerEvent | undefined {
  const candidates = broker.filter((item) => item.type === type && !used.has(item.row.seq))
  if (correlationKey !== undefined) {
    const keyed = candidates.filter((item) => item.correlationKey === correlationKey)
    return keyed.find((item) => item.payloadHash === payloadHash) ?? keyed[0]
  }
  return candidates.find((item) => item.payloadHash === payloadHash) ?? candidates[0]
}
