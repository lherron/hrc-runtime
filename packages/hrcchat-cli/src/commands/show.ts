import { CliUsageError } from 'cli-kit'
import type { HrcClient } from 'hrc-sdk'
import { formatAddress } from '../normalize.js'
import { printJson } from '../print.js'
import { resolveMessageSelector } from './message-selector.js'

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

  const { record } = await resolveMessageSelector(client, seqOrId)

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
