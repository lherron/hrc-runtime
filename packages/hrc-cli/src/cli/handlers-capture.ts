import type { InvocationEventType, TurnId } from 'spaces-harness-broker-protocol'

import { printJson } from '../print.js'
import { resolveRuntimeArg } from '../selector-resolve.js'
import { hasFlag, parseFlag, requireArg } from './argv.js'
import { formatCaptureState } from './handlers-runtime.js'
import { localCliDispatchOrigin } from './handlers-scope-cmd.js'
import { createClient, fatal } from './shared.js'

/**
 * Capture release is operator-only: a clean shell with no HRC/ASP session
 * envelope at all. Any envelope key — well-formed or not — refuses. (This was
 * the operator branch of the retired server-lifecycle env classifier; T-09861
 * moved server lifecycle to daemon-minted credentials and left capture's own
 * rule unchanged.)
 */
const CAPTURE_OPERATOR_ENVELOPE_KEYS = [
  'HRC_SESSION_REF',
  'HRC_RUN_ID',
  'ASP_SCOPE_REF',
  'ASP_TASK_ID',
  'ASP_DEFAULT_TASK',
  'ASP_HANDLE',
  'HRC_HOST_SESSION_ID',
  'AGENT_HOST_SESSION_ID',
  'HRC_GENERATION',
  'AGENT_GENERATION',
] as const

async function requireOperatorPrincipal(): Promise<string> {
  const present = CAPTURE_OPERATOR_ENVELOPE_KEYS.filter((key) => process.env[key] !== undefined)
  if (present.length > 0) {
    fatal(
      `capture release is operator-only; this caller carries an HRC/ASP session envelope (${present.join(', ')}); run it from a clean operator shell`
    )
  }
  return localCliDispatchOrigin()?.actor ?? 'human'
}

export async function cmdCaptureStatus(args: string[]): Promise<void> {
  const target = requireArg(args, 0, '<target>')
  const client = createClient()
  const runtimeId = await resolveRuntimeArg(target, client)
  const result = await client.brokerCaptureStatus(runtimeId)
  if (hasFlag(args, '--json')) {
    printJson(result)
    return
  }
  process.stdout.write(`capture: ${formatCaptureState(result.capture)}\n`)
}

export async function cmdCaptureRelease(args: string[]): Promise<void> {
  const target = requireArg(args, 0, '<target>')
  const rawRecordId = parseFlag(args, '--raw-record')
  const disposition = parseFlag(args, '--disposition')
  if (rawRecordId === undefined || rawRecordId.length === 0) {
    fatal('--raw-record is required')
  }
  if (disposition !== 'ignored-known' && disposition !== 'normalized-as') {
    fatal('--disposition must be ignored-known or normalized-as')
  }

  let normalizedAs:
    | {
        type: InvocationEventType
        payload: unknown
        turnId?: TurnId | undefined
      }
    | undefined
  if (disposition === 'normalized-as') {
    const eventType = parseFlag(args, '--event-type')
    const eventPayload = parseFlag(args, '--event-payload')
    if (eventType === undefined || eventPayload === undefined) {
      fatal('--event-type and --event-payload are required with normalized-as')
    }
    let payload: unknown
    try {
      payload = JSON.parse(eventPayload) as unknown
    } catch (error) {
      fatal(`--event-payload must be valid JSON: ${error instanceof Error ? error.message : error}`)
    }
    const turnId = parseFlag(args, '--turn-id')
    normalizedAs = {
      type: eventType as InvocationEventType,
      payload,
      ...(turnId !== undefined ? { turnId: turnId as TurnId } : {}),
    }
  }

  const client = createClient()
  const runtimeId = await resolveRuntimeArg(target, client)
  const note = parseFlag(args, '--note')
  const response = await client.brokerCaptureRelease({
    runtimeId,
    operatorPrincipal: await requireOperatorPrincipal(),
    rawRecordId,
    disposition,
    ...(normalizedAs !== undefined ? { normalizedAs } : {}),
    ...(note !== undefined ? { note } : {}),
  })
  printJson(response)
}

/**
 * T-08566: `hrc capture recover <runtimeId>` — one explicit operator attempt to
 * project a terminal runtime's retained broker evidence through its owning
 * release. Mutating, so it requires `--yes`; `--dry-run` reports eligibility,
 * release capability and the current outcome without spawning a reader.
 */
export async function cmdCaptureRecover(args: string[]): Promise<void> {
  const runtimeId = requireArg(args, 0, '<runtimeId>')
  const yes = hasFlag(args, '--yes')
  const dryRun = hasFlag(args, '--dry-run')
  if (!yes && !dryRun) {
    fatal('capture recover requires --yes (use --dry-run to preview)')
  }
  const client = createClient()
  const response = await client.captureRecover({
    runtimeId,
    ...(dryRun ? { dryRun: true } : { yes: true }),
  })
  if (hasFlag(args, '--json')) {
    printJson(response)
    return
  }
  const parts = [
    `capture recover${response.dryRun ? ' (dry-run)' : ''}: ${response.runtimeId}`,
    `outcome=${response.outcome}`,
    ...(response.class !== undefined ? [`class=${response.class}`] : []),
    `held=${response.held}`,
    `projectedThroughSeq=${response.projectedThroughSeq}`,
    ...(response.currentSeq !== undefined ? [`currentSeq=${response.currentSeq}`] : []),
    `spawned=${response.spawned}`,
  ]
  process.stdout.write(`${parts.join(' ')}\n`)
}
