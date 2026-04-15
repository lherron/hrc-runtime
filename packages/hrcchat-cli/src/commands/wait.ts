import type { WaitMessageRequest } from 'hrc-core'
import type { HrcClient } from 'hrc-sdk'
import { hasFlag, parseDuration, parseFlag, printJson } from '../cli-args.js'
import { formatAddress, resolveAddress } from '../normalize.js'

export async function cmdWait(client: HrcClient, args: string[]): Promise<void> {
  const json = hasFlag(args, '--json')
  const callerSessionRef = process.env['HRC_SESSION_REF']

  const request: WaitMessageRequest = {}

  const toRaw = parseFlag(args, '--to') ?? parseFlag(args, '--responses-to')
  if (toRaw) request.to = resolveAddress(toRaw, callerSessionRef)

  const fromRaw = parseFlag(args, '--from')
  if (fromRaw) request.from = resolveAddress(fromRaw, callerSessionRef)

  const threadRaw = parseFlag(args, '--thread')
  if (threadRaw) request.thread = { rootMessageId: threadRaw }

  const afterRaw = parseFlag(args, '--after')
  if (afterRaw) request.afterSeq = Number.parseInt(afterRaw, 10)

  const timeoutRaw = parseFlag(args, '--timeout')
  if (timeoutRaw) request.timeoutMs = parseDuration(timeoutRaw)

  const result = await client.waitMessage(request)

  if (json) {
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
