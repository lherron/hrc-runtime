import { CliUsageError, parseDuration } from 'cli-kit'
import type {
  HrcSubmissionResponse,
  HrcTurnResponseFormat,
  SemanticTurnHandoffPendingResponse,
  SemanticTurnHandoffResponse,
} from 'hrc-core'
import type { HrcClient } from 'hrc-sdk'

import type { ProfileAwareResolvedScopeInput as ScopeInput } from 'hrc-sdk'
import { printJson, printJsonLine } from '../../print.js'
import { writeDeliveryOutcome, writeDeliveryWarnings } from '../delivery-warning.js'
import { resolveSenderAddress } from '../normalize.js'
import { resolveLaunchTarget } from '../resolve-intent.js'
import { isRecord } from '../stacked-shared.js'
import type { StackedHandoff } from '../stacked-types.js'
import { TERMINALS, TURN_EXIT_STALL, TurnExitError } from './turn-terminals.js'
import type {
  TurnBodyInput,
  TurnCommandDependencies,
  TurnOptions,
  TurnOutputOptions,
} from './turn.js'

function isPendingSemanticTurnHandoff(
  response: SemanticTurnHandoffResponse
): response is SemanticTurnHandoffPendingResponse {
  return 'status' in response && response.status === 'pending'
}

/** A steer can acknowledge format-2 admission before its execution exists. */
function isAdmittedRunSubmission(
  response: HrcSubmissionResponse
): response is HrcSubmissionResponse & {
  admission: 'admitted'
  runId: string
  runtimeId?: string | undefined
  hostSessionId: string
  generation: number
  observation: { lifecycle: { fromSeq: number } }
} {
  return (
    response.admission === 'admitted' &&
    'runId' in response &&
    typeof response.runId === 'string' &&
    'hostSessionId' in response &&
    typeof response.hostSessionId === 'string' &&
    'generation' in response &&
    typeof response.generation === 'number' &&
    'observation' in response &&
    response.observation.lifecycle !== undefined
  )
}

/**
 * `--timeout` is a hard bound on `--wait` whatever the server does (T-08865):
 * print the timeout as the command's JSON result and exit non-zero.
 */
export function waitTimeoutExit(
  timeoutMs: number,
  fields: { runId?: string | undefined; door?: string | undefined } = {}
): TurnExitError {
  printJsonLine({
    result: 'wait_timeout',
    timeoutMs,
    ...(fields.runId !== undefined ? { runId: fields.runId } : {}),
    ...(fields.door !== undefined ? { door: fields.door } : {}),
  })
  return new TurnExitError(TURN_EXIT_STALL, `--wait timeout reached after ${timeoutMs}ms`)
}

/** Call `onDeadline` when (or if already) the wait deadline fires; returns the unbind. */
export function bindWaitDeadline(
  deadline: AbortSignal | undefined,
  onDeadline: () => void
): () => void {
  if (deadline === undefined) return () => {}
  if (deadline.aborted) {
    onDeadline()
    return () => {}
  }
  deadline.addEventListener('abort', onDeadline, { once: true })
  return () => deadline.removeEventListener('abort', onDeadline)
}

/**
 * A waited door whose turn ended failed (e.g. its broker never started) exits
 * like a watched failed turn, after its response line is printed (T-08865).
 */
export function exitIfWaitedTurnFailed(response: HrcSubmissionResponse): void {
  const body = response as Record<string, unknown>
  const terminal = isRecord(body['terminal']) ? body['terminal'] : {}
  if (body['status'] !== 'failed' && terminal['status'] !== 'failed') return
  const error = isRecord(body['error']) ? body['error'] : {}
  const code = typeof error['code'] === 'string' ? error['code'] : 'failed'
  const message = typeof error['message'] === 'string' ? `: ${error['message']}` : ''
  throw new TurnExitError(TERMINALS.error.exitCode, `turn failed: ${code}${message}`)
}

/** Run a server-side waiting door; the client deadline ends it if the server does not. */
export async function withWaitDeadline<T>(
  output: TurnOutputOptions,
  door: string,
  call: (signal: AbortSignal | undefined) => Promise<T>
): Promise<T> {
  try {
    return await call(output.waitDeadline)
  } catch (error) {
    if (output.waitDeadline?.aborted === true && output.waitTimeoutMs !== undefined) {
      throw waitTimeoutExit(output.waitTimeoutMs, { door })
    }
    throw error
  }
}

