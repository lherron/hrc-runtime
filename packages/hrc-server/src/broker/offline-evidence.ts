/**
 * T-08566 stage 2 — retained-evidence recovery (SPEC §3.4.1, §3.4.4, §4).
 *
 * Reads committed normalized envelopes of a dead worker through the exact
 * persisted owning release's `evidence-read` mode, validates each page whole,
 * and projects it through `BrokerEventMapper.applyRetained` under the
 * retained-evidence fence. It holds no ACK, opens no control or observer socket
 * and writes nothing under the ledger directory.
 *
 * Authority: a recovery attempt owns its runtime exclusively (see
 * runtime-exclusive-owner.ts). Only `terminated`/`failed` harness-broker
 * runtimes with an unreachable endpoint are eligible; everything else is refused
 * before any reader spawns or any cursor moves.
 */

import { existsSync } from 'node:fs'
import { dirname } from 'node:path'

import type { CaptureRecoverResponse, HrcRuntimeSnapshot, RetainedEvidenceTrigger } from 'hrc-core'
import type { HrcDatabase, RetainedEvidenceOutcomeRecord } from 'hrc-store-sqlite'

import { writeServerLog } from '../server-log'
import { persistedAspdExecutionRelease } from './controller/dispatch'
import {
  type OfflineEvidenceDeps,
  eligibilityRefusal,
  persistedEventLedgerPath,
  readAndProject,
  releaseCapabilityDeclared,
} from './offline-evidence-attempt'
import {
  BUDGET_FREE_OUTCOMES,
  ELIGIBLE_STATUSES,
  OFFLINE_EVIDENCE_RETRY_BUDGET,
  RETAINED_EVIDENCE_OUTCOME_SCHEMA,
  classifyRetainedOutcome,
  outcomeHoldsEvidence,
} from './offline-evidence-outcomes'
import { acquireRetainedRecoveryOwnership } from './runtime-exclusive-owner'

// Public surface of the original module: re-exported so importers keep this path.
export {
  OFFLINE_EVIDENCE_CAPABILITY,
  OFFLINE_EVIDENCE_PAGE_LIMIT,
  OFFLINE_EVIDENCE_PAGE_MAX_BYTES,
  OFFLINE_EVIDENCE_READER_TIMEOUT_MS,
  OFFLINE_EVIDENCE_RETRY_BUDGET,
  OFFLINE_EVIDENCE_SCHEMA,
  OFFLINE_EVIDENCE_SLICE_MAX_BYTES,
  OFFLINE_EVIDENCE_SLICE_MAX_MS,
  OFFLINE_EVIDENCE_SLICE_MAX_PAGES,
  OFFLINE_EVIDENCE_STDERR_MAX_BYTES,
  OFFLINE_EVIDENCE_STDOUT_SLACK_BYTES,
  RETAINED_EVIDENCE_OUTCOME_SCHEMA,
  classifyRetainedOutcome,
  outcomeHoldsEvidence,
} from './offline-evidence-outcomes'
export {
  type OfflineEvidenceDeps,
  type OfflineEvidenceOptions,
  persistedEventLedgerPath,
} from './offline-evidence-attempt'
export { killActiveOfflineReaders } from './offline-evidence-reader'
export {
  type PageVerdict,
  type TypedErrorVerdict,
  type ValidPage,
  validateOfflineEvidencePage,
  validateOfflineEvidenceTypedError,
} from './offline-evidence-validate'

// ── public entry ─────────────────────────────────────────────────────────────

export type RecoverRetainedEvidenceInput = {
  runtimeId: string
  trigger: RetainedEvidenceTrigger
  dryRun?: boolean | undefined
}

function targetInvocationId(db: HrcDatabase, runtime: HrcRuntimeSnapshot): string | undefined {
  const invocations = db.brokerInvocations.listByRuntimeId(runtime.runtimeId)
  if (runtime.activeInvocationId !== undefined) {
    const active = invocations.find((entry) => entry.invocationId === runtime.activeInvocationId)
    if (active) return active.invocationId
  }
  return invocations.at(-1)?.invocationId
}

