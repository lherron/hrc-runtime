import { printJson } from '../print.js'
import { resolveRuntimeArg } from '../selector-resolve.js'
import { hasFlag, requireArg } from './argv.js'
import { formatCaptureState } from './handlers-runtime.js'
import { createClient } from './shared.js'

export async function cmdCaptureStatus(args: string[]): Promise<void> {
  const target = requireArg(args, 0, '<target>')
  const client = createClient()
  const runtimeId = await resolveRuntimeArg(target, client)
  const result = await client.brokerCaptureStatus(runtimeId)
  if (hasFlag(args, '--json')) {
    printJson(result)
    return
  }
  process.stdout.write(`capture: ${formatCaptureState(result.capture)}\n`)
}
