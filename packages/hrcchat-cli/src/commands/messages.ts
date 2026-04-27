import type { HrcMessageFilter, HrcMessageRecord } from 'hrc-core'
import type { HrcClient } from 'hrc-sdk'
import { formatAddress, resolveAddress } from '../normalize.js'
import { printJson } from '../print.js'

export type MessagesOptions = {
  to?: string
  responsesTo?: string
  from?: string
  thread?: string
  after?: string
  limit?: string
  json?: boolean | undefined
}

export async function cmdMessages(
  client: HrcClient,
  opts: MessagesOptions,
  positionals: string[]
): Promise<void> {
  const callerSessionRef = process.env['HRC_SESSION_REF']

  const filter: HrcMessageFilter = {}

  // Positional target = participant filter
  const targetInput = positionals[0]
  if (targetInput) {
    filter.participant = resolveAddress(targetInput, callerSessionRef)
  }

  const toRaw = opts.to ?? opts.responsesTo
  if (toRaw) filter.to = resolveAddress(toRaw, callerSessionRef)

  if (opts.from) filter.from = resolveAddress(opts.from, callerSessionRef)

  if (opts.thread) filter.thread = { rootMessageId: opts.thread }

  if (opts.after) filter.afterSeq = Number.parseInt(opts.after, 10)

  filter.limit = Number.parseInt(opts.limit ?? '50', 10)

  // Without an --after cursor, tail: fetch the latest N in descending order
  // then reverse so the display is oldest-first within the window.
  const tailMode = filter.afterSeq === undefined
  if (tailMode) filter.order = 'desc'

  const result = await client.listMessages(filter)
  const messages = tailMode ? [...result.messages].reverse() : result.messages

  if (opts.json) {
    printJson({ ...result, messages })
    return
  }

  if (messages.length === 0) {
    process.stdout.write('No messages.\n')
    return
  }

  for (const msg of messages) {
    renderMessage(msg)
  }
}

function renderMessage(msg: HrcMessageRecord): void {
  const from = formatAddress(msg.from)
  const to = formatAddress(msg.to)
  const ts = msg.createdAt.replace('T', ' ').replace(/\.\d+Z$/, '')
  const phase = msg.phase === 'request' ? '>' : msg.phase === 'response' ? '<' : '-'
  const seq = `#${msg.messageSeq}`

  process.stdout.write(`${seq} ${ts} ${phase} ${from} -> ${to}\n`)

  const lines = msg.body.split('\n')
  const firstLine = lines[0] ?? ''
  const preview = firstLine.length > 120 ? `${firstLine.slice(0, 117)}...` : firstLine
  process.stdout.write(`  ${preview}\n`)

  if (lines.length > 1) {
    process.stdout.write(`  (${lines.length} lines)\n`)
  }
}
