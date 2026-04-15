import type { HrcClient } from 'hrc-sdk'
import { hasFlag, printJson, requireArg } from '../cli-args.js'
import { resolveTargetToSessionRef } from '../normalize.js'
import { resolveRuntimeIntentForTarget } from '../resolve-intent.js'

export async function cmdSummon(client: HrcClient, args: string[]): Promise<void> {
  const json = hasFlag(args, '--json')
  const targetInput = requireArg(args, 0, '<target>')
  const sessionRef = resolveTargetToSessionRef(targetInput)

  const runtimeIntent = await resolveRuntimeIntentForTarget(targetInput)

  const result = await client.ensureTarget({
    sessionRef,
    runtimeIntent,
  })

  if (json) {
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
