/**
 * Hard migration fences for the hrcchat verbs that moved at the T-07612 flag
 * day. Mirrors hrc-cli's `moved-command.ts` (the `hrc metrics` precedent):
 * exit 2 with the replacement, and no help, so `old --help` cannot read as a
 * still-supported alias.
 */
import { CliUsageError } from 'cli-kit'
import type { Command } from 'commander'

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
    throw new CliUsageError(`'hrcchat ${name}' moved; use '${replacement}'`)
  })
  return shim
}
