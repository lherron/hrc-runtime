import type { HrcMessageFilter, HrcMessageRecord } from 'hrc-core'
import type { HrcClient } from 'hrc-sdk'
import { hasFlag, parseFlag, parseIntegerFlag, printJson } from '../cli-args.js'
import { formatAddress, resolveAddress } from '../normalize.js'

export async function cmdMessages(client: HrcClient, args: string[]): Promise<void> {
  const json = hasFlag(args, '--json')
  const callerSessionRef = process.env['HRC_SESSION_REF']

  const filter: HrcMessageFilter = {}

  // Positional target = participant filter
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

  filter.limit = parseIntegerFlag(args, '--limit', { defaultValue: 50, min: 1 })

  const result = await client.listMessages(filter)

  if (json) {
    printJson(result)
    return
  }

  if (result.messages.length === 0) {
    process.stdout.write('No messages.\n')
    return
  }

  for (const msg of result.messages) {
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
