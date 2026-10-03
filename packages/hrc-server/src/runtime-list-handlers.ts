import { HrcBadRequestError, HrcErrorCode } from 'hrc-core'
import type { HrcRuntimeSnapshot } from 'hrc-core'
import type { HrcDatabase } from 'hrc-store-sqlite'
import { parseListRunsFilter, parseListRuntimesFilter } from './server-parsers.js'
import type { ExactRouteHandler } from './server-types.js'
import { json } from './server-util.js'
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

export type RuntimeListDependencies = {
  readonly db: HrcDatabase
  readonly staleGenerationThresholdSec: number
  reconcileTmuxRuntimeLiveness(runtime: HrcRuntimeSnapshot): Promise<HrcRuntimeSnapshot>
}

export type RuntimeListRoute = {
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
  deps: RuntimeListDependencies,
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
  deps: RuntimeListDependencies,
  url: URL
): Promise<HrcRuntimeSnapshot[]> {
  return (
    await queryRuntimesForProjection(deps, url, {
      paginate: false,
      includeTerminalByDefault: true,
    })
  ).runtimes
}

async function handleListRuntimes(deps: RuntimeListDependencies, url: URL): Promise<Response> {
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

function handleListRuns(deps: RuntimeListDependencies, url: URL): Response {
  const filter = parseListRunsFilter(url)
  return json(deps.db.runs.listRuns(filter))
}

export function createRuntimeListRoutes(deps: RuntimeListDependencies): RuntimeListRoute[] {
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
  ]
}