function responseFor(
  db: HrcDatabase,
  runtime: HrcRuntimeSnapshot,
  invocationId: string | undefined,
  trigger: RetainedEvidenceTrigger,
  fields: {
    outcome: string
    recorded: boolean
    attempts: number
    spawned: boolean
    projectedThroughSeq: number
    currentSeq?: number | undefined
    detail: Record<string, unknown>
    bound: boolean
    dryRun?: boolean | undefined
    eligibility?: CaptureRecoverResponse['eligibility']
    capability?: CaptureRecoverResponse['capability']
  }
): CaptureRecoverResponse {
  const outcomeClass = classifyRetainedOutcome(fields.outcome)
  return {
    runtimeId: runtime.runtimeId,
    ...(invocationId !== undefined ? { invocationId } : {}),
    trigger,
    ...(fields.dryRun ? { dryRun: true } : {}),
    spawned: fields.spawned,
    outcome: fields.outcome,
    ...(outcomeClass !== 'paused' ? { class: outcomeClass } : { class: 'incomplete' as const }),
    complete: outcomeClass === 'complete',
    // §4.2 (H1 rev 3): `held` is the directory-hold predicate on the runtime row
    // as it stands after the attempt, never the attempt outcome's class.
    held: currentHold(db, runtime.runtimeId),
    attempts: fields.attempts,
    recorded: fields.recorded,
    projectedThroughSeq: fields.projectedThroughSeq,
    ...(fields.currentSeq !== undefined ? { currentSeq: fields.currentSeq } : {}),
    ...(fields.eligibility ? { eligibility: fields.eligibility } : {}),
    ...(fields.capability ? { capability: fields.capability } : {}),
    detail: fields.detail,
  }
}

function recordOutcome(
  deps: OfflineEvidenceDeps,
  runtime: HrcRuntimeSnapshot,
  invocationId: string,
  trigger: RetainedEvidenceTrigger,
  outcome: string,
  attempts: number,
  detail: Record<string, unknown>
): RetainedEvidenceOutcomeRecord {
  const outcomeClass = classifyRetainedOutcome(outcome)
  const record = deps.db.retainedEvidenceOutcomes.append({
    runtimeId: runtime.runtimeId,
    invocationId,
    recordedAt: deps.now(),
    outcome,
    outcomeClass: outcomeClass === 'paused' ? 'retryable' : outcomeClass,
    trigger,
    attempts,
    detail: {
      schema: RETAINED_EVIDENCE_OUTCOME_SCHEMA,
      outcome,
      class: outcomeClass,
      trigger,
      attempts,
      readAt: deps.now(),
      ...detail,
    },
  })
  writeServerLog('INFO', 'retained_evidence.outcome', {
    runtimeId: runtime.runtimeId,
    invocationId,
    outcome,
    class: outcomeClass,
    trigger,
    attempts,
  })
  return record
}

/**
 * One retained-evidence recovery attempt (or dry run) for a runtime's current
 * invocation. Refusals that must not become audit rows (worker live, revivable,
 * not a broker runtime) are returned unrecorded.
 */
