import { CliUsageError, consumeBody } from 'cli-kit'
import type { HrcClient } from 'hrc-sdk'
import { resolveTargetToSessionRef } from '../normalize.js'
import { printJson } from '../print.js'

export type SendOptions = {
  enter?: boolean
  file?: string
  json?: boolean | undefined
}

export async function cmdSend(
  client: HrcClient,
  opts: SendOptions,
  positionals: string[]
): Promise<void> {
  const targetInput = positionals[0]
  if (!targetInput) throw new CliUsageError('send requires <target>')
  const body = consumeBody({ positional: positionals[1], file: opts.file })

  if (!body) {
    throw new CliUsageError('send requires text (positional, -, or --file)')
  }

  const sessionRef = resolveTargetToSessionRef(targetInput)
  // Commander's --no-enter sets opts.enter to false; default is true
  const enter = opts.enter !== false

  const result = await client.deliverLiteralBySelector({
    selector: { sessionRef },
    text: body,
    enter,
  })

  if (opts.json) {
    printJson(result)
    return
  }

  process.stdout.write(`Sent to ${sessionRef}\n`)
}
