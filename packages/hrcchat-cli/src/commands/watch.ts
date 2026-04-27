import type { HrcMessageFilter } from 'hrc-core'
import type { HrcClient } from 'hrc-sdk'
import { formatAddress, resolveAddress } from '../normalize.js'

export type WatchOptions = {
  follow?: boolean
  to?: string
  responsesTo?: string
  from?: string
  thread?: string
  after?: string
  timeout?: number // milliseconds (parsed by parseDuration in main.ts)
  json?: boolean | undefined
}

export async function cmdWatch(
  client: HrcClient,
  opts: WatchOptions,
  positionals: string[]
): Promise<void> {
  const callerSessionRef = process.env['HRC_SESSION_REF']

  const filter: HrcMessageFilter = {}

  const targetInput = positionals[0]
  if (targetInput) {
    filter.participant = resolveAddress(targetInput, callerSessionRef)
  }

  const toRaw = opts.to ?? opts.responsesTo
  if (toRaw) filter.to = resolveAddress(toRaw, callerSessionRef)

  if (opts.from) filter.from = resolveAddress(opts.from, callerSessionRef)

  if (opts.thread) filter.thread = { rootMessageId: opts.thread }

  if (opts.after) filter.afterSeq = Number.parseInt(opts.after, 10)

  const timeoutMs = opts.timeout

  const ac = new AbortController()
  process.on('SIGINT', () => ac.abort())

  try {
    for await (const msg of client.watchMessages({
      filter,
      follow: opts.follow,
      timeoutMs,
      signal: ac.signal,
    })) {
      if (opts.json) {
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
