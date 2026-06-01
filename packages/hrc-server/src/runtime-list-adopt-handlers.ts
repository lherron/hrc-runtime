import {
  HrcBadRequestError,
  HrcConflictError,
  HrcErrorCode,
  HrcInternalError,
  HrcNotFoundError,
} from 'hrc-core'
import type {
  HrcEventEnvelope,
  HrcLaunchRecord,
  HrcLifecycleEvent,
  HrcRuntimeSnapshot,
} from 'hrc-core'
import type { HrcDatabase } from 'hrc-store-sqlite'
import { getBrokerRuntimeTmuxSocketPath } from './broker-decisions.js'
import { appendHrcEvent } from './hrc-event-helper.js'
import {
  isRecord,
  parseJsonBody,
  parseListRunsFilter,
  parseListRuntimesFilter,
} from './server-parsers.js'
import type { ExactRouteHandler } from './server-types.js'
import { json, timestamp } from './server-util.js'
import { reassociateBrokerTmuxLease } from './startup-reconcile.js'
import { filterRuntimes } from './sweep-helpers.js'

export type RuntimeListAdoptDependencies = {
  readonly db: HrcDatabase
  reconcileTmuxRuntimeLiveness(runtime: HrcRuntimeSnapshot): Promise<HrcRuntimeSnapshot>
  notifyEvent(event: HrcEventEnvelope | HrcLifecycleEvent): void
}

export type RuntimeListAdoptRoute = {
  method: 'GET' | 'POST'
  pathname: string
  handler: ExactRouteHandler
}

async function handleListRuntimes(deps: RuntimeListAdoptDependencies, url: URL): Promise<Response> {
  const filter = parseListRuntimesFilter(url)
  const runtimes = filter.hostSessionId
    ? deps.db.runtimes.listByHostSessionId(filter.hostSessionId)
    : deps.db.runtimes.listAll()
  const reconciled = await Promise.all(
    runtimes.map((runtime) => deps.reconcileTmuxRuntimeLiveness(runtime))
  )
  return json(filterRuntimes(reconciled, filter))
}

function handleListRuns(deps: RuntimeListAdoptDependencies, url: URL): Response {
  const filter = parseListRunsFilter(url)
  return json(deps.db.runs.listRuns(filter))
}

function handleListLaunches(deps: RuntimeListAdoptDependencies, url: URL): Response {
  const hostSessionId = url.searchParams.get('hostSessionId') ?? undefined
  const runtimeId = url.searchParams.get('runtimeId') ?? undefined
  let launches: HrcLaunchRecord[]
  if (runtimeId) {
    launches = deps.db.launches.listByRuntimeId(runtimeId)
  } else if (hostSessionId) {
    launches = deps.db.launches.listByHostSessionId(hostSessionId)
  } else {
    launches = deps.db.launches.listAll()
  }
  return json(launches)
}

async function handleAdoptRuntime(
  deps: RuntimeListAdoptDependencies,
  request: Request
): Promise<Response> {
  const body = await parseJsonBody(request)
  if (!isRecord(body) || typeof body['runtimeId'] !== 'string') {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'runtimeId is required')
  }
  const runtimeId = body['runtimeId'] as string
  const runtime = deps.db.runtimes.getByRuntimeId(runtimeId)
  if (!runtime) {
    throw new HrcNotFoundError(HrcErrorCode.UNKNOWN_RUNTIME, `unknown runtime: ${runtimeId}`)
  }
  if (runtime.transport !== 'tmux') {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'cannot adopt a non-tmux runtime: no attachable pane/process exists',
      {
        runtimeId,
        transport: runtime.transport,
      }
    )
  }
  if (runtime.status !== 'dead' && runtime.status !== 'stale') {
    throw new HrcConflictError(
      HrcErrorCode.CONFLICT,
      `runtime ${runtimeId} is not adoptable (status: ${runtime.status})`,
      {
        runtimeId,
        status: runtime.status,
      }
    )
  }
  if (runtime.adopted) {
    return json(runtime)
  }
  // T-01738 F-V5: a broker-tmux runtime's pane lives on a per-runtime lease
  // server. Adopting one whose lease is dead (or whose live ids no longer
  // match the persisted pane) would mark it `adopted` while pointing a later
  // turn at a pane that does not exist. Verify lease liveness first.
  if (runtime.controllerKind === 'harness-broker') {
    const leaseSocketPath = getBrokerRuntimeTmuxSocketPath(runtime)
    const leaseLive = await reassociateBrokerTmuxLease(runtime)
    if (!leaseLive) {
      throw new HrcConflictError(
        HrcErrorCode.CONFLICT,
        `runtime ${runtimeId} cannot be adopted: its broker-tmux lease is not live${
          leaseSocketPath ? ` (socket ${leaseSocketPath})` : ''
        }`,
        {
          runtimeId,
          status: runtime.status,
          ...(leaseSocketPath ? { leaseSocketPath } : {}),
        }
      )
    }
  }
  const updated = deps.db.runtimes.update(runtimeId, {
    adopted: true,
    status: 'adopted',
    updatedAt: timestamp(),
  })
  if (!updated) {
    throw new HrcInternalError(`failed to adopt runtime ${runtimeId}`)
  }
  const session = deps.db.sessions.getByHostSessionId(runtime.hostSessionId)
  if (session) {
    const event = appendHrcEvent(deps.db, 'runtime.adopted', {
      ts: timestamp(),
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      runtimeId,
    })
    deps.notifyEvent(event)
  }
  return json(updated)
}

export function createRuntimeListAdoptRoutes(
  deps: RuntimeListAdoptDependencies
): RuntimeListAdoptRoute[] {
  return [
    {
      method: 'GET',
      pathname: '/v1/runs',
      handler: (_request, url) => handleListRuns(deps, url),
    },
    {
      method: 'GET',
      pathname: '/v1/runtimes',
      handler: (_request, url) => handleListRuntimes(deps, url),
    },
    {
      method: 'GET',
      pathname: '/v1/launches',
      handler: (_request, url) => handleListLaunches(deps, url),
    },
    {
      method: 'POST',
      pathname: '/v1/runtimes/adopt',
      handler: (request) => handleAdoptRuntime(deps, request),
    },
  ]
}
