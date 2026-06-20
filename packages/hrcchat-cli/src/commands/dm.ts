import { CliUsageError, consumeBody, parseDuration } from 'cli-kit'
import { HrcDomainError } from 'hrc-core'
import type { HrcMessageAddress, SemanticDmResponse, WaitMessageResponse } from 'hrc-core'
import type { HrcClient } from 'hrc-sdk'
import { formatAddress, resolveAddress, resolveCallerAddress } from '../normalize.js'
import { printJsonLine } from '../print.js'
import { resolveRuntimeIntentForTarget } from '../resolve-intent.js'
import { buildDmWaitResult } from '../wait-final.js'

export type DmOptions = {
  respondTo?: string
  replyTo?: string
  crossScopeReply?: boolean
  mode?: 'auto' | 'headless' | 'nonInteractive'
  file?: string
  json?: boolean | undefined
  project?: string | undefined
  /**
   * Final-only Codex wait mode. `response` blocks quietly for the correlated
   * reply, then emits one compact JSON object. Distinct from `--follow`, which
   * streams progress (handled upstream in main.ts and never reaches cmdDm).
   */
  wait?: string | undefined
  /** Wait budget for `--wait response`. Default 20m. */
  timeout?: string | undefined
  /** Suppress all non-terminal stdout/stderr while waiting (default in wait mode). */
  quiet?: boolean | undefined
}

const DM_WAIT_DEFAULT_TIMEOUT = '20m'

export async function cmdDm(
  client: HrcClient,
  opts: DmOptions,
  positionals: string[]
): Promise<void> {
  const targetInput = positionals[0]
  if (!targetInput) {
    throw new CliUsageError('missing required argument: <target>')
  }

  const body = consumeBody({ positional: positionals[1], file: opts.file })

  if (!body) {
    throw new CliUsageError('dm requires a message body (positional, -, or --file)')
  }

  // ── Final-only Codex wait mode ──
  // `--wait response` blocks quietly for the correlated reply, then emits one
  // compact JSON object. The server performs the blocking wait (thread-scoped,
  // phase=response, afterSeq cursor); the CLI stays silent until the terminal
  // result. This is additive: --follow is intercepted in main.ts and never
  // reaches cmdDm, so streaming semantics are untouched.
  const waitMode = opts.wait
  if (waitMode !== undefined && waitMode !== 'response') {
    throw new CliUsageError(`unsupported --wait mode for dm: "${waitMode}" (expected: response)`)
  }
  const quiet = waitMode !== undefined ? opts.quiet !== false : opts.quiet === true
  const waitTimeoutMs =
    waitMode !== undefined ? parseDuration(opts.timeout ?? DM_WAIT_DEFAULT_TIMEOUT) : undefined
  if (waitTimeoutMs !== undefined && waitTimeoutMs <= 0) {
    throw new CliUsageError(`invalid duration: ${opts.timeout} (must be > 0)`)
  }

  const callerSessionRef = process.env['HRC_SESSION_REF']
  const from = resolveCallerAddress()
  const to = resolveAddress(targetInput, callerSessionRef)

  const respondTo = opts.respondTo ? resolveAddress(opts.respondTo, callerSessionRef) : undefined

  // Resolve runtimeIntent for session targets so auto-summon works
  const runtimeIntent =
    to.kind === 'session' ? resolveRuntimeIntentForTarget(targetInput) : undefined

  // Final-only wait does NOT use the server's coupled `wait` option: that
  // blocks on turn completion, so its timeoutMs only bounds the post-completion
  // message wait and a slow turn would blow past `--timeout`. Instead we
  // dispatch fast (detached turn) and run a client-side bounded waitMessage
  // below — giving `--timeout` as a true hard ceiling.
  const sendWith = (replyToMessageId: string | undefined): Promise<SemanticDmResponse> =>
    client.semanticDm({
      from,
      to,
      body,
      mode: opts.mode,
      respondTo,
      replyToMessageId,
      runtimeIntent,
      createIfMissing: true,
      ...(opts.crossScopeReply ? { allowCrossScopeReply: true } : {}),
    })

  // T-01744: a stale/unresolvable --reply-to anchor (e.g. the parent message was
  // lost across an unclean daemon restart) must not block delivery. The server
  // rejects an unknown anchor with malformed_request{field:'replyToMessageId'};
  // when that happens, self-heal by resending unthreaded (the documented
  // workaround) and warn, instead of failing the send outright.
  const startedAt = Date.now()
  let result: SemanticDmResponse
  try {
    result = await sendWith(opts.replyTo)
  } catch (err) {
    if (opts.replyTo !== undefined && isUnknownReplyAnchorError(err)) {
      // In quiet wait mode the stream must carry no progress/warning output
      // before the terminal JSON; the unthreaded resend is reflected by the
      // result's correlation mode instead.
      if (!quiet) {
        process.stderr.write(
          `hrcchat: --reply-to anchor "${opts.replyTo}" is unknown; sending without threading\n`
        )
      }
      result = await sendWith(undefined)
    } else {
      throw err
    }
  }

  // Final-only wait: block quietly (client-side, hard `--timeout` ceiling) for
  // the correlated response, then emit exactly one compact result object. Exit
  // codes are set silently (no stderr) so scripts can branch on $? while the
  // quiet contract holds; the `status` field is the primary signal.
  if (waitMode === 'response' && waitTimeoutMs !== undefined) {
    const request = result.request
    // A dispatch that already failed (e.g. busy headless runtime) will never
    // produce a response — skip the wait and report the error immediately.
    const waited: WaitMessageResponse | undefined = request.execution.errorCode
      ? undefined
      : await client.waitMessage({
          thread: { rootMessageId: request.rootMessageId },
          phases: ['response'],
          afterSeq: request.messageSeq,
          timeoutMs: waitTimeoutMs,
        })
    const waitResult = buildDmWaitResult({
      request,
      waited,
      target: to,
      elapsedMs: Date.now() - startedAt,
    })
    printJsonLine(waitResult)
    if (waitResult.status === 'timeout') {
      process.exitCode = 1
    } else if (waitResult.status === 'error') {
      process.exitCode = 4
    }
    return
  }

  if (opts.json) {
    printJsonLine(buildHandoffEnvelope(result, to))
    return
  }

  // Human output
  if (result.reply) {
    process.stdout.write(result.reply.body)
    if (!result.reply.body.endsWith('\n')) {
      process.stdout.write('\n')
    }
  } else {
    const toStr = formatAddress(to)
    process.stdout.write(`dm sent to ${toStr} (seq: ${result.request.messageSeq})\n`)
  }
}

