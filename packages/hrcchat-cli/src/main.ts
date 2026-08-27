#!/usr/bin/env bun
import { CliUsageError, attachJsonOption, exitWithError } from 'cli-kit'
import { Command, CommanderError, Option } from 'commander'
import { HrcDomainError, installCliMetricsRecorder } from 'hrc-core'
import { HrcClient, discoverSocket, loadDotEnvLocal } from 'hrc-sdk'

import { cmdInfo } from './commands/info.js'
import { TurnExitError, cmdTurn } from './commands/turn.js'
import { formatHrcDomainError } from './domain-error-format.js'
import { registerMovedCommandShim } from './moved-command.js'
import { forwardDmToWrkc } from './wrkc-spawn.js'

// Shared context-only .env.local loader (hrc-sdk): walks up to the nearest
// git root, real env wins, credential-class keys are refused with a warning.
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

/**
 * Verbs retired at the T-07612 flag day, with where each one went. Talk moved to
 * `wrkc` because wrkq owns collaboration; live-runtime verbs moved to `hrc`
 * because HRC owns execution. `trace` and `who` are simply gone: `trace` traced
 * a message across the federation message path this flag day deletes, and `who`
 * listed federation targets that `hrc target locate` and `wrkc members` cover
 * between them.
 */
const MOVED_VERBS: ReadonlyArray<readonly [string, string]> = [
  ['show', 'wrkc show <EN-xxxxx|room>'],
  ['thread', 'wrkc log <room>'],
  ['messages', 'wrkc ls / wrkc log <room>'],
  ['summon', 'hrc summon'],
  ['send', 'hrc send'],
  ['peek', 'hrc peek'],
  ['doctor', 'hrc doctor'],
  ['trace', 'wrkc show EN-xxxxx (the federation message path it traced is deleted)'],
  ['who', 'hrc target locate / wrkc members <room>'],
]

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
  // Moved verbs are hidden from help but stay in the suggestion pool: an agent
  // who typed `shwo` needs to be told the verb moved, not that it never existed.
  if (command === program) {
    for (const [name] of MOVED_VERBS) names.push(name)
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
  .description('show the hrcchat -> wrkc / hrc migration map')
  .action(() => {
    cmdInfo(program)
  })

// -- dm: the one forwarding shim ---------------------------------------------
//
// T-07612 §9.2. Every other verb is a hard fence, but `dm` is scripted in dozens
// of places across the collective, so it forwards to `wrkc say` for the burn-in
// window and tells the caller, on stderr, exactly what it forwarded.

const dmCmd = program
  .command('dm')
  .description('DEPRECATED: forwards to `wrkc say`; call wrkc directly')
  .argument('<target>', 'target handle or "human"')
  .argument('[message]', 'message body (use - for stdin)')
  .option('--as <principal>', 'sender principal ("human" or an agent name)')
  .option('--respond-to <kind>', 'human|agent|system (human maps to agent:lance)')
  .option('--reply-to <id>', 'accepted and dropped: in a room the reply is the ack')
  .option('--cross-scope-reply', 'accepted and dropped')
  .option('--steer', 'maps to `wrkc say --urgent`')
  .addOption(new Option('--urgent', 'alias for --steer').hideHelp())
  .option('--queue', 'accepted and dropped: queued delivery is the wrkc default')
  .option('--mode <mode>', 'accepted and dropped: use +node=/+model= on the target')
  .option('--file <path>', 'read body from file')
  .option('--follow <duration>', 'refused: use `hrc monitor watch EN-xxxxx`')
  .option('--wait <mode>', 'maps to `wrkc say --wait`')
  .option('--timeout <duration>', 'wait budget')
  .option('--quiet', 'accepted and dropped')
  .action(async (target, message, opts) => {
    await forwardDmToWrkc(target, message, { ...opts, json: globalOpts().json })
  })

dmCmd.addHelpText(
  'before',
  `hrcchat dm forwards to \`wrkc say\` and is removed after the burn-in window.

  hrcchat dm <target> <body>            ->  wrkc say <target> --to <target> <body>
  hrcchat dm human <body>               ->  wrkc say lance --to lance <body>
  hrcchat dm <t> --wait response        ->  wrkc say <t> --to <t> --wait
  hrcchat dm <t> --steer                ->  wrkc say <t> --to <t> --urgent
  hrcchat dm <t> --follow <d>           ->  hrc monitor watch EN-xxxxx (refused here)

`
)

// -- turn: retained as the implementation behind `hrc turn` -------------------
//
// Dispatching tracked work and streaming its progress is EXECUTION, which HRC
// owns under the §2 boundary rule, and `wrkc say --wait` is not a substitute
// for it: it returns a reply body, not a live turn. `hrc turn` is the public
// spelling and forwards here; this registration is hidden and warns, and wave 5
// (T-07617) must absorb the implementation into hrc-cli before the hrcchat
// package is deleted.

const turnCmd = program
  .command('turn', { hidden: true })
  .description('internal: implementation behind `hrc turn`')
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
    if (process.env['HRC_TURN_FORWARDED'] !== '1') {
      process.stderr.write(
        'hrcchat turn is internal; use `hrc turn` (T-07612 flag day). Talk is `wrkc say`.\n'
      )
    }
    const client = createClient()
    await cmdTurn(client, { ...opts }, [target, ...(prompt !== undefined ? [prompt] : [])])
  })

void turnCmd

// -- moved verbs --------------------------------------------------------------
//
// Talk moved to wrkc because wrkq owns collaboration; live-runtime verbs moved
// to hrc because HRC owns execution. `trace` and `who` are simply gone: `trace`
// traced a message across the federation message path, which this flag day
// deletes, and `who` listed federation targets that `hrc target locate` and
// `wrkc members` cover between them.

for (const [name, replacement] of MOVED_VERBS) {
  registerMovedCommandShim(program, name, replacement)
}

// -- Grouped help index -------------------------------------------------------

program.addHelpText(
  'after',
  `
hrcchat is retired (T-07612). wrkq owns collaboration; HRC owns execution.

TALK -> wrkc                            LIVE RUNTIMES -> hrc
  dm        wrkc say <ref> --to <a>       summon    hrc summon
  show      wrkc show <EN|room>           send      hrc send
  thread    wrkc log <room>               peek      hrc peek
  messages  wrkc ls / wrkc log <room>     doctor    hrc doctor
                                          turn      hrc turn
GONE
  trace     the federation message path it traced is deleted
  who       hrc target locate / wrkc members <room>

Only \`--to\` fires: a wrkc say without it is a room log entry, not a delivery.
Run \`wrkc info\` for the room/envelope model.
`
)

// -- Run (guarded — only when executed directly, not when imported) -----------

// Exported for the CLI-surface conformance gate (scripts/check-cli-surface.ts), which introspects
// the live command registry. Import is side-effect-free: parseAsync is guarded by import.meta.main.
export { program }

// WHY exported: bin/hrcchat.js invokes this. `import.meta.main` is false when
// this module is imported from the bin wrapper, so the guard below cannot be the
// only entry. Extracting the body keeps import side-effect-free for the
// CLI-surface conformance gate, which is what the guard originally protected.
export async function runCli(): Promise<void> {
  const metrics = installCliMetricsRecorder({ bin: 'hrcchat', argv: process.argv })
  metrics.setCommandTree(program)
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

if (import.meta.main) {
  await runCli()
}
