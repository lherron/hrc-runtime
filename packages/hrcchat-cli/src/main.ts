#!/usr/bin/env bun
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

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
import { TurnExitError, cmdTurn } from './commands/turn.js'
import { cmdWho } from './commands/who.js'
import { formatHrcDomainError } from './domain-error-format.js'

// -- .env.local loading -------------------------------------------------------

function applyDotEnvFile(envPath: string): void {
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

/**
 * Walk up from cwd applying each .env.local found, stopping at — and
 * including — the nearest git root. Nearer files win (visited first; a key is
 * only set while still unset) and real environment variables win over all
 * files. This lets the CLI invoked from a subdir (e.g. var/agents/cody)
 * inherit ASP_PROJECT from a parent .env.local at the git root
 * (var/agents/.env.local). The `.git` probe uses existsSync so worktree agent
 * dirs (where .git is a file, not a directory) are recognized too.
 */
function loadDotEnvLocal(): void {
  let dir = process.cwd()
  while (true) {
    applyDotEnvFile(join(dir, '.env.local'))
    if (existsSync(join(dir, '.git'))) break // nearest git root — boundary
    const parent = dirname(dir)
    if (parent === dir) break // filesystem root — no git root found
    dir = parent
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

const commanderErrorCommands = new WeakMap<CommanderError, Command>()
const PHANTOM_COMMAND_SUGGESTIONS = new Map([
  ['msg', 'messages'],
  ['message', 'messages'],
  ['seq', 'show'],
])

function throwCommanderError(this: Command, err: CommanderError): never {
  commanderErrorCommands.set(err, this)
  throw err
}

function collectVisibleCommandNames(command: Command | undefined): string[] {
  if (!command) return []

  const names: string[] = []
  for (const candidate of command.createHelp().visibleCommands(command)) {
    names.push(candidate.name())
    const alias = candidate.alias()
    if (alias) names.push(alias)
  }
  return Array.from(new Set(names))
}

function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0

  const previous = Array.from({ length: b.length + 1 }, (_, index) => index)
  const current = Array.from({ length: b.length + 1 }, () => 0)

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1
      const deletion = (previous[j] ?? 0) + 1
      const insertion = (current[j - 1] ?? 0) + 1
      const substitution = (previous[j - 1] ?? 0) + cost
      current[j] = Math.min(deletion, insertion, substitution)
    }
    previous.splice(0, previous.length, ...current)
  }

  return previous[b.length] ?? Math.max(a.length, b.length)
}

function suggestSimilarCommand(unknownName: string, candidates: string[]): string | undefined {
  const uniqueCandidates = Array.from(new Set(candidates)).filter(
    (candidate) => candidate.length > 1
  )
  let bestDistance = 4
  let best: string[] = []

  for (const candidate of uniqueCandidates) {
    if (Math.abs(unknownName.length - candidate.length) > 3) continue

    const distance = levenshteinDistance(unknownName, candidate)
    const length = Math.max(unknownName.length, candidate.length)
    const similarity = (length - distance) / length
    if (similarity <= 0.4 || distance > 3) continue

    if (distance < bestDistance) {
      bestDistance = distance
      best = [candidate]
    } else if (distance === bestDistance) {
      best.push(candidate)
    }
  }

  best.sort((a, b) => a.localeCompare(b))
  return best[0]
}

function normalizeCommanderError(err: CommanderError): Error {
  const unknownCommandMatch = err.message.match(/^error: unknown command '([^']+)'/)
  if (unknownCommandMatch?.[1]) {
    const unknownName = unknownCommandMatch[1]
    const suggestion =
      PHANTOM_COMMAND_SUGGESTIONS.get(unknownName) ??
      suggestSimilarCommand(
        unknownName,
        collectVisibleCommandNames(commanderErrorCommands.get(err))
      )
    const hint = suggestion ? ` — did you mean '${suggestion}'?` : ''
    return new CliUsageError(`unknown command '${unknownName}'${hint}`)
  }
  return new CliUsageError(err.message)
}

// -- Commander setup ----------------------------------------------------------

