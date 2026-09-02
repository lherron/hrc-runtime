import type { InvocationEventType, TurnId } from 'spaces-harness-broker-protocol'

import { evaluateServerLifecycleAuthorization } from '../cli-runtime/shutdown-intent.js'
import { printJson } from '../print.js'
import { resolveRuntimeArg } from '../selector-resolve.js'
import { hasFlag, parseFlag, requireArg } from './argv.js'
import { formatCaptureState } from './handlers-runtime.js'
import { localCliDispatchOrigin } from './handlers-scope-cmd.js'
import { createClient, fatal } from './shared.js'

function requireOperatorPrincipal(): string {
  const authorization = evaluateServerLifecycleAuthorization(process.env, undefined)
  if (!authorization.allowed || authorization.callerKind !== 'operator') {
    fatal(
      authorization.allowed
        ? 'capture release is operator-only; run it from a clean operator shell'
        : authorization.message.replace('server lifecycle mutation', 'capture release')
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
    operatorPrincipal: requireOperatorPrincipal(),
    rawRecordId,
    disposition,
    ...(normalizedAs !== undefined ? { normalizedAs } : {}),
    ...(note !== undefined ? { note } : {}),
  })
  printJson(response)
}
