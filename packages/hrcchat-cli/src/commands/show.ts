import type { HrcClient } from 'hrc-sdk'
import { fatal, hasFlag, printJson, requireArg } from '../cli-args.js'
import { formatAddress } from '../normalize.js'

export async function cmdShow(client: HrcClient, args: string[]): Promise<void> {
  const json = hasFlag(args, '--json')
  const seqOrId = requireArg(args, 0, '<seq|message-id>')

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
    fatal(`message not found: ${seqOrId}`)
    return // unreachable but satisfies TS
  }

  if (json) {
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
