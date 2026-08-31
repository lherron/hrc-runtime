import { formatScopeHandle, parseScopeRef } from 'agent-scope'
import type {
  HrcMailAutoReplyCandidate,
  HrcMailAutoReplyIntent,
  HrcMailAutoReplyIntentState,
} from 'hrc-store-sqlite'

import { projectSemanticTurnResponse } from './event-notification-handlers.js'
import type { HrcServerInstanceForHandlers } from './server-instance-context.js'
import { writeServerLog } from './server-log.js'
import { parseSessionRef } from './server-parsers.js'
import { envelopeReplyAddressee } from './wrkq/envelope-presentation.js'
import type { WrkqLedgerClient } from './wrkq/ledger-client.js'
import type { WrkqEnvelope } from './wrkq/ledger-types.js'

const AUTO_REPLY_RECONCILE_INTERVAL_MS = 1_000

type AutoReplyReconcileDeps = {
  db: HrcServerInstanceForHandlers['db']
  wrkqLedger: WrkqLedgerClient
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function senderIdentity(envelope: WrkqEnvelope): string {
  return envelope.from.scopeRef?.trim() || envelope.from.principalRef.trim()
}

/**
 * The exact rev 6 trigger projection.
 *
 * A drive carrying unrelated envelopes is a manual-discipline batch. The only
 * multi-envelope shape eligible here is one fan-out group in one room from one
 * sender. Presented/reminder rows are excluded: the trigger says PENDING mail.
 */
export function autoReplyCandidateFor(
  envelopes: readonly WrkqEnvelope[]
): HrcMailAutoReplyCandidate | undefined {
  const first = envelopes[0]
  if (first === undefined || envelopes.some((envelope) => envelope.state !== 'pending')) {
    return undefined
  }
  const groupId = first.groupId ?? first.id
  const sender = senderIdentity(first)
  const counterpartyRef = envelopeReplyAddressee(first)
  if (counterpartyRef === undefined) return undefined
  if (
    envelopes.some(
      (envelope) =>
        (envelope.groupId ?? envelope.id) !== groupId ||
        envelope.roomKey !== first.roomKey ||
        senderIdentity(envelope) !== sender ||
        envelopeReplyAddressee(envelope) !== counterpartyRef
    )
  ) {
    return undefined
  }
  return {
    sourceRef: envelopes.length === 1 ? first.id : groupId,
    sourceEnvelopeIds: envelopes.map((envelope) => envelope.id),
    roomKey: first.roomKey,
    counterpartyRef,
  }
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

  deps.db.mailDrives.markAutoReplySayStarted(intent.driveAttemptId)
  try {
    await deps.wrkqLedger.roomSay({
      ref: intent.roomKey,
      body: projection.body,
      to: [intent.counterpartyRef],
      idempotencyKey: key,
      meta: { auto: 'turn_final' },
      principalRef: identity.principalRef,
      scopeRef: identity.scopeRef,
    })
    return completeIntent(deps, intent, 'minted', {
      idempotencyKey: key,
      truncated: projection.truncated,
      confirmation: 'say-success',
    })
  } catch (sayError) {
    // Every error is ambiguous by contract, including wrkq's deliberately
    // untyped duplicate refusal. Only the ledger read below can classify it.
    const verified = await verifyMintByRead(deps, intent, identity.principalRef, key)
    if (verified.outcome === 'failed') {
      const message = `say ambiguous (${errorText(sayError)}); verification read failed (${verified.error})`
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
    const message = `say ambiguous (${errorText(sayError)}); verification read confirmed no matching envelope`
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
