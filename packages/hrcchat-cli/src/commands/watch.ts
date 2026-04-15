import type { HrcMessageFilter } from 'hrc-core'
import type { HrcClient } from 'hrc-sdk'
import { hasFlag, parseDuration, parseFlag } from '../cli-args.js'
import { formatAddress, resolveAddress } from '../normalize.js'

export async function cmdWatch(client: HrcClient, args: string[]): Promise<void> {
  const json = hasFlag(args, '--json')
  const follow = hasFlag(args, '--follow')
  const callerSessionRef = process.env['HRC_SESSION_REF']

  const filter: HrcMessageFilter = {}

  const firstArg = args[0]
  if (firstArg && !firstArg.startsWith('-')) {
    filter.participant = resolveAddress(firstArg, callerSessionRef)
  }

  const toRaw = parseFlag(args, '--to') ?? parseFlag(args, '--responses-to')
  if (toRaw) filter.to = resolveAddress(toRaw, callerSessionRef)

  const fromRaw = parseFlag(args, '--from')
  if (fromRaw) filter.from = resolveAddress(fromRaw, callerSessionRef)

  const threadRaw = parseFlag(args, '--thread')
  if (threadRaw) filter.thread = { rootMessageId: threadRaw }

  const afterRaw = parseFlag(args, '--after')
  if (afterRaw) filter.afterSeq = Number.parseInt(afterRaw, 10)

  const timeoutRaw = parseFlag(args, '--timeout')
  const timeoutMs = timeoutRaw ? parseDuration(timeoutRaw) : undefined

  const ac = new AbortController()
  process.on('SIGINT', () => ac.abort())

  try {
    for await (const msg of client.watchMessages({
      filter,
      follow,
      timeoutMs,
      signal: ac.signal,
    })) {
      if (json) {
        process.stdout.write(`${JSON.stringify(msg)}\n`)
      } else {
        const from = formatAddress(msg.from)
        const to = formatAddress(msg.to)
        const phase = msg.phase === 'request' ? '>' : msg.phase === 'response' ? '<' : '-'
        process.stdout.write(
          `#${msg.messageSeq} ${phase} ${from} -> ${to}: ${msg.body.split('\n')[0]}\n`
        )
      }
    }
  } catch (err) {
    if (ac.signal.aborted) return
    throw err
  }
}
