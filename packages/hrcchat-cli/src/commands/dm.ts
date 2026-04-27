import { CliUsageError, consumeBody } from 'cli-kit'
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
