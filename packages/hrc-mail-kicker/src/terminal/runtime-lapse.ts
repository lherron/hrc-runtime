/**
 * rev 5.1 D3 — a runtime that terminated holding an obligation fails it.
 *
 * The predicate is *R is no longer live*, read off the runtime STATUS column;
 * the four terminal event kinds are only the wake. That distinction is the
 * whole of D3's robustness: `terminated`, `crashed`, `dead` and `stale` are
 * written by four different mechanisms (user exit, abnormal broker terminal,
 * the reaper twice over), and a rule keyed on one event name would silently
 * miss the other three.
 *
 * Returns whether the observation COMPLETED, so a caller can memoize a runtime
 * as swept without memoizing a ledger outage as an answer.
 */
import type { MailKickerContext } from '../context.js'
import { isRuntimeTerminal } from '../drive/attempt-lifecycle.js'
import { LAPSE_SWEEP_LOOKBACK_MS, errorText } from '../internal.js'
import { WrkqLedgerUnavailableError } from '../ledger/client.js'
import { newestPresentationReceipt } from '../ledger/types.js'
import type { WrkqEnvelopePendingView } from '../ledger/types.js'
import { failEnvelopeWithAudit } from './envelope-terminal.js'

export async function failLapsedObligations(
  server: MailKickerContext,
  targetSessionRef: string,
  runtimeIds: ReadonlySet<string>
): Promise<boolean> {
  let view: WrkqEnvelopePendingView
  try {
    view = await server.ledger.pendingView({ scopes: [targetSessionRef], includeFyi: true })
  } catch (error) {
    server.log(
      error instanceof WrkqLedgerUnavailableError ? 'WARN' : 'ERROR',
      'wrkq.kicker.lapse_pending_view_failed',
      { targetSessionRef, error: errorText(error) }
    )
    return false
  }
  let complete = true
  for (const envelope of view.items) {
    if (envelope.state !== 'presented') continue
    const runtime = newestPresentationReceipt(envelope)?.runtimeId
    if (runtime === undefined || !runtimeIds.has(runtime)) continue
    try {
      await failEnvelopeWithAudit(server, {
        envelope: envelope.id,
        reason: 'runtime_terminated',
        runtime,
        targetSessionRef,
        callSite: 'lapsed_obligations',
      })
    } catch (error) {
      server.log('WARN', 'wrkq.kicker.lapse_failed', {
        targetSessionRef,
        envelope: envelope.id,
        runtimeId: runtime,
        error: errorText(error),
      })
      complete = false
    }
  }
  return complete
}

/**
 * The D3 backstop: every locally-known runtime that has since gone terminal.
 *
 * The wake path below catches the ordinary case within a second of the event.
 * This exists because a wake is a claim and a status column is a fact — a
 * daemon that was down when the runtime died, a reaper reclassification that
 * fanned out no event, a `--force` restart that orphaned a broker: none of
 * those reach the observer, and all of them leave the same row behind.
 *
 * Memoized per runtime per process. Nothing can be presented TO a dead runtime,
 * so one complete observation per runtime is the whole job; a restart re-scans
 * the lookback window, and the ledger's own idempotence absorbs the overlap.
 */
export async function sweepLapsedObligations(server: MailKickerContext): Promise<void> {
  const since = new Date(Date.now() - LAPSE_SWEEP_LOOKBACK_MS).toISOString()
  const byTarget = new Map<string, Set<string>>()
  for (const bound of server.db.mailDrives.listRuntimeBoundTargets(since)) {
    if (server.mailKickerLapsedRuntimes.has(bound.runtimeId)) continue
    const runtime = server.db.runtimes.getByRuntimeId(bound.runtimeId) ?? undefined
    if (runtime === undefined || !isRuntimeTerminal(runtime.status)) continue
    const runtimes = byTarget.get(bound.targetSessionRef) ?? new Set<string>()
    runtimes.add(bound.runtimeId)
    byTarget.set(bound.targetSessionRef, runtimes)
  }
  for (const [targetSessionRef, runtimeIds] of byTarget) {
    if (await failLapsedObligations(server, targetSessionRef, runtimeIds)) {
      for (const runtimeId of runtimeIds) server.mailKickerLapsedRuntimes.add(runtimeId)
    }
  }
}

/**
 * §5 — hand this scope the failure notices it is owed, as a sender.
 *
 * fyi-class: rendered from the ledger row, carrying no envelope and creating no
 * obligation. It rides the scope's LIVE GENERATION and nothing else — no live
 * seat means the notices simply stay queued for the next attend, because a
 * failure notice must never be the reason a session is born. That is why the
 * gate is `presentationRuntimeIdFor` (a current-generation seat) rather than
 * "a session row exists": a session whose runtime is gone would otherwise have
 * a dispatch provision one.
 */