const program = new Command()
  .name('hrcchat')
  .description('semantic directed messaging for HRC agents')
  .exitOverride(throwCommanderError)
  .showSuggestionAfterError(false)
  .configureOutput({
    outputError: () => {
      // The CLI error handler prints the single canonical prefixed line.
    },
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
    cmdInfo(program)
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
  .description('materialize/pre-warm a target; turn auto-summons when needed')
  .argument('<target>', 'target handle')
  .action(async (target) => {
    const client = createClient()
    await cmdSummon(client, { json: globalOpts().json }, [target])
  })

// -- dm -----------------------------------------------------------------------

const dmCmd = program
  .command('dm')
  .description('send a durable DM/status note; pass --follow <duration> to stream tracked progress')
  .argument('<target>', 'target handle, "human", or "system"')
  .argument('[message]', 'message body (use - for stdin)')
  .option('--respond-to <kind>', 'human|agent|system')
  .option('--reply-to <id>', 'reply to a specific message ID')
  .option(
    '--cross-scope-reply',
    'allow --reply-to to thread across conversation scopes (blocked by default)'
  )
  .option('--mode <mode>', 'auto|headless|nonInteractive')
  .option('--file <path>', 'read body from file')
  .option(
    '--follow <duration>',
    'dispatch as a tracked turn and stream turn_stacked ndjson progress at this interval'
  )
  .action(async (target, message, opts) => {
    const client = createClient()
    const g = globalOpts()
    if (opts.follow !== undefined) {
      await cmdTurn(
        client,
        {
          follow: opts.follow,
          ...(opts.replyTo ? { replyTo: opts.replyTo } : {}),
          ...(opts.crossScopeReply ? { crossScopeReply: true } : {}),
        },
        [target, ...(message !== undefined ? [message] : [])]
      )
      return
    }
    await cmdDm(client, { ...opts, json: g.json, project: g.project }, [
      target,
      ...(message !== undefined ? [message] : []),
    ])
  })

dmCmd.addHelpText(
  'before',
  "Send a durable DM/status note. Add --follow <duration> to dispatch as a tracked turn and stream\nturn_stacked ndjson progress on that interval (suitable for Claude Code's Monitor tool).\n"
)

// -- send ---------------------------------------------------------------------

const sendCmd = program
  .command('send')
  .description(
    'inject literal input into a live tmux runtime; bypasses semantic dispatch; not for tracked work'
  )
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

sendCmd.addHelpText(
  'before',
  'Inject literal text into a live tmux runtime (raw keystrokes; bypasses semantic dispatch). NOT a turn \u2014 use hrcchat turn for work.\n'
)

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
  .description('tail live tmux pane of a bound runtime')
  .argument('<target>', 'target handle')
  .option('--lines <n>', 'number of lines to capture', '80')
  .action(async (target, opts) => {
    const client = createClient()
    await cmdPeek(client, { ...opts, json: globalOpts().json }, [target])
  })

// -- turn ---------------------------------------------------------------------

const turnCmd = program
  .command('turn')
  .description('dispatch tracked work to an agent and stream progress')
  .argument('<target>', 'target handle or scopeRef')
  .argument('[prompt]', 'prompt text (use - for stdin)')
  .option('--fresh-context, --new', 'clear context before dispatching (clean slate)')
  .option('--dry-run', 'resolve and print the dispatch plan without dispatching')
  .option('--format <format>', 'output format: tree, compact, ndjson, json')
  .option('--pretty', 'force the human-facing terminal render even on non-TTY')
  .option('--stall-after <duration>', 'abort if idle for this long', '1h')
  .option(
    '--stacked <duration>',
    'emit bounded turn_stacked ndjson progress (interval lines plus phase/stall/final/error/permission force-flushes; implies ndjson)'
  )
  .option('--follow <duration>', 'alias for --stacked')
  .option('--reply-to <id>', 'reply to a specific message ID')
  .option(
    '--cross-scope-reply',
    'allow --reply-to to thread across conversation scopes (blocked by default)'
  )
  .option('--file <path>', 'read prompt from file')
  .action(async (target, prompt, opts) => {
    const client = createClient()
    await cmdTurn(client, { ...opts }, [target, ...(prompt !== undefined ? [prompt] : [])])
  })

turnCmd.addHelpText(
  'before',
  'Dispatch work to an agent. For tracked dispatch with bounded mid-flight progress, use\n--follow <duration> (alias --stacked); the stream is one turn_stacked ndjson line per interval\nplus force-flush lines on phase/stall/final/error/permission. Terminal frames (phase:final|error)\nalso carry "taskState": the live wrkq state of the scoped task (e.g. "completed"|"in_progress"),\nor null for a non-task-scoped handle (:primary) or when wrkq is unavailable. Mutex against\n--format tree|compact and --pretty.\n'
)

// -- doctor -------------------------------------------------------------------

program
  .command('doctor')
  .description('run connectivity and target health checks')
  .argument('[target]', 'target handle')
  .action(async (target) => {
    const client = createClient()
    await cmdDoctor(client, { json: globalOpts().json }, target ? [target] : [])
  })

// -- Grouped help index -------------------------------------------------------

program.addHelpText(
  'after',
  `
WORK
  turn        dispatch tracked work to an agent and stream progress

MESSAGES
  dm          send a durable DM/status note; pass --follow <duration> for tracked progress
  show        show one message by seq or message ID
  messages    query durable directed message history

LIVE
  send        inject literal input into a live tmux runtime; bypasses semantic dispatch; not for tracked work
  summon      materialize/pre-warm a target; turn auto-summons when needed
  peek        tail live tmux pane of a bound runtime

UTILITY
  who         list visible targets
  doctor      run connectivity and target health checks
  info        show CLI/runtime info
`
)

// -- Run (guarded — only when executed directly, not when imported) -----------

// Exported for the CLI-surface conformance gate (scripts/check-cli-surface.ts), which introspects
// the live command registry. Import is side-effect-free: parseAsync is guarded by import.meta.main.
export { program }

if (import.meta.main) {
  try {
    await program.parseAsync(process.argv)
  } catch (err) {
    const json = globalOpts().json ?? false

    // Turn command intentional exit codes (1, 3, 4, 5, 130)
    if (err instanceof TurnExitError) {
      if (!json) {
        process.stderr.write(`hrcchat: ${err.message}\n`)
      }
      process.exit(err.exitCode)
    }

    // Commander usage errors (unknown option, missing arg) → exit 2
    if (err instanceof CommanderError) {
      if (
        err.code === 'commander.helpDisplayed' ||
        err.code === 'commander.help' ||
        err.code === 'commander.version'
      ) {
        process.exit(0)
      }
      exitWithError(normalizeCommanderError(err), { json, binName: 'hrcchat' })
    }
    // Domain errors from CLI usage mistakes → exit 2
    if (err instanceof CliUsageError) {
      exitWithError(err, { json, binName: 'hrcchat' })
    }
    // HRC server/network errors → exit 1
    if (err instanceof HrcDomainError) {
      exitWithError(new Error(formatHrcDomainError(err)), { json, binName: 'hrcchat' })
    }
    // Unknown errors → exit 1
    exitWithError(err, { json, binName: 'hrcchat' })
  }
}
