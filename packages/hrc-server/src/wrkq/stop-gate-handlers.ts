/**
 * The Stop gate (T-07612 §8, built in wave 3 / T-07615).
 *
 * Refuses turn end while this scope has presented reply-required envelopes that
 * are neither replied nor deferred. The predicate is a wrkq query — wrkq owns
 * the obligation — and it FAILS OPEN: a ledger this daemon cannot reach must
 * never be able to trap an agent inside a turn.
 *
 * It lived in `mail/mail-handlers.ts` until the flag day (T-07616) deleted
 * hrcmail. Only the file moved: this gate has read the wrkq ledger since wave 3
 * and never had an hrcmail predicate. The route keeps its
 * `/v1/internal/mail/stop-decision` spelling because the harness hook scripts on
 * four nodes call it by name; renaming it is a separate, coordinated change.
 *
 * The refusal COUNTER (`hrcmail_stop_refusals`) is still written here and that
 * is deliberate: a per-run refusal cap is execution state, which HRC owns under
 * the §2 boundary rule. The tables frozen at the flag day are the ones holding
 * collaboration — `messages` and the mail ENVELOPE tables — not this one.
 */
import { sessionRefFor } from 'hrc-core'
import type { HrcMailStopEnvelopeSummary } from 'hrc-store-sqlite'

import { normalizeTargetSessionRef } from '../messages.js'
import type { HrcServerInstanceForHandlers } from '../server-instance-context.js'
import { writeServerLog } from '../server-log.js'
import { isRecord, parseJsonBody } from '../server-parsers.js'
import { json } from '../server-util.js'
import { envelopeIdSequence } from './ledger-types.js'

const STOP_SUMMARY_LIMIT = 8
const STOP_BODY_PREVIEW_CHARS = 160
const STOP_REASON_MAX_CHARS = 4_096

export async function handleMailStopDecision(
  this: HrcServerInstanceForHandlers,
  request: Request
): Promise<Response> {
  const body = await parseJsonBody(request)
  if (!isRecord(body)) {
    return json(
      { error: { code: 'MALFORMED_REQUEST', message: 'request body must be an object' } },
      400
    )
  }
  const runtimeId = body['runtimeId']
  if (typeof runtimeId !== 'string' || runtimeId.length === 0) {
    return json(
      { error: { code: 'MALFORMED_REQUEST', message: 'runtimeId must be a non-empty string' } },
      400
    )
  }
  const runtime = this.db.runtimes.getByRuntimeId(runtimeId)
  if (runtime === null || runtime.activeRunId === undefined) {
    return json({ decision: 'allow', reason: 'no_active_turn' })
  }

  const run = this.db.runs.getByRunId(runtime.activeRunId)
  if (
    run === null ||
    run.runtimeId !== runtimeId ||
    run.scopeRef !== runtime.scopeRef ||
    run.laneRef !== runtime.laneRef ||
    !isActiveStopRunStatus(run.status)
  ) {
    return json({ decision: 'allow', reason: 'stale_active_turn' })
  }

  const targetSessionRef = normalizeTargetSessionRef(sessionRefFor(run))
  let blocking: HrcMailStopEnvelopeSummary[]
  try {
    // The scope ref goes RAW, lane suffix and all: wrkq strips the lane and
    // keeps the scope, and trimming it here would be HRC guessing at a grammar
    // it does not own.
    const view = await this.wrkqLedger.pendingView({ scopes: [targetSessionRef] })
    const blockingIds = new Set(view.blocking)
    blocking = view.items
      .filter((envelope) => blockingIds.has(envelope.id))
      .map((envelope) => ({
        envelopeId: envelope.id,
        from: envelope.from.scopeRef ?? envelope.from.principalRef,
        roomKey: envelope.roomKey,
        body: envelope.body,
      }))
  } catch (error) {
    writeServerLog('WARN', 'wrkq.stop_hook.fail_open', {
      runId: run.runId,
      targetSessionRef,
      error: error instanceof Error ? error.message : String(error),
    })
    return json({
      decision: 'allow',
      reason: 'ledger_unavailable',
      runId: run.runId,
      targetSessionRef,
    })
  }

  const newestEnvelopeSeq = blocking.reduce(
    (newest, envelope) => Math.max(newest, envelopeIdSequence(envelope.envelopeId)),
    0
  )
  const decision = this.db.mailStopRefusals.evaluate(
    run.runId,
    targetSessionRef,
    blocking,
    newestEnvelopeSeq,
    STOP_SUMMARY_LIMIT
  )
  if (decision.decision === 'allow') {
    return json({
      decision: 'allow',
      reason: decision.reason,
      runId: run.runId,
      targetSessionRef,
      unackedCount: decision.unackedCount,
      refusalCount: decision.refusalCount,
      totalRefusalCount: decision.totalRefusalCount,
    })
  }

  return json({
    decision: 'block',
    reason: formatStopReason(decision),
    runId: run.runId,
    targetSessionRef,
    unackedCount: decision.unackedCount,
    refusalCount: decision.refusalCount,
    totalRefusalCount: decision.totalRefusalCount,
  })
}

function isActiveStopRunStatus(status: string): boolean {
  return status === 'accepted' || status === 'started' || status === 'running'
}

function formatStopReason(
  decision: Extract<
    ReturnType<HrcServerInstanceForHandlers['db']['mailStopRefusals']['evaluate']>,
    { decision: 'block' }
  >
): string {
  const lines = [
    `Turn finish paused: ${decision.unackedCount} unanswered ${decision.unackedCount === 1 ? 'envelope' : 'envelopes'} remain (refusal ${decision.refusalCount}/3).`,
  ]
  for (const envelope of decision.envelopes) {
    lines.push(
      `- ${clip(envelope.roomKey, 80)} from ${clip(envelope.from, 120)}: ${clip(normalizePreview(envelope.body), STOP_BODY_PREVIEW_CHARS)}`
    )
  }
  if (decision.unackedCount > decision.envelopes.length) {
    lines.push(`- … and ${decision.unackedCount - decision.envelopes.length} more`)
  }
  lines.push(
    'Run `wrkc inbox`, then reply (`wrkc say <room> --to <sender>`) or `wrkc defer` every envelope before stopping. Replying IS the ack; deferred envelopes leave this gate.'
  )
  return clip(lines.join('\n'), STOP_REASON_MAX_CHARS)
}

function normalizePreview(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function clip(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, Math.max(maxChars - 1, 0))}…`
}

export const wrkqStopGateHandlersMethods = { handleMailStopDecision }

export type WrkqStopGateHandlersMethods = typeof wrkqStopGateHandlersMethods
