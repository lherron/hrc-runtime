#!/usr/bin/env bun
import { CliUsageError, attachJsonOption, exitWithError } from 'cli-kit'
import { Command, CommanderError, Option } from 'commander'
import { HrcDomainError, installCliMetricsRecorder } from 'hrc-core'
import { HrcClient, discoverSocket, loadDotEnvLocal } from 'hrc-sdk'

import { TurnExitError, cmdTurn } from './commands/turn.js'
import { formatHrcDomainError } from './domain-error-format.js'
import { HRCCHAT_REDIRECT } from './redirect.js'

// hrc turn still uses this package's turn engine internally. Direct hrcchat
// callers are fenced before parsing; only hrc's explicit handoff reaches it.
loadDotEnvLocal()

type GlobalOptions = {
  json?: boolean
}

function throwCommanderError(this: Command, err: CommanderError): never {
  throw err
}

export const program = new Command()
  .name('hrcchat')
  .description('retired; use wrkc')
  .exitOverride(throwCommanderError)
  .showSuggestionAfterError(false)
  .configureOutput({
    outputError: () => {
      // The canonical error handler below owns stderr.
    },
  })

attachJsonOption(program)
program.option('--project <id>', 'override project context')

program
  .command('turn', { hidden: true })
  .description('internal implementation behind `hrc turn`')
  .argument('<target>', 'target handle or scopeRef')
  .argument('[prompt]', 'prompt text (use - for stdin)')
  .option('--as <principal>', 'explicit sender principal')
  .option('--fresh-context, --new', 'clear context before dispatching (clean slate)')
  .option('--dry-run', 'resolve and print the dispatch plan without dispatching')
  .option('--format <format>', 'output format: tree, compact, ndjson, json')
  .option('--pretty', 'force the human-facing terminal render even on non-TTY')
  .option('--stall-after <duration>', 'abort if idle for this long', '1h')
  .option('--stacked <duration>', 'emit bounded turn_stacked ndjson progress')
  .option('--follow <duration>', 'alias for --stacked')
  .option('--wait <mode>', 'block quietly until terminal, then emit one JSON object')
  .option('--timeout <duration>', 'wait budget for --wait final (default 45m)')
  .option('--quiet', 'suppress all progress output while --wait blocks')
  .option('--reply-to <id>', 'reply to a specific message ID')
  .option('--cross-scope-reply', 'allow --reply-to to thread across conversation scopes')
  .option('--steer', 'STRICT steer: deliver into the active turn or fail typed')
  .option('--queue', 'DEFERRED delivery: queue behind the active turn')
  .addOption(new Option('--urgent', 'deprecated alias for --steer').hideHelp())
  .option('--file <path>', 'read prompt from file')
  .option(
    '--response-format-json-schema <schema>',
    'request JSON Schema constrained final response (inline JSON object or file path)'
  )
  .action(async (target, prompt, opts) => {
    const client = new HrcClient(discoverSocket())
    await cmdTurn(client, { ...opts }, [target, ...(prompt !== undefined ? [prompt] : [])])
  })

function isInternalHrcTurn(): boolean {
  return process.env['HRC_TURN_FORWARDED'] === '1' && process.argv[2] === 'turn'
}

export async function runCli(): Promise<void> {
  const metrics = installCliMetricsRecorder({ bin: 'hrcchat', argv: process.argv })
  metrics.setCommandTree(program)

  if (!isInternalHrcTurn()) {
    process.stderr.write(HRCCHAT_REDIRECT)
    process.exitCode = 2
    return
  }

  try {
    await program.parseAsync(process.argv)
  } catch (err) {
    const json = program.opts<GlobalOptions>().json ?? false

    if (err instanceof TurnExitError) {
      if (!json) process.stderr.write(`hrcchat: ${err.message}\n`)
      process.exit(err.exitCode)
    }
    if (err instanceof CommanderError) {
      if (
        err.code === 'commander.helpDisplayed' ||
        err.code === 'commander.help' ||
        err.code === 'commander.version'
      ) {
        process.exit(0)
      }
      exitWithError(new CliUsageError(err.message), { json, binName: 'hrcchat' })
    }
    if (err instanceof CliUsageError) {
      exitWithError(err, { json, binName: 'hrcchat' })
    }
    if (err instanceof HrcDomainError) {
      exitWithError(new Error(formatHrcDomainError(err)), { json, binName: 'hrcchat' })
    }
    exitWithError(err, { json, binName: 'hrcchat' })
  }
}

if (import.meta.main) {
  await runCli()
}
