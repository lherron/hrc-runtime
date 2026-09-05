/**
 * The Stop gate (T-07612 §8, built in wave 3 / T-07615).
 *
 * Refuses turn end while this scope has presented reply-required envelopes that
 * are neither replied nor deferred. The predicate is a wrkq query — wrkq owns
 * the obligation — and it FAILS OPEN: a ledger this daemon cannot reach must
 * never be able to trap an agent inside a turn.
 *
 * T-08094 re-keyed it on the RUNTIME. It used to resolve the seat from
 * `runtime.activeRunId` and allow the stop outright when there was none — and a
 * human-typed pane turn mints no run, so an obligation steered into one was
 * never gated at all. The seat scope comes off the runtime row now, which is
 * true for both shapes, and the refusal counter is keyed the same way: a
 * per-runtime, per-obligation-set count rather than a per-run one.
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
import { envelopeIdSequence } from 'hrc-mail-kicker'
import type { HrcMailStopEnvelopeSummary } from 'hrc-store-sqlite'

import { normalizeTargetSessionRef } from '../messages.js'
import type { HrcServerInstanceForHandlers } from '../server-instance-context.js'
import { writeServerLog } from '../server-log.js'
import { isRecord, parseJsonBody } from '../server-parsers.js'
import { json } from '../server-util.js'

const STOP_SUMMARY_LIMIT = 8
const STOP_BODY_PREVIEW_CHARS = 160
const STOP_REASON_MAX_CHARS = 4_096

export const MAIL_HINT_TEXT = (heldCount: number): string => {
  const noun = heldCount === 1 ? 'envelope is' : 'envelopes are'
  return `Mail hint from HRC: ${heldCount} ${noun} waiting for this seat. Run \`wrkc inbox\` to see them and \`wrkc show EN-xxxxx\` to read one. Replying with \`wrkc say <room> --to <sender>\` answers it now; anything unanswered presents at turn end.`
}

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
  if (runtime === null) {
    return json({ decision: 'allow', reason: 'no_runtime' })
  }

  const targetSessionRef = normalizeTargetSessionRef(sessionRefFor(runtime))
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
      runtimeId,
      targetSessionRef,
      error: error instanceof Error ? error.message : String(error),
    })
    return json({
      decision: 'allow',
      reason: 'ledger_unavailable',
      runtimeId,
      targetSessionRef,
    })
  }

  const newestEnvelopeSeq = blocking.reduce(
    (newest, envelope) => Math.max(newest, envelopeIdSequence(envelope.envelopeId)),
    0
  )
  const decision = this.db.mailStopRefusals.evaluate(
    runtimeId,
    targetSessionRef,
    blocking,
    newestEnvelopeSeq,
    STOP_SUMMARY_LIMIT
  )
  if (decision.decision === 'allow') {
    return json({
      decision: 'allow',
      reason: decision.reason,
      runtimeId,
      targetSessionRef,
      unackedCount: decision.unackedCount,
      refusalCount: decision.refusalCount,
      totalRefusalCount: decision.totalRefusalCount,
    })
  }

  return json({
    decision: 'block',
    reason: formatStopReason(decision),
    runtimeId,
    targetSessionRef,
    unackedCount: decision.unackedCount,
    refusalCount: decision.refusalCount,
    totalRefusalCount: decision.totalRefusalCount,
  })
}

/**
 * Count-only local hint for mail the harness is holding behind the active turn.
 *
 * Unlike the Stop gate above, this path never consults wrkq: PostToolUse owns a
 * 250 ms bridge budget, and a hint is optional execution context rather than a
 * presentation or obligation.
 *
 * The count is the seat's OUTSTANDING ENQUEUE SUBMISSIONS (T-08094). On a
 * steer-capable seat it is zero by construction: a steered body lands inside
 * the turn the reader is already in, so there is nothing to hint about.
 */
export async function handleMailHintDecision(
  this: HrcServerInstanceForHandlers,
  request: Request
): Promise<Response> {
  let runtimeId = ''
  try {
    const body = await parseJsonBody(request)
    runtimeId = isRecord(body) && typeof body['runtimeId'] === 'string' ? body['runtimeId'] : ''
    if (runtimeId.length === 0) {
      writeHintSuppressed(runtimeId, 'error')
      return json({})
    }

    const runtime = this.db.runtimes.getByRuntimeId(runtimeId)
    if (runtime === null) {
      writeHintSuppressed(runtimeId, 'no_runtime')
      return json({})
    }

    const targetSessionRef = normalizeTargetSessionRef(sessionRefFor(runtime))
    const decision = this.db.mailDelivery.evaluateSeatHint(targetSessionRef, runtimeId)
    if (decision.outcome === 'suppressed') {
      writeHintSuppressed(runtimeId, decision.reason)
      return json({})
    }

    const hint = MAIL_HINT_TEXT(decision.outstandingCount)
    writeServerLog('INFO', 'wrkq.kicker.hint_issued', {
      runtimeId,
      targetSessionRef,
      outstandingCount: decision.outstandingCount,
      reason: decision.reason,
    })
    return json({
      hint,
      heldCount: decision.outstandingCount,
      reason: decision.reason,
    })
  } catch (error) {
    writeHintSuppressed(runtimeId, 'error', error)
    return json({})
  }
}

function writeHintSuppressed(
  runtimeId: string,
  reason: 'no_runtime' | 'no_outstanding_mail' | 'runtime_mismatch' | 'cadence' | 'error',
  error?: unknown
): void {
  writeServerLog('DEBUG', 'wrkq.kicker.hint_suppressed', {
    runtimeId,
    reason,
    ...(error === undefined
      ? {}
      : { error: error instanceof Error ? error.message : String(error) }),
  })
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

export const wrkqStopGateHandlersMethods = { handleMailHintDecision, handleMailStopDecision }

export type WrkqStopGateHandlersMethods = typeof wrkqStopGateHandlersMethods
