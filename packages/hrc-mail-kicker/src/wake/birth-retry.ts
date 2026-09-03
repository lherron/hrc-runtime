/**
 * The VIRGIN BIRTHS this node owes, as sweep candidates (T-07661).
 *
 * THE GAP. The kicker's two wake sources both need the scope to exist already.
 * The ledger tail is an INSERT wake consumed once — after it, the cursor is
 * past that `envelope.created` forever — and the sweep's candidate sources are
 * the scopes this node seats and the attempts it holds. A virgin scope whose
 * one insert wake ended in a refusal (a registry 503, a designated home that
 * was momentarily unreachable, a capability failure, or the wire-enum bug that
 * actually produced T-07658) is in none of them, so nothing ever tried again.
 * The obligation stayed visible in the ledger the whole time — nothing was
 * lost — but delivery waited on unrelated traffic arriving. On T-07658 that
 * took 21 minutes and a daemon restart.
 *
 * TWO SOURCES, because the designation has two classes and they are discovered
 * from opposite ends:
 *
 *  - DESIGNATED. The registry host holds a live designation naming this node,
 *    for a scope it has never established. That is the collective's own record
 *    of a birth this node owes, and it is authoritative: a node asks only about
 *    ITSELF, so this can never make a non-designated node claim a scope. It
 *    also covers the case no local record can — a designated node that never
 *    saw the insert at all, because it was down when the wake fired.
 *
 *  - `none` CLASS. A sender that names no scope (a human) designates NOTHING,
 *    and tier 5 stays local on every node — the pre-T-07655 law, explicitly out
 *    of that task's scope. There is no designation row to read, so the only
 *    record is this node's own refused drive attempt.
 *
 * WHAT IT MUST NOT DO is re-introduce the multi-node birth race. It does not:
 * the designated source is scoped to the asking node by the host, and the
 * `none` source only re-attempts what this node already attempted once from the
 * insert wake — the same already-arbitrated tier-5 CAS, at a sixtieth of the
 * rate. Scopes this node has been told are designated ELSEWHERE are dropped
 * here rather than re-driven into a deferral it has already announced, and the
 * T-07650 foreign-home filter still runs ahead of every claim regardless.
 *
 * A ledger or registry failure yields the candidates it could resolve and logs;
 * it never takes the ordinary sweep down with it.
 */
import { createPlacementLedgerRepository } from 'hrc-store-sqlite'

import type { MailKickerContext } from '../context.js'
import type { KickerRegistryConsultResult } from '../contracts.js'
import { kickerScopeRefFor } from '../drive/authority.js'
import { BIRTH_SWEEP_BACKOFF_BASE_MS, BIRTH_SWEEP_MAX_REFUSALS, errorText } from '../internal.js'
import { targetSessionRefForLedgerScope } from '../ledger/scope.js'
import { failEnvelopeWithAudit } from '../terminal/envelope-terminal.js'

export async function unbornBirthWakeCandidates(
  server: MailKickerContext,
  seated: readonly string[]
): Promise<string[]> {
  const seatedSet = new Set(seated)
  const candidates = new Set<string>()

  for (const targetSessionRef of await designatedUnbornTargets(server)) {
    if (!seatedSet.has(targetSessionRef)) candidates.add(targetSessionRef)
  }
  for (const targetSessionRef of refusedBirthTargets(server)) {
    if (!seatedSet.has(targetSessionRef)) candidates.add(targetSessionRef)
  }

  // A scope that has left the candidate set has been born (or bound elsewhere),
  // so its retry bound is spent state. Pruned here rather than on the birth
  // itself because this is the one place that sees the whole set.
  for (const targetSessionRef of server.mailKickerBirthSweepBackoff.keys()) {
    if (!candidates.has(targetSessionRef)) {
      server.mailKickerBirthSweepBackoff.delete(targetSessionRef)
    }
  }

  const now = Date.now()
  return [...candidates].filter(
    (targetSessionRef) =>
      (server.mailKickerBirthSweepBackoff.get(targetSessionRef)?.nextAtMs ?? 0) <= now
  )
}

/** Live designations naming this node whose scope the registry has never bound. */
async function designatedUnbornTargets(server: MailKickerContext): Promise<string[]> {
  const list = server.registry?.listUnbornDesignations
  if (list === undefined) return []
  let designations: readonly { scopeRef: string }[]
  try {
    designations = await list.call(server.registry, server.nodeId)
  } catch (error) {
    // An unreachable registry is not evidence that this node owes no births.
    // It is a reason to try again on the next sweep, and never a reason to
    // widen the local half to compensate.
    server.log('WARN', 'wrkq.kicker.unborn_designations_failed', {
      nodeId: server.nodeId,
      error: errorText(error),
    })
    return []
  }
  const targets: string[] = []
  for (const designation of designations) {
    const sessionRef = targetSessionRefForLedgerScope(designation.scopeRef)
    if (sessionRef !== undefined) targets.push(sessionRef)
  }
  return targets
}
/**
 * Scopes this node refused a birth for, from its own drive-attempt rows.
 *
 * Filtered against the two records that say the scope is no longer this node's
 * to birth: a local placement-ledger row (it was established, here or by a
 * rebind onto here) and a birth deferral this node has already announced (the
 * collective designated it elsewhere, and re-driving it would buy one more
 * refusal per sweep and nothing else).
 */
function refusedBirthTargets(server: MailKickerContext): string[] {
  const ledger = createPlacementLedgerRepository(server.db.sqlite)
  const targets: string[] = []
  for (const targetSessionRef of server.db.mailDrives.listRefusedBirthTargets()) {
    const scopeRef = kickerScopeRefFor(targetSessionRef)
    if (scopeRef === undefined) continue
    if (ledger.get(scopeRef) !== undefined) continue
    if (server.mailKickerBirthDeferredAnnounced.has(scopeRef)) continue
    targets.push(targetSessionRef)
  }
  return targets
}