export async function recoverRetainedEvidence(
  deps: OfflineEvidenceDeps,
  input: RecoverRetainedEvidenceInput
): Promise<CaptureRecoverResponse | undefined> {
  const db = deps.db
  const runtime = db.runtimes.getByRuntimeId(input.runtimeId)
  if (!runtime) return undefined
  const invocationId = targetInvocationId(db, runtime)
  const bound = persistedAspdExecutionRelease(runtime) !== undefined
  const prior = invocationId
    ? db.retainedEvidenceOutcomes.latest(runtime.runtimeId, invocationId)
    : null
  const priorAttempts = prior?.attempts ?? 0
  const projectedNow = invocationId
    ? (db.brokerInvocations.getByInvocationId(invocationId)?.lastProjectedSeq ?? 0)
    : 0

  if (invocationId === undefined) {
    return responseFor(db, runtime, undefined, input.trigger, {
      outcome: 'offline_read_no_invocation',
      recorded: false,
      attempts: 0,
      spawned: false,
      projectedThroughSeq: 0,
      detail: {},
      bound,
    })
  }

  if (input.dryRun) {
    const refusal = await eligibilityRefusal(deps, runtime, invocationId)
    const release = persistedAspdExecutionRelease(runtime)
    const declared = release ? releaseCapabilityDeclared(release.releaseRoot) : undefined
    return responseFor(db, runtime, invocationId, input.trigger, {
      outcome: prior?.outcome ?? 'not_attempted',
      recorded: false,
      attempts: priorAttempts,
      spawned: false,
      projectedThroughSeq: projectedNow,
      detail: prior?.detail ?? {},
      bound,
      dryRun: true,
      eligibility: refusal ? { eligible: false, reason: refusal.outcome } : { eligible: true },
      capability: {
        declared: declared === true,
        ...(release ? { releaseId: release.releaseId } : {}),
      },
    })
  }

  const ownership = acquireRetainedRecoveryOwnership(deps.ownerMap, runtime.runtimeId)
  if (!ownership.acquired) {
    const outcome = 'offline_read_attach_in_flight'
    if (ownership.heldBy === 'attach') {
      recordOutcome(deps, runtime, invocationId, input.trigger, outcome, priorAttempts, {
        heldBy: 'attach',
        requestedAfterSeq: projectedNow,
      })
    }
    return responseFor(db, runtime, invocationId, input.trigger, {
      outcome,
      recorded: ownership.heldBy === 'attach',
      attempts: priorAttempts,
      spawned: false,
      projectedThroughSeq: projectedNow,
      detail: { heldBy: ownership.heldBy },
      bound,
    })
  }

  try {
    // Re-read inside ownership: eligibility is never judged on a stale row.
    const owned = db.runtimes.getByRuntimeId(runtime.runtimeId) ?? runtime
    const refusal = await eligibilityRefusal(deps, owned, invocationId)
    if (refusal) {
      writeServerLog('INFO', 'retained_evidence.refused', {
        runtimeId: owned.runtimeId,
        invocationId,
        outcome: refusal.outcome,
        reason: refusal.reason,
        trigger: input.trigger,
      })
      return responseFor(db, owned, invocationId, input.trigger, {
        outcome: refusal.outcome,
        recorded: false,
        attempts: priorAttempts,
        spawned: false,
        projectedThroughSeq: projectedNow,
        detail: { reason: refusal.reason },
        bound,
      })
    }

    const budget = deps.options?.retryBudget ?? OFFLINE_EVIDENCE_RETRY_BUDGET
    if (input.trigger !== 'operator' && prior !== null) {
      const priorClass = classifyRetainedOutcome(prior.outcome)
      if (priorClass === 'complete' || priorClass === 'disposed' || priorClass === 'paused') {
        return responseFor(db, owned, invocationId, input.trigger, {
          outcome: prior.outcome,
          recorded: false,
          attempts: priorAttempts,
          spawned: false,
          projectedThroughSeq: projectedNow,
          detail: prior.detail,
          bound,
        })
      }
      if (priorClass === 'retryable' && priorAttempts >= budget) {
        const paused = recordOutcome(
          deps,
          owned,
          invocationId,
          input.trigger,
          'paused_needs_disposition',
          priorAttempts,
          { priorOutcome: prior.outcome, requestedAfterSeq: projectedNow }
        )
        return responseFor(db, owned, invocationId, input.trigger, {
          outcome: paused.outcome,
          recorded: true,
          attempts: priorAttempts,
          spawned: false,
          projectedThroughSeq: projectedNow,
          detail: paused.detail,
          bound,
        })
      }
    }

    const attempt = await readAndProject(deps, owned, invocationId, prior)
    const attempts = BUDGET_FREE_OUTCOMES.has(attempt.outcome) ? priorAttempts : priorAttempts + 1
    recordOutcome(deps, owned, invocationId, input.trigger, attempt.outcome, attempts, {
      ...attempt.detail,
      projectedThroughSeq: attempt.projectedThroughSeq,
      ...(attempt.currentSeq !== undefined ? { currentSeq: attempt.currentSeq } : {}),
    })
    return responseFor(db, owned, invocationId, input.trigger, {
      outcome: attempt.outcome,
      recorded: true,
      attempts,
      spawned: attempt.spawned,
      projectedThroughSeq: attempt.projectedThroughSeq,
      ...(attempt.currentSeq !== undefined ? { currentSeq: attempt.currentSeq } : {}),
      detail: attempt.detail,
      bound,
    })
  } finally {
    ownership.release()
  }
}

