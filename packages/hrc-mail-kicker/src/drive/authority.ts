/**
 * The runtime a presentation receipt must name: the host session's CURRENT
 * seat, not the oldest row it ever had (T-07650 mechanism A).
 *
 * The previous expression was `listByHostSessionId(...).find(r => r.status !==
 * 'exited')`. That query is `ORDER BY created_at ASC`, and `'exited'` is an
 * `HrcBrokerInvocationState`, never a runtime status — no stored row has ever
 * held it, so the predicate excluded nothing and the expression was `[0]`: the
 * FIRST runtime the host session ever had, whatever became of it. A receipt
 * therefore named a five-week-old row while the turn ran on the current one, in
 * proportion to how long the session had lived and not to anything being wrong.
 * The audits found it fleet-wide with zero true corpses behind it — max3 60/60,
 * svc 38/38, every one resolving to a live host session.
 *
 * Newest-first, skipping the unavailable states, and pinned to the SESSION'S
 * GENERATION so a prior-generation runtime left `ready` after a rotation can
 * never be named (T-07650, on Lance's max3 specimen: gen 27 `ready` since
 * 17:00Z took a message meant for gen 50). No current-generation seat means NO
 * runtimeId on the receipt: a receipt with no runtime is honest and already has
 * its own line in the audit, while a receipt naming the wrong one is not
 * recoverable after the fact.
 */
export function presentationRuntimeIdFor(
  server: MailKickerContext,
  session: HrcSessionRecord
): string | undefined {
  const runtimes = server.db.runtimes.listByHostSessionId(session.hostSessionId)
  for (let index = runtimes.length - 1; index >= 0; index -= 1) {
    const runtime = runtimes[index]
    if (runtime === undefined) continue
    if (runtime.generation !== session.generation) continue
    if (runtime.status === 'exited' || isRuntimeUnavailableStatus(runtime.status)) continue
    return runtime.runtimeId
  }
  return undefined
}

/**
 * Finish a drive attempt that threw, instead of merely annotating it.
 *
 * `recordError` ANNOTATES; it does not finish, and a `claimed` attempt owns its
 * scope's drive slot for as long as the row exists. A catch that only annotates
 * therefore makes the target permanently undrivable by this daemon, silently —
 * the hazard the missing-intent branch already names in `driveMailTargetOnce`,
 * reached through a different door. Both generic catches were that door
 * (T-07653); this is their single exit.
 *
 * A `started` attempt is the one case that is NOT finished here, and it is not
 * an exception to the rule. It PROVED a dispatch: the turn is before the
 * harness, the run row exists, and `observeAttempt` closes the attempt from the
 * run's terminal event with the round accounting `completeStartedAttempt` owes
 * the presented envelopes. Finishing it here would release a slot the live turn
 * still holds and re-present those envelopes under a NEW attempt id, which is a
 * duplicate delivery rather than a repair. A run that ends without ever
 * reaching a terminal state is the ACTIVE-RUN RECONCILER's to terminalize
 * (`sweep-reconcile.ts`), not the kicker's — the kicker only reads that row.
 */
export function failDriveAfterThrow(
  server: MailKickerContext,
  attempt: HrcMailDriveAttempt,
  message: string
): HrcMailDriveAttemptState {
  const current = server.db.mailDrives.getAttempt(attempt.driveAttemptId) ?? attempt
  return current.state === 'started'
    ? server.db.mailDrives.recordError(current.driveAttemptId, message).state
    : server.db.mailDrives.failWithoutStart(current.driveAttemptId, message).state
}

/** The scope behind a drive target, or nothing when the ref is unparseable. */
export function kickerScopeRefFor(targetSessionRef: string): string | undefined {
  try {
    return parseSessionRef(targetSessionRef).scopeRef
  } catch {
    return undefined
  }
}

/**
 * Skip a foreign-homed target: ONE positive line per scope per epoch.
 *
 * Two things happen here and both matter. The line is written once — a skip
 * repeated every tick is the same noise this fixes, wearing a calmer verb — and
 * any still-CLAIMED attempt is FINISHED rather than left annotated.
 * `recordError` alone leaves an attempt `claimed`, and a claimed attempt owns
 * the scope's drive slot forever, which is how twelve dead rows accumulated on
 * lab and kept re-entering `listInFlightTargets()` hours after the rebind. A
 * `started` attempt is left alone: it proved a dispatch, and its terminal event
 * is what closes it.
 *
 * Stale local RUNTIMES are deliberately NOT torn down here. Evicting a live
 * seat is an operator retirement decision (the retirement primitive enumerates the scope's live
 * runtime ids at revoke time), never a delivery mechanism's; a routing verdict
 * must not kill a session an operator may be attached to. Nor is the exclusion
 * pushed into `listLiveSessionRefs()`: that query lives in hrc-store-sqlite,
 * which has neither this node's identity nor a registry client, and it would
 * still leave `listInFlightTargets()` unfiltered. One filter, at the one place
 * both candidate sources converge.
 */
