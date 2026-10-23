import { CliUsageError } from 'cli-kit'
import { Command, Help, Option } from 'commander'

import { throwCommanderError, validateCommandBeforeHelp } from './command-errors.js'
import { allCommandNodes, annotateCommand, finalizeCommandMetadata } from './command-metadata.js'
import { printInfo, renderRootHelp, resolveHelpView } from './help.js'
import { registerFederationCommands } from './register-federation.js'
import { registerMetricsCommands } from './register-metrics.js'
import { registerRuntimeCommands } from './register-runtime.js'
import { registerServerSessionCommands } from './register-server-session.js'
import { registerTopLevelCommands } from './register-top.js'

// -- Commander dispatch -------------------------------------------------------

export function buildProgram(): Command {
  const program = new Command()
    .name('hrc')
    .enablePositionalOptions()
    .description('HRC operator CLI')
    .exitOverride(throwCommanderError)
    .showSuggestionAfterError(false)
    .configureOutput({
      outputError: () => {
        // The CLI error handler prints the single canonical prefixed line.
      },
    })

  program.hook('preAction', (rootCommand, actionCommand) => {
    if (rootCommand.opts<{ output?: string }>().output !== 'json') return
    if (!actionCommand.options.some((option) => option.long === '--json')) {
      throw new CliUsageError(`--output json is not supported by '${actionCommand.name()}'`)
    }
    actionCommand.setOptionValueWithSource('json', true, 'cli')
  })

  const info = program
    .command('info')
    .description('show HRC orientation and first-contact guidance')
    .option('--agent', 'render the agent command runbook')
    .option('--human', 'render the human operator guide')
    .option('--json', 'output as JSON')
    .action(async (_opts, command: Command) => {
      const local = command.opts<{ agent?: boolean; human?: boolean; json?: boolean }>()
      const root = program.opts<{ agent?: boolean; human?: boolean }>()
      await printInfo(program, {
        agent: local.agent === true || root.agent === true,
        human: local.human === true || root.human === true,
        json: local.json,
      })
    })
  annotateCommand(info, { audience: 'both' })

  registerServerSessionCommands(program)
  registerTopLevelCommands(program)
  registerRuntimeCommands(program)
  registerMetricsCommands(program)
  registerFederationCommands(program)
  finalizeCommandMetadata(program)

  // Commander stops each parent's option scan at its subcommand. Register the
  // globals at every node, giving an existing local spelling (notably the
  // runtime --agent <agent> filter) precedence. Forward only these fallback
  // options to the root so help, output aliases and error rendering share state.
  for (const command of allCommandNodes(program)) {
    for (const option of [
      new Option('--output <format>', 'output format alias for --json').choices(['json']),
      new Option('--agent', 'render the agent-oriented help projection'),
      new Option('--human', 'render the human-oriented help projection'),
    ]) {
      if (command.options.some((local) => local.long === option.long)) continue
      if (command !== program) option.hideHelp()
      command.addOption(option)
      if (command !== program) {
        command.on(`option:${option.name()}`, (value) => {
          program.setOptionValueWithSource(option.attributeName(), value ?? true, 'cli')
          // These are root options, not inputs to the command's legacy handler.
          command.setOptionValueWithSource(option.attributeName(), undefined, 'cli')
        })
      }
    }
  }
  program.on('beforeAllHelp', ({ command }: { command: Command }) => {
    validateCommandBeforeHelp(command)
  })

  program.configureHelp({
    formatHelp(command) {
      if (command === program) {
        return renderRootHelp(program, resolveHelpView(program.opts()))
      }
      const helper = new Help()
      return helper.formatHelp(command, helper)
    },
  })

  return program
}
