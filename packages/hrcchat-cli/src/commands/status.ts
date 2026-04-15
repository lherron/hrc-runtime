import type { HrcClient } from 'hrc-sdk'
import { hasFlag, printJson } from '../cli-args.js'
import { formatAddress, resolveCallerAddress, resolveTargetToSessionRef } from '../normalize.js'

export async function cmdStatus(client: HrcClient, args: string[]): Promise<void> {
  const json = hasFlag(args, '--json')
  const targetInput = args[0] && !args[0].startsWith('-') ? args[0] : undefined

  if (targetInput) {
    // Target-specific status
    const sessionRef = resolveTargetToSessionRef(targetInput)
    const target = await client.getTarget(sessionRef)

    if (json) {
      printJson(target)
      return
    }

    process.stdout.write(`Target: ${target.sessionRef}\n`)
    process.stdout.write(`  scopeRef: ${target.scopeRef}\n`)
    process.stdout.write(`  laneRef: ${target.laneRef}\n`)
    process.stdout.write(`  state: ${target.state}\n`)
    if (target.activeHostSessionId) {
      process.stdout.write(`  hostSessionId: ${target.activeHostSessionId}\n`)
    }
    if (target.generation !== undefined) {
      process.stdout.write(`  generation: ${target.generation}\n`)
    }
    process.stdout.write(`  modes: ${target.capabilities.modesSupported.join(', ') || 'none'}\n`)
    process.stdout.write(
      `  dm: ${target.capabilities.dmReady}  send: ${target.capabilities.sendReady}  peek: ${target.capabilities.peekReady}\n`
    )
    if (target.runtime) {
      process.stdout.write(
        `  runtime: ${target.runtime.runtimeId} (${target.runtime.transport}, ${target.runtime.status})\n`
      )
    }
    return
  }

  // General status
  const health = await client.getHealth()
  const status = await client.getStatus()

  if (json) {
    printJson({ health, status })
    return
  }

  const caller = resolveCallerAddress()
  process.stdout.write(`HRC: ${health.ok ? 'connected' : 'unreachable'}\n`)
  process.stdout.write(`API: v${status.apiVersion}\n`)
  process.stdout.write(`Caller: ${formatAddress(caller)}\n`)
  process.stdout.write(`Sessions: ${status.sessionCount}\n`)
  process.stdout.write(`Runtimes: ${status.runtimeCount}\n`)
}