export function assertProjectResolved(targetInput: string, resolved: ScopeInput): void {
  if (resolved.parsed.projectId) {
    return
  }

  throw new CliUsageError(
    [
      `cannot resolve a project for target "${targetInput}".`,
      'A turn must target an agent within a project, but none was found: the',
      'target has no @<project> qualifier, ASP_PROJECT is unset, and the current',
      'directory maps to no known project. Fix one of:',
      `  • qualify the target:  hrc turn ${targetInput}@<project> "…"`,
      `  • set the env:         ASP_PROJECT=<project> hrc turn ${targetInput} "…"`,
      `  • run from a project:  cd ~/praesidium/<project> && hrc turn ${targetInput} "…"`,
    ].join('\n')
  )
}

export type PreparedTurnObservation = {
  resolved: ScopeInput
  handoff: StackedHandoff
  catchUpThroughSeq?: number | undefined
  /**
   * Follow the seat rather than one run. A steer that joins a running turn is
   * settled into the run that owns that turn, so its own run carries none of
   * the turn's events; the first turn terminal on the seat after admission is
   * the turn it joined or started.
   */
  followSeat?: boolean | undefined
}

/**
 * A steer the server downgraded (T-08536) was asked for "now" and delivered
 * "after". Say so on stderr for every output mode; the JSON response line carries the fields.
 */
export function writeDoorDowngrade(
  response: Pick<HrcSubmissionResponse, 'effectiveDoor' | 'requestedDoor' | 'downgradeReason'>,
  write: (text: string) => void = (text) => process.stderr.write(text)
): void {
  if (response.requestedDoor === undefined || response.effectiveDoor === undefined) return
  write(
    `notice: ${response.requestedDoor} downgraded to ${response.effectiveDoor} (${response.downgradeReason ?? 'unknown'}): the message runs after the current turn\n`
  )
}

