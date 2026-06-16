import type { Command } from 'commander'

/**
 * Render the top-level command roster from the live Commander registry — the single source of
 * truth. Generated (not hand-maintained) so the `info` COMMANDS block can never drift out of sync
 * with the registered commands. The CLI-surface conformance gate (scripts/check-cli-surface.ts)
 * relies on the roster being registry-derived rather than a hand-kept list.
 */
export function renderCommandRoster(program: Command): string {
  const commands = program
    .createHelp()
    .visibleCommands(program)
    .filter((command) => command.name() !== 'help')
  const width = Math.max(...commands.map((command) => command.name().length))
  return commands
    .map((command) => `  ${command.name().padEnd(width + 2)}${command.description()}`)
    .join('\n')
}
