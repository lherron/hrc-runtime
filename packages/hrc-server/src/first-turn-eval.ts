import { createHash } from 'node:crypto'
/**
 * `first_turn_missing` detection + trip (T-07235).
 *
 * A dedicated armed-row evaluation pass. It reuses the sweep infrastructure's
 * fencing but runs on its OWN timer: the 300s zombie-sweep cadence cannot honor
 * a 120s deadline. The scan is an indexed read over the handful of armed rows
 * plus a single-row transactional stamp on trip — no broker I/O, no per-runtime
 * probes — so the added cadence is negligible, and one runtime's failure never
 * stops the pass.
 *
 * Detection contract, stated honestly: a trip is recorded no earlier than the
 * deadline and no later than deadline + the evaluation interval.
 */
import {
  HRC_FIRST_TURN_MISSING_BUNDLE_ARTIFACT_KIND,
  HRC_FIRST_TURN_MISSING_DIAGNOSTICS_EVENT,
  HRC_FIRST_TURN_MISSING_EVENT,
  HrcErrorCode,
  type HrcFirstTurnWatchRecord,
} from 'hrc-core'

import { type FirstTurnBundleDeps, assembleFirstTurnBundle } from './first-turn-bundle.js'
import { FIRST_TURN_BUNDLE_BUDGET_MS } from './first-turn-watch.js'
import { appendHrcEvent } from './hrc-event-helper.js'
import type { HrcServerInstanceForHandlers } from './server-instance-context.js'
import { writeServerLog } from './server-log.js'
import { timestamp } from './server-util.js'

export type FirstTurnEvalSummary = {
  scanned: number
  tripped: number
  errors: number
}

/** The canonical retrieval path, threaded into the event and every waiter error. */
export function firstTurnDiagnosticsHint(tripEventSeq: number): string {
  return `hrc runtime diagnostics ${tripEventSeq}`
}

/**
 * Step 1 of the trip, and the ONLY step that must be durable before anything
 * else happens: the reason-coded fact, the watch stamp, and the armed run's
 * terminal state, all in ONE transaction. Diagnostic I/O comes later and can
 * never delay, block, or rewrite this record.
 *
 * Returns the trip event (already durable) or null when the row was no longer
 * armed — a late `turn.started` or a concurrent pass wins the race and this
 * generation is simply not tripped.
 */
function recordTrip(
  server: HrcServerInstanceForHandlers,
  watch: HrcFirstTurnWatchRecord
): { hrcSeq: number; event: ReturnType<typeof appendHrcEvent> } | null {
  const trippedAt = timestamp()
  const commit = server.db.sqlite.transaction(() => {
    const event = appendHrcEvent(server.db, HRC_FIRST_TURN_MISSING_EVENT, {
      ts: trippedAt,
      hostSessionId: watch.hostSessionId,
      scopeRef: watch.scopeRef,
      laneRef: watch.laneRef,
      generation: watch.generation,
      runtimeId: watch.runtimeId,
      ...(watch.runId !== undefined ? { runId: watch.runId } : {}),
      errorCode: HrcErrorCode.FIRST_TURN_MISSING,
      payload: {
        runtimeId: watch.runtimeId,
        generation: watch.generation,
        scopeRef: watch.scopeRef,
        hostSessionId: watch.hostSessionId,
        ...(watch.runId !== undefined ? { runId: watch.runId } : {}),
        ...(watch.invocationId !== undefined ? { invocationId: watch.invocationId } : {}),
        ...(watch.primingDispatchedAt !== undefined
          ? { primingDispatchedAt: watch.primingDispatchedAt }
          : {}),
        ...(watch.firstTurnDeadlineAt !== undefined
          ? { firstTurnDeadlineAt: watch.firstTurnDeadlineAt }
          : {}),
        trippedAt,
      },
    })

    const stamped = server.db.firstTurnWatch.markTripped(
      watch.runtimeId,
      watch.generation,
      trippedAt,
      event.hrcSeq
    )
    if (!stamped) {
      // Lost the race (a late turn.started, a disarm, or a concurrent pass).
      // Abort so the event never outlives the stamp it belongs to.
      throw new FirstTurnTripRaceLost()
    }

    // Run-terminal stamp rides the SAME transaction: every waiter observes the
    // step-1 fact instead of timing out privately, and the run's terminal
    // answer to its caller is decided exactly once.
    if (watch.runId !== undefined) {
      const run = server.db.runs.getByRunId(watch.runId)
      if (run !== null && run.completedAt === undefined) {
        server.db.runs.markCompleted(watch.runId, {
          status: 'failed',
          completedAt: trippedAt,
          updatedAt: trippedAt,
          errorCode: HrcErrorCode.FIRST_TURN_MISSING,
          errorMessage: `no turn.started for runtime ${watch.runtimeId} generation ${watch.generation} by ${watch.firstTurnDeadlineAt ?? trippedAt}; diagnostics: ${firstTurnDiagnosticsHint(event.hrcSeq)}`,
        })
      }
    }

    return event
  })

  try {
    const event = commit()
    return { hrcSeq: event.hrcSeq, event }
  } catch (error) {
    if (error instanceof FirstTurnTripRaceLost) return null
    throw error
  }
}

class FirstTurnTripRaceLost extends Error {
  constructor() {
    super('first_turn_watch row was no longer armed')
  }
}

