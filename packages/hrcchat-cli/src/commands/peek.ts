import { CliUsageError } from 'cli-kit'
import type { HrcClient } from 'hrc-sdk'
import { resolveTargetToSessionRef } from '../normalize.js'
import { printJson } from '../print.js'

export type PeekOptions = {
  lines?: string
  json?: boolean | undefined
}

export async function cmdPeek(
  client: HrcClient,
  opts: PeekOptions,
  positionals: string[]
): Promise<void> {
  const targetInput = positionals[0]
  if (!targetInput) throw new CliUsageError('peek requires <target>')
  const lines = Number.parseInt(opts.lines ?? '80', 10)
  const sessionRef = resolveTargetToSessionRef(targetInput)

  const result = await client.captureBySelector({
    selector: { sessionRef },
    lines,
  })

  if (opts.json) {
    printJson(result)
    return
  }

  process.stdout.write(result.text)
  if (!result.text.endsWith('\n')) {
    process.stdout.write('\n')
  }
}
