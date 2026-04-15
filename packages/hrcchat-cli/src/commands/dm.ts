import type { HrcClient } from 'hrc-sdk'
import {
  consumeBody,
  fatal,
  hasFlag,
  parseDuration,
  parseFlag,
  printJson,
  requireArg,
} from '../cli-args.js'
import { formatAddress, resolveAddress, resolveCallerAddress } from '../normalize.js'
import { resolveRuntimeIntentForTarget } from '../resolve-intent.js'

export async function cmdDm(client: HrcClient, args: string[]): Promise<void> {
  const json = hasFlag(args, '--json')
  const wait = hasFlag(args, '--wait')
  const targetInput = requireArg(args, 0, '<target>')
  const body = consumeBody(args, 1)

  if (!body) {
    fatal('dm requires a message body (positional, -, or --file)')
  }

  const callerSessionRef = process.env['HRC_SESSION_REF']
  const from = resolveCallerAddress()
  const to = resolveAddress(targetInput, callerSessionRef)

  const respondToRaw = parseFlag(args, '--respond-to')
  const respondTo = respondToRaw ? resolveAddress(respondToRaw, callerSessionRef) : undefined

  const replyToMessageId = parseFlag(args, '--reply-to')
  const modeRaw = parseFlag(args, '--mode') as 'auto' | 'headless' | 'nonInteractive' | undefined
  const timeoutRaw = parseFlag(args, '--timeout')
  const timeoutMs = timeoutRaw ? parseDuration(timeoutRaw) : undefined

  // Resolve runtimeIntent for session targets so auto-summon works
  const runtimeIntent =
    to.kind === 'session' ? resolveRuntimeIntentForTarget(targetInput) : undefined

  const result = await client.semanticDm({
    from,
    to,
    body,
    mode: modeRaw,
    respondTo,
    replyToMessageId,
    runtimeIntent,
    createIfMissing: true,
    wait: wait || timeoutMs !== undefined ? { enabled: true, timeoutMs } : undefined,
  })

  if (json) {
    printJson(result)
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
