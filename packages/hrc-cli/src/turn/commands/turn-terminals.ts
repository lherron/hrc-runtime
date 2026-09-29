import type { HrcLifecycleEvent } from 'hrc-core'
import type { RenderFrame } from 'hrc-frame-render'
import { printJsonLine } from '../../print.js'
import type { StackedAggregator } from '../stacked-aggregator.js'
import { isCanonicalTurnCompletionFailure, isRecord } from '../stacked-shared.js'
import { FlushReason, Phase, Result } from '../stacked-types.js'

/**
 * Typed exit error for the turn command.
 * Thrown instead of calling process.exit() directly so that main.ts
 * can map it to the correct exit code, and tests can assert on it.
 *
 * Exit codes:
 *   0 — turn completed (success, no error thrown)
 *   1 — stall-after fired
 *   2 — usage error (handled by CliUsageError)
 *   3 — infra failure (socket, daemon)
 *   4 — runtime dead before turn completed
 *   5 — permission-blocked
 *   6 — no admitted run to attach to
 * 130 — SIGINT
 */
export class TurnExitError extends Error {
  readonly exitCode: number
  constructor(exitCode: number, message: string) {
    super(message)
    this.name = 'TurnExitError'
    this.exitCode = exitCode
  }
}

export const TURN_EXIT_STALL = 1
export const TURN_EXIT_INFRA = 3
export const TURN_EXIT_RUNTIME_DEAD = 4
export const TURN_EXIT_PERMISSION_BLOCKED = 5
export const TURN_EXIT_NOTHING_TO_ATTACH = 6
export const TURN_EXIT_SIGINT = 130

/**
 * The four terminal outcomes of the turn watch loop, reified as a table so the
 * (phase, flush, exitCode, result, message) tuple for each is declared in one
 * place rather than hand-aligned across four `aggregator.finish(...) ; throw`
 * blocks. Every triple is preserved byte-for-byte from the original blocks —
 * exit codes (0/4/5) are the user-facing CLI contract and must not shift.
 *
 *   runtimeDead — runtime exited before the turn completed (exit 4)
 *   permission  — turn blocked on a permission request (exit 5)
 *   error       — turn ended with an error (exit 4, reusing RUNTIME_DEAD)
 *   success     — turn completed normally (exit 0, no throw)
 *
 * Note `runtimeDead` and `error` share TURN_EXIT_RUNTIME_DEAD but carry
 * different Result values (RuntimeDead vs TurnError) and messages.
 */
export type TerminalKind = 'runtimeDead' | 'permission' | 'error' | 'success'

type TerminalOutcome = {
  phase: Phase
  flush: FlushReason
  exitCode: number
  result: Result
  /** aggregator-finish error payload; omitted when the arm carries no error */
  errorMessage?: string
  /** TurnExitError message; omitted for the non-throwing success arm */
  throwMessage?: string
}

export const TERMINALS: Record<TerminalKind, TerminalOutcome> = {
  runtimeDead: {
    phase: Phase.Error,
    flush: FlushReason.Error,
    exitCode: TURN_EXIT_RUNTIME_DEAD,
    result: Result.RuntimeDead,
    errorMessage: 'runtime exited before turn completed',
    throwMessage: 'runtime exited before turn completed',
  },
  permission: {
    phase: Phase.Permission,
    flush: FlushReason.Permission,
    exitCode: TURN_EXIT_PERMISSION_BLOCKED,
    result: Result.PermissionBlocked,
    throwMessage: 'turn blocked on permission request (no interactive approval in MVP)',
  },
  error: {
    phase: Phase.Error,
    flush: FlushReason.Error,
    exitCode: TURN_EXIT_RUNTIME_DEAD,
    result: Result.TurnError,
    errorMessage: 'turn ended with error',
    throwMessage: 'turn ended with error',
  },
  success: {
    phase: Phase.Final,
    flush: FlushReason.Final,
    exitCode: 0,
    result: Result.Success,
  },
}

/**
 * Finalize the stacked aggregator for a terminal outcome, then (for every arm
 * except success) throw the matching TurnExitError. Preserves the exact
 * finish(...) payload and exit-code/message of the original inline blocks.
 */
