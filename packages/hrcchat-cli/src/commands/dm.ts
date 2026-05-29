import { CliUsageError, consumeBody } from 'cli-kit'
import { HrcDomainError } from 'hrc-core'
import type { HrcMessageAddress, SemanticDmResponse } from 'hrc-core'
import type { HrcClient } from 'hrc-sdk'
import { formatAddress, resolveAddress, resolveCallerAddress } from '../normalize.js'
import { printJsonLine } from '../print.js'
import { resolveRuntimeIntentForTarget } from '../resolve-intent.js'

export type DmOptions = {
  respondTo?: string
  replyTo?: string
  mode?: 'auto' | 'headless' | 'nonInteractive'
  file?: string
  json?: boolean | undefined
  project?: string | undefined
}

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

  const callerSessionRef = process.env['HRC_SESSION_REF']
  const from = resolveCallerAddress()
  const to = resolveAddress(targetInput, callerSessionRef)

  const respondTo = opts.respondTo ? resolveAddress(opts.respondTo, callerSessionRef) : undefined

  // Resolve runtimeIntent for session targets so auto-summon works
  const runtimeIntent =
    to.kind === 'session' ? resolveRuntimeIntentForTarget(targetInput) : undefined

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
    })

  // T-01744: a stale/unresolvable --reply-to anchor (e.g. the parent message was
  // lost across an unclean daemon restart) must not block delivery. The server
  // rejects an unknown anchor with malformed_request{field:'replyToMessageId'};
  // when that happens, self-heal by resending unthreaded (the documented
  // workaround) and warn, instead of failing the send outright.
  let result: SemanticDmResponse
  try {
    result = await sendWith(opts.replyTo)
  } catch (err) {
    if (opts.replyTo !== undefined && isUnknownReplyAnchorError(err)) {
      process.stderr.write(
        `hrcchat: --reply-to anchor "${opts.replyTo}" is unknown; sending without threading\n`
      )
      result = await sendWith(undefined)
    } else {
      throw err
    }
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
