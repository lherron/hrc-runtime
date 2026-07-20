import { CliUsageError } from 'cli-kit'
import { Command, Option } from 'commander'

import { throwCommanderError } from './command-errors.js'
import { registerMetricsCommands } from './register-metrics.js'
import { registerRuntimeCommands } from './register-runtime.js'
import { registerServerSessionCommands } from './register-server-session.js'
import { registerTopLevelCommands } from './register-top.js'
import { printInfo } from './usage.js'

// -- Commander dispatch -------------------------------------------------------

export function buildProgram(): Command {
  const program = new Command()
    .name('hrc')
    .description('HRC operator CLI')
    .exitOverride(throwCommanderError)
    .showSuggestionAfterError(false)
    .configureOutput({
      outputError: () => {
        // The CLI error handler prints the single canonical prefixed line.
      },
    })

  program.addOption(
    new Option('--output <format>', 'output format alias for --json').choices(['json'])
  )
  program.hook('preAction', (rootCommand, actionCommand) => {
    if (rootCommand.opts<{ output?: string }>().output !== 'json') return
    if (!actionCommand.options.some((option) => option.long === '--json')) {
      throw new CliUsageError(`--output json is not supported by '${actionCommand.name()}'`)
    }
    actionCommand.setOptionValueWithSource('json', true, 'cli')
  })

  program
    .command('info')
    .description('show HRC orientation and first-contact guidance')
    .option('--json', 'output as JSON')
    .action(async (_opts, command: Command) => {
      await printInfo(program, { json: command.opts()['json'] === true })
    })

  registerServerSessionCommands(program)
  registerRuntimeCommands(program)
  registerTopLevelCommands(program)
  registerMetricsCommands(program)

  return program
}
