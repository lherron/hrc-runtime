#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { CliUsageError, attachJsonOption, exitWithError } from 'cli-kit'
import { Command, CommanderError } from 'commander'
import { HrcDomainError } from 'hrc-core'
import { HrcClient, discoverSocket } from 'hrc-sdk'

import { cmdDm } from './commands/dm.js'
import { cmdDoctor } from './commands/doctor.js'
import { cmdInfo } from './commands/info.js'
import { cmdMessages } from './commands/messages.js'
import { cmdPeek } from './commands/peek.js'
import { cmdSend } from './commands/send.js'
import { cmdShow } from './commands/show.js'
import { cmdSummon } from './commands/summon.js'
import { cmdWho } from './commands/who.js'

// -- .env.local loading -------------------------------------------------------

function loadDotEnvLocal(): void {
  const envPath = join(process.cwd(), '.env.local')
  let content: string
  try {
    content = readFileSync(envPath, 'utf8')
  } catch {
    return
  }
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx === -1) continue
    const key = trimmed.slice(0, eqIdx).trim()
    const value = trimmed.slice(eqIdx + 1).trim()
    if (key && process.env[key] === undefined) {
      process.env[key] = value
    }
  }
}

loadDotEnvLocal()

// -- Client factory -----------------------------------------------------------

function createClient(): HrcClient {
  const socketPath = discoverSocket()
  return new HrcClient(socketPath)
}

// -- Types --------------------------------------------------------------------

type GlobalOptions = {
  json?: boolean
  project?: string
}

// -- Commander setup ----------------------------------------------------------

const program = new Command()
  .name('hrcchat')
  .description('semantic directed messaging for HRC agents')
  .exitOverride((err) => {
    throw err
  })

attachJsonOption(program)
program.option('--project <id>', 'override project context')

function globalOpts(): GlobalOptions {
  return program.opts<GlobalOptions>()
}

// -- info ---------------------------------------------------------------------

program
  .command('info')
  .description('show CLI/runtime info')
  .action(() => {
    cmdInfo()
  })

// -- who ----------------------------------------------------------------------

program
  .command('who')
  .description('list visible targets')
  .option('--discover', 'include discoverable targets')
  .option('--all-projects', 'list targets across all projects')
  .action(async (opts) => {
    const client = createClient()
    const g = globalOpts()
    await cmdWho(client, { ...opts, json: g.json, project: g.project })
  })

// -- summon -------------------------------------------------------------------

program
  .command('summon')
  .description('materialize a target without starting a live runtime')
  .argument('<target>', 'target handle')
  .action(async (target) => {
    const client = createClient()
    await cmdSummon(client, { json: globalOpts().json }, [target])
  })

// -- dm -----------------------------------------------------------------------

program
  .command('dm')
  .description('send a semantic directed request')
  .argument('<target>', 'target handle, "human", or "system"')
  .argument('[message]', 'message body (use - for stdin)')
  .option('--respond-to <kind>', 'human|agent|system')
  .option('--reply-to <id>', 'reply to a specific message ID')
  .option('--mode <mode>', 'auto|headless|nonInteractive')
  .option('--file <path>', 'read body from file')
  .action(async (target, message, opts) => {
    const client = createClient()
    const g = globalOpts()
    await cmdDm(client, { ...opts, json: g.json, project: g.project }, [
      target,
      ...(message !== undefined ? [message] : []),
    ])
  })

// -- send ---------------------------------------------------------------------

program
  .command('send')
  .description('deliver literal input to a live runtime')
  .argument('<target>', 'target handle')
  .argument('[message]', 'text to send (use - for stdin)')
  .option('--enter', 'send enter key after text (default)')
  .option('--no-enter', 'do not send enter key')
  .option('--file <path>', 'read body from file')
  .action(async (target, message, opts) => {
    const client = createClient()
    await cmdSend(client, { ...opts, json: globalOpts().json }, [
      target,
      ...(message !== undefined ? [message] : []),
    ])
  })

// -- show ---------------------------------------------------------------------

program
  .command('show')
  .description('show one message by seq or message ID')
  .argument('<seq-or-id>', 'message seq number or message ID')
  .action(async (seqOrId) => {
    const client = createClient()
    await cmdShow(client, { json: globalOpts().json }, [seqOrId])
  })

// -- messages -----------------------------------------------------------------

program
  .command('messages')
  .description('query durable directed message history')
  .argument('[target]', 'filter by target participant')
  .option('--to <address>', 'filter by recipient')
  .option('--responses-to <address>', 'alias for --to')
  .option('--from <address>', 'filter by sender')
  .option('--thread <id>', 'filter by thread root message ID')
  .option('--after <seq>', 'messages after this seq number')
  .option('--limit <n>', 'max messages to return', '50')
  .action(async (target, opts) => {
    const client = createClient()
    await cmdMessages(client, { ...opts, json: globalOpts().json }, target ? [target] : [])
  })

// -- peek ---------------------------------------------------------------------

program
  .command('peek')
  .description('capture live output from a bound runtime')
  .argument('<target>', 'target handle')
  .option('--lines <n>', 'number of lines to capture', '80')
  .action(async (target, opts) => {
    const client = createClient()
    await cmdPeek(client, { ...opts, json: globalOpts().json }, [target])
  })

// -- doctor -------------------------------------------------------------------

program
  .command('doctor')
  .description('run connectivity and target health checks')
  .argument('[target]', 'target handle')
  .action(async (target) => {
    const client = createClient()
    await cmdDoctor(client, { json: globalOpts().json }, target ? [target] : [])
  })

// -- Run (guarded — only when executed directly, not when imported) -----------

if (import.meta.main) {
  try {
    await program.parseAsync(process.argv)
  } catch (err) {
    const json = globalOpts().json ?? false

    // Commander usage errors (unknown option, missing arg) → exit 2
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
    // Domain errors from CLI usage mistakes → exit 2
    if (err instanceof CliUsageError) {
      exitWithError(err, { json, binName: 'hrcchat' })
    }
    // HRC server/network errors → exit 1
    if (err instanceof HrcDomainError) {
      exitWithError(new Error(`[${err.code}] ${err.message}`), { json, binName: 'hrcchat' })
    }
    // Unknown errors → exit 1
    exitWithError(err, { json, binName: 'hrcchat' })
  }
}
