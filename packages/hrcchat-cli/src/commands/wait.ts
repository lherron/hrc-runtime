import type { WaitMessageRequest } from 'hrc-core'
import type { HrcClient } from 'hrc-sdk'
import { formatAddress, resolveAddress } from '../normalize.js'
import { printJson } from '../print.js'

export type WaitOptions = {
  to?: string
  responsesTo?: string
  from?: string
  thread?: string
  after?: string
  timeout?: number // milliseconds (parsed by parseDuration in main.ts)
  json?: boolean | undefined
}

export async function cmdWait(client: HrcClient, opts: WaitOptions): Promise<void> {
  const callerSessionRef = process.env['HRC_SESSION_REF']

  const request: WaitMessageRequest = {}

  const toRaw = opts.to ?? opts.responsesTo
  if (toRaw) request.to = resolveAddress(toRaw, callerSessionRef)

  if (opts.from) request.from = resolveAddress(opts.from, callerSessionRef)

  if (opts.thread) request.thread = { rootMessageId: opts.thread }

  if (opts.after) request.afterSeq = Number.parseInt(opts.after, 10)

  if (opts.timeout !== undefined) request.timeoutMs = opts.timeout

  const result = await client.waitMessage(request)

  if (opts.json) {
    printJson(result)
    return
  }

  if (result.matched) {
    const msg = result.record
    const from = formatAddress(msg.from)
    const to = formatAddress(msg.to)
    process.stdout.write(`#${msg.messageSeq} ${from} -> ${to}\n`)
    process.stdout.write(msg.body)
    if (!msg.body.endsWith('\n')) {
      process.stdout.write('\n')
    }
  } else {
    process.stderr.write('hrcchat: wait timed out\n')
    process.exit(124)
  }
}
