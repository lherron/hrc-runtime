import { HrcBadRequestError, HrcErrorCode } from 'hrc-core'
import type {
  BirthDesignationRecord,
  ListLiveSeatRefsResponse,
  ListPlacementBindingsResponse,
  ListUnbornDesignationsResponse,
} from 'hrc-core'
import { createPlacementLedgerRepository } from 'hrc-store-sqlite'

import type { HrcServerInstanceForHandlers } from './server-instance-context.js'
import { writeServerLog } from './server-log.js'
import { json } from './server-util.js'

/**
 * Injector placement + federation surface (T-08609).
 *
 * Three enumeration reads the extracted kicker needs every tick / catch-up /
 * retry. All read-only; all return committed rows, never projections.
 */

/** `GET /v1/runtimes/live-refs` — narrow per-seat identity rows, no ledger page. */
export async function handleListLiveSeatRefs(
  this: HrcServerInstanceForHandlers
): Promise<Response> {
  return json({
    refs: this.db.runtimes.listLiveSessionRefRows(),
  } satisfies ListLiveSeatRefsResponse)
}

/**
 * `GET /v1/placement/bindings?home=self&state=active` — locally homed active
 * bindings, the cold-start catch-up enumeration. Only this query is served:
 * anything else is a caller error, not a broader read.
 */
export async function handleListPlacementBindings(
  this: HrcServerInstanceForHandlers,
  _request: Request,
  url: URL
): Promise<Response> {
  if (url.searchParams.get('home') !== 'self' || url.searchParams.get('state') !== 'active') {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'only home=self&state=active is served by this route',
      { field: 'home' }
    )
  }
  const localNodeId = this.federationNodeId
  let bindings: ListPlacementBindingsResponse['bindings'] = []
  try {
    bindings = createPlacementLedgerRepository(this.db.sqlite)
      .list()
      .filter((record) => record.state === 'active' && record.homeNodeId === localNodeId)
      .map((record) => ({
        scopeRef: record.scopeRef,
        homeNodeId: record.homeNodeId,
        state: record.state,
      }))
  } catch {
    // A pre-federation database has no placement table. Nothing bound here is
    // an honest answer, matching the skew scan's treatment (locate-server.ts).
    bindings = []
  }
  return json({ localNodeId, bindings } satisfies ListPlacementBindingsResponse)
}

/**
 * `GET /v1/federation/designations?unborn=true` — wraps
 * `registry.listUnbornDesignations(nodeId)`. Mirrors the in-process sweep's
 * contract: no registry means no designations, and an unreachable registry is
 * a reason to retry, never an error that widens the local half.
 */
export async function handleListUnbornDesignations(
  this: HrcServerInstanceForHandlers,
  _request: Request,
  url: URL
): Promise<Response> {
  if (url.searchParams.get('unborn') !== 'true') {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'only unborn=true is served by this route',
      { field: 'unborn' }
    )
  }
  const localNodeId = this.federationNodeId
  const registry = this.federationRegistryClient
  if (registry?.listUnbornDesignations === undefined) {
    return json({ localNodeId, designations: [] } satisfies ListUnbornDesignationsResponse)
  }
  let designations: BirthDesignationRecord[]
  try {
    designations = await registry.listUnbornDesignations(localNodeId)
  } catch (error) {
    writeServerLog('WARN', 'federation.unborn_designations_failed', {
      nodeId: localNodeId,
      error: error instanceof Error ? error.message : String(error),
    })
    return json({ localNodeId, designations: [] } satisfies ListUnbornDesignationsResponse)
  }
  return json({ localNodeId, designations } satisfies ListUnbornDesignationsResponse)
}

export const placementFederationHandlersMethods = {
  handleListLiveSeatRefs,
  handleListPlacementBindings,
  handleListUnbornDesignations,
}

export type PlacementFederationHandlersMethods = typeof placementFederationHandlersMethods
