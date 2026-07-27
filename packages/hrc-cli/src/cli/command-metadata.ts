import type { Command } from 'commander'

export type CommandAudience = 'agent' | 'human' | 'both'

export type AgentUsageMetadata = {
  example: string
  exitCodes: string
  output: string
}

export type HrcCommandMetadata = {
  audience: CommandAudience
  humanSummary: string
  agentUsage?: AgentUsageMetadata | undefined
  humanExample?: string | undefined
}

type CommandWithMetadata = Command & {
  _hrcMetadata?: HrcCommandMetadata | undefined
}

export type CommandMetadataInput = {
  audience: CommandAudience
  agentUsage?: AgentUsageMetadata | undefined
  humanExample?: string | undefined
}

/**
 * Attach audience/usage truth directly to the Commander node that executes it.
 * Renderers walk these same nodes; there is no parallel command roster.
 */
export function annotateCommand<T extends Command>(command: T, input: CommandMetadataInput): T {
  const node = command as CommandWithMetadata
  node._hrcMetadata = {
    audience: input.audience,
    humanSummary: command.description(),
    ...(input.agentUsage ? { agentUsage: input.agentUsage } : {}),
    ...(input.humanExample ? { humanExample: input.humanExample } : {}),
  }
  return command
}

export function commandMetadata(command: Command): HrcCommandMetadata {
  const metadata = (command as CommandWithMetadata)._hrcMetadata
  if (!metadata) {
    throw new Error(`missing HRC command metadata for ${commandPath(command)}`)
  }
  return metadata
}

export function commandPath(command: Command): string {
  const names: string[] = []
  for (let current: Command | null = command; current?.parent; current = current.parent) {
    names.unshift(current.name())
  }
  return names.join(' ')
}

/**
 * Every node receives concrete metadata. Unannotated descendants inherit their
 * parent's audience and use their registered description as the human one-liner.
 */
export function finalizeCommandMetadata(root: Command): void {
  annotateMissing(root, 'both')
}

function annotateMissing(command: Command, inheritedAudience: CommandAudience): void {
  const node = command as CommandWithMetadata
  if (node._hrcMetadata) {
    node._hrcMetadata.humanSummary = command.description()
  } else {
    node._hrcMetadata = {
      audience: inheritedAudience,
      humanSummary: command.description(),
    }
  }
  const audience = node._hrcMetadata.audience
  for (const child of command.commands) annotateMissing(child, audience)
}

export function allCommandNodes(root: Command): Command[] {
  const nodes: Command[] = []
  const visit = (command: Command): void => {
    nodes.push(command)
    command.commands.forEach(visit)
  }
  visit(root)
  return nodes
}

export function audienceIncludes(
  metadata: HrcCommandMetadata,
  audience: 'agent' | 'human'
): boolean {
  return metadata.audience === 'both' || metadata.audience === audience
}
