export async function deliverFailureNotices(
  server: MailKickerContext,
  targetSessionRef: string,
  session: HrcSessionRecord
): Promise<void> {
  const notices = server.db.mailDrives.listUndeliveredFailureNotices(targetSessionRef)
  if (notices.length === 0) return
  if (presentationRuntimeIdFor(server, session) === undefined) return
  const intent =
    session.lastAppliedIntentJson ??
    server.resolveRuntimeIntent(parseSessionRef(targetSessionRef).scopeRef, undefined)
  if (intent === undefined) return
  const prompt = notices.map((notice) => notice.notice).join('\n\n')
  try {
    const body = await server.dispatchTurn(session, intent, prompt, {
      waitForCompletion: false,
      submissionDoor: 'enqueue',
      ttlMs: KICKER_SUBMISSION_TTL_MS,
      submissionOrigin: { principalRef: 'system:hrc-kicker', scopeRef: session.scopeRef },
    })
    if (body.status !== 'started') {
      throw new Error(`failure notice did not start (status=${body.status})`)
    }
    server.db.mailDrives.markFailureNoticesDelivered(
      targetSessionRef,
      notices.map((notice) => notice.envelopeId)
    )
    server.log('INFO', 'wrkq.kicker.failure_notice_delivered', {
      targetSessionRef,
      runId: body.runId,
      envelopes: notices.map((notice) => notice.envelopeId),
    })
  } catch (error) {
    // Nothing is marked delivered, so the next attend tries again. A notice
    // that could not be shown is not a notice that stops being owed.
    server.log('WARN', 'wrkq.kicker.failure_notice_failed', {
      targetSessionRef,
      envelopes: notices.map((notice) => notice.envelopeId),
      error: errorText(error),
    })
  }
}

/**
 * §5 — queue the sender-side notice for one `envelope.failed` off the tail.
 *
 * Rendered by reading the ROW back, not from the event payload: the real
 * payload carries `{state, reason, room_uuid, runtime_id}` and neither party
 * nor the room key (paired against wrkqd at wrkq 88b133a). The envelope id is
 * on the event row itself.
 *
 * Only a sender this node homes or seats is served. A notice is delivered by
 * exactly one daemon — the sender's own — and a human sender is served by the
 * ACP surfaces instead (§11), never by a summon here.
 */
export async function queueFailureNotice(
  server: MailKickerContext,
  event: WrkqMonitorEvent
): Promise<void> {
  const envelopeId = event.resourceId
  if (envelopeId === undefined) return
  const reason = failureReasonFor(event.payload)
  if (reason === undefined) return
  const envelope = await server.ledger.envelopeShow({ envelope: envelopeId })
  const senderScope = envelope.from.scopeRef
  if (senderScope === undefined) return
  const targetSessionRef = targetSessionRefForLedgerScope(senderScope)
  if (targetSessionRef === undefined) return
  // The placement ledger is keyed on the CANONICAL scope, not on the handle
  // wrkq stores. Handing it the handle throws rather than missing, which is how
  // one un-normalized read took the whole notice path down.
  const canonicalScope = kickerScopeRefFor(targetSessionRef)
  const placement =
    canonicalScope === undefined
      ? undefined
      : createPlacementLedgerRepository(server.db.sqlite).get(canonicalScope)
  const homed = placement?.state === 'active' && placement.homeNodeId === server.nodeId
  if (!homed && server.findTargetSession(targetSessionRef) === undefined) return
  const runtimeId = failedPayload(event.payload)?.runtime_id
  const notice = formatEnvelopeFailureNotice(envelope, reason, {
    ...(runtimeId === undefined ? {} : { runtimeId }),
  })
  if (!server.db.mailDrives.recordFailureNotice({ envelopeId, targetSessionRef, notice })) return
  server.log('INFO', 'wrkq.kicker.failure_notice_queued', {
    targetSessionRef,
    envelope: envelopeId,
    reason,
  })
  server.wake(targetSessionRef, 'insert')
}

function failedPayload(raw: string | undefined): WrkqEnvelopeFailedPayload | undefined {
  if (raw === undefined) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  return isRecord(parsed) ? (parsed as WrkqEnvelopeFailedPayload) : undefined
}

const FAILURE_REASONS = new Set<WrkqEnvelopeFailureReason>([
  'runtime_terminated',
  'ignored',
  'undeliverable',
  'legacy',
])

function failureReasonFor(raw: string | undefined): WrkqEnvelopeFailureReason | undefined {
  const reason = failedPayload(raw)?.reason
  if (reason === undefined) return undefined
  return FAILURE_REASONS.has(reason as WrkqEnvelopeFailureReason)
    ? (reason as WrkqEnvelopeFailureReason)
    : undefined
}
import type { HrcSessionRecord } from 'hrc-core'
import { createPlacementLedgerRepository } from 'hrc-store-sqlite'

import type { MailKickerContext } from '../context.js'
import { kickerScopeRefFor, presentationRuntimeIdFor } from '../drive/authority.js'
import { KICKER_SUBMISSION_TTL_MS, errorText, isRecord, parseSessionRef } from '../internal.js'
import { formatEnvelopeFailureNotice } from '../ledger/presentation.js'
import { targetSessionRefForLedgerScope } from '../ledger/scope.js'
import type {
  WrkqEnvelopeFailedPayload,
  WrkqEnvelopeFailureReason,
  WrkqMonitorEvent,
} from '../ledger/types.js'
