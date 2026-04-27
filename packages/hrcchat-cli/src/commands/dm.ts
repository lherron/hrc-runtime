import { CliUsageError, consumeBody } from 'cli-kit'
import type { HrcMessageAddress, SemanticDmResponse } from 'hrc-core'
import type { HrcClient } from 'hrc-sdk'
import { formatAddress, resolveAddress, resolveCallerAddress } from '../normalize.js'
import { printJson } from '../print.js'
import { resolveRuntimeIntentForTarget } from '../resolve-intent.js'

export type DmOptions = {
  respondTo?: string
  replyTo?: string
  mode?: 'auto' | 'headless' | 'nonInteractive'
  wait?: boolean
  timeout?: number // milliseconds (parsed by parseDuration in main.ts)
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

  const timeoutMs = opts.timeout

  // Resolve runtimeIntent for session targets so auto-summon works
  const runtimeIntent =
    to.kind === 'session' ? resolveRuntimeIntentForTarget(targetInput) : undefined

  const result = await client.semanticDm({
    from,
    to,
    body,
    mode: opts.mode,
    respondTo,
    replyToMessageId: opts.replyTo,
    runtimeIntent,
    createIfMissing: true,
    wait: opts.wait || timeoutMs !== undefined ? { enabled: true, timeoutMs } : undefined,
  })

  if (opts.json) {
    printJson(buildHandoffEnvelope(result, to))
    return
  }

  // Human output
  if (result.reply) {
    process.stdout.write(result.reply.body)
    if (!result.reply.body.endsWith('\n')) {
      process.stdout.write('\n')
    }
  } else if (result.waited) {
    if (result.waited.matched) {
      process.stdout.write(result.waited.record.body)
      if (!result.waited.record.body.endsWith('\n')) {
        process.stdout.write('\n')
      }
    } else {
      process.stderr.write('hrcchat: wait timed out\n')
      process.exit(124)
    }
  } else {
    const toStr = formatAddress(to)
    process.stdout.write(`dm sent to ${toStr} (seq: ${result.request.messageSeq})\n`)
  }
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
  /** Full response preserved for backward compatibility and debugging. */
  request: SemanticDmResponse['request']
  execution?: SemanticDmResponse['execution']
  reply?: SemanticDmResponse['reply']
  waited?: SemanticDmResponse['waited']
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
    request: result.request,
    ...(result.execution ? { execution: result.execution } : {}),
    ...(result.reply ? { reply: result.reply } : {}),
    ...(result.waited ? { waited: result.waited } : {}),
  }
}
