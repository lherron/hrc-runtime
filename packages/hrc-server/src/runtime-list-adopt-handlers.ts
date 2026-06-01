import {
  HrcBadRequestError,
  HrcConflictError,
  HrcErrorCode,
  HrcInternalError,
  HrcNotFoundError,
} from 'hrc-core'
import type { HrcLaunchRecord } from 'hrc-core'
import { getBrokerRuntimeTmuxSocketPath } from './broker-decisions.js'
import { appendHrcEvent } from './hrc-event-helper.js'
import type { HrcServerInstanceForHandlers } from './server-instance-context.js'
import {
  isRecord,
  parseJsonBody,
  parseListRunsFilter,
  parseListRuntimesFilter,
} from './server-parsers.js'
import { json, timestamp } from './server-util.js'
import { reassociateBrokerTmuxLease } from './startup-reconcile.js'
import { filterRuntimes } from './sweep-helpers.js'

export async function handleListRuntimes(
  this: HrcServerInstanceForHandlers,
  url: URL
): Promise<Response> {
  const filter = parseListRuntimesFilter(url)
  const runtimes = filter.hostSessionId
    ? this.db.runtimes.listByHostSessionId(filter.hostSessionId)
    : this.db.runtimes.listAll()
  const reconciled = await Promise.all(
    runtimes.map((runtime) => this.reconcileTmuxRuntimeLiveness(runtime))
  )
  return json(filterRuntimes(reconciled, filter))
}

export function handleListRuns(this: HrcServerInstanceForHandlers, url: URL): Response {
  const filter = parseListRunsFilter(url)
  return json(this.db.runs.listRuns(filter))
}

export function handleListLaunches(this: HrcServerInstanceForHandlers, url: URL): Response {
  const hostSessionId = url.searchParams.get('hostSessionId') ?? undefined
  const runtimeId = url.searchParams.get('runtimeId') ?? undefined
  let launches: HrcLaunchRecord[]
  if (runtimeId) {
    launches = this.db.launches.listByRuntimeId(runtimeId)
  } else if (hostSessionId) {
    launches = this.db.launches.listByHostSessionId(hostSessionId)
  } else {
    launches = this.db.launches.listAll()
  }
  return json(launches)
}

export async function handleAdoptRuntime(
  this: HrcServerInstanceForHandlers,
  request: Request
): Promise<Response> {
  const body = await parseJsonBody(request)
  if (!isRecord(body) || typeof body['runtimeId'] !== 'string') {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'runtimeId is required')
  }
  const runtimeId = body['runtimeId'] as string
  const runtime = this.db.runtimes.getByRuntimeId(runtimeId)
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
  const updated = this.db.runtimes.update(runtimeId, {
    adopted: true,
    status: 'adopted',
    updatedAt: timestamp(),
  })
  if (!updated) {
    throw new HrcInternalError(`failed to adopt runtime ${runtimeId}`)
  }
  const session = this.db.sessions.getByHostSessionId(runtime.hostSessionId)
  if (session) {
    const event = appendHrcEvent(this.db, 'runtime.adopted', {
      ts: timestamp(),
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      runtimeId,
    })
    this.notifyEvent(event)
  }
  return json(updated)
}

export const runtimeListAdoptHandlersMethods = {
  handleListRuntimes,
  handleListRuns,
  handleListLaunches,
  handleAdoptRuntime,
}

export type RuntimeListAdoptHandlersMethods = typeof runtimeListAdoptHandlersMethods
