import type { TurnAdmissionGate } from '../turn-admission-gate.js'

export const ADMISSION_STEPS = [
  'drain-lease',
  'retired-persona',
  'fence',
  'participant-resolution',
  'ownership-proof',
  'capability-authority',
  'execution-presentation',
  'rotation',
  'launch-carry-observation',
] as const
export type AdmissionStepName = (typeof ADMISSION_STEPS)[number]
export type AdmissionStep = {
  step: AdmissionStepName
  outcome:
    | 'passed'
    | 'skipped:not-carried'
    | 'skipped:not-applicable'
    | 'skipped:replay'
    | 'not-reached'
    | 'refused'
    | 'possible_write'
    | 'replayed'
}
export type TypedRefusal = { code: string; cause: unknown }
export type RouteOutcome<R> =
  | { kind: 'accepted'; value: R }
  | {
      kind: 'rejected_unlanded'
      rejection: { source: 'positive-rejection' | 'proved-withdrawal'; value: R }
    }
export type AdmissionResult<R> = (
  | { outcome: 'refused'; refusal: TypedRefusal }
  | { outcome: 'replayed'; recorded: R }
  | { outcome: 'routed'; routed: RouteOutcome<R> }
  | { outcome: 'possible_write'; cause: unknown }
) & { trace: AdmissionStep[] }
export type StepOutcome<R> =
  | { outcome: 'passed' | 'skipped:not-carried' | 'skipped:not-applicable' }
  | { outcome: 'refused'; refusal: TypedRefusal }
  | { outcome: 'replayed'; recorded: R }
export type AdmissionOperation<R> = { step: AdmissionStepName; run(): Promise<StepOutcome<R>> }

/** The lease belongs to this call, including response projection inside route. */
export async function runLeasedAdmission<R>(
  ctx: { gate: TurnAdmissionGate; record(result: AdmissionResult<R>): void },
  work: {
    steps: readonly AdmissionOperation<R>[]
    route(): Promise<RouteOutcome<R>>
    signal?: AbortSignal | undefined
  }
): Promise<AdmissionResult<R>> {
  const trace: AdmissionStep[] = []
  let release: (() => void) | undefined
  let position = 0
  let completed: AdmissionResult<R> | undefined
  const complete = (result: AdmissionResult<R>): AdmissionResult<R> => {
    const remainder = result.outcome === 'replayed' ? 'skipped:replay' : 'not-reached'
    for (const step of ADMISSION_STEPS.slice(trace.length)) trace.push({ step, outcome: remainder })
    completed = result
    return result
  }
  try {
    release = ctx.gate.admit()
    trace.push({ step: 'drain-lease', outcome: 'passed' })
    for (position = 1; position < ADMISSION_STEPS.length; position++) {
      const operation = work.steps[position - 1]
      if (operation === undefined || operation.step !== ADMISSION_STEPS[position])
        throw new Error('admission step order is incomplete')
      if (work.signal?.aborted) throw work.signal.reason
      const result = await operation.run()
      trace.push({ step: operation.step, outcome: result.outcome })
      if (result.outcome === 'refused')
        return complete({ outcome: 'refused', refusal: result.refusal, trace })
      if (result.outcome === 'replayed')
        return complete({ outcome: 'replayed', recorded: result.recorded, trace })
    }
    const routed = await work.route()
    if (work.signal?.aborted) throw work.signal.reason
    return complete({ outcome: 'routed', routed, trace })
  } catch (cause) {
    if (position >= 7) {
      if (trace.length < ADMISSION_STEPS.length)
        trace.push({
          step: ADMISSION_STEPS[position] ?? 'launch-carry-observation',
          outcome: 'possible_write',
        })
      return complete({ outcome: 'possible_write', cause, trace })
    }
    if (trace.length <= position)
      trace.push({
        step: ADMISSION_STEPS[position] ?? 'launch-carry-observation',
        outcome: 'refused',
      })
    const detail =
      cause !== null && typeof cause === 'object'
        ? (cause as { code?: string; detail?: { code?: string; reason?: string } })
        : undefined
    return complete({
      outcome: 'refused',
      refusal: {
        code: refusalCode(
          detail?.detail?.code ?? detail?.detail?.reason ?? detail?.code ?? 'admission_failed'
        ),
        cause,
      },
      trace,
    })
  } finally {
    try {
      if (completed !== undefined) ctx.record(completed)
    } finally {
      release?.()
    }
  }
}

/** Preserve each door's existing error response; uncertainty never mutates rows. */
export function admissionValue<R>(result: AdmissionResult<R>): R {
  if (result.outcome === 'refused') throw result.refusal.cause
  if (result.outcome === 'possible_write') throw result.cause
  if (result.outcome === 'replayed') return result.recorded
  return result.routed.kind === 'accepted' ? result.routed.value : result.routed.rejection.value
}

function refusalCode(code: string): string {
  const aliases: Record<string, string> = {
    server_draining: 'daemon_draining',
    'scope-retired': 'session_retired',
    'local-persona-not-allowed': 'persona_mismatch',
    'app-session-not-allowed': 'persona_mismatch',
    participant_rotation_unsupported: 'fresh_context_on_participant',
  }
  return aliases[code] ?? code
}
