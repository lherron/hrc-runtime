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
import { canOperatorAttach, parseBrokerRuntimeHostingState } from './broker/runtime-hosting.js'
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

const DEFAULT_RUNTIME_LIST_LIMIT = 100
const MAX_RUNTIME_LIST_LIMIT = 500
const NEXT_CURSOR_HEADER = 'x-hrc-next-cursor'
const TERMINAL_RUNTIME_STATUSES = new Set([
  'archived',
  'crashed',
  'dead',
  'disposed',
  'exited',
  'failed',
  'stale',
  'stopped',
  'terminal',
  'terminated',
])

export type RuntimeListAdoptDependencies = {
  readonly db: HrcDatabase
  readonly staleGenerationThresholdSec: number
  reconcileTmuxRuntimeLiveness(runtime: HrcRuntimeSnapshot): Promise<HrcRuntimeSnapshot>
  notifyEvent(event: HrcEventEnvelope | HrcLifecycleEvent): void
}

export type RuntimeListAdoptRoute = {
  method: 'GET' | 'POST'
  pathname: string
  handler: ExactRouteHandler
}

type RuntimeListPage = {
  runtimes: HrcRuntimeSnapshot[]
  nextCursor?: string | undefined
}

type RuntimeCursor = {
  statusRank: number
  createdAt: string
  runtimeId: string
}

function runtimeStatusRank(runtime: HrcRuntimeSnapshot, statuses: string[] | undefined): number {
  if (statuses === undefined) return 0
  const rank = statuses.indexOf(runtime.status)
  return rank === -1 ? statuses.length : rank
}

function compareRuntimeToCursor(
  runtime: HrcRuntimeSnapshot,
  cursor: RuntimeCursor,
  statuses: string[] | undefined
): number {
  const statusRank = runtimeStatusRank(runtime, statuses)
  if (statusRank !== cursor.statusRank) return statusRank - cursor.statusRank
  const createdAt = runtime.createdAt.localeCompare(cursor.createdAt)
  if (createdAt !== 0) return createdAt
  return runtime.runtimeId.localeCompare(cursor.runtimeId)
}

function compareRuntimes(
  left: HrcRuntimeSnapshot,
  right: HrcRuntimeSnapshot,
  statuses: string[] | undefined
): number {
  const leftRank = runtimeStatusRank(left, statuses)
  const rightRank = runtimeStatusRank(right, statuses)
  if (leftRank !== rightRank) return leftRank - rightRank
  const createdAt = left.createdAt.localeCompare(right.createdAt)
  if (createdAt !== 0) return createdAt
  return left.runtimeId.localeCompare(right.runtimeId)
}

function encodeRuntimeCursor(runtime: HrcRuntimeSnapshot, statuses: string[] | undefined): string {
  return Buffer.from(
    JSON.stringify({
      statusRank: runtimeStatusRank(runtime, statuses),
      createdAt: runtime.createdAt,
      runtimeId: runtime.runtimeId,
    } satisfies RuntimeCursor)
  ).toString('base64url')
}

function parseRuntimeCursor(raw: string | undefined): RuntimeCursor | undefined {
  if (raw === undefined) return undefined

  try {
    const value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown
    if (
      typeof value !== 'object' ||
      value === null ||
      typeof (value as Partial<RuntimeCursor>).statusRank !== 'number' ||
      !Number.isInteger((value as Partial<RuntimeCursor>).statusRank) ||
      ((value as Partial<RuntimeCursor>).statusRank as number) < 0 ||
      typeof (value as Partial<RuntimeCursor>).createdAt !== 'string' ||
      typeof (value as Partial<RuntimeCursor>).runtimeId !== 'string'
    ) {
      throw new Error('invalid cursor payload')
    }
    return value as RuntimeCursor
  } catch {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'cursor must be a runtime-list cursor returned by the server',
      { field: 'cursor' }
    )
  }
}

function isVisibleInDefaultRuntimeList(runtime: HrcRuntimeSnapshot): boolean {
  return !TERMINAL_RUNTIME_STATUSES.has(runtime.status)
}

