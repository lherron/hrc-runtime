import { CliUsageError, consumeBody } from 'cli-kit'
import { HrcDomainError } from 'hrc-core'
import type { HrcClient } from 'hrc-sdk'

import { printJson } from '../print.js'
import { resolveLiveTargetToSessionRef, resolveSummonTarget } from './resolve.js'

/**
 * The live-runtime verbs, absorbed from `hrcchat` (T-07612 §9.2).
 *
 * `summon` materializes or pre-warms a target. `send` injects literal
 * keystrokes and BYPASSES THE LEDGER — nothing it delivers becomes an envelope,
 * an obligation, or a record anyone can read afterwards, which is exactly why
 * the warning stays attached to it. `peek` reads a pane. `doctor` checks
 * reachability.
 */

export type SummonOptions = { json?: boolean | undefined }

export async function cmdSummon(
  client: HrcClient,
  opts: SummonOptions,
  positionals: string[]
): Promise<void> {
  const targetInput = positionals[0]
  if (!targetInput) throw new CliUsageError('summon requires <target>')
  const { sessionRef, runtimeIntent } = resolveSummonTarget(targetInput)

  const result = await client.ensureTarget({ sessionRef, runtimeIntent })

  if (opts.json) {
    printJson(result)
    return
  }

  process.stdout.write(`Summoned: ${result.sessionRef}\n`)
  process.stdout.write(`  state: ${result.state}\n`)
  if (result.activeHostSessionId) {
    process.stdout.write(`  hostSessionId: ${result.activeHostSessionId}\n`)
  }
  if (result.generation !== undefined) {
    process.stdout.write(`  generation: ${result.generation}\n`)
  }
  process.stdout.write(
    `  capabilities: dm=${result.capabilities.dmReady} send=${result.capabilities.sendReady} peek=${result.capabilities.peekReady}\n`
  )
}

export type SendOptions = { enter?: boolean; file?: string; json?: boolean | undefined }

export async function cmdSend(
  client: HrcClient,
  opts: SendOptions,
  positionals: string[]
): Promise<void> {
  const targetInput = positionals[0]
  if (!targetInput) throw new CliUsageError('send requires <target>')
  const body = consumeBody({ positional: positionals[1], file: opts.file })
  if (!body) throw new CliUsageError('send requires text (positional, -, or --file)')

  const sessionRef = resolveLiveTargetToSessionRef(targetInput)
  // Commander's --no-enter sets opts.enter to false; the default is true.
  const enter = opts.enter !== false

  const result = await client.deliverLiteralBySelector({
    selector: { sessionRef },
    text: body,
    enter,
  })

  if (opts.json) {
    printJson(result)
    return
  }
  process.stdout.write(`Sent to ${sessionRef}\n`)
}

export type PeekOptions = { lines?: string; json?: boolean | undefined }

export async function cmdPeek(
  client: HrcClient,
  opts: PeekOptions,
  positionals: string[]
): Promise<void> {
  const targetInput = positionals[0]
  if (!targetInput) throw new CliUsageError('peek requires <target>')
  const lines = Number.parseInt(opts.lines ?? '80', 10)
  const sessionRef = resolveLiveTargetToSessionRef(targetInput)

  const result = await client.captureBySelector({ selector: { sessionRef }, lines })

  if (opts.json) {
    printJson(result)
    return
  }
  process.stdout.write(result.text)
  if (!result.text.endsWith('\n')) process.stdout.write('\n')
}

export type TargetCheck = { name: string; status: 'ok' | 'warn' | 'fail'; detail?: string }

/**
 * The target half of `hrc doctor` (T-07612 §9.2).
 *
 * `hrc doctor` already answered "is this NODE healthy". Absorbing hrcchat's
 * doctor adds "and is this TARGET reachable" to the same verb rather than a
 * second command, because an operator asking either question is asking one
 * question: can I talk to it.
 */
export async function targetDoctorChecks(
  client: HrcClient,
  targetInput: string
): Promise<TargetCheck[]> {
  const checks: TargetCheck[] = []
  let sessionRef: string
  try {
    sessionRef = resolveLiveTargetToSessionRef(targetInput)
  } catch (err) {
    return [{ name: 'target-resolve', status: 'fail', detail: errDetail(err) }]
  }

  try {
    const target = await client.getTarget(sessionRef)
    checks.push({ name: 'target-lookup', status: 'ok', detail: target.state })

    if (target.state === 'broken') {
      checks.push({ name: 'target-health', status: 'fail', detail: 'target is in broken state' })
    }

    if (target.capabilities.dmReady) {
      checks.push({ name: 'dm-capability', status: 'ok' })
    } else {
      checks.push({
        name: 'dm-capability',
        status: 'warn',
        detail: `modes: ${target.capabilities.modesSupported.join(', ') || 'none'}`,
      })
    }

    if (target.runtime) {
      checks.push({
        name: 'runtime',
        status: 'ok',
        detail: `${target.runtime.transport}:${target.runtime.status}`,
      })
    } else {
      checks.push({ name: 'runtime', status: 'warn', detail: 'no bound runtime' })
    }
  } catch (err) {
    checks.push({
      name: 'target-lookup',
      status: 'fail',
      detail: err instanceof HrcDomainError ? `[${err.code}] ${err.message}` : errDetail(err),
    })
  }
  return checks
}

function errDetail(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
