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
  if (runtime.planHash === undefined || runtime.selectedProfileHash === undefined) return undefined
  const record = db.compiledRuntimePlans.getByPlanHash(runtime.planHash)
  if (record === null) return undefined
  try {
    const plan = JSON.parse(record.planProjectionJson) as {
      executionProfiles?: Array<{
        profileHash?: unknown
        harnessInvocation?: {
          startRequest?: { initialInput?: { inputId?: unknown } }
        }
      }>
    }
    const selected = plan.executionProfiles?.find(
      (profile) => profile.profileHash === runtime.selectedProfileHash
    )
    const inputId = selected?.harnessInvocation?.startRequest?.initialInput?.inputId
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
      record.type === 'submission.cancelled'
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