// ── retention hold (SPEC §4.2) ───────────────────────────────────────────────

const REVIVABLE_STATUSES = new Set(['crashed', 'dead', 'stale', 'detached'])

export type RetainedEvidenceHold = {
  held: boolean
  /** Why: `revivable` status, or the latest outcome (`not_attempted` when none). */
  reason?: string | undefined
  ledgerPath?: string | undefined
}

/**
 * Whether a bound harness-broker runtime's ledger directory is held. The hold
 * ends only on `recovered` or `operator_disposed`; a retry budget never releases
 * evidence. Unbound runtimes get no new hold (U16).
 */
function currentHold(db: HrcDatabase, runtimeId: string): boolean {
  const current = db.runtimes.getByRuntimeId(runtimeId)
  return current ? retainedEvidenceHold(db, current).held : false
}

export function retainedEvidenceHold(
  db: HrcDatabase,
  runtime: HrcRuntimeSnapshot
): RetainedEvidenceHold {
  if (runtime.controllerKind !== 'harness-broker') return { held: false }
  if (persistedAspdExecutionRelease(runtime) === undefined) return { held: false }
  const ledgerPath = persistedEventLedgerPath(runtime)
  if (ledgerPath === undefined) return { held: false }
  if (REVIVABLE_STATUSES.has(runtime.status)) {
    return { held: true, reason: 'revivable', ledgerPath }
  }
  // §4.2 (H1 rev 3): the outcome clause applies in every status. A live, adopted
  // or stopped runtime stays held until each invocation is recovered or disposed;
  // the hold never gates live replay (the retained-projection fence does).
  for (const invocation of db.brokerInvocations.listByRuntimeId(runtime.runtimeId)) {
    const latest = db.retainedEvidenceOutcomes.latest(runtime.runtimeId, invocation.invocationId)
    if (latest === null) return { held: true, reason: 'not_attempted', ledgerPath }
    if (outcomeHoldsEvidence(latest.outcome))
      return { held: true, reason: latest.outcome, ledgerPath }
  }
  return { held: false, ledgerPath }
}

/**
 * Before the sweep may remove an unbound terminal runtime's ledger directory,
 * record why its evidence is unrecoverable by design (U16, D3/D7 ordering).
 * Returns the recorded (or already present) outcome, or undefined when the
 * runtime is not an unbound terminal harness-broker runtime.
 */
