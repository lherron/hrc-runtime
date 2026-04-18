import type { HrcClient } from 'hrc-sdk'
import { hasFlag, parseIntegerFlag, printJson, requireArg } from '../cli-args.js'
import { resolveTargetToSessionRef } from '../normalize.js'

export async function cmdPeek(client: HrcClient, args: string[]): Promise<void> {
  const json = hasFlag(args, '--json')
  const targetInput = requireArg(args, 0, '<target>', ['--lines', '--project'])
  const lines = parseIntegerFlag(args, '--lines', { defaultValue: 80, min: 1 })
  const sessionRef = resolveTargetToSessionRef(targetInput)

  const result = await client.captureBySelector({
    selector: { sessionRef },
    lines,
  })

  if (json) {
    printJson(result)
    return
  }

  process.stdout.write(result.text)
  if (!result.text.endsWith('\n')) {
    process.stdout.write('\n')
  }
}
