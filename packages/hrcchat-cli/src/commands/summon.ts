import { CliUsageError } from 'cli-kit'
import type { HrcClient } from 'hrc-sdk'
import { resolveTargetToSessionRef } from '../normalize.js'
import { printJson } from '../print.js'
import { resolveRuntimeIntentForTarget } from '../resolve-intent.js'

export type SummonOptions = {
  json?: boolean | undefined
}

export async function cmdSummon(
  client: HrcClient,
  opts: SummonOptions,
  positionals: string[]
): Promise<void> {
  const targetInput = positionals[0]
  if (!targetInput) throw new CliUsageError('summon requires <target>')
  const sessionRef = resolveTargetToSessionRef(targetInput)

  const runtimeIntent = await resolveRuntimeIntentForTarget(targetInput)

  const result = await client.ensureTarget({
    sessionRef,
    runtimeIntent,
  })

  if (opts.json) {
    printJson(result)
    return
  }

  process.stdout.write(`Summoned: ${result.sessionRef}\n`)
  process.stdout.write(`  state: ${result.state}\n`)
  if (result.activeHostSessionId) {
    process.stdout.write(`  hostSessionId: ${result.activeHostSessionId}\n`)
  }
  if (result.generation !== undefined) {
    process.stdout.write(`  generation: ${result.generation}\n`)
  }
  process.stdout.write(
    `  capabilities: dm=${result.capabilities.dmReady} send=${result.capabilities.sendReady} peek=${result.capabilities.peekReady}\n`
  )
}