/**
 * Step 2: best-effort diagnostics, OUTSIDE the sweep's critical path and under
 * a hard time budget. Bundle failure or timeout never delays, blocks, or
 * rewrites the step-1 record; a partial assembly still publishes the linking
 * event, carrying an explicit per-field failure map rather than going silently
 * absent.
 */
async function publishDiagnostics(
  server: HrcServerInstanceForHandlers,
  watch: HrcFirstTurnWatchRecord,
  tripEventSeq: number
): Promise<void> {
  const deps: FirstTurnBundleDeps = {
    db: server.db,
    options: { runtimeRoot: server.options.runtimeRoot },
    ...(server.brokerTmuxManagerFactory !== undefined
      ? { tmuxManagerFactory: server.brokerTmuxManagerFactory }
      : {}),
    release: {
      ...(server.capturedRelease.mode === 'atomic'
        ? {
            releaseId: server.capturedRelease.releaseId,
            aspSetVersion: server.capturedRelease.aspBuild.setVersion,
          }
        : {}),
    },
    budgetMs: FIRST_TURN_BUNDLE_BUDGET_MS,
    now: timestamp,
  }

  const armed: HrcFirstTurnWatchRecord = {
    ...watch,
    tripEventSeq,
    firstTurnMissingTrippedAt: watch.firstTurnMissingTrippedAt ?? timestamp(),
  }

  let bundleDir: string | undefined
  let failures: Record<string, string> = {}
  try {
    const assembled = await assembleFirstTurnBundle(deps, armed)
    bundleDir = assembled.bundleDir
    failures = assembled.bundle.failures
  } catch (error) {
    failures = { bundle: error instanceof Error ? error.message : String(error) }
  }

  const now = timestamp()
  // The artifact dir is written FIRST, then the linking event is emitted with
  // the pointer. The reverse order would publish a pointer to nothing.
  if (bundleDir !== undefined) {
    try {
      server.db.runtimeArtifacts.insertIdempotent({
        artifactId: `first-turn-missing-${tripEventSeq}`,
        operationId: watch.runtimeId,
        artifactKind: HRC_FIRST_TURN_MISSING_BUNDLE_ARTIFACT_KIND,
        mediaType: 'application/json',
        storageKind: 'file-path',
        contentHash: createHash('sha256').update(bundleDir).digest('hex'),
        artifactPath: bundleDir,
        createdAt: now,
      })
    } catch (error) {
      failures['artifactRow'] = error instanceof Error ? error.message : String(error)
    }
  }

  const event = appendHrcEvent(server.db, HRC_FIRST_TURN_MISSING_DIAGNOSTICS_EVENT, {
    ts: now,
    hostSessionId: watch.hostSessionId,
    scopeRef: watch.scopeRef,
    laneRef: watch.laneRef,
    generation: watch.generation,
    runtimeId: watch.runtimeId,
    ...(watch.runId !== undefined ? { runId: watch.runId } : {}),
    payload: {
      tripEventSeq,
      ...(bundleDir !== undefined ? { bundleDir } : {}),
      failures,
      retrieval: firstTurnDiagnosticsHint(tripEventSeq),
    },
  })
  if (bundleDir !== undefined) {
    server.db.firstTurnWatch.recordDiagnostics(watch.runtimeId, watch.generation, {
      bundleDir,
      diagnosticsEventSeq: event.hrcSeq,
      updatedAt: now,
    })
  }
  server.notifyEvent(event)
}

/**
 * One evaluation pass. Per-row failure isolation: a runtime that throws is
 * counted and skipped, and the pass keeps making progress on the rest.
 */
export async function runFirstTurnEvaluationOnce(
  server: HrcServerInstanceForHandlers
): Promise<FirstTurnEvalSummary> {
  const now = timestamp()
  const due = server.db.firstTurnWatch.listArmedDue(now)
  const summary: FirstTurnEvalSummary = { scanned: due.length, tripped: 0, errors: 0 }

  for (const watch of due) {
    let trip: { hrcSeq: number; event: ReturnType<typeof appendHrcEvent> } | null
    try {
      trip = recordTrip(server, watch)
    } catch (error) {
      summary.errors += 1
      writeServerLog('WARN', 'runtime.first_turn_missing_trip_failed', {
        runtimeId: watch.runtimeId,
        generation: watch.generation,
        error: error instanceof Error ? error.message : String(error),
      })
      continue
    }
    if (trip === null) continue

    summary.tripped += 1
    server.notifyEvent(trip.event)
    writeServerLog('WARN', 'runtime.first_turn_missing', {
      runtimeId: watch.runtimeId,
      generation: watch.generation,
      scopeRef: watch.scopeRef,
      runId: watch.runId,
      firstTurnDeadlineAt: watch.firstTurnDeadlineAt,
      tripEventSeq: trip.hrcSeq,
      retrieval: firstTurnDiagnosticsHint(trip.hrcSeq),
    })

    try {
      await publishDiagnostics(server, watch, trip.hrcSeq)
    } catch (error) {
      // Explicitly non-fatal: the primary fact is already durable.
      writeServerLog('WARN', 'runtime.first_turn_missing_diagnostics_failed', {
        runtimeId: watch.runtimeId,
        generation: watch.generation,
        tripEventSeq: trip.hrcSeq,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return summary
}
