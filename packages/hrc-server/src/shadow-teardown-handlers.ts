/**
 * Shadow teardown: retire seats this node is running for scopes it does not
 * home (T-07650).
 *
 * The authority filter stops this node ACQUIRING new obligations for a foreign
 * scope. It does not stop the seat that is already there. On lab, a host session
 * created 2026-07-20 — legitimately, when lab could still home the scope —
 * survived the rebind to max3 and kept minting runtimes: fifteen between
 * 00:56Z and 01:38Z on the night this was found, eighteen presentation receipts
 * written into the global collaboration ledger, and zero readers (its whole life
 * holds two turns, both from July). svc's equivalent was worse because it
 * worked: a live shadow read and answered four rulings addressed to a seat on
 * max3, and the ledger cannot tell that ack from the addressee's own, because
 * both speak under the same scope.
 *
 * So the rule is keyed on the node's authority NOW, never on how the session
 * came to exist: a host session on a node that does not currently home its
 * scope is a shadow, whatever it was when it was created. A rule phrased
 * "sessions minted for foreign-homed scopes" matches neither specimen.
 *
 * WHY THIS IS NOT IN THE KICKER. Ruled on T-07650: no delivery mechanism evicts
 * a live seat. Eviction is a lifecycle decision and it belongs on a lifecycle
 * timer, where it is visible, disable-able, and cannot be reached by a message
 * arriving. The kicker asks the same question through the same resolver and
 * does nothing but decline.
 *
 * IT ACTS ONLY ON POSITIVE EVIDENCE. An unreachable registry, an unbound scope
 * and a retired one all resolve to "not foreign" and nothing is terminated. The
 * cost of a false positive here is killing a seat that was doing its job.
 */

import type { HrcRuntimeSnapshot } from 'hrc-core'
import { isRuntimeUnavailableStatus } from './require-helpers.js'

import { isSingleNodeMode } from './federation/federation-config.js'
import { homeAuthorityDeps, resolveForeignHome } from './federation/home-authority.js'
import type { HrcServerInstanceForHandlers } from './server-instance-context.js'
import { writeServerLog } from './server-log.js'

/**
 * Its own cadence, deliberately slower than delivery. A shadow is a standing
 * condition, not an event: it appears at a rebind and persists until something
 * retires it, so a minute of latency costs nothing and a tighter loop would put
 * a terminate path behind a timer that fires while turns are starting.
 */
const SHADOW_TEARDOWN_INTERVAL_MS = 60_000
const SHADOW_TEARDOWN_ENABLED_ENV = 'HRC_SHADOW_TEARDOWN_ENABLED'

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Live seats only: a stale or terminated row is already retired. */
function liveRuntimes(server: HrcServerInstanceForHandlers): HrcRuntimeSnapshot[] {
  return server.db.runtimes
    .listAll()
    .filter((runtime) => runtime.status !== 'exited' && !isRuntimeUnavailableStatus(runtime.status))
}

export function startForeignHomeShadowTeardown(this: HrcServerInstanceForHandlers): void {
  // Nothing can be foreign where there is no other node. `federationRegistryClient`
  // is NOT the test for that: a single-node daemon still resolves one, an
  // always-throwing stub whose every consult would be a log line. The peer set
  // is the honest predicate.
  const config = this.options.federationConfig
  if (config === undefined || isSingleNodeMode(config)) return
  if (this.federationRegistryClient === undefined) return
  if (process.env[SHADOW_TEARDOWN_ENABLED_ENV] === '0') return
  if (this.shadowTeardownTimer !== undefined) return
  // NOT run at startup, deliberately. At boot the runtimes table still describes
  // the world as it was before the restart, and `reconcileStartupState` is what
  // decides which of those rows still have a process behind them. A destructive
  // sweep that ran first would be reading liveness that has not been re-checked
  // yet — and a shadow is a standing condition, so waiting one interval costs
  // nothing.
  this.shadowTeardownTimer = setInterval(() => {
    void this.runForeignHomeShadowTeardown()
  }, SHADOW_TEARDOWN_INTERVAL_MS)
  this.shadowTeardownTimer.unref?.()
}

/**
 * One pass. Enumerates from the runtimes table rather than from any seat's own
 * account of itself — svc reported one runtime for a scope that had six, which
 * is why the rule is "start from the enumeration" (T-07650). Grouping is by
 * HOST SESSION because a runtime id churns mid-session: one svc shadow cycled
 * five ids in five weeks, three of them in one evening.
 */
export async function runForeignHomeShadowTeardown(
  this: HrcServerInstanceForHandlers
): Promise<void> {
  if (this.shadowTeardownInFlight !== undefined) return this.shadowTeardownInFlight
  if (this.stopping) return

  const pass = (async () => {
    const deps = homeAuthorityDeps(this, (scopeRef, error) => {
      writeServerLog('WARN', 'federation.shadow_teardown.home_consult_failed', {
        scopeRef,
        error: errorText(error),
      })
    })

    const bySession = new Map<string, HrcRuntimeSnapshot[]>()
    for (const runtime of liveRuntimes(this)) {
      bySession.set(runtime.hostSessionId, [
        ...(bySession.get(runtime.hostSessionId) ?? []),
        runtime,
      ])
    }

    let scanned = 0
    let shadowSessions = 0
    let terminated = 0
    let failed = 0
    for (const [hostSessionId, runtimes] of bySession) {
      if (this.stopping) break
      scanned += 1
      const scopeRef = runtimes[0]?.scopeRef
      if (scopeRef === undefined) continue
      const foreign = await resolveForeignHome(deps, scopeRef)
      if (foreign === undefined) continue

      shadowSessions += 1
      const retired: string[] = []
      for (const runtime of runtimes) {
        try {
          await this.terminateRuntime(runtime, {
            reason: `${scopeRef} is homed on ${foreign.homeNodeId} (epoch ${foreign.placementEpoch}); this node holds no authority to seat it`,
            source: 'federation.shadow_teardown',
          })
          retired.push(runtime.runtimeId)
          terminated += 1
        } catch (error) {
          failed += 1
          writeServerLog('WARN', 'federation.shadow_teardown.failed', {
            scopeRef,
            hostSessionId,
            runtimeId: runtime.runtimeId,
            status: runtime.status,
            error: errorText(error),
          })
        }
      }
      if (retired.length === 0) continue
      // One line per host session, naming what was killed and what it was
      // doing: a `busy` shadow is the dangerous specimen, and the record has to
      // show that this is what stopped it.
      writeServerLog('INFO', 'federation.shadow_teardown.retired', {
        scopeRef,
        hostSessionId,
        homeNodeId: foreign.homeNodeId,
        placementEpoch: foreign.placementEpoch,
        source: foreign.source,
        runtimeIds: retired,
        statuses: runtimes.map((runtime) => runtime.status),
      })
    }

    // Every tick, changed or not: a healthy timer and a dead timer must not
    // look identical from the log. Matches the retention and lease-gc siblings.
    writeServerLog('INFO', 'federation.shadow_teardown.complete', {
      localNodeId: this.federationNodeId,
      scannedHostSessions: scanned,
      shadowSessions,
      terminated,
      failed,
    })
  })().finally(() => {
    if (this.shadowTeardownInFlight === pass) this.shadowTeardownInFlight = undefined
  })

  this.shadowTeardownInFlight = pass
  return pass
}

export const shadowTeardownHandlersMethods = {
  startForeignHomeShadowTeardown,
  runForeignHomeShadowTeardown,
}

export type ShadowTeardownHandlersMethods = typeof shadowTeardownHandlersMethods
