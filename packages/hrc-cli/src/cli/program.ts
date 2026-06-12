import { CliUsageError, exitWithError } from 'cli-kit'
import { type Command, CommanderError } from 'commander'

import { HrcDomainError } from 'hrc-core'

import { MonitorWaitExit } from '../monitor-wait.js'
import { buildProgram } from './build-program.js'
import { normalizeCommanderError } from './command-errors.js'
import { CliStatusExit } from './shared.js'
import { printUsage } from './usage.js'

function handleCliError(err: unknown, program: Command): never {
  const json = program.opts<{ json?: boolean | undefined }>().json ?? false

  if (err instanceof CommanderError) {
    if (
      err.code === 'commander.helpDisplayed' ||
      err.code === 'commander.help' ||
      err.code === 'commander.version'
    ) {
      process.exit(0)
    }
    exitWithError(normalizeCommanderError(err), { json, binName: 'hrc' })
  }

  if (err instanceof CliUsageError) {
    exitWithError(err, { json, binName: 'hrc' })
  }

  if (err instanceof CliStatusExit) {
    process.exit(err.code)
  }

  if (err instanceof MonitorWaitExit) {
    process.exit(err.code)
  }

  if (err instanceof HrcDomainError) {
    exitWithError(new Error(`[${err.code}] ${err.message}`), { json, binName: 'hrc' })
  }

  exitWithError(err, { json, binName: 'hrc' })
}

export async function runProgram(argv: string[]): Promise<void> {
  if (argv.length <= 2) {
    printUsage()
    process.exit(1)
  }

  const program = buildProgram()
  try {
    await program.parseAsync(argv)
  } catch (err) {
    handleCliError(err, program)
  }
}

export async function main(args: string[] = process.argv.slice(2)): Promise<void> {
  await runProgram(['node', 'hrc', ...args])
}