export function skipForeignHomedTarget(
  server: MailKickerContext,
  targetSessionRef: string,
  scopeRef: string,
  foreign: ForeignHome,
  wakeReason: HrcMailDriveWakeReason
): void {
  const activeAttempt = server.db.mailDrives.getActiveAttempt(targetSessionRef)
  const resolvedAttemptId = server.db.mailDrives.markForeignHomeResolution(
    targetSessionRef,
    `${scopeRef} is homed on ${foreign.homeNodeId}; this node has no authority to drive it`,
    activeAttempt?.state === 'claimed' ? activeAttempt.driveAttemptId : undefined
  )?.driveAttemptId
  server.mailKickerBirthSweepBackoff.delete(targetSessionRef)

  // Announcement is deduped on its OWN map, not on the resolver's memo. The
  // memo is shared with the shadow teardown, and whichever mechanism happened
  // to resolve the scope first would otherwise silence this line for the other.
  const announcement = foreign.homeNodeId
  const alreadyAnnounced = server.mailKickerForeignHomeAnnounced.get(scopeRef) === announcement
  server.mailKickerForeignHomeAnnounced.set(scopeRef, announcement)
  if (alreadyAnnounced && resolvedAttemptId === undefined) return

  server.log('INFO', 'wrkq.kicker.foreign_home_skipped', {
    targetSessionRef,
    scopeRef,
    homeNodeId: foreign.homeNodeId,
    source: foreign.source,
    wakeReason,
    ...(resolvedAttemptId === undefined ? {} : { resolvedAttemptId }),
  })
}

/**
 * A gate refusal that is a BIRTH DEFERRAL rather than a drive failure (T-07655).
 *
 * Two reasons qualify, and both mean the same thing operationally: this node
 * takes no part in the birth, and there is nothing wrong with it or with the
 * mail. Before this existed they fell into the generic catch and printed
 * `drive_failed`, which is how three nodes racing for one birth looked like
 * three broken drives.
 */
type BirthDeferral = {
  reason:
    | 'birth-designated-elsewhere'
    | 'designated-home-unreachable'
    | 'birth-designation-mismatch'
  homeNodeId: string
  designationEpoch: number
  birthEnvelopeId: string
  senderScopeRef: string
  provenance: string
}

export function birthDeferralFor(error: unknown): BirthDeferral | undefined {
  if (!(error instanceof HrcDomainError)) return undefined
  const reason = error.detail['reason']
  if (
    reason !== 'birth-designated-elsewhere' &&
    reason !== 'designated-home-unreachable' &&
    reason !== 'birth-designation-mismatch'
  ) {
    return undefined
  }
  const designation = error.detail['birthDesignation']
  if (!isRecord(designation)) return undefined
  const homeNodeId = designation['homeNodeId']
  const designationEpoch = designation['designationEpoch']
  const birthEnvelopeId = designation['birthEnvelopeId']
  const senderScopeRef = designation['senderScopeRef']
  const provenance = designation['provenance']
  if (
    typeof homeNodeId !== 'string' ||
    typeof designationEpoch !== 'number' ||
    typeof birthEnvelopeId !== 'string' ||
    typeof senderScopeRef !== 'string' ||
    typeof provenance !== 'string'
  ) {
    return undefined
  }
  return { reason, homeNodeId, designationEpoch, birthEnvelopeId, senderScopeRef, provenance }
}

/**
 * Finish a deferred attempt and say so ONCE per scope per designation epoch.
 *
 * The attempt must be FINISHED, not merely annotated: a claimed attempt owns
 * the scope's drive slot, and a scope this node will never birth would hold its
 * own slot forever (the T-07653 invariant, and the same trap
 * `placement_unresolvable` documents above).
 */
export function deferBirthForTarget(
  server: MailKickerContext,
  targetSessionRef: string,
  scopeRef: string,
  attempt: HrcMailDriveAttempt,
  deferral: BirthDeferral,
  wakeReason: HrcMailDriveWakeReason
): void {
  const resolvedAttemptId = server.db.mailDrives.markForeignHomeResolution(
    targetSessionRef,
    `${scopeRef} is designated to be born on ${deferral.homeNodeId}; this node takes no part in the birth`,
    attempt.driveAttemptId
  )?.driveAttemptId
  server.mailKickerBirthSweepBackoff.delete(targetSessionRef)

  const announcement = `${deferral.homeNodeId}@${deferral.designationEpoch}`
  const alreadyAnnounced = server.mailKickerBirthDeferredAnnounced.get(scopeRef) === announcement
  server.mailKickerBirthDeferredAnnounced.set(scopeRef, announcement)
  if (alreadyAnnounced) return

  server.log('INFO', 'wrkq.kicker.birth_deferred', {
    targetSessionRef,
    scopeRef,
    birthEnvelopeId: deferral.birthEnvelopeId,
    senderScopeRef: deferral.senderScopeRef,
    homeNodeId: deferral.homeNodeId,
    provenance: deferral.provenance,
    designationEpoch: deferral.designationEpoch,
    reason: deferral.reason,
    wakeReason,
    ...(resolvedAttemptId === undefined ? {} : { resolvedAttemptId }),
  })
}
import { HrcDomainError } from 'hrc-core'
import type { HrcSessionRecord } from 'hrc-core'
import type {
  HrcMailDriveAttempt,
  HrcMailDriveAttemptState,
  HrcMailDriveWakeReason,
} from 'hrc-store-sqlite'

import type { MailKickerContext } from '../context.js'
import type { ForeignHome } from '../contracts.js'
import { isRecord, isRuntimeUnavailableStatus, parseSessionRef } from '../internal.js'