export function recordUnboundBeforeSweep(
  db: HrcDatabase,
  runtime: HrcRuntimeSnapshot,
  now: string
): string | undefined {
  if (runtime.controllerKind !== 'harness-broker') return undefined
  if (!ELIGIBLE_STATUSES.has(runtime.status)) return undefined
  if (persistedAspdExecutionRelease(runtime) !== undefined) return undefined
  const outcome = 'offline_reader_unsupported_unbound_release'
  for (const invocation of db.brokerInvocations.listByRuntimeId(runtime.runtimeId)) {
    if (db.retainedEvidenceOutcomes.latest(runtime.runtimeId, invocation.invocationId) !== null) {
      continue
    }
    db.retainedEvidenceOutcomes.append({
      runtimeId: runtime.runtimeId,
      invocationId: invocation.invocationId,
      recordedAt: now,
      outcome,
      outcomeClass: 'unbound',
      trigger: 'startup',
      attempts: 0,
      detail: {
        schema: RETAINED_EVIDENCE_OUTCOME_SCHEMA,
        outcome,
        class: 'unbound',
        trigger: 'startup',
      },
    })
    writeServerLog('INFO', 'retained_evidence.outcome', {
      runtimeId: runtime.runtimeId,
      invocationId: invocation.invocationId,
      outcome,
      class: 'unbound',
      trigger: 'startup',
      attempts: 0,
    })
  }
  return outcome
}

/**
 * Operator disposition (SPEC §4.2): append `operator_disposed` for every held
 * invocation. The caller then applies the ordinary prune in the same transaction.
 */
export function recordOperatorDisposition(
  db: HrcDatabase,
  runtime: HrcRuntimeSnapshot,
  input: { by: string; reason: string; at: string }
): number {
  let recorded = 0
  for (const invocation of db.brokerInvocations.listByRuntimeId(runtime.runtimeId)) {
    const latest = db.retainedEvidenceOutcomes.latest(runtime.runtimeId, invocation.invocationId)
    if (latest !== null && !outcomeHoldsEvidence(latest.outcome)) continue
    const outcome = 'operator_disposed'
    db.retainedEvidenceOutcomes.append({
      runtimeId: runtime.runtimeId,
      invocationId: invocation.invocationId,
      recordedAt: input.at,
      outcome,
      outcomeClass: 'disposed',
      trigger: 'operator',
      attempts: latest?.attempts ?? 0,
      detail: {
        schema: RETAINED_EVIDENCE_OUTCOME_SCHEMA,
        outcome,
        class: 'disposed',
        trigger: 'operator',
        disposition: {
          by: input.by,
          reason: input.reason,
          at: input.at,
          priorOutcome: latest?.outcome ?? 'not_attempted',
        },
      },
    })
    writeServerLog('INFO', 'retained_evidence.outcome', {
      runtimeId: runtime.runtimeId,
      invocationId: invocation.invocationId,
      outcome,
      class: 'disposed',
      trigger: 'operator',
      priorOutcome: latest?.outcome ?? 'not_attempted',
    })
    recorded += 1
  }
  return recorded
}

// ── automatic triggers (SPEC §3.4.3) ────────────────────────────────────────

export const RETAINED_EVIDENCE_PASS_LIMIT = 20
export const RETAINED_EVIDENCE_TERMINAL_DELAY_MS = 1_000

/** Bound terminal runtimes whose evidence is not yet attempted or retryable. */
export function retainedEvidencePassCandidates(
  db: HrcDatabase,
  limit: number
): { runtimeIds: string[]; eligible: number; unboundTerminal: number } {
  const runtimeIds: string[] = []
  let eligible = 0
  let unboundTerminal = 0
  for (const runtime of db.runtimes.listAll()) {
    if (runtime.controllerKind !== 'harness-broker' || !ELIGIBLE_STATUSES.has(runtime.status)) {
      continue
    }
    if (persistedAspdExecutionRelease(runtime) === undefined) {
      unboundTerminal += 1
      continue
    }
    const hold = retainedEvidenceHold(db, runtime)
    if (!hold.held || hold.ledgerPath === undefined) continue
    const retryable =
      hold.reason === 'not_attempted' ||
      (hold.reason !== undefined && classifyRetainedOutcome(hold.reason) === 'retryable')
    if (!retryable || !existsSync(dirname(hold.ledgerPath))) continue
    eligible += 1
    if (runtimeIds.length < limit) runtimeIds.push(runtime.runtimeId)
  }
  return { runtimeIds, eligible, unboundTerminal }
}
