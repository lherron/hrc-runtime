import { CliUsageError } from 'cli-kit'
import type { Command } from 'commander'

function commandPath(command: Command): string {
  const names: string[] = []
  for (let current: Command | null = command; current?.parent; current = current.parent) {
    names.unshift(current.name())
  }
  return names.join(' ')
}

export function throwMovedCommand(path: string, replacement: string): never {
  throw new CliUsageError(`'hrc ${path}' moved; use '${replacement}'`)
}

/**
 * Keep a removed spelling executable only as a hard migration fence.
 *
 * Help is disabled deliberately: even `old-path --help` must fail with the
 * replacement pointer instead of looking like a supported alias.
 */
export function registerMovedCommandShim(
  parent: Command,
  name: string,
  replacement: string
): Command {
  const shim = parent
    .command(name, { hidden: true })
    .description(`moved to ${replacement}`)
    .helpOption(false)
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .argument('[args...]')

  shim.action(() => {
    throwMovedCommand(commandPath(shim), replacement)
  })
  return shim
}
