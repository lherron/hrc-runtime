import { printJson } from '../print.js'
import { hasFlag, requireArg } from './argv.js'
import { emitScopeCommandErrorJson, explainScopeCommandError } from './errors.js'
import {
  attachWithRetry,
  bindGhosttySurfaceIfPresent,
  execAttachCommand,
  selectLatestUsableRuntime,
} from './runtime-select.js'
import { resolveManagedScopeContext } from './scope.js'
import { createClient, fatal } from './shared.js'

function printAttachUsage(): void {
  process.stdout.write(`Usage: hrc attach <scope> [--dry-run]

  Resolve a managed session by scope and attach to its latest active runtime.

  Compatibility:
  attach <runtimeId>  Print the attach descriptor JSON for an explicit runtime ID.
`)
}

async function printLocalAttachPreview(scope: string, sessionRef: string): Promise<void> {
  const w = (s: string) => process.stdout.write(`${s}\n`)

  w(`hrc attach ${scope} --dry-run  (local plan preview — no server state consulted)\n`)
  w(`  sessionRef:    ${sessionRef}`)
  w('  runtimeLookup: latest non-unavailable runtime for the resolved host session')
  w('  recovery:      detached OpenAI sessions materialize a fresh tmux runtime on attach')
  w('  action:        POST /v1/runtimes/attach for that runtime, then exec returned argv')
  w('')
  w('  Note: this preview does not resolve the session or inspect runtime state.')
  w('  Run without --dry-run to execute.')
}

export async function cmdAttach(args: string[]): Promise<void> {
  if (args.length === 0) {
    printAttachUsage()
    return
  }

  const target = requireArg(args, 0, '<scope>')
  const dryRun = hasFlag(args, '--dry-run')
  const jsonOutput = hasFlag(args, '--json')

  if (target.startsWith('rt-')) {
    if (dryRun) {
      fatal('attach --dry-run expects a scope, not a runtimeId')
    }
    const client = createClient()
    const descriptor = await client.getAttachDescriptor(target)
    printJson(descriptor)
    return
  }

  let sessionRef: string | undefined
  try {
    const scope = await resolveManagedScopeContext(target)
    sessionRef = scope.sessionRef

    if (dryRun) {
      await printLocalAttachPreview(target, sessionRef)
      return
    }

    const client = createClient()
    const resolved = await client.resolveSession({ sessionRef })
    if (!resolved.found) {
      throw new Error(`no session exists for "${target}". Start one with: hrc start ${target}`)
    }

    const runtimes = await client.listRuntimes({
      hostSessionId: resolved.hostSessionId,
    })
    const runtime = selectLatestUsableRuntime(runtimes)
    if (!runtime) {
      throw new Error(
        `session exists for "${target}" but has no live runtime. Resume its continuation with: hrc resume ${target}; or start fresh with: hrc start ${target} --force-restart`
      )
    }

    const descriptor = await attachWithRetry(client, resolved.hostSessionId, runtime)
    await bindGhosttySurfaceIfPresent(client, descriptor)
    execAttachCommand(descriptor.argv, descriptor.env)
  } catch (err) {
    if (jsonOutput) {
      emitScopeCommandErrorJson('attach', err, target, sessionRef)
    }
    throw explainScopeCommandError('attach', err, target, sessionRef)
  }
}
