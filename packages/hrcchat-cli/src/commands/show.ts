import { CliUsageError } from 'cli-kit'
import type { HrcClient } from 'hrc-sdk'
import { formatAddress } from '../normalize.js'
import { printJson } from '../print.js'

export type ShowOptions = {
  json?: boolean | undefined
}

export async function cmdShow(
  client: HrcClient,
  opts: ShowOptions,
  positionals: string[]
): Promise<void> {
  const seqOrId = positionals[0]
  if (!seqOrId) throw new CliUsageError('show requires <seq-or-id>')

  // Try as numeric seq first, then as message ID
  const seq = Number(seqOrId)
  const filter = Number.isFinite(seq)
    ? { afterSeq: seq - 1, limit: 1 }
    : { afterSeq: 0, limit: 1000 } // fallback: scan for message ID

  const result = await client.listMessages(filter)
  const record = Number.isFinite(seq)
    ? result.messages[0]
    : result.messages.find((m) => m.messageId === seqOrId)

  if (!record) {
    throw new CliUsageError(`message not found: ${seqOrId}`)
  }

  if (opts.json) {
    printJson(record)
    return
  }

  // Human output
  const from = formatAddress(record.from)
  const to = formatAddress(record.to)
  const phase =
    record.phase === 'response' ? ' (response)' : record.phase === 'oneway' ? ' (oneway)' : ''
  process.stdout.write(`#${record.messageSeq} ${from} → ${to}${phase}\n`)
  process.stdout.write(`${record.body}\n`)
}
