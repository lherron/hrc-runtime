import { BROKER_TO_HRC_LIFECYCLE_POLICY_HASH, BROKER_TO_HRC_LIFECYCLE_POLICY_ID } from 'hrc-core'
import {
  CAPTURE_VERIFIER_SCHEMA,
  type CaptureVerificationAnalytics,
  type LifecycleCheck,
  type LifecycleProjectionAnalytics,
  type ProviderJsonlAnalytics,
  type ProviderObservationMatch,
  type RawEventsAnalytics,
  type VerifyInvocationInput,
} from './types.js'

export function buildAnalytics(input: {
  transcript?: VerifyInvocationInput['transcript'] | undefined
  brokerLedger: CaptureVerificationAnalytics['brokerLedger']
  rawEvents: RawEventsAnalytics
  lifecycleProjection: LifecycleProjectionAnalytics
  providerMatches: ProviderObservationMatch[]
}): CaptureVerificationAnalytics {
  return {
    schema: CAPTURE_VERIFIER_SCHEMA,
    ...(input.transcript !== undefined
      ? { providerJsonl: providerJsonlAnalytics(input.transcript) }
      : {}),
    brokerLedger: input.brokerLedger,
    rawEvents: input.rawEvents,
    lifecycleProjection: input.lifecycleProjection,
    crossSink: {
      ...(input.transcript !== undefined
        ? { providerToBroker: providerToBrokerAnalytics(input.providerMatches) }
        : {}),
      brokerToRaw: {
        expected: input.rawEvents.expectedFromBroker,
        matched: input.rawEvents.matched,
        missing: input.rawEvents.missing,
        mismatched: input.rawEvents.mismatched,
      },
      brokerToLifecycle: {
        expected: input.lifecycleProjection.expected,
        present: input.lifecycleProjection.present,
        missing: input.lifecycleProjection.missing,
        suppressed: input.lifecycleProjection.suppressed,
        notApplicable: input.lifecycleProjection.notApplicable,
      },
    },
  }
}

export function providerJsonlAnalytics(
  transcript: NonNullable<VerifyInvocationInput['transcript']>
): ProviderJsonlAnalytics {
  return {
    path: transcript.path,
    provider: transcript.provider,
    totalLines: transcript.totalLines,
    parsedRecords: transcript.parsedRecords,
    invalidJsonRecords: transcript.invalidJsonRecords,
    applicableObservations: transcript.applicableObservations,
    ignoredRecords: transcript.ignoredRecords,
    unsupportedRecords: transcript.unsupportedRecords,
    unknownRecords: transcript.unknownRecords,
    warningCount: transcript.warningCount,
    observationsByType: transcript.observationsByType,
  }
}

export function providerToBrokerAnalytics(
  matches: ProviderObservationMatch[]
): NonNullable<CaptureVerificationAnalytics['crossSink']['providerToBroker']> {
  const out = {
    expected: matches.length,
    matched: 0,
    missing: 0,
    divergent: 0,
    textMismatchTolerated: 0,
  }
  for (const match of matches) {
    switch (match.status) {
      case 'matched':
        out.matched += 1
        break
      case 'missing':
        out.missing += 1
        break
      case 'divergent':
        out.divergent += 1
        break
      case 'text-mismatch-tolerated':
        out.textMismatchTolerated += 1
        break
    }
  }
  return out
}

export function buildLifecycleAnalytics(
  lifecycle: LifecycleCheck[],
  checkedBrokerEvents: number
): LifecycleProjectionAnalytics {
  const out: LifecycleProjectionAnalytics = {
    policyId: BROKER_TO_HRC_LIFECYCLE_POLICY_ID,
    policyVersion: 'v1',
    policyHash: BROKER_TO_HRC_LIFECYCLE_POLICY_HASH,
    checkedBrokerEvents,
    policyMapped: 0,
    expected: 0,
    present: 0,
    missing: 0,
    suppressed: 0,
    notApplicable: 0,
    byBrokerType: {},
    byLifecycleKind: {},
  }

  for (const item of lifecycle) {
    let brokerBucket = out.byBrokerType[item.brokerType]
    if (brokerBucket === undefined) {
      brokerBucket = {
        policyMapped: 0,
        expected: 0,
        present: 0,
        missing: 0,
        suppressed: 0,
        notApplicable: 0,
      }
      out.byBrokerType[item.brokerType] = brokerBucket
    }
    if (item.status === 'not_applicable') {
      out.notApplicable += 1
      brokerBucket.notApplicable += 1
      continue
    }

    out.policyMapped += 1
    brokerBucket.policyMapped += 1

    const lifecycleKind = item.lifecycleKind ?? 'unknown'
    let kindBucket = out.byLifecycleKind[lifecycleKind]
    if (kindBucket === undefined) {
      kindBucket = {
        expected: 0,
        present: 0,
        missing: 0,
        suppressed: 0,
      }
      out.byLifecycleKind[lifecycleKind] = kindBucket
    }

    if (item.status === 'suppressed') {
      out.suppressed += 1
      brokerBucket.suppressed += 1
      kindBucket.suppressed += 1
      continue
    }

    out.expected += 1
    brokerBucket.expected += 1
    kindBucket.expected += 1

    if (item.status === 'present') {
      out.present += 1
      brokerBucket.present += 1
      kindBucket.present += 1
    } else {
      out.missing += 1
      brokerBucket.missing += 1
      kindBucket.missing += 1
    }
  }

  return out
}

export function emptyRawEventsAnalytics(): RawEventsAnalytics {
  return {
    expectedFromBroker: 0,
    appliedBrokerRows: 0,
    linkedByHrcEventSeq: 0,
    found: 0,
    matched: 0,
    missing: 0,
    mismatched: 0,
    wrongSource: 0,
    wrongEventKind: 0,
    wrongInvocation: 0,
    wrongSeq: 0,
    wrongType: 0,
    payloadMismatch: 0,
    malformedEventJson: 0,
    malformedPayload: 0,
  }
}
