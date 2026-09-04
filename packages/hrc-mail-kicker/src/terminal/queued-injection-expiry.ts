import type { HrcBrokerInvocationEventRecord } from 'hrc-core'

import type { MailKickerContext } from '../context.js'
import { logAttemptTerminal } from '../diagnostics/attempt-log.js'
import { targetSessionRefForLedgerScope } from '../ledger/scope.js'
import { failEnvelopeWithAudit } from './envelope-terminal.js'

const EXPIRY_EVENT_TYPES = new Set(['queue.expired', 'submission.expired'])
const inFlightByServer = new WeakMap<object, Map<string, Promise<void>>>()

function parsePayload(record: Pick<HrcBrokerInvocationEventRecord, 'brokerEventJson'>) {
  try {
    const parsed = JSON.parse(record.brokerEventJson) as unknown
    return parsed !== null && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

function envelopeOriginForSubmission(
  records: readonly HrcBrokerInvocationEventRecord[],
  submissionId: string
): string | undefined {
  for (const record of records) {
    if (record.type !== 'admission.requested') continue
    const payload = parsePayload(record)
    if (payload?.['submissionId'] !== submissionId) continue
    const origin = payload['origin']
    if (origin === null || typeof origin !== 'object') continue
    const envelopeId = (origin as Record<string, unknown>)['envelopeId']
    if (typeof envelopeId === 'string') return envelopeId
  }
  return undefined
}

async function failReceiptedExpiredSubmission(
  server: MailKickerContext,
  record: HrcBrokerInvocationEventRecord,
  submissionId: string
): Promise<void> {
  const records = server.db.brokerInvocationEvents.listByInvocationId(record.invocationId)
  const originEnvelopeId = envelopeOriginForSubmission(records, submissionId)
  if (originEnvelopeId === undefined) return

  const originEnvelope = await server.ledger.envelopeShow({
    envelope: originEnvelopeId,
  })
  const originReceipt = originEnvelope.presentedTo.find(
    (receipt) => receipt.runtimeId === record.runtimeId && receipt.inputId === submissionId
  )
  if (originReceipt?.driveAttemptId === undefined) return

  const driveAttemptId = originReceipt.driveAttemptId
  let failedCount = 0
  for (const envelopeId of server.db.mailDrives.presentationEnvelopeIds(driveAttemptId)) {
    const envelope = await server.ledger.envelopeShow({
      envelope: envelopeId,
    })
    if (envelope.terminal || envelope.state !== 'presented') continue
    const receipt = envelope.presentedTo.find(
      (candidate) =>
        candidate.driveAttemptId === driveAttemptId &&
        candidate.runtimeId === record.runtimeId &&
        candidate.inputId === submissionId
    )
    if (receipt === undefined) continue
    const targetSessionRef =
      envelope.to?.scopeRef === undefined
        ? undefined
        : targetSessionRefForLedgerScope(envelope.to.scopeRef)
    if (targetSessionRef === undefined) {
      server.log('WARN', 'wrkq.kicker.queued_injection_expiry_target_invalid', {
        envelopeId,
        runtimeId: record.runtimeId,
        inputId: submissionId,
        targetScopeRef: envelope.to?.scopeRef,
      })
      continue
    }

    server.log('WARN', 'wrkq.kicker.queued_injection_expired', {
      envelopeId,
      runtimeId: record.runtimeId,
      inputId: submissionId,
    })
    try {
      const terminal = await failEnvelopeWithAudit(server, {
        envelope: envelopeId,
        reason: 'undeliverable',
        runtime: record.runtimeId,
        targetSessionRef,
        driveAttemptId,
        callSite: 'queued_injection_expiry',
      })
      if (terminal.outcome === 'failed') failedCount += 1
    } catch (error) {
      server.log('WARN', 'wrkq.kicker.queued_injection_expiry_fail_failed', {
        envelopeId,
        runtimeId: record.runtimeId,
        inputId: submissionId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  if (failedCount > 0) {
    const reason = `broker queued injection expired before acceptance (${submissionId})`
    const failed = server.db.mailDrives.failWithoutStart(driveAttemptId, reason)
    logAttemptTerminal(server, failed, {
      reason: 'queued_injection_expired',
      presentedEnvelopeIds: server.db.mailDrives.presentationEnvelopeIds(driveAttemptId),
    })
  }
}

/**
 * Turn the broker's queue TTL into an explicit sender-visible failure.
 *
 * A batch exists only in HRC while held, so it has no broker TTL to observe.
 * This hook covers the smaller post-flush window after one broker input exists
 * and every batch member has an execution-bound presentation receipt.
 */
export function handleQueuedInjectionExpiry(
  server: MailKickerContext,
  record: HrcBrokerInvocationEventRecord
): Promise<void> {
  if (!EXPIRY_EVENT_TYPES.has(record.type)) return Promise.resolve()
  const submissionId = parsePayload(record)?.['submissionId']
  if (typeof submissionId !== 'string') return Promise.resolve()

  const key = `${record.invocationId}:${submissionId}`
  const inFlight = inFlightByServer.get(server) ?? new Map<string, Promise<void>>()
  inFlightByServer.set(server, inFlight)
  const existing = inFlight.get(key)
  if (existing !== undefined) return existing

  const handling = failReceiptedExpiredSubmission(server, record, submissionId).finally(() => {
    if (inFlight.get(key) === handling) inFlight.delete(key)
  })
  inFlight.set(key, handling)
  return handling
}