/**
 * True when the server rejected the request specifically because the
 * `--reply-to` anchor could not be resolved (vs. any other malformed input).
 */
function isUnknownReplyAnchorError(err: unknown): boolean {
  return (
    err instanceof HrcDomainError &&
    err.code === 'malformed_request' &&
    err.detail?.['field'] === 'replyToMessageId'
  )
}

// -- Handoff envelope ---------------------------------------------------------

/**
 * Build the monitor-handoff JSON envelope from a SemanticDmResponse.
 *
 * Required fields: messageId, seq, to (handle form), sessionRef (canonical).
 * Nullable fields: runtimeId, turnId (null when target not yet executing).
 *
 * This envelope is the stable contract consumed by `hrc monitor wait msg:<id>`.
 */
export type DmHandoffEnvelope = {
  messageId: string
  seq: number
  to: string
  sessionRef: string
  runtimeId: string | null
  turnId: string | null
  errorCode?: string | undefined
  errorMessage?: string | undefined
  /** Full response preserved for backward compatibility and debugging. */
  request: SemanticDmResponse['request']
  execution?: SemanticDmResponse['execution']
  reply?: SemanticDmResponse['reply']
}

function buildHandoffEnvelope(
  result: SemanticDmResponse,
  toAddr: HrcMessageAddress
): DmHandoffEnvelope {
  const { request, execution } = result

  // sessionRef: prefer execution response (most fresh), then message execution field, then target address
  const sessionRef =
    execution?.sessionRef ??
    request.execution.sessionRef ??
    (toAddr.kind === 'session' ? toAddr.sessionRef : '')

  // runtimeId: prefer execution response, fall back to persisted execution
  const runtimeId = execution?.runtimeId ?? request.execution.runtimeId ?? null

  // turnId: mapped from runId in the execution layer
  const turnId = execution?.runId ?? request.execution.runId ?? null

  return {
    messageId: request.messageId,
    seq: request.messageSeq,
    to: formatAddress(toAddr),
    sessionRef,
    runtimeId,
    turnId,
    ...(request.execution.errorCode ? { errorCode: request.execution.errorCode } : {}),
    ...(request.execution.errorMessage ? { errorMessage: request.execution.errorMessage } : {}),
    request: result.request,
    ...(result.execution ? { execution: result.execution } : {}),
    ...(result.reply ? { reply: result.reply } : {}),
  }
}
