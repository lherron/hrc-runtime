import { formatScopeHandle, parseScopeRef } from 'agent-scope'
import type { HrcMailAutoReplyIntent, HrcMailAutoReplyIntentState } from 'hrc-store-sqlite'

import type { WrkqEnvelope } from 'hrc-mail-kicker'
import { projectSemanticTurnResponse } from './event-notification-handlers.js'
import type { HrcServerInstanceForHandlers } from './server-instance-context.js'
import { writeServerLog } from './server-log.js'
import { parseSessionRef } from './server-parsers.js'
import { storedManifestEnvelopeIdsForTurn } from './turn-dispatch-handlers.js'
import { WrkqLedgerRequestError } from './wrkq/ledger-client.js'
import type { WrkqLedgerClient } from './wrkq/ledger-client.js'

const AUTO_REPLY_RECONCILE_INTERVAL_MS = 1_000

type AutoReplyReconcileDeps = {
  db: HrcServerInstanceForHandlers['db']
  wrkqLedger: WrkqLedgerClient
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function agentSayIdentity(targetSessionRef: string): {
  principalRef: string
  scopeRef: string
} {
  const parsedScope = parseScopeRef(parseSessionRef(targetSessionRef).scopeRef)
  return {
    principalRef: `agent:${parsedScope.agentId}`,
    scopeRef: formatScopeHandle(parsedScope),
  }
}

function pendingAgeMs(intent: HrcMailAutoReplyIntent): number {
  const created = Date.parse(intent.createdAt)
  return Number.isNaN(created) ? 0 : Math.max(Date.now() - created, 0)
}

type ExactDischarge = {
  source: 'manifest' | 'candidate'
  envelopeIds: string[]
}

function brokerPayload(record: { brokerEventJson: string }): Record<string, unknown> {
  try {
    const parsed = JSON.parse(record.brokerEventJson) as unknown
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function exactDischargeForIntent(
  deps: AutoReplyReconcileDeps,
  intent: HrcMailAutoReplyIntent
): ExactDischarge {
  const run = deps.db.runs.getByRunId(intent.runId)
  const records =
    run?.invocationId === undefined
      ? []
      : deps.db.brokerInvocationEvents.listByInvocationId(run.invocationId)
  const disposition = records.find((record) => {
    if (record.type !== 'submission.executed' && record.type !== 'submission.absorbed') {
      return false
    }
    const payload = brokerPayload(record)
    return (
      (record.runId !== undefined && record.runId === intent.runId) ||
      (run?.brokerSubmissionId !== undefined && payload['submissionId'] === run.brokerSubmissionId)
    )
  })
  const turnId = disposition === undefined ? undefined : brokerPayload(disposition)['turnId']
  if (typeof turnId === 'string') {
    const manifest = storedManifestEnvelopeIdsForTurn(records, turnId)
    if (manifest.eventsPresent) {
      return { source: 'manifest', envelopeIds: manifest.envelopeIds }
    }
  }
  return { source: 'candidate', envelopeIds: [...intent.sourceEnvelopeIds] }
}

function dischargeRefusal(
  error: unknown
): { envelopeId: string; code: string; reason?: string | undefined } | undefined {
  if (
    !(error instanceof WrkqLedgerRequestError) ||
    error.message !== 'invalid discharge envelope'
  ) {
    return undefined
  }
  const data = error.data
  if (data === null || typeof data !== 'object') return undefined
  const record = data as Record<string, unknown>
  if (record['code'] !== 'WRKQ_VALIDATION' || typeof record['envelope'] !== 'string') {
    return undefined
  }
  return {
    envelopeId: record['envelope'],
    code: record['code'],
    ...(typeof record['reason'] === 'string' ? { reason: record['reason'] } : {}),
  }
}

function completeIntent(
  deps: AutoReplyReconcileDeps,
  intent: HrcMailAutoReplyIntent,
  state: Exclude<HrcMailAutoReplyIntentState, 'pending'>,
  detail: Record<string, unknown> = {}
): HrcMailAutoReplyIntentState {
  deps.db.mailDrives.completeAutoReplyIntent(intent.driveAttemptId, state)
  writeServerLog('INFO', 'wrkq.auto_reply.terminal', {
    driveAttemptId: intent.driveAttemptId,
    runId: intent.runId,
    sourceRef: intent.sourceRef,
    roomKey: intent.roomKey,
    state,
    pendingAgeMs: pendingAgeMs(intent),
    ...detail,
  })
  return state
}

async function verifyMintByRead(
  deps: AutoReplyReconcileDeps,
  intent: HrcMailAutoReplyIntent,
  principalRef: string,
  idempotencyKey: string
): Promise<{ outcome: 'found' | 'absent' } | { outcome: 'failed'; error: string }> {
  try {
    const view = await deps.wrkqLedger.roomLog({ room: intent.roomKey })
    const found = view.items.some(
      (envelope) =>
        envelope.from.principalRef === principalRef && envelope.idempotencyKey === idempotencyKey
    )
    return { outcome: found ? 'found' : 'absent' }
  } catch (error) {
    return { outcome: 'failed', error: errorText(error) }
  }
}

/**
 * Drive one durable intent by the ratified F2-R state machine.
 *
 * A failed verification read is the sharp edge: it proves neither absence nor
 * retry permission, so this function returns with the row still pending and
 * performs NO second say. A later reconciler pass restarts the whole step.
 */
export async function reconcileAutoReplyIntent(
  deps: AutoReplyReconcileDeps,
  intent: HrcMailAutoReplyIntent
): Promise<HrcMailAutoReplyIntentState> {
  const attempt = deps.db.mailDrives.recordAutoReplyAttempt(intent.driveAttemptId)
  const projection = projectSemanticTurnResponse(deps.db, intent.runId)
  writeServerLog('INFO', 'wrkq.auto_reply.pending', {
    driveAttemptId: intent.driveAttemptId,
    runId: intent.runId,
    sourceRef: intent.sourceRef,
    roomKey: intent.roomKey,
    attemptCount: attempt.attemptCount,
    pendingAgeMs: pendingAgeMs(intent),
    truncated: projection.truncated,
  })

  if (projection.body.trim().length === 0) {
    return completeIntent(deps, intent, 'empty-response', { truncated: projection.truncated })
  }

  const key = `auto-reply:${intent.driveAttemptId}`
  const identity = agentSayIdentity(intent.targetSessionRef)

  // A crash or lost response can leave the row here. Verify the prior say
  // BEFORE interpreting its discharge side effect as a manual reply.
  if (intent.verificationPending) {
    const verified = await verifyMintByRead(deps, intent, identity.principalRef, key)
    if (verified.outcome === 'failed') {
      const message = `prior say outcome ambiguous; verification read failed (${verified.error})`
      deps.db.mailDrives.recordAutoReplyError(intent.driveAttemptId, message)
      writeServerLog('WARN', 'wrkq.auto_reply.verify_read_failed', {
        driveAttemptId: intent.driveAttemptId,
        runId: intent.runId,
        sourceRef: intent.sourceRef,
        idempotencyKey: key,
        pendingAgeMs: pendingAgeMs(intent),
        action: 'stay-pending-no-retry',
        error: message,
      })
      return 'pending'
    }
    if (verified.outcome === 'found') {
      return completeIntent(deps, intent, 'minted', {
        idempotencyKey: key,
        truncated: projection.truncated,
        confirmation: 'restart-verify-by-read',
      })
    }
    // Successful absence is the only fact that grants retry permission.
    deps.db.mailDrives.clearAutoReplyVerification(intent.driveAttemptId)
  }

  let sources: WrkqEnvelope[]
  try {
    sources = await Promise.all(
      intent.sourceEnvelopeIds.map((envelope) => deps.wrkqLedger.envelopeShow({ envelope }))
    )
  } catch (error) {
    const message = `discharge read failed: ${errorText(error)}`
    deps.db.mailDrives.recordAutoReplyError(intent.driveAttemptId, message)
    writeServerLog('WARN', 'wrkq.auto_reply.discharge_read_failed', {
      driveAttemptId: intent.driveAttemptId,
      runId: intent.runId,
      sourceRef: intent.sourceRef,
      pendingAgeMs: pendingAgeMs(intent),
      error: message,
    })
    return 'pending'
  }

  if (sources.length > 0 && sources.every((source) => source.state === 'acked')) {
    return completeIntent(deps, intent, 'already-discharged')
  }

  const derived = exactDischargeForIntent(deps, intent)
  const refusedPreviously = intent.dischargeOutcome?.refusedEnvelopeId
  const candidateIds = derived.envelopeIds.filter((id) => id !== refusedPreviously)
  const known = new Map(sources.map((source) => [source.id, source]))
  try {
    for (const envelopeId of candidateIds) {
      if (!known.has(envelopeId)) {
        known.set(envelopeId, await deps.wrkqLedger.envelopeShow({ envelope: envelopeId }))
      }
    }
  } catch (error) {
    const message = `manifest discharge read failed: ${errorText(error)}`
    deps.db.mailDrives.recordAutoReplyError(intent.driveAttemptId, message)
    return 'pending'
  }
  const dischargeEnvelopeIds = candidateIds.filter((id) => {
    const envelope = known.get(id)
    return envelope?.obligation === 'reply_required' && envelope.presentedTo.length > 0
  })
  if (dischargeEnvelopeIds.length === 0) {
    const message = `exact discharge set is empty (${derived.source})`
    deps.db.mailDrives.recordAutoReplyDischargeOutcome(intent.driveAttemptId, {
      source: derived.source,
      envelopeIds: [],
      ...(refusedPreviously === undefined ? {} : { refusedEnvelopeId: refusedPreviously }),
    })
    deps.db.mailDrives.recordAutoReplyError(intent.driveAttemptId, message)
    return 'pending'
  }

  const say = async (ids: string[]) => {
    deps.db.mailDrives.markAutoReplySayStarted(intent.driveAttemptId)
    return await deps.wrkqLedger.roomSay({
      ref: intent.roomKey,
      body: projection.body,
      to: [intent.counterpartyRef],
      idempotencyKey: key,
      dischargeEnvelopeIds: ids,
      meta: {
        auto: 'turn_final',
        discharge: derived.source,
        dischargeEnvelopeIds: ids,
      },
      principalRef: identity.principalRef,
      scopeRef: identity.scopeRef,
    })
  }

  deps.db.mailDrives.recordAutoReplyDischargeOutcome(intent.driveAttemptId, {
    source: derived.source,
    envelopeIds: dischargeEnvelopeIds,
    ...(refusedPreviously === undefined ? {} : { refusedEnvelopeId: refusedPreviously }),
  })
  try {
    await say(dischargeEnvelopeIds)
    return completeIntent(deps, intent, 'minted', {
      idempotencyKey: key,
      truncated: projection.truncated,
      confirmation: 'say-success',
      discharge: derived.source,
      dischargeEnvelopeIds,
    })
  } catch (sayError) {
    let ambiguousError: unknown = sayError
    const refusal = dischargeRefusal(sayError)
    if (refusal !== undefined) {
      deps.db.mailDrives.clearAutoReplyVerification(intent.driveAttemptId)
      const reduced = dischargeEnvelopeIds.filter((id) => id !== refusal.envelopeId)
      deps.db.mailDrives.recordAutoReplyDischargeOutcome(intent.driveAttemptId, {
        source: derived.source,
        envelopeIds: reduced,
        refusedEnvelopeId: refusal.envelopeId,
        refusalCode: refusal.code,
        ...(refusal.reason === undefined ? {} : { refusalReason: refusal.reason }),
      })
      const message = `exact discharge refused ${refusal.envelopeId}: ${refusal.reason ?? refusal.code}`
      deps.db.mailDrives.recordAutoReplyError(intent.driveAttemptId, message)
      if (reduced.length === 0) return 'pending'
      try {
        await say(reduced)
        return completeIntent(deps, intent, 'minted', {
          idempotencyKey: key,
          truncated: projection.truncated,
          confirmation: 'reduced-set-retry',
          discharge: derived.source,
          dischargeEnvelopeIds: reduced,
          refusedEnvelopeId: refusal.envelopeId,
        })
      } catch (retryError) {
        const retryRefusal = dischargeRefusal(retryError)
        if (retryRefusal !== undefined) {
          deps.db.mailDrives.clearAutoReplyVerification(intent.driveAttemptId)
          deps.db.mailDrives.recordAutoReplyDischargeOutcome(intent.driveAttemptId, {
            source: derived.source,
            envelopeIds: reduced.filter((id) => id !== retryRefusal.envelopeId),
            refusedEnvelopeId: retryRefusal.envelopeId,
            refusalCode: retryRefusal.code,
            ...(retryRefusal.reason === undefined ? {} : { refusalReason: retryRefusal.reason }),
          })
          deps.db.mailDrives.recordAutoReplyError(
            intent.driveAttemptId,
            `reduced exact discharge refused ${retryRefusal.envelopeId}: ${retryRefusal.reason ?? retryRefusal.code}`
          )
          return 'pending'
        }
        ambiguousError = retryError
      }
    }
    // Every error is ambiguous by contract, including wrkq's deliberately
    // untyped duplicate refusal. Only the ledger read below can classify it.
    const verified = await verifyMintByRead(deps, intent, identity.principalRef, key)
    if (verified.outcome === 'failed') {
      const message = `say ambiguous (${errorText(ambiguousError)}); verification read failed (${verified.error})`
      deps.db.mailDrives.recordAutoReplyError(intent.driveAttemptId, message)
      writeServerLog('WARN', 'wrkq.auto_reply.verify_read_failed', {
        driveAttemptId: intent.driveAttemptId,
        runId: intent.runId,
        sourceRef: intent.sourceRef,
        idempotencyKey: key,
        pendingAgeMs: pendingAgeMs(intent),
        action: 'stay-pending-no-retry',
        error: message,
      })
      return 'pending'
    }
    if (verified.outcome === 'found') {
      return completeIntent(deps, intent, 'minted', {
        idempotencyKey: key,
        truncated: projection.truncated,
        confirmation: 'verify-by-read',
      })
    }

    deps.db.mailDrives.clearAutoReplyVerification(intent.driveAttemptId)
    const message = `say ambiguous (${errorText(ambiguousError)}); verification read confirmed no matching envelope`
    deps.db.mailDrives.recordAutoReplyError(intent.driveAttemptId, message)
    writeServerLog('WARN', 'wrkq.auto_reply.retry_scheduled', {
      driveAttemptId: intent.driveAttemptId,
      runId: intent.runId,
      sourceRef: intent.sourceRef,
      idempotencyKey: key,
      pendingAgeMs: pendingAgeMs(intent),
      action: 'stay-pending-retry-say-next-pass',
      error: message,
    })
    return 'pending'
  }
}

export async function reconcilePendingAutoReplies(
  this: HrcServerInstanceForHandlers
): Promise<void> {
  for (const intent of this.db.mailDrives.listPendingAutoReplyIntents()) {
    try {
      await reconcileAutoReplyIntent(this, intent)
    } catch (error) {
      const message = `reconcile failed: ${errorText(error)}`
      this.db.mailDrives.recordAutoReplyError(intent.driveAttemptId, message)
      writeServerLog('ERROR', 'wrkq.auto_reply.reconcile_failed', {
        driveAttemptId: intent.driveAttemptId,
        runId: intent.runId,
        sourceRef: intent.sourceRef,
        pendingAgeMs: pendingAgeMs(intent),
        error: message,
      })
    }
  }
}

export function requestAutoReplyReconcile(this: HrcServerInstanceForHandlers): void {
  if (this.stopping || this.autoReplyReconcileInFlight !== undefined) return
  const operation = this.reconcilePendingAutoReplies()
    .catch((error: unknown) => {
      writeServerLog('ERROR', 'wrkq.auto_reply.sweep_failed', { error: errorText(error) })
    })
    .finally(() => {
      if (this.autoReplyReconcileInFlight === operation) {
        this.autoReplyReconcileInFlight = undefined
      }
    })
  this.autoReplyReconcileInFlight = operation
}

export function startAutoReplyReconciler(this: HrcServerInstanceForHandlers): void {
  if (this.autoReplyReconcileTimer !== undefined) return
  queueMicrotask(() => this.requestAutoReplyReconcile())
  this.autoReplyReconcileTimer = setInterval(
    () => this.requestAutoReplyReconcile(),
    AUTO_REPLY_RECONCILE_INTERVAL_MS
  )
  this.autoReplyReconcileTimer.unref?.()
}

export const autoReplyHandlersMethods = {
  reconcilePendingAutoReplies,
  requestAutoReplyReconcile,
  startAutoReplyReconciler,
}

export type AutoReplyHandlersMethods = typeof autoReplyHandlersMethods
