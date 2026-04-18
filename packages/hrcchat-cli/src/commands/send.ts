import type { HrcClient } from 'hrc-sdk'
import { consumeBody, fatal, hasFlag, printJson, requireArg } from '../cli-args.js'
import { resolveTargetToSessionRef } from '../normalize.js'

const SEND_VALUE_FLAGS = ['--file', '--project']

export async function cmdSend(client: HrcClient, args: string[]): Promise<void> {
  const json = hasFlag(args, '--json')
  const targetInput = requireArg(args, 0, '<target>', SEND_VALUE_FLAGS)
  const body = consumeBody(args, 1, SEND_VALUE_FLAGS)

  if (!body) {
    fatal('send requires text (positional, -, or --file)')
  }

  const sessionRef = resolveTargetToSessionRef(targetInput)
  const enter = !hasFlag(args, '--no-enter')

  const result = await client.deliverLiteralBySelector({
    selector: { sessionRef },
    text: body,
    enter,
  })

  if (json) {
    printJson(result)
    return
  }

  process.stdout.write(`Sent to ${sessionRef}\n`)
}
