/**
 * The periodic sweep: the correctness backstop behind the ledger tail.
 *
 * Its candidate set is deliberately NARROW — the scopes this node is currently
 * seating, plus any drive attempt still in flight. It keeps one bounded
 * `pendingView` per sweep instead of a query that grows with every scope the
 * daemon has ever seen. Discovering a scope with no live seat is the TAIL's
 * job: it resumes from a persisted cursor, so an envelope written while HRC was
 * down is replayed rather than swept for.
 *
 * That division of labour holds for a RESTART and ONLY for a restart. A
 * first-ever start has no cursor to resume from and the tail starts at the
 * ledger's END, so nothing here and nothing there can see an envelope that was
 * already pending — the seated set does not contain the scope, and the tail has
 * jumped past its `envelope.created`. The one-time cold-start catch-up below
 * (`runMailKickerColdStartCatchup`, T-07643) closes exactly that case; this
 * comment previously asserted a backstop that did not exist in it.
 *
 * The candidate set gained a THIRD source in T-07661: the virgin births this
 * node owes. Both of the sources above key on a scope this node already HAS —
 * a seat or an attempt — and a virgin scope whose one insert wake ended in a
 * refusal has neither, so it had no second chance at all until unrelated later
 * traffic re-woke the kicker. See `unbornBirthWakeCandidates`.
 */
import type { MailKickerContext } from '../context.js'
import { reportBootReconcileOnce, reportStalledDeliveries } from '../diagnostics/stranded.js'
import { LEDGER_SWEEP_SCOPE_BATCH, errorText } from '../internal.js'
import { WrkqLedgerUnavailableError } from '../ledger/client.js'
import { sweepLapsedObligations } from '../terminal/runtime-lapse.js'
import { unbornBirthWakeCandidates } from './birth-retry.js'
import { chunk, collectPendingTargets } from './cold-start.js'

export function runMailKickerSweep(this: MailKickerContext): Promise<void> {
  if (!this.enabled || this.stopping) return Promise.resolve()
  if (this.mailKickerSweepInFlight !== undefined) return this.mailKickerSweepInFlight

  const sweep = (async () => {
    // T-07964 §4: one boot report, on the first periodic sweep rather than at
    // `start()`, so runtime reattachment and the broker's warmup have already
    // happened and the runs it names are the ones that really did survive.
    await reportBootReconcileOnce(this)
    // Every sweep, but at most one line per attempt per process: a wedge does
    // not clear on its own, so a seat that stalls between boots must not stay
    // silent until the next one.
    await reportStalledDeliveries(this).catch((error: unknown) => {
      this.log('WARN', 'wrkq.kicker.stalled_delivery_check_failed', { error: errorText(error) })
    })
    // rev 5.1 D3 backstop. Ahead of the delivery sweep on purpose: an
    // obligation that has already lapsed should be failed before the same tick
    // reads the wake set, so the sender's notice and the reader's next
    // presentation cannot cross.
    await sweepLapsedObligations(this)
    const now = new Date().toISOString()
    const targets = new Set<string>(this.db.mailDrives.listInFlightTargets())
    // Two rev 5.1 candidate sources that key on nothing in the ledger: a due
    // D4 reminder, and a §5 notice waiting for its sender's next attend.
    // Neither shows up as pending mail, so without these a scope whose only
    // outstanding business is one of them is never woken at all.
    for (const target of this.db.mailDrives.listDueReminderTargets(now)) targets.add(target)
    for (const target of this.db.mailDrives.listFailureNoticeTargets()) targets.add(target)
    const seated = this.db.runtimes.listLiveSessionRefs()
    const unborn = await unbornBirthWakeCandidates(this, seated)
    for (const batch of chunk([...seated, ...unborn], LEDGER_SWEEP_SCOPE_BATCH)) {
      try {
        // includeFyi here too: a seated addressee should be shown a fyi on the
        // next sweep, which is §5's "otherwise on X's next attend".
        const view = await this.ledger.pendingView({ scopes: batch, includeFyi: true })
        if (view.repended > 0) {
          this.log('INFO', 'wrkq.kicker.deferrals_repended', { repended: view.repended })
        }
        collectPendingTargets(view.items, targets)
      } catch (error) {
        this.log(
          error instanceof WrkqLedgerUnavailableError ? 'WARN' : 'ERROR',
          'wrkq.kicker.sweep_pending_view_failed',
          { scopes: batch.length, error: errorText(error) }
        )
        break
      }
    }
    for (const targetSessionRef of targets) {
      this.mailKickerPendingTargets.set(targetSessionRef, 'periodic')
    }
    await Promise.all([...targets].map((targetSessionRef) => this.drainTarget(targetSessionRef)))
  })().finally(() => {
    if (this.mailKickerSweepInFlight === sweep) this.mailKickerSweepInFlight = undefined
  })
  this.mailKickerSweepInFlight = sweep
  return sweep
}