export async function prepareDispatchedTurn(
  client: HrcClient,
  opts: TurnOptions,
  input: TurnBodyInput,
  output: TurnOutputOptions,
  stallAfterMs: number,
  responseFormat: HrcTurnResponseFormat | undefined,
  dependencies: TurnCommandDependencies
): Promise<PreparedTurnObservation | undefined> {
  const { targetInput, body, bodyFromFile, bodyFromStdin } = input
  const { waitMode, stackedWindowMs } = output
  const resolveLaunch = dependencies.resolveLaunchTarget ?? resolveLaunchTarget
  const { resolved, sessionRef, runtimeIntent } = await resolveLaunch(targetInput)

  if (opts.dryRun) {
    printJson({
      command: 'turn',
      dryRun: true,
      note: 'local plan preview — no server state consulted, nothing dispatched',
      target: targetInput,
      sessionRef,
      scopeRef: resolved.scopeRef,
      laneRef: resolved.laneRef,
      projectId: resolved.parsed.projectId ?? null,
      placementResolution: resolved.placement.resolution,
      bodySource: bodyFromFile ? 'file' : bodyFromStdin ? 'stdin' : 'positional',
      bodyLength: body.length,
      clearContextFirst: opts.new === true,
      replyToMessageId: opts.replyTo ?? null,
      responseFormat: responseFormat ?? null,
      output: {
        format: opts.format ?? null,
        pretty: opts.pretty === true,
        stackedWindowMs: stackedWindowMs ?? null,
        stallAfterMs,
      },
      runtimeIntent,
    })
    return undefined
  }

  assertProjectResolved(targetInput, resolved)
  const sender = await resolveSenderAddress(opts.as)
  if (sender.source === 'human-fallback') {
    if (!process.stdout.isTTY) {
      throw new CliUsageError(
        'no session envelope and no interactive terminal: name the sender with --as <principal> ("human" or an agent handle) — scripted sends must not default to the human seat'
      )
    }
    process.stderr.write('notice: dispatching as human (no session envelope)\n')
  }
  const from = sender.address
  const to = { kind: 'session' as const, sessionRef }
  const principalRef =
    from.kind === 'session'
      ? (from.sessionRef.split('/lane:')[0] ?? from.sessionRef)
      : from.entity === 'human'
        ? 'human:lance'
        : `system:${from.entity}`
  const ttlMs = opts.ttl === undefined ? undefined : parseDuration(opts.ttl)
  if (ttlMs !== undefined && ttlMs <= 0) {
    throw new CliUsageError(`invalid duration: ${opts.ttl} (must be > 0)`)
  }
  const submissionRequest = {
    target: sessionRef,
    body,
    origin: { principalRef, ...(from.kind === 'session' ? { scopeRef: principalRef } : {}) },
    ...(opts.new === true ? { freshContext: true } : {}),
    ...(responseFormat !== undefined ? { responseFormat } : {}),
  }
  const queue = opts.queue === true
  if (opts.preempt === true) {
    const preempted = await withWaitDeadline(output, 'preempt', (signal) =>
      client.preempt(
        {
          ...submissionRequest,
          ...(ttlMs !== undefined ? { ttlMs } : {}),
          ...(waitMode === 'final' ? { wait: true, turnPolicy: 'guarded' as const } : {}),
        },
        { signal: waitMode === 'final' ? signal : undefined }
      )
    )
    printJsonLine(preempted)
    exitIfWaitedTurnFailed(preempted)
    return undefined
  }
  if (!queue) {
    // Steer = send now (T-08533): join the running turn, or start one. A target
    // with no session row has no seat to steer yet; its birth turn is the turn
    // the steer would start, and the handoff below is the door that births it.
    const existing = await client.resolveSession({ sessionRef, create: false })
    if (existing.found) {
      if (waitMode === 'final') {
        const waited = await withWaitDeadline(output, 'steer', (signal) =>
          client.steer({ ...submissionRequest, wait: true }, { signal })
        )
        writeDoorDowngrade(waited)
        printJsonLine(waited)
        exitIfWaitedTurnFailed(waited)
        return undefined
      }
      const steered = await client.steer(submissionRequest)
      writeDoorDowngrade(steered)
      // Format-2 admission has no execution run or lifecycle cursor yet; its
      // receipt is input-based and cannot be followed as a legacy run.
      if (!isAdmittedRunSubmission(steered)) {
        printJsonLine(steered)
        return undefined
      }
      return {
        resolved,
        // A steer downgraded to enqueue (T-08536) waits BEHIND the running turn,
        // so the seat's next terminal may not be its turn: follow its own run.
        followSeat: steered.effectiveDoor !== 'enqueue',
        handoff: {
          sessionRef,
          scopeRef: resolved.scopeRef,
          laneRef: resolved.laneRef,
          hostSessionId: steered.hostSessionId,
          runtimeId: steered.runtimeId ?? '',
          runId: steered.runId,
          generation: steered.generation,
          fromSeq: steered.observation?.lifecycle.fromSeq ?? 0,
        },
      }
    }
  }
  if (queue && (waitMode === 'final' || ttlMs !== undefined)) {
    const enqueued = await withWaitDeadline(output, 'enqueue', (signal) =>
      client.enqueue(
        {
          ...submissionRequest,
          ...(ttlMs !== undefined ? { ttlMs } : {}),
          ...(waitMode === 'final' ? { wait: true, turnPolicy: 'guarded' as const } : {}),
        },
        { signal: waitMode === 'final' ? signal : undefined }
      )
    )
    printJsonLine(enqueued)
    exitIfWaitedTurnFailed(enqueued)
    return undefined
  }
  const dispatch = await client.semanticTurnHandoff({
    from,
    to,
    body,
    runtimeIntent,
    createIfMissing: true,
    ...(opts.new === true ? { freshContext: true } : {}),
    replyToMessageId: opts.replyTo,
    allowCrossScopeReply: opts.crossScopeReply,
    responseFormat,
  })
  if (isPendingSemanticTurnHandoff(dispatch)) {
    printJsonLine(dispatch)
    return undefined
  }
  const quiet = waitMode !== undefined ? opts.quiet !== false : opts.quiet === true
  if (!quiet) {
    writeDeliveryWarnings(dispatch.warnings)
    writeDeliveryOutcome(dispatch.delivery)
  }
  return { resolved, handoff: dispatch }
}
