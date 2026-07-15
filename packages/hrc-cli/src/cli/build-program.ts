import { Command } from 'commander'

import { throwCommanderError } from './command-errors.js'
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

  program
    .command('info')
    .description('show HRC orientation and first-contact guidance')
    .option('--json', 'output as JSON')
    .action((_opts, command: Command) => {
      printInfo(program, { json: command.opts()['json'] === true })
    })

  registerServerSessionCommands(program)
  registerRuntimeCommands(program)
  registerTopLevelCommands(program)

  return program
}
