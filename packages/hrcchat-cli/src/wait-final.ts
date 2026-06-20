/**
 * Codex-friendly final-only wait results for `hrcchat dm --wait` and
 * `hrcchat turn --wait`.
 *
 * These commands send/dispatch once, block QUIETLY while the correlated
 * response/terminal condition is pending, then emit exactly one compact JSON
 * object. The shapes here are that machine-actionable contract — distinct from
 * the human/debug `--follow`/`--stacked` progress streams, which are unchanged.
 *
 * Terminal `status` values:
 *   responded — the correlated response/final result arrived
 *   timeout   — the wait budget elapsed with no terminal result
 *   error     — the send/turn ended in an error before any response
 *   cancelled — the wait was interrupted (e.g. SIGINT)
 */
import type {
  HrcMessageAddress,
  HrcMessageRecord,
  WaitMessageResponse,
} from 'hrc-core'

import { formatAddress } from './normalize.js'

export type WaitFinalStatus = 'responded' | 'timeout' | 'error' | 'cancelled'

/**
 * How the response was tied back to the outgoing message.
 *   reply_to  — direct reply/thread linkage (reply.replyToMessageId or
 *               reply.rootMessageId points at the outgoing message)
 *   after_seq — fallback: first response on the conversation after the
 *               outgoing message's sequence number
 */
export type WaitFinalCorrelation = {
  mode: 'reply_to' | 'after_seq'
  afterSeq: number
}

export type WaitFinalResponse = {
  messageId: string
  from: string
  text: string
}

/**
 * The single compact object emitted by a final-only wait. Optional fields are
 * present only when meaningful: `correlation`/`response` on success,
 * `lastSeq`/`errorCode`/`errorMessage` on timeout/error.
 */
export type WaitFinalResult = {
  status: WaitFinalStatus
  sentMessageId: string
  target: string
  elapsedMs: number
  correlation?: WaitFinalCorrelation
  response?: WaitFinalResponse
  /** Resume/inspection cursor for timeout/error — the outgoing message seq. */
  lastSeq?: number
  errorCode?: string
  errorMessage?: string
}

/**
 * Decide whether a response record is threaded back to the outgoing message
 * (direct reply linkage) or only correlated by position (after-seq fallback).
 */
function deriveCorrelation(
  reply: HrcMessageRecord,
  sentMessageId: string,
  afterSeq: number
): WaitFinalCorrelation {
  const threaded = reply.replyToMessageId === sentMessageId || reply.rootMessageId === sentMessageId
  return { mode: threaded ? 'reply_to' : 'after_seq', afterSeq }
}

function responseFrom(reply: HrcMessageRecord): WaitFinalResponse {
  return {
    messageId: reply.messageId,
    from: formatAddress(reply.from),
    text: reply.body,
  }
}

/**
 * Build the final-only result for `hrcchat dm --wait response`.
 *
 * The dispatch is fired WITHOUT the server's coupled wait (which would block on
 * turn completion, defeating a hard `--timeout`); instead the CLI performs a
 * client-side bounded `waitMessage` (thread-scoped, phase=response, afterSeq
 * cursor). `request` is the outgoing record; `waited` is that bounded wait's
 * result, or `undefined` when the dispatch itself errored before any wait.
 */
export function buildDmWaitResult(args: {
  request: HrcMessageRecord
  waited: WaitMessageResponse | undefined
  target: HrcMessageAddress
  elapsedMs: number
}): WaitFinalResult {
  const { request, waited, elapsedMs } = args
  const target = formatAddress(args.target)
  const sentMessageId = request.messageId
  const afterSeq = request.messageSeq

  const reply = waited && waited.matched ? waited.record : undefined
  if (reply) {
    return {
      status: 'responded',
      sentMessageId,
      target,
      elapsedMs,
      correlation: deriveCorrelation(reply, sentMessageId, afterSeq),
      response: responseFrom(reply),
    }
  }

  // No reply: a dispatch error wins over a plain timeout (it is the actionable
  // reason the response will never come).
  const errorCode = request.execution.errorCode
  const errorMessage = request.execution.errorMessage
  if (errorCode) {
    return {
      status: 'error',
      sentMessageId,
      target,
      elapsedMs,
      lastSeq: afterSeq,
      errorCode,
      ...(errorMessage ? { errorMessage } : {}),
    }
  }

  return {
    status: 'timeout',
    sentMessageId,
    target,
    elapsedMs,
    lastSeq: afterSeq,
  }
}