async function queryRuntimesForProjection(
  deps: RuntimeListAdoptDependencies,
  url: URL,
  options: {
    paginate: boolean
    includeTerminalByDefault: boolean
  }
): Promise<RuntimeListPage> {
  const parsedFilter = parseListRuntimesFilter(url)
  const filter =
    options.includeTerminalByDefault && parsedFilter.all === undefined
      ? { ...parsedFilter, all: true }
      : parsedFilter
  const runtimes = filter.hostSessionId
    ? deps.db.runtimes.listByHostSessionId(filter.hostSessionId)
    : deps.db.runtimes.listAll()
  const visible = filter.all === true ? runtimes : runtimes.filter(isVisibleInDefaultRuntimeList)
  const filtered = filterRuntimes(visible, filter, deps.staleGenerationThresholdSec * 1000).sort(
    (left, right) => compareRuntimes(left, right, filter.status)
  )

  const cursor = options.paginate ? parseRuntimeCursor(filter.cursor) : undefined
  const afterCursor =
    cursor === undefined
      ? filtered
      : filtered.filter((runtime) => compareRuntimeToCursor(runtime, cursor, filter.status) > 0)

  let selected = afterCursor
  let nextCursor: string | undefined
  if (options.paginate) {
    const limit = filter.limit ?? DEFAULT_RUNTIME_LIST_LIMIT
    if (limit < 1 || limit > MAX_RUNTIME_LIST_LIMIT) {
      throw new HrcBadRequestError(
        HrcErrorCode.MALFORMED_REQUEST,
        `limit must be between 1 and ${MAX_RUNTIME_LIST_LIMIT}`,
        { field: 'limit', value: limit }
      )
    }
    selected = afterCursor.slice(0, limit)
    if (afterCursor.length > selected.length) {
      nextCursor = encodeRuntimeCursor(
        selected[selected.length - 1] as HrcRuntimeSnapshot,
        filter.status
      )
    }
  }

  const reconciled = await Promise.all(
    selected.map((runtime) => deps.reconcileTmuxRuntimeLiveness(runtime))
  )
  const reconciledVisible =
    filter.all === true ? reconciled : reconciled.filter(isVisibleInDefaultRuntimeList)
  const projected = filterRuntimes(
    reconciledVisible,
    filter,
    deps.staleGenerationThresholdSec * 1000
  ).sort((left, right) => compareRuntimes(left, right, filter.status))

  return {
    runtimes: projectRuntimeHealth(deps.db, projected),
    ...(nextCursor !== undefined ? { nextCursor } : {}),
  }
}

/**
 * T-07235 — attach the `first_turn_missing` health detail so a fleet glance
 * (`hrc runtime list`) finds a runtime whose first turn never arrived, and
 * carries the trip event id that `hrc runtime diagnostics` consumes. This is a
 * PROJECTION, never persisted state: runtime status deliberately stays live
 * (the trip is observe-only), so health is the only place the finding shows.
 * One indexed read for the whole page.
 */
function projectRuntimeHealth(
  db: HrcDatabase,
  runtimes: HrcRuntimeSnapshot[]
): HrcRuntimeSnapshot[] {
  if (runtimes.length === 0) return runtimes
  const trips = db.firstTurnWatch.listLatestTripByRuntime()
  if (trips.size === 0) return runtimes
  return runtimes.map((runtime) => {
    const trip = trips.get(runtime.runtimeId)
    if (
      trip === undefined ||
      trip.firstTurnMissingTrippedAt === undefined ||
      trip.tripEventSeq === undefined
    ) {
      return runtime
    }
    return {
      ...runtime,
      health: {
        firstTurnMissing: {
          trippedAt: trip.firstTurnMissingTrippedAt,
          tripEventSeq: trip.tripEventSeq,
          generation: trip.generation,
          bundleAvailable: trip.bundleDir !== undefined,
          retrieval: `hrc runtime diagnostics ${trip.tripEventSeq}`,
        },
      },
    }
  })
}

export async function listRuntimesForProjection(
  deps: RuntimeListAdoptDependencies,
  url: URL
): Promise<HrcRuntimeSnapshot[]> {
  return (
    await queryRuntimesForProjection(deps, url, {
      paginate: false,
      includeTerminalByDefault: true,
    })
  ).runtimes
}

async function handleListRuntimes(deps: RuntimeListAdoptDependencies, url: URL): Promise<Response> {
  const page = await queryRuntimesForProjection(deps, url, {
    paginate: true,
    includeTerminalByDefault: false,
  })
  const response = json(page.runtimes)
  if (page.nextCursor !== undefined) {
    response.headers.set(NEXT_CURSOR_HEADER, page.nextCursor)
  }
  return response
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
  deps: RuntimeListAdoptDependencies & { readonly runtimeRoot: string },
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
  if (runtime.transport !== 'tmux' && !canOperatorAttach(runtime)) {
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
  if (runtime.controllerKind === 'harness-broker' && runtime.transport === 'tmux') {
    // T-01873: read the leased-tmux substrate socket from the runtime-hosting
    // choke point (decorative — surfaced only in the not-adoptable error).
    const hosting = parseBrokerRuntimeHostingState(runtime)
    const leaseSocketPath =
      hosting?.substrate.kind === 'leased-tmux' ? hosting.substrate.tmuxSocketPath : undefined
    const leaseLive = await reassociateBrokerTmuxLease(runtime, deps.runtimeRoot)
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
  const now = timestamp()
  const updated = deps.db.runtimes.update(runtimeId, {
    adopted: true,
    status: 'adopted',
    statusChangedAt: now,
    updatedAt: now,
  })
  if (!updated) {
    throw new HrcInternalError(`failed to adopt runtime ${runtimeId}`)
  }
  const session = deps.db.sessions.getByHostSessionId(runtime.hostSessionId)
  if (session) {
    const event = appendHrcEvent(deps.db, 'runtime.adopted', {
      ts: now,
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
  deps: RuntimeListAdoptDependencies & { readonly runtimeRoot: string }
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
