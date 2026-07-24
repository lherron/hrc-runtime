type CommandRosterEntry = {
  name(): string
  description(): string
}

type CommandRosterProgram = {
  createHelp(): {
    visibleCommands(program: CommandRosterProgram): CommandRosterEntry[]
  }
}

/**
 * Render the top-level command roster from the live Commander registry — the single source of
 * truth. Generated (not hand-maintained) so the `info` COMMANDS block can never drift out of sync
 * with the registered commands. The CLI-surface conformance gate (scripts/check-cli-surface.ts)
 * relies on the roster being registry-derived rather than a hand-kept list.
 */
export function renderCommandRoster(program: CommandRosterProgram): string {
  const commands = program
    .createHelp()
    .visibleCommands(program)
    .filter((command) => command.name() !== 'help')
  const width = Math.max(...commands.map((command) => command.name().length))
  return commands
    .map((command) => `  ${command.name().padEnd(width + 2)}${command.description()}`)
    .join('\n')
}

export function writePlacementWarnings(prefix: string, warnings: string[] | undefined): void {
  if (!warnings || warnings.length === 0) return
  for (const warning of warnings) {
    process.stderr.write(`[${prefix}] warning: ${warning}\n`)
  }
}

export function formatAgentNotFound(
  agentId: string,
  searchedAgentRoots: string[] | undefined
): string {
  if (searchedAgentRoots && searchedAgentRoots.length > 0) {
    return `agent "${agentId}" not found; searched: ${searchedAgentRoots.join(', ')}`
  }
  return `agent "${agentId}" not found; no agent roots configured.\n  Set ASP_AGENTS_ROOT or configure agents-root in asp-targets.toml.`
}
