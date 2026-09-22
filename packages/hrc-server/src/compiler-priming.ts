import type { HrcRuntimeSnapshot } from 'hrc-core'
import type { HrcDatabase } from 'hrc-store-sqlite'

/**
 * The compiler-owned agent priming submission of a cold broker boot.
 *
 * A promptless cold boot launches the invocation with the compiler's priming
 * input, which carries no HRC run/input identity by design: the caller's prompt
 * is a separate guarded invoke that must wait for the priming turn to finish.
 * Two readers need the same fact and must never disagree about it —
 * `waitForCompilerPrimingTerminal` (which arms the submit) and the zombie sweep
 * (which must not count a running priming turn as run silence, T-07944) — so the
 * predicate lives here, once, over the broker ledger alone.
 */

function parseBrokerEventPayload(record: { brokerEventJson: string }): Record<string, unknown> {
  try {
    const payload = JSON.parse(record.brokerEventJson) as unknown
    return payload !== null && typeof payload === 'object'
      ? (payload as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

export function compilerPrimingSubmissionId(
  db: HrcDatabase,
  runtime: HrcRuntimeSnapshot
): string | undefined {
  const operation =
    runtime.activeOperationId !== undefined
      ? db.runtimeOperations.getByOperationId(runtime.activeOperationId)
      : undefined
  // The operation's frozen v2 admission is the durable source for execution
  // bytes. The compact compiled-plan projection intentionally retains only
  // selection/provenance, so it cannot be used to rediscover an input id.
  if (operation?.preparationJson !== undefined) {
    try {
      const preparation = JSON.parse(operation.preparationJson) as {
        admission?: {
          plan?: { schemaVersion?: unknown }
          execution?: {
            dispatchRequest?: { startRequest?: { initialInput?: { inputId?: unknown } } }
          }
        }
      }
      if (preparation.admission?.plan?.schemaVersion === 'agent-runtime-plan/v2') {
        const inputId =
          preparation.admission.execution?.dispatchRequest?.startRequest?.initialInput?.inputId
        if (typeof inputId === 'string' && inputId.length > 0) return inputId
      }
    } catch {
      // The plan fallback below retains ordinary historical compatibility.
    }
  }
  // The controller's just-started snapshot is intentionally smaller than the
  // persisted runtime row. Boundary P already bound its active operation to a
  // plan, so use that durable link until the returned snapshot is refreshed.
  const planHash = runtime.planHash ?? operation?.planHash
  if (planHash === undefined) return undefined
  const record = db.compiledRuntimePlans.getByPlanHash(planHash)
  if (record === null) return undefined
  try {
    const plan = JSON.parse(record.planProjectionJson) as {
      schemaVersion?: unknown
      execution?: {
        dispatchRequest?: { startRequest?: { initialInput?: { inputId?: unknown } } }
      }
    }
    // Retained v1 plan bytes are attach/replay evidence only. Never reopen
    // their plural profile selection during a v2 runtime decision.
    if (plan.schemaVersion !== 'agent-runtime-plan/v2') return undefined
    const inputId = plan.execution?.dispatchRequest?.startRequest?.initialInput?.inputId
    return typeof inputId === 'string' && inputId.length > 0 ? inputId : undefined
  } catch {
    return undefined
  }
}

/**
 * Has the compiler priming submission on `invocationId` reached a terminal
 * state? Consumes only the broker ledger projection: no local busy guess,
 * polling, timer, or reply row participates.
 */
export function isCompilerPrimingSubmissionTerminal(
  db: HrcDatabase,
  invocationId: string,
  submissionId: string
): boolean {
  const records = db.brokerInvocationEvents.listByInvocationId(invocationId)
  let turnId: string | undefined
  for (const record of records) {
    const payload = parseBrokerEventPayload(record)
    if (payload['submissionId'] !== submissionId) continue
    if (
      record.type === 'submission.rejected' ||
      record.type === 'submission.expired' ||
      record.type === 'submission.cancelled' ||
      record.type === 'submission.lost'
    ) {
      return true
    }
    if (record.type === 'submission.executed' && typeof payload['turnId'] === 'string') {
      turnId = payload['turnId']
    }
  }
  if (turnId === undefined) return false
  return records.some((record) => {
    if (
      record.type !== 'turn.completed' &&
      record.type !== 'turn.failed' &&
      record.type !== 'turn.interrupted'
    ) {
      return false
    }
    return parseBrokerEventPayload(record)['turnId'] === turnId
  })
}

/**
 * True while this runtime's compiler priming submission exists and has NOT gone
 * terminal — i.e. the seat is genuinely busy running the priming turn even
 * though the accepted run it belongs to has emitted nothing since acceptance.
 */
export function isCompilerPrimingActive(db: HrcDatabase, runtime: HrcRuntimeSnapshot): boolean {
  const invocationId = runtime.activeInvocationId
  if (invocationId === undefined) return false
  const submissionId = compilerPrimingSubmissionId(db, runtime)
  if (submissionId === undefined) return false
  return !isCompilerPrimingSubmissionTerminal(db, invocationId, submissionId)
}
