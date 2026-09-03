import { createPlacementLedgerRepository } from 'hrc-store-sqlite'

import type { MailKickerContext } from '../context.js'
import { LEDGER_SWEEP_SCOPE_BATCH } from '../internal.js'
import { targetSessionRefForLedgerScope } from '../ledger/scope.js'
import type { WrkqEnvelope } from '../ledger/types.js'

export function chunk<T>(values: readonly T[], size: number): T[][] {
  const batches: T[][] = []
  for (let index = 0; index < values.length; index += size) {
    batches.push(values.slice(index, index + size))
  }
  return batches
}

/** The drive targets a `pendingView` page names, added to an existing set. */
export function collectPendingTargets(items: readonly WrkqEnvelope[], targets: Set<string>): void {
  for (const envelope of items) {
    const scopeRef = envelope.to?.scopeRef
    if (scopeRef === undefined) continue
    const sessionRef = targetSessionRefForLedgerScope(scopeRef)
    if (sessionRef !== undefined) targets.add(sessionRef)
  }
}

/**
 * Every scope this node HOMES, seated or not.
 *
 * The placement ledger is the daemon's own record of the bindings it holds
 * authority for, so it is the only local answer to "which addressees are mine"
 * that does not require a live seat. It is read here rather than kept on the
 * instance because the catch-up runs once per process and a stale snapshot
 * would be worse than a query.
 *
 * A scope no node has ever homed has no row anywhere, and is not this node's to
 * deliver to: an envelope to one still rides the tail's `envelope.created` into
 * the summon gate, which is where a first birth belongs.
 */
function homedTargetSessionRefs(server: MailKickerContext): string[] {
  const refs = new Set<string>()
  for (const record of createPlacementLedgerRepository(server.db.sqlite).list()) {
    if (record.state !== 'active') continue
    if (record.homeNodeId !== server.nodeId) continue
    const sessionRef = targetSessionRefForLedgerScope(record.scopeRef)
    if (sessionRef !== undefined) refs.add(sessionRef)
  }
  return [...refs]
}

/**
 * The one-time cold-start catch-up (T-07643).
 *
 * A first-ever start persists its cursor at the ledger's END — replaying the
 * whole log would re-drive every historical envelope — and the periodic sweep
 * only looks at seated scopes. So on that one start, an envelope that was
 * ALREADY pending against a scope this node homes but is not currently seating
 * is invisible to both halves of the wake routing, and nothing ever delivers
 * it. It stays `pending` with an empty `presentedTo` indefinitely: not dead,
 * not floored, not logged. That is what happened on svc and lab at the T-07616
 * flag day, where an envelope was rescued only because unrelated later traffic
 * to the same scope swept it up.
 *
 * The fix is one widened sweep, run once, over the placement-ledger scopes this
 * node homes. It is not the periodic sweep's job: the sweep runs every thirty
 * ticks forever, and a query that grows with every scope the daemon has ever
 * bound is a load problem when it is not a one-off.
 *
 * THROWS on a ledger failure, deliberately. A catch-up that silently did not
 * happen is the same silent gap it exists to close, so the caller keeps the
 * intent armed and retries on the next tick instead.
 *
 * It DISCOVERS; it does not deliver. Each target is handed to the ordinary wake
 * path and the catch-up returns, because awaiting a cold summon per target
 * would hold the tail — the one-second wake path — for as long as the slowest
 * birth on the node takes.
 */
export async function runMailKickerColdStartCatchup(server: MailKickerContext): Promise<void> {
  const homed = homedTargetSessionRefs(server)
  const targets = new Set<string>()
  for (const batch of chunk(homed, LEDGER_SWEEP_SCOPE_BATCH)) {
    const view = await server.ledger.pendingView({ scopes: batch, includeFyi: true })
    if (view.repended > 0) {
      server.log('INFO', 'wrkq.kicker.deferrals_repended', { repended: view.repended })
    }
    collectPendingTargets(view.items, targets)
  }
  server.log('INFO', 'wrkq.kicker.cold_start_catchup', {
    homedScopes: homed.length,
    targets: [...targets],
  })
  for (const targetSessionRef of targets) {
    server.wake(targetSessionRef, 'recovery')
  }
}