/**
 * Charge one retry after a periodic drive ACTUALLY attempted a birth and the
 * summon path refused it, and give up on the fifth (rev 5.1 D7).
 *
 * Candidacy is not evidence of a refusal. In particular, a target that this
 * node resolves as foreign-home is pruned without spending anybody else's D7
 * budget. The drive returns this outcome only when `ensureTargetSession` was
 * entered, did not establish a session, and left a failed/null-host attempt.
 *
 * Under rev 4 the bound FLATTENED at five and retried forever at sixteen-minute
 * intervals. rev 5.1 ends it instead: the fifth refusal fails every pending
 * envelope for that target `undeliverable` and tells the sender, which is a
 * decision someone can act on rather than a spin nobody is watching.
 */
export async function chargeBirthSweepRefusal(
  server: MailKickerContext,
  targetSessionRef: string,
  driveAttemptId: string
): Promise<void> {
  const now = Date.now()
  const attempts = (server.mailKickerBirthSweepBackoff.get(targetSessionRef)?.attempts ?? 0) + 1
  if (attempts >= BIRTH_SWEEP_MAX_REFUSALS) {
    try {
      const terminal = await failUndeliverableMail(
        server,
        targetSessionRef,
        driveAttemptId,
        attempts
      )
      if (terminal) {
        server.mailKickerBirthSweepBackoff.delete(targetSessionRef)
      } else {
        server.mailKickerBirthSweepBackoff.set(targetSessionRef, {
          attempts: BIRTH_SWEEP_MAX_REFUSALS - 1,
          nextAtMs: now + BIRTH_SWEEP_BACKOFF_BASE_MS * 2 ** (attempts - 1),
        })
      }
    } catch (error) {
      server.mailKickerBirthSweepBackoff.set(targetSessionRef, {
        attempts: BIRTH_SWEEP_MAX_REFUSALS - 1,
        nextAtMs: now + BIRTH_SWEEP_BACKOFF_BASE_MS * 2 ** (attempts - 1),
      })
      server.log('WARN', 'wrkq.kicker.undeliverable_failed', {
        targetSessionRef,
        error: errorText(error),
      })
    }
    return
  }
  server.mailKickerBirthSweepBackoff.set(targetSessionRef, {
    attempts,
    nextAtMs: now + BIRTH_SWEEP_BACKOFF_BASE_MS * 2 ** (attempts - 1),
  })
  server.log('INFO', 'wrkq.kicker.unborn_birth_retry', {
    targetSessionRef,
    attempt: attempts,
    nextAttemptInMs: BIRTH_SWEEP_BACKOFF_BASE_MS * 2 ** (attempts - 1),
  })
}

/**
 * rev 5.1 D7 — this node cannot seat the addressee, and has stopped trying.
 *
 * The registry is re-consulted here even though the drive has already run. D7
 * is destructive authority, so a stale candidate or a binding committed during
 * the failed birth must not let this node terminate another home's mail.
 *
 * Only a `pending` envelope is failed: `undeliverable` means the body was never
 * pushed at all, and wrkqd enforces that on its side too. Anything already
 * presented belongs to D3/D5 and is not this bound's to end.
 */
async function failUndeliverableMail(
  server: MailKickerContext,
  targetSessionRef: string,
  driveAttemptId: string,
  refusals: number
): Promise<boolean> {
  const scopeRef = kickerScopeRefFor(targetSessionRef)
  const registry = server.registry
  if (registry !== undefined) {
    if (scopeRef === undefined) {
      server.log('WARN', 'wrkq.kicker.undeliverable_home_unresolved', {
        targetSessionRef,
        reason: 'target session ref has no parseable scope',
      })
      return false
    }
    let authority: KickerRegistryConsultResult
    try {
      authority = await registry.consult(scopeRef)
    } catch (error) {
      server.log('WARN', 'wrkq.kicker.undeliverable_home_consult_failed', {
        targetSessionRef,
        scopeRef,
        error: errorText(error),
      })
      return false
    }
    if (authority.outcome === 'bound' && authority.binding.homeNodeId !== server.nodeId) {
      const homeNodeId = authority.binding.homeNodeId
      server.foreignHomeMemo.set(scopeRef, { homeNodeId, source: 'registry' })
      const resolvedAttemptId = server.db.mailDrives.markForeignHomeResolution(
        targetSessionRef,
        `${scopeRef} is homed on ${homeNodeId}; this node has no authority to fail its mail`,
        driveAttemptId
      )?.driveAttemptId
      server.log('INFO', 'wrkq.kicker.undeliverable_skipped_foreign_home', {
        targetSessionRef,
        scopeRef,
        homeNodeId,
        refusals,
        ...(resolvedAttemptId === undefined ? {} : { resolvedAttemptId }),
      })
      return true
    }
  }

  const view = await server.ledger.pendingView({ scopes: [targetSessionRef] })
  for (const envelope of view.items) {
    if (envelope.state !== 'pending') continue
    if (envelope.presentedTo.length > 0) continue
    server.log('WARN', 'wrkq.kicker.birth_refusals_exhausted', {
      targetSessionRef,
      envelope: envelope.id,
      refusals,
    })
    await failEnvelopeWithAudit(server, {
      envelope: envelope.id,
      reason: 'undeliverable',
      targetSessionRef,
      callSite: 'birth_refusals_exhausted',
    })
  }
  return true
}
