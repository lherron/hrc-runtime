/**
 * Read-only retrieval for `first_turn_missing` trips + bundles (T-07235).
 *
 * The bundle must be reachable without opening sqlite or knowing the
 * filesystem layout, so this is the canonical retrieval path behind
 * `hrc runtime diagnostics`. It never mutates anything and never re-probes a
 * runtime: a trip is durable history, and reading it must stay cheap.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { HrcErrorCode, HrcNotFoundError } from 'hrc-core'
import type {
  GetFirstTurnDiagnosticsResponse,
  HrcFirstTurnDiagnosticsTrip,
  HrcFirstTurnMissingBundle,
  HrcFirstTurnWatchRecord,
  ListFirstTurnDiagnosticsResponse,
} from 'hrc-core'
import type { HrcDatabase } from 'hrc-store-sqlite'

import { json } from './server-util.js'

const DEFAULT_TRIP_LIST_LIMIT = 50

export function toDiagnosticsTrip(watch: HrcFirstTurnWatchRecord): HrcFirstTurnDiagnosticsTrip {
  return {
    tripEventSeq: watch.tripEventSeq ?? 0,
    runtimeId: watch.runtimeId,
    generation: watch.generation,
    scopeRef: watch.scopeRef,
    laneRef: watch.laneRef,
    hostSessionId: watch.hostSessionId,
    ...(watch.runId !== undefined ? { runId: watch.runId } : {}),
    ...(watch.invocationId !== undefined ? { invocationId: watch.invocationId } : {}),
    ...(watch.primingDispatchedAt !== undefined
      ? { primingDispatchedAt: watch.primingDispatchedAt }
      : {}),
    ...(watch.firstTurnDeadlineAt !== undefined
      ? { firstTurnDeadlineAt: watch.firstTurnDeadlineAt }
      : {}),
    trippedAt: watch.firstTurnMissingTrippedAt ?? '',
    ...(watch.bundleDir !== undefined ? { bundleDir: watch.bundleDir } : {}),
    bundleAvailable: watch.bundleDir !== undefined,
  }
}

export async function handleFirstTurnDiagnostics(db: HrcDatabase, url: URL): Promise<Response> {
  const tripRaw = url.searchParams.get('trip')
  const runtimeId = url.searchParams.get('runtimeId') ?? undefined

  if (tripRaw !== null && tripRaw.trim() !== '') {
    const tripEventSeq = Number.parseInt(tripRaw.trim(), 10)
    const watch = Number.isFinite(tripEventSeq)
      ? db.firstTurnWatch.getByTripEventSeq(tripEventSeq)
      : null
    if (watch === null) {
      throw new HrcNotFoundError(
        HrcErrorCode.UNKNOWN_RUNTIME,
        `no first_turn_missing trip with event id ${tripRaw}`,
        { trip: tripRaw }
      )
    }
    const trip = toDiagnosticsTrip(watch)
    const loaded = await loadBundle(watch.bundleDir)
    return json({
      ok: true,
      trip,
      ...(loaded.bundle !== undefined ? { bundle: loaded.bundle } : {}),
      ...(loaded.error !== undefined ? { bundleError: loaded.error } : {}),
    } satisfies GetFirstTurnDiagnosticsResponse)
  }

  const trips = (
    runtimeId !== undefined
      ? db.firstTurnWatch.listTripsByRuntimeId(runtimeId)
      : db.firstTurnWatch.listTrips(DEFAULT_TRIP_LIST_LIMIT)
  ).map(toDiagnosticsTrip)

  return json({ ok: true, trips } satisfies ListFirstTurnDiagnosticsResponse)
}

async function loadBundle(
  bundleDir: string | undefined
): Promise<{ bundle?: HrcFirstTurnMissingBundle | undefined; error?: string | undefined }> {
  if (bundleDir === undefined) {
    // A trip is complete without its bundle: a missing bundle degrades
    // diagnosis, never detection.
    return { error: 'no_bundle_recorded' }
  }
  try {
    const raw = await readFile(join(bundleDir, 'manifest.json'), 'utf8')
    return { bundle: JSON.parse(raw) as HrcFirstTurnMissingBundle }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}
