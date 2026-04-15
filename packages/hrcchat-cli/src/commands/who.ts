import type { HrcClient } from 'hrc-sdk'
import { hasFlag, printJson } from '../cli-args.js'
import { resolveProjectId } from '../normalize.js'

export async function cmdWho(client: HrcClient, args: string[]): Promise<void> {
  const json = hasFlag(args, '--json')
  const discover = hasFlag(args, '--discover')
  const allProjects = hasFlag(args, '--all-projects')
  const projectId = allProjects ? undefined : resolveProjectId(args)

  const targets = await client.listTargets({
    projectId,
    discover,
  })

  if (json) {
    printJson(targets)
    return
  }

  if (targets.length === 0) {
    process.stdout.write('No targets found.\n')
    return
  }

  const stateIcon: Record<string, string> = {
    discoverable: '?',
    summoned: '-',
    bound: '*',
    busy: '!',
    broken: 'x',
  }

  for (const t of targets) {
    const icon = stateIcon[t.state] ?? ' '
    const dm = t.capabilities.dmReady ? 'dm' : '  '
    const send = t.capabilities.sendReady ? 'send' : '    '
    const peek = t.capabilities.peekReady ? 'peek' : '    '
    const caps = `[${dm} ${send} ${peek}]`

    // Extract friendly display name
    const match = t.scopeRef.match(/^agent:([^:]+)(?::project:([^:]+))?/)
    const display = match ? (match[2] ? `${match[1]}@${match[2]}` : match[1]) : t.sessionRef

    const lane = t.laneRef !== 'main' ? `~${t.laneRef}` : ''
    const gen = t.generation !== undefined ? ` gen:${t.generation}` : ''
    const runtime = t.runtime ? ` ${t.runtime.transport}:${t.runtime.status}` : ''

    process.stdout.write(
      `  ${icon} ${display}${lane}  ${t.state.padEnd(12)} ${caps}${gen}${runtime}\n`
    )
  }
}
