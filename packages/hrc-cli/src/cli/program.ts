import { CliUsageError, exitWithError } from 'cli-kit'
import { type Command, CommanderError } from 'commander'

import { HrcDomainError, HrcErrorCode } from 'hrc-core'

import { MonitorWaitExit } from '../monitor-wait.js'
import { buildProgram } from './build-program.js'
import { normalizeCommanderError, validateCommandPathBeforeHelp } from './command-errors.js'
import { renderRootHelp, resolveHelpView } from './help.js'
import { CliStatusExit } from './shared.js'

const USAGE_DOMAIN_CODES = new Set<string>([
  HrcErrorCode.MALFORMED_REQUEST,
  HrcErrorCode.INVALID_SELECTOR,
  HrcErrorCode.INVALID_FENCE,
])

function domainErrorAdvice(err: HrcDomainError): string | undefined {
  if (err.detail['code'] === 'broker_runtime_not_active') {
    return 'Retry the same command once; the broker runtime may still be reattaching.'
  }
  const recommendation = err.detail['recommendation']
  return typeof recommendation === 'string' && recommendation.length > 0
    ? recommendation
    : undefined
}

export function formatHrcDomainError(err: HrcDomainError): string {
  const lines = [`[${err.code}] ${err.message}`]
  if (Object.keys(err.detail).length > 0) {
    lines.push(`detail: ${JSON.stringify(err.detail)}`)
  }
  const advice = domainErrorAdvice(err)
  if (advice) lines.push(`next: ${advice}`)
  return lines.join('\n')
}

export function handleCliError(err: unknown, program: Command): never {
  const rootOptions = program.opts<{ json?: boolean | undefined; output?: string | undefined }>()
  const json = rootOptions.json === true || rootOptions.output === 'json'

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
    const usage = USAGE_DOMAIN_CODES.has(err.code)
    const advice = domainErrorAdvice(err)
    if (json) {
      process.stderr.write(
        `${JSON.stringify({
          error: {
            code: err.code,
            message: err.message,
            detail: err.detail,
            ...(advice ? { advice } : {}),
            usage,
          },
        })}\n`
      )
      process.exit(usage ? 2 : 1)
    }
    const rendered = formatHrcDomainError(err)
    exitWithError(usage ? new CliUsageError(rendered) : new Error(rendered), {
      json: false,
      binName: 'hrc',
    })
  }

  exitWithError(err, { json, binName: 'hrc' })
}

export async function runProgram(
  argv: string[],
  configureProgram?: ((program: Command) => void) | undefined
): Promise<void> {
  const program = buildProgram()
  configureProgram?.(program)
  if (argv.length <= 2) {
    process.stderr.write(renderRootHelp(program, resolveHelpView()))
    process.exit(2)
  }

  try {
    validateCommandPathBeforeHelp(program, argv.slice(2))
    await program.parseAsync(argv)
  } catch (err) {
    handleCliError(err, program)
  }
}

export async function main(args: string[] = process.argv.slice(2)): Promise<void> {
  await runProgram(['node', 'hrc', ...args])
}