export async function finalizeTurn(
  aggregator: StackedAggregator | undefined,
  kind: TerminalKind
): Promise<void> {
  const outcome = TERMINALS[kind]
  await aggregator?.finish({
    phase: outcome.phase,
    flush: outcome.flush,
    exitCode: outcome.exitCode,
    result: outcome.result,
    ...(outcome.errorMessage !== undefined ? { error: { message: outcome.errorMessage } } : {}),
  })
  if (outcome.throwMessage !== undefined) {
    throw new TurnExitError(outcome.exitCode, outcome.throwMessage)
  }
}

/**
 * Watch-loop terminal predicate: which events end the turn for the watch loop
 * (both the stacked and non-stacked paths). Deliberately BROADER than the
 * stacked aggregator's own `isStackedAggregatorFinal` (turn.completed only) —
 * the two are intentionally distinct, NOT a duplicate. Do not unify the bodies;
 * see T-04733 (daedalus-gated) for why widening/narrowing either is a behavior
 * change.
 */
export function isWatchLoopTurnTerminal(event: HrcLifecycleEvent): boolean {
  return event.eventKind === 'turn_end' || event.eventKind === 'turn.completed'
}

export type TurnFailure = {
  result: 'turn_failed'
  runId: string | undefined
  eventKind: string
  hrcSeq: number
  errorCode: string | undefined
  code: string
  message: string | undefined
  diagnosticsSeq?: number | undefined
  retrieval?: string | undefined
}

/**
 * Events after which the watched run can never complete: `turn.failed` (e.g.
 * broker_start_failed) and a `first_turn_missing` trip, which makes the run
 * terminal server-side (a late turn.started never resurrects it).
 */
export function turnFailureOf(event: HrcLifecycleEvent): TurnFailure | undefined {
  if (event.eventKind !== 'turn.failed' && event.eventKind !== 'first_turn_missing') {
    return undefined
  }
  const payload = isRecord(event.payload) ? event.payload : {}
  const payloadCode = typeof payload['code'] === 'string' ? payload['code'] : undefined
  const message = typeof payload['message'] === 'string' ? payload['message'] : undefined
  const firstTurnMissing = event.eventKind === 'first_turn_missing'
  return {
    result: 'turn_failed',
    runId: event.runId,
    eventKind: event.eventKind,
    hrcSeq: event.hrcSeq,
    errorCode: event.errorCode,
    code: payloadCode ?? event.errorCode ?? event.eventKind,
    message,
    ...(firstTurnMissing
      ? { diagnosticsSeq: event.hrcSeq, retrieval: `hrc runtime diagnostics ${event.hrcSeq}` }
      : {}),
  }
}

/** Report a failed turn on the active sink and exit with the error terminal's code. */
export async function failTurn(
  failure: TurnFailure,
  aggregator: StackedAggregator | undefined,
  printFailureLine: boolean
): Promise<never> {
  const detail = `${failure.code}${failure.message !== undefined ? `: ${failure.message}` : ''}`
  const outcome = TERMINALS.error
  if (aggregator) {
    await aggregator.finish({
      phase: outcome.phase,
      flush: outcome.flush,
      exitCode: outcome.exitCode,
      result: outcome.result,
      error: { message: detail },
    })
  } else if (printFailureLine) {
    printJsonLine(failure)
  }
  throw new TurnExitError(outcome.exitCode, `turn failed: ${detail}`)
}

export function isRuntimeDead(event: HrcLifecycleEvent): boolean {
  return (
    event.eventKind === 'runtime_exited' ||
    event.eventKind === 'runtime_crashed' ||
    event.eventKind === 'runtime_killed'
  )
}

export function deriveStackedPhase(
  event: HrcLifecycleEvent,
  prior: RenderFrame['phase'] | undefined
): RenderFrame['phase'] | undefined {
  if (event.eventKind === 'permission_request') {
    return 'permission'
  }
  if (event.eventKind === 'turn.completed') {
    return isCanonicalTurnCompletionFailure(event) ? 'error' : 'final'
  }
  if (event.eventKind === 'run_failed' || event.eventKind === 'turn.error') {
    return 'error'
  }
  if (event.eventKind === 'run_queued') {
    return prior ?? 'queued'
  }
  return prior === 'permission' || prior === 'error' ? prior : 'progress'
}

export async function enrichFinalEvent(event: HrcLifecycleEvent): Promise<HrcLifecycleEvent> {
  return event
}
